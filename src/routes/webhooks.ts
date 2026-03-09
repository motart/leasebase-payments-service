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
import { logger, queryOne } from '@leasebase/service-common';
import { getStripe, getWebhookSecrets, isStripeConfigured } from '../stripe/client';

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
    // If result is null, event was already stored (duplicate)
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

// ── Individual handler stubs (to be implemented) ─────────────────────────────

async function handlePaymentIntentSucceeded(event: Stripe.Event): Promise<void> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  logger.info({ piId: paymentIntent.id, amount: paymentIntent.amount }, 'PaymentIntent succeeded');

  // TODO: Implement
  // 1. Find payment_transaction by stripe_payment_intent_id
  // 2. Update status to SUCCEEDED
  // 3. Update obligation.amount_paid
  // 4. Create PAYMENT ledger entry
  // 5. Create PLATFORM_FEE ledger entry
}

async function handlePaymentIntentFailed(event: Stripe.Event): Promise<void> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  logger.info({ piId: paymentIntent.id }, 'PaymentIntent failed');

  // TODO: Implement
  // 1. Find payment_transaction by stripe_payment_intent_id
  // 2. Update status to FAILED with failure_code and failure_message
  // 3. Publish notification event (via EventBridge or direct)
  // 4. Evaluate retry eligibility
}

async function handlePaymentIntentProcessing(event: Stripe.Event): Promise<void> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  logger.info({ piId: paymentIntent.id }, 'PaymentIntent processing');

  // TODO: Update payment_transaction status to PROCESSING
}

async function handleDisputeCreated(event: Stripe.Event): Promise<void> {
  const dispute = event.data.object as Stripe.Dispute;
  logger.info({ disputeId: dispute.id, chargeId: dispute.charge }, 'Dispute created');

  // TODO: Implement
  // 1. Find payment_transaction by stripe_charge_id
  // 2. Insert dispute record
  // 3. Create DISPUTE ledger entry
  // 4. Notify owner
}

async function handleDisputeClosed(event: Stripe.Event): Promise<void> {
  const dispute = event.data.object as Stripe.Dispute;
  logger.info({ disputeId: dispute.id, status: dispute.status }, 'Dispute closed');

  // TODO: Update dispute record, create DISPUTE_REVERSAL ledger entry if lost
}

async function handleChargeRefunded(event: Stripe.Event): Promise<void> {
  const charge = event.data.object as Stripe.Charge;
  logger.info({ chargeId: charge.id, amountRefunded: charge.amount_refunded }, 'Charge refunded');

  // TODO: Confirm refund record status
}

async function handleAccountUpdated(event: Stripe.Event): Promise<void> {
  const account = event.data.object as Stripe.Account;
  logger.info({ accountId: account.id, chargesEnabled: account.charges_enabled }, 'Account updated');

  // Determine status from Stripe account state
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

  // TODO: Implement
  // 1. Upsert payout record
  // 2. Update status based on event type
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
