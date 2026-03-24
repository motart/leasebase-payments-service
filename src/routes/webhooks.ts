/**
 * Stripe webhook endpoints.
 *
 * POST /webhooks/stripe         — Platform webhook (payments, charges, disputes)
 * POST /webhooks/stripe-connect — Connect webhook (account updates, payouts)
 *
 * IMPORTANT: These routes must receive the raw body (Buffer) for signature verification.
 * The parent router must NOT apply express.json() to these paths.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import type Stripe from 'stripe';
import { logger, queryOne, getPool, emitNotification } from '@leasebase/service-common';
import { getStripe, getWebhookSecrets, isStripeConfigured } from '../stripe/client';
import { getLeaseDetails } from '../data/lease-queries';
import { getTenantEmail } from '../data/tenant-queries';
import { insertAuditLog } from '../lib/audit';
import { sendReceiptEmail } from '../lib/email';
import {
  sendAutopaySuccessEmail,
  sendAutopayFailureEmail,
  sendRetryExhaustedEmail,
} from '../lib/notifications';
import { deriveConnectState } from '../lib/connect-status';

const router = Router();

// ── Signature verification helper ────────────────────────────────────────────

function verifyAndParse(rawBody: Buffer, signature: string, secret: string): Stripe.Event {
  const stripe = getStripe();
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

// ── Idempotency: store event ─────────────────────────────────────────────────

async function storeEvent(event: Stripe.Event): Promise<boolean> {
  try {
    const result = await queryOne<{ id: string }>(
      `INSERT INTO webhook_event (stripe_event_id, event_type, api_version, stripe_account_id, payload, status)
       VALUES ($1, $2, $3, $4, $5, 'RECEIVED')
       ON CONFLICT (stripe_event_id) DO NOTHING
       RETURNING id`,
      [
        event.id,
        event.type,
        event.api_version || null,
        (event as any).account || null,
        JSON.stringify(event),
      ],
    );
    return result !== null;
  } catch (err) {
    logger.error({ err, eventId: event.id }, 'Failed to store webhook event');
    return false;
  }
}

async function markEventProcessed(eventId: string, status: 'PROCESSED' | 'FAILED', errorMessage?: string): Promise<void> {
  await queryOne(
    `UPDATE webhook_event SET status = $1, error_message = $2, processed_at = NOW(),
     retry_count = CASE WHEN $1 = 'FAILED' THEN retry_count + 1 ELSE retry_count END
     WHERE stripe_event_id = $3`,
    [status, errorMessage || null, eventId],
  );
}

// ── Platform event handlers ──────────────────────────────────────────────────

async function handlePlatformEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'payment_intent.succeeded':
      await handlePaymentIntentSucceeded(event);
      break;
    case 'payment_intent.payment_failed':
      await handlePaymentIntentFailed(event);
      break;
    case 'payment_intent.processing':
      await handlePaymentIntentProcessing(event);
      break;
    case 'setup_intent.succeeded':
      await handleSetupIntentSucceeded(event);
      break;
    case 'setup_intent.setup_failed':
      await handleSetupIntentFailed(event);
      break;
    case 'payment_method.detached':
      await handlePaymentMethodDetached(event);
      break;
    case 'charge.dispute.created':
      await handleDisputeCreated(event);
      break;
    case 'charge.dispute.closed':
      await handleDisputeClosed(event);
      break;
    case 'charge.refunded':
      await handleChargeRefunded(event);
      break;
    default:
      logger.info({ eventType: event.type }, 'Unhandled platform event type');
  }
}

// ── Connect event handlers ───────────────────────────────────────────────────

async function handleConnectEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'account.updated':
      await handleAccountUpdated(event);
      break;
    case 'account.application.deauthorized':
      await handleAccountDeauthorized(event);
      break;
    case 'payout.paid':
    case 'payout.failed':
    case 'payout.created':
    case 'payout.canceled':
      await handlePayoutEvent(event);
      break;
    default:
      logger.info({ eventType: event.type }, 'Unhandled connect event type');
  }
}

// ── Payment Success (critical path with atomic guard) ────────────────────────

async function handlePaymentIntentSucceeded(event: Stripe.Event): Promise<void> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  logger.info({ piId: paymentIntent.id, amount: paymentIntent.amount }, 'PaymentIntent succeeded');

  // Find the payment_transaction
  const txn = await queryOne<{
    id: string;
    charge_id: string;
    organization_id: string;
    lease_id: string;
    tenant_user_id: string | null;
    amount: number;
    currency: string;
    status: string;
    source: string;
  }>(
    `SELECT id, charge_id, organization_id, lease_id, tenant_user_id, amount, currency, status, source
     FROM payment_transaction
     WHERE stripe_payment_intent_id = $1`,
    [paymentIntent.id],
  );

  if (!txn) {
    // Transaction not found — could be a race condition (webhook arrived before redirect).
    // Store event as RECEIVED and let it be reprocessed later.
    logger.warn({ piId: paymentIntent.id }, 'PaymentIntent succeeded but no matching transaction found — will retry on replay');
    return;
  }

  // Idempotent guard: already succeeded
  if (txn.status === 'SUCCEEDED') {
    logger.info({ txnId: txn.id }, 'Transaction already SUCCEEDED — skipping');
    return;
  }

  // Extract payment method summary from the PaymentIntent
  const pmSummary = extractPaymentMethodSummary(paymentIntent);

  // Extract Stripe charge ID
  const stripeChargeId = typeof paymentIntent.latest_charge === 'string'
    ? paymentIntent.latest_charge
    : (paymentIntent.latest_charge as any)?.id ?? null;

  // Atomic transaction: update txn + charge + create receipt
  const pool = getPool();
  const client = await pool.connect();
  let receiptData: { receipt_number: string; id: string } | null = null;

  try {
    await client.query('BEGIN');

    // Row-level lock on charge to prevent concurrent amount_paid updates
    const chargeRow = await client.query(
      `SELECT id, amount, amount_paid, status, billing_period, organization_id
       FROM charge WHERE id = $1 FOR UPDATE`,
      [txn.charge_id],
    );
    const charge = chargeRow.rows[0];

    if (!charge) {
      // Charge was deleted? Shouldn't happen. Log and rollback.
      logger.error({ chargeId: txn.charge_id, txnId: txn.id }, 'Charge not found during success handling');
      await client.query('ROLLBACK');
      return;
    }

    // Double-check idempotency within transaction
    const txnCheck = await client.query(
      `SELECT status FROM payment_transaction WHERE id = $1 FOR UPDATE`,
      [txn.id],
    );
    if (txnCheck.rows[0]?.status === 'SUCCEEDED') {
      await client.query('ROLLBACK');
      return;
    }

    // Update transaction status
    await client.query(
      `UPDATE payment_transaction
       SET status = 'SUCCEEDED', stripe_charge_id = $1, updated_at = NOW()
       WHERE id = $2`,
      [stripeChargeId, txn.id],
    );

    // Update charge amount_paid
    const newAmountPaid = charge.amount_paid + txn.amount;
    const newChargeStatus = newAmountPaid >= charge.amount ? 'PAID' : charge.status;
    await client.query(
      `UPDATE charge SET amount_paid = $1, status = $2, updated_at = NOW() WHERE id = $3`,
      [newAmountPaid, newChargeStatus, charge.id],
    );

    // Audit log
    await client.query(
      `INSERT INTO payment_audit_log
        (organization_id, entity_type, entity_id, action, old_status, new_status, metadata, actor_type, actor_id)
       VALUES ($1, 'PAYMENT_TRANSACTION', $2, 'STATUS_CHANGED', $3, 'SUCCEEDED', $4, 'WEBHOOK', $5)`,
      [
        txn.organization_id,
        txn.id,
        txn.status,
        JSON.stringify({ stripe_event_id: event.id, stripe_charge_id: stripeChargeId }),
        event.id,
      ],
    );

    // Get lease details for receipt
    const leaseDetails = await getLeaseDetails(txn.lease_id);

    // Get org short ID for receipt number prefix
    const orgPrefix = txn.organization_id.substring(0, 8).toUpperCase();
    const seqResult = await client.query(`SELECT nextval('payments_service.receipt_number_seq') AS seq`);
    const receiptNumber = `${orgPrefix}-${String(seqResult.rows[0].seq).padStart(5, '0')}`;

    // Create receipt
    const receiptResult = await client.query(
      `INSERT INTO receipt
        (organization_id, payment_transaction_id, charge_id, lease_id, tenant_user_id,
         receipt_number, amount, currency, payment_method_summary, property_name, unit_number, billing_period)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, receipt_number`,
      [
        txn.organization_id,
        txn.id,
        txn.charge_id,
        txn.lease_id,
        txn.tenant_user_id,
        receiptNumber,
        txn.amount,
        txn.currency,
        pmSummary,
        leaseDetails?.property_name ?? null,
        leaseDetails?.unit_number ?? null,
        charge.billing_period,
      ],
    );
    receiptData = receiptResult.rows[0];

    await client.query('COMMIT');

    logger.info(
      { txnId: txn.id, chargeId: txn.charge_id, receiptNumber, newChargeStatus },
      'Payment success processed — transaction, charge, receipt updated atomically',
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // After commit: non-transactional, retryable side effects
  // 1. Send receipt email directly via SES
  if (receiptData && txn.tenant_user_id) {
    const tenantEmail = await getTenantEmail(txn.tenant_user_id);
    if (tenantEmail) {
      const sent = await sendReceiptEmail({
        toEmail: tenantEmail,
        receiptNumber: receiptData.receipt_number,
        amount: txn.amount,
        currency: txn.currency,
        billingPeriod: null, // TODO: pass billing_period from charge
        propertyName: null,
        unitNumber: null,
        paymentMethodSummary: pmSummary,
        paidAt: new Date().toISOString(),
      });

      if (sent) {
        // Update receipt.sent_at
        await queryOne(
          `UPDATE receipt SET sent_at = NOW(), email_sent_to = $1 WHERE id = $2`,
          [tenantEmail, receiptData.id],
        );
      }
    }
  }

  // 2. Autopay-specific: send autopay success email + update attempt_log
  if (txn.source === 'AUTOPAY' && receiptData && txn.tenant_user_id) {
    const tenantEmail = await getTenantEmail(txn.tenant_user_id);
    if (tenantEmail) {
      await sendAutopaySuccessEmail({
        toEmail: tenantEmail,
        amount: txn.amount,
        currency: txn.currency,
        receiptNumber: receiptData.receipt_number,
        billingPeriod: null,
      });
    }

    // Mark the latest attempt_log as SUCCEEDED
    await queryOne(
      `UPDATE autopay_attempt_log SET status = 'SUCCEEDED'
       WHERE charge_id = $1 AND status = 'PENDING'
       ORDER BY created_at DESC LIMIT 1`,
      [txn.charge_id],
    ).catch((err) => logger.warn({ err, chargeId: txn.charge_id }, 'Failed to update autopay attempt_log'));
  }

  // 3. In-app notification (dual-write alongside direct SES emails)
  if (receiptData && txn.tenant_user_id) {
    emitNotification({
      organizationId: txn.organization_id,
      recipientUserIds: [txn.tenant_user_id],
      eventType: 'payment_succeeded',
      title: 'Payment received',
      body: `Your payment of $${(txn.amount / 100).toFixed(2)} has been received. Receipt #${receiptData.receipt_number}.`,
      relatedType: 'payment',
      relatedId: txn.id,
      audience: 'tenant',
      templateData: {
        formattedAmount: `$${(txn.amount / 100).toFixed(2)}`,
        receiptNumber: receiptData.receipt_number,
        amount: txn.amount,
        currency: txn.currency,
      },
      metadata: { receiptNumber: receiptData.receipt_number, amount: txn.amount },
    }).catch(() => {});
  }
}

// ── Payment Failure ──────────────────────────────────────────────────────────

async function handlePaymentIntentFailed(event: Stripe.Event): Promise<void> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const lastError = paymentIntent.last_payment_error;

  logger.info({ piId: paymentIntent.id, failureCode: lastError?.code }, 'PaymentIntent failed');

  const txn = await queryOne<{
    id: string; organization_id: string; status: string;
    source: string; charge_id: string | null; autopay_retry_count: number;
  }>(
    `SELECT id, organization_id, status, source, charge_id, autopay_retry_count
     FROM payment_transaction WHERE stripe_payment_intent_id = $1`,
    [paymentIntent.id],
  );

  if (!txn) {
    logger.warn({ piId: paymentIntent.id }, 'PaymentIntent failed but no matching transaction found');
    return;
  }

  if (txn.status === 'FAILED') {
    logger.info({ txnId: txn.id }, 'Transaction already FAILED — skipping');
    return;
  }

  await queryOne(
    `UPDATE payment_transaction
     SET status = 'FAILED', failure_code = $1, failure_message = $2, updated_at = NOW()
     WHERE id = $3`,
    [lastError?.code ?? null, lastError?.message ?? null, txn.id],
  );

  await insertAuditLog({
    organizationId: txn.organization_id,
    entityType: 'PAYMENT_TRANSACTION',
    entityId: txn.id,
    action: 'STATUS_CHANGED',
    oldStatus: txn.status,
    newStatus: 'FAILED',
    metadata: { stripe_event_id: event.id, failure_code: lastError?.code },
    actorType: 'WEBHOOK',
    actorId: event.id,
  });

  // Autopay-specific side effects: record retry tracking
  if (txn.source === 'AUTOPAY') {
    await handleAutopayFailureSideEffects(
      txn.id,
      txn.organization_id,
      txn.charge_id,
      txn.autopay_retry_count,
      lastError?.code ?? null,
    );
  }
}

// ── Payment Processing (ACH) ────────────────────────────────────────────────

async function handlePaymentIntentProcessing(event: Stripe.Event): Promise<void> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  logger.info({ piId: paymentIntent.id }, 'PaymentIntent processing');

  const txn = await queryOne<{ id: string; organization_id: string; status: string }>(
    `SELECT id, organization_id, status FROM payment_transaction WHERE stripe_payment_intent_id = $1`,
    [paymentIntent.id],
  );

  if (!txn) {
    logger.warn({ piId: paymentIntent.id }, 'PaymentIntent processing but no matching transaction found');
    return;
  }

  if (txn.status === 'PROCESSING' || txn.status === 'SUCCEEDED') {
    return; // already advanced
  }

  await queryOne(
    `UPDATE payment_transaction SET status = 'PROCESSING', updated_at = NOW() WHERE id = $1`,
    [txn.id],
  );

  await insertAuditLog({
    organizationId: txn.organization_id,
    entityType: 'PAYMENT_TRANSACTION',
    entityId: txn.id,
    action: 'STATUS_CHANGED',
    oldStatus: txn.status,
    newStatus: 'PROCESSING',
    metadata: { stripe_event_id: event.id },
    actorType: 'WEBHOOK',
    actorId: event.id,
  });
}

// ── Setup Intent Handlers (Phase 1B) ─────────────────────────────────────────

async function handleSetupIntentSucceeded(event: Stripe.Event): Promise<void> {
  const setupIntent = event.data.object as Stripe.SetupIntent;
  const pmId = typeof setupIntent.payment_method === 'string'
    ? setupIntent.payment_method
    : (setupIntent.payment_method as any)?.id;

  logger.info({ setupIntentId: setupIntent.id, pmId }, 'SetupIntent succeeded (webhook)');

  if (!pmId) {
    logger.warn({ setupIntentId: setupIntent.id }, 'SetupIntent succeeded but no payment_method attached');
    return;
  }

  // Check if we already have this PM locally
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM payment_method WHERE stripe_payment_method_id = $1`,
    [pmId],
  );
  if (existing) {
    // Already persisted (via /setup-intent/complete or previous webhook)
    logger.info({ pmId }, 'PaymentMethod already exists locally — skipping webhook upsert');
    return;
  }

  // Fetch the full PaymentMethod from Stripe to get card details
  const stripe = getStripe();
  let pm: Stripe.PaymentMethod;
  try {
    pm = await stripe.paymentMethods.retrieve(pmId);
  } catch (err) {
    logger.error({ err, pmId }, 'Failed to retrieve PaymentMethod from Stripe during webhook');
    return;
  }

  const card = pm.card;
  const customerId = typeof setupIntent.customer === 'string'
    ? setupIntent.customer
    : (setupIntent.customer as any)?.id ?? null;
  const userId = setupIntent.metadata?.leasebase_user_id;
  const orgId = setupIntent.metadata?.leasebase_org_id;

  if (!userId || !orgId) {
    logger.warn({ setupIntentId: setupIntent.id }, 'SetupIntent missing leasebase metadata — cannot persist PM');
    return;
  }

  // Check if this is the first method for the user
  const countResult = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM payment_method
     WHERE user_id = $1 AND organization_id = $2 AND status = 'ACTIVE'`,
    [userId, orgId],
  );
  const isFirst = Number(countResult?.count || 0) === 0;

  await queryOne(
    `INSERT INTO payment_method
       (organization_id, user_id, stripe_payment_method_id, stripe_customer_id,
        stripe_setup_intent_id, type, last4, brand, exp_month, exp_year,
        fingerprint, is_default, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'ACTIVE')
     ON CONFLICT (stripe_payment_method_id) DO NOTHING`,
    [
      orgId, userId, pm.id, customerId, setupIntent.id,
      pm.type, card?.last4 ?? null, card?.brand ?? null,
      card?.exp_month ?? null, card?.exp_year ?? null,
      card?.fingerprint ?? null, isFirst,
    ],
  );

  logger.info({ pmId: pm.id, userId, orgId, isDefault: isFirst }, 'PaymentMethod persisted via webhook');
}

async function handleSetupIntentFailed(event: Stripe.Event): Promise<void> {
  const setupIntent = event.data.object as Stripe.SetupIntent;
  const lastError = setupIntent.last_setup_error;
  logger.info(
    { setupIntentId: setupIntent.id, failureCode: lastError?.code },
    'SetupIntent setup failed',
  );

  // If we had a payment_method row pending for this setup intent, mark it failed
  const pm = await queryOne<{ id: string }>(
    `SELECT id FROM payment_method WHERE stripe_setup_intent_id = $1 AND status = 'ACTIVE'`,
    [setupIntent.id],
  );
  if (pm) {
    await queryOne(
      `UPDATE payment_method
       SET status = 'FAILED', status_reason = $1, updated_at = NOW()
       WHERE id = $2`,
      [lastError?.message ?? 'Setup failed', pm.id],
    );
  }
}

async function handlePaymentMethodDetached(event: Stripe.Event): Promise<void> {
  const pmObject = event.data.object as Stripe.PaymentMethod;
  logger.info({ pmId: pmObject.id }, 'PaymentMethod detached externally');

  // Mark as DETACHED locally if we have it
  await queryOne(
    `UPDATE payment_method
     SET status = 'DETACHED', is_default = false, detached_at = NOW(), updated_at = NOW()
     WHERE stripe_payment_method_id = $1 AND status = 'ACTIVE'`,
    [pmObject.id],
  );
}

// ── Autopay-aware failure handling ───────────────────────────────────────────
// (extends handlePaymentIntentFailed — autopay notification side effect)

async function handleAutopayFailureSideEffects(
  txnId: string,
  orgId: string,
  chargeId: string | null,
  retryCount: number,
  failureCode: string | null,
): Promise<void> {
  try {
    // Record autopay attempt log
    const attemptNumber = retryCount + 1;
    const maxRetries = 3;
    const nextRetryAt = attemptNumber < maxRetries
      ? getNextRetryDate(attemptNumber)
      : null;

    await queryOne(
      `INSERT INTO autopay_attempt_log
         (organization_id, charge_id, payment_transaction_id, attempt_number, status, failure_reason, next_retry_at)
       VALUES ($1, $2, $3, $4, 'FAILED', $5, $6)`,
      [orgId, chargeId, txnId, attemptNumber, failureCode, nextRetryAt],
    );

    logger.info(
      { txnId, attemptNumber, nextRetryAt, maxRetries },
      'Autopay failure recorded in attempt log',
    );

    // Send failure/exhausted email to tenant
    if (chargeId) {
      const txnRow = await queryOne<{
        tenant_user_id: string | null;
        amount: number;
        currency: string;
      }>(
        `SELECT tenant_user_id, amount, currency FROM payment_transaction WHERE id = $1`,
        [txnId],
      );

      if (txnRow?.tenant_user_id) {
        const tenantEmail = await getTenantEmail(txnRow.tenant_user_id);
        if (tenantEmail) {
          if (attemptNumber >= maxRetries) {
            // Final retry exhausted
            await sendRetryExhaustedEmail({
              toEmail: tenantEmail,
              amount: txnRow.amount,
              currency: txnRow.currency,
            });
          } else {
            // More retries remain
            await sendAutopayFailureEmail({
              toEmail: tenantEmail,
              amount: txnRow.amount,
              currency: txnRow.currency,
              failureReason: failureCode,
              retryNumber: attemptNumber,
              maxRetries,
              nextRetryDate: nextRetryAt,
            });
          }
        }
      }
    }
  } catch (err) {
    logger.error({ err, txnId }, 'Failed to record autopay failure side effects');
  }
}

function getNextRetryDate(attemptNumber: number): string | null {
  const delayDays = [1, 3, 5]; // retry 1: +1d, retry 2: +3d, retry 3: +5d
  const delay = delayDays[attemptNumber - 1];
  if (delay === undefined) return null;
  const next = new Date();
  next.setDate(next.getDate() + delay);
  return next.toISOString();
}

// ── Dispute / Refund stubs (Phase 2) ─────────────────────────────────────────

async function handleDisputeCreated(event: Stripe.Event): Promise<void> {
  const dispute = event.data.object as Stripe.Dispute;
  logger.info({ disputeId: dispute.id, chargeId: dispute.charge }, 'Dispute created');
  // TODO Phase 2: create dispute record, notify owner
}

async function handleDisputeClosed(event: Stripe.Event): Promise<void> {
  const dispute = event.data.object as Stripe.Dispute;
  logger.info({ disputeId: dispute.id, status: dispute.status }, 'Dispute closed');
  // TODO Phase 2: update dispute record
}

async function handleChargeRefunded(event: Stripe.Event): Promise<void> {
  const charge = event.data.object as Stripe.Charge;
  logger.info({ chargeId: charge.id, amountRefunded: charge.amount_refunded }, 'Charge refunded');
  // TODO Phase 2: update refund record
}

// ── Connect: Account Updated ─────────────────────────────────────────────────

async function handleAccountUpdated(event: Stripe.Event): Promise<void> {
  const account = event.data.object as Stripe.Account;
  logger.info({ accountId: account.id, chargesEnabled: account.charges_enabled }, 'Account updated');

  const derived = deriveConnectState(account);

  await queryOne(
    `UPDATE payment_account
     SET status = $1, charges_enabled = $2, payouts_enabled = $3,
         capabilities = $4, requirements = $5, updated_at = NOW()
     WHERE stripe_account_id = $6`,
    [
      derived.status,
      derived.charges_enabled,
      derived.payouts_enabled,
      derived.capabilities,
      derived.requirements,
      account.id,
    ],
  );
}

async function handleAccountDeauthorized(event: Stripe.Event): Promise<void> {
  const account = event.data.object as Stripe.Account;
  logger.warn({ accountId: account.id }, 'Account deauthorized');

  await queryOne(
    `UPDATE payment_account SET status = 'DISCONNECTED', updated_at = NOW()
     WHERE stripe_account_id = $1`,
    [account.id],
  );
}

async function handlePayoutEvent(event: Stripe.Event): Promise<void> {
  const payout = event.data.object as Stripe.Payout;
  logger.info({ payoutId: payout.id, status: payout.status, type: event.type }, 'Payout event');
  // TODO Phase 2: upsert payout_record
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractPaymentMethodSummary(pi: Stripe.PaymentIntent): string | null {
  const pm = pi.payment_method;
  if (!pm || typeof pm === 'string') return null;

  if (pm.card) {
    return `${pm.card.brand?.charAt(0).toUpperCase()}${pm.card.brand?.slice(1) ?? ''} ••${pm.card.last4}`;
  }
  if (pm.us_bank_account) {
    return `ACH ••${pm.us_bank_account.last4}`;
  }
  return pm.type ?? null;
}

// ── POST /webhooks/stripe ────────────────────────────────────────────────────

router.post('/stripe', async (req: Request, res: Response, _next: NextFunction) => {
  if (!isStripeConfigured()) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }

  const signature = req.headers['stripe-signature'] as string;
  if (!signature) {
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }

  let event: Stripe.Event;
  try {
    const secrets = getWebhookSecrets();
    // Use rawBody captured by the verify callback in express.json().
    const rawBody = (req as any).rawBody;
    logger.info({
      hasRawBody: rawBody !== undefined,
      rawBodyType: typeof rawBody,
      isBuffer: Buffer.isBuffer(rawBody),
      bodyType: typeof req.body,
    }, 'Webhook raw body diagnostic');
    const payload = Buffer.isBuffer(rawBody) ? rawBody : (typeof rawBody === 'string' ? rawBody : JSON.stringify(req.body));
    event = verifyAndParse(payload as Buffer, signature, secrets.platform);
  } catch (err) {
    logger.error({ err }, 'Webhook signature verification failed');
    return res.status(401).json({ error: 'Signature verification failed' });
  }

  // Idempotency: store and check for duplicates
  const isNew = await storeEvent(event);
  if (!isNew) {
    logger.info({ eventId: event.id }, 'Duplicate webhook event — skipping');
    return res.json({ received: true });
  }

  // Process event
  try {
    await handlePlatformEvent(event);
    await markEventProcessed(event.id, 'PROCESSED');
  } catch (err) {
    logger.error({ err, eventId: event.id }, 'Webhook processing failed');
    await markEventProcessed(event.id, 'FAILED', (err as Error).message);
    // Still return 200 to prevent Stripe retries — we handle retries internally
  }

  res.json({ received: true });
});

// ── POST /webhooks/stripe-connect ────────────────────────────────────────────

router.post('/stripe-connect', async (req: Request, res: Response, _next: NextFunction) => {
  if (!isStripeConfigured()) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }

  const signature = req.headers['stripe-signature'] as string;
  if (!signature) {
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }

  let event: Stripe.Event;
  try {
    const secrets = getWebhookSecrets();
    const rawBody = (req as any).rawBody as Buffer;
    event = verifyAndParse(rawBody, signature, secrets.connect);
  } catch (err) {
    logger.error({ err }, 'Connect webhook signature verification failed');
    return res.status(401).json({ error: 'Signature verification failed' });
  }

  const isNew = await storeEvent(event);
  if (!isNew) {
    logger.info({ eventId: event.id }, 'Duplicate connect webhook event — skipping');
    return res.json({ received: true });
  }

  try {
    await handleConnectEvent(event);
    await markEventProcessed(event.id, 'PROCESSED');
  } catch (err) {
    logger.error({ err, eventId: event.id }, 'Connect webhook processing failed');
    await markEventProcessed(event.id, 'FAILED', (err as Error).message);
  }

  res.json({ received: true });
});

export { router as webhooksRouter };
export { handlePlatformEvent as handlePlatformEventReplay };
