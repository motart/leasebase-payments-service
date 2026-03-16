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
import { logger, queryOne, getPool } from '@leasebase/service-common';
import { getStripe, getWebhookSecrets, isStripeConfigured } from '../stripe/client';
import { getLeaseDetails } from '../data/lease-queries';
import { getTenantEmail } from '../data/tenant-queries';
import { insertAuditLog } from '../lib/audit';
import { sendReceiptEmail } from '../lib/email';

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
  }>(
    `SELECT id, charge_id, organization_id, lease_id, tenant_user_id, amount, currency, status
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

  // 2. TODO: Publish PaymentSucceeded event to EventBridge
  //    (notification-service will consume → send "payment received" push to owner)
}

// ── Payment Failure ──────────────────────────────────────────────────────────

async function handlePaymentIntentFailed(event: Stripe.Event): Promise<void> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const lastError = paymentIntent.last_payment_error;

  logger.info({ piId: paymentIntent.id, failureCode: lastError?.code }, 'PaymentIntent failed');

  const txn = await queryOne<{ id: string; organization_id: string; status: string }>(
    `SELECT id, organization_id, status FROM payment_transaction WHERE stripe_payment_intent_id = $1`,
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

  // TODO: Publish PaymentFailed event to EventBridge
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

  let status = 'ONBOARDING_INCOMPLETE';
  if (account.charges_enabled && account.payouts_enabled) {
    status = 'ACTIVE';
  } else if (account.requirements?.disabled_reason) {
    status = 'RESTRICTED';
  } else if (
    account.requirements?.currently_due?.length === 0 &&
    account.requirements?.pending_verification?.length
  ) {
    status = 'PENDING_VERIFICATION';
  }

  await queryOne(
    `UPDATE payment_account
     SET status = $1, charges_enabled = $2, payouts_enabled = $3,
         capabilities = $4, requirements = $5, updated_at = NOW()
     WHERE stripe_account_id = $6`,
    [
      status,
      account.charges_enabled,
      account.payouts_enabled,
      JSON.stringify(account.capabilities || {}),
      JSON.stringify(account.requirements || {}),
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
    event = verifyAndParse(req.body as Buffer, signature, secrets.platform);
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
    event = verifyAndParse(req.body as Buffer, signature, secrets.connect);
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
