/**
 * Reconcile a stale PENDING payment_transaction against Stripe PaymentIntent truth.
 *
 * Used by:
 *  - POST /checkout/create-intent — to resolve stale intents before creating new ones
 *  - Future: GET /mine, GET /mine/charges for read-path reconciliation
 *
 * Returns the resolved Stripe PI status so callers can decide how to proceed.
 */
import { queryOne, logger } from '@leasebase/service-common';
import { getStripe, isStripeConfigured } from '../stripe/client';
import type Stripe from 'stripe';

export type ResolvedPiStatus =
  | 'stale'           // PI is abandonable (requires_payment_method, requires_confirmation, requires_action, canceled)
  | 'processing'      // PI is actively processing (ACH)
  | 'succeeded'       // PI already succeeded (webhook may have been missed)
  | 'unknown';        // Could not determine (Stripe unavailable)

export interface StaleTransaction {
  id: string;
  stripe_payment_intent_id: string | null;
  status: string;
  charge_id: string;
}

/**
 * Check a PENDING transaction against Stripe and update local state if needed.
 * Returns the resolved status category so the caller knows how to proceed.
 */
export async function reconcileTransaction(txn: StaleTransaction): Promise<ResolvedPiStatus> {
  if (!txn.stripe_payment_intent_id || !isStripeConfigured()) {
    return 'unknown';
  }

  try {
    const stripe = getStripe();
    const pi = await stripe.paymentIntents.retrieve(txn.stripe_payment_intent_id);

    return await applyPiStatus(txn, pi);
  } catch (err) {
    logger.warn(
      { err, txnId: txn.id, piId: txn.stripe_payment_intent_id },
      'Transaction reconciliation failed — treating as unknown',
    );
    return 'unknown';
  }
}

async function applyPiStatus(txn: StaleTransaction, pi: Stripe.PaymentIntent): Promise<ResolvedPiStatus> {
  switch (pi.status) {
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
    case 'canceled': {
      // PI was never completed — mark local txn as ABANDONED
      await queryOne(
        `UPDATE payment_transaction SET status = 'CANCELED', failure_message = $1, updated_at = NOW() WHERE id = $2 AND status = 'PENDING'`,
        [`Abandoned: Stripe PI status was ${pi.status}`, txn.id],
      );
      logger.info(
        { txnId: txn.id, piId: pi.id, piStatus: pi.status },
        'Stale transaction marked CANCELED after Stripe reconciliation',
      );
      return 'stale';
    }

    case 'processing': {
      // ACH in flight — update local to PROCESSING
      if (txn.status === 'PENDING') {
        await queryOne(
          `UPDATE payment_transaction SET status = 'PROCESSING', updated_at = NOW() WHERE id = $1 AND status = 'PENDING'`,
          [txn.id],
        );
        logger.info({ txnId: txn.id, piId: pi.id }, 'Transaction updated to PROCESSING from Stripe reconciliation');
      }
      return 'processing';
    }

    case 'succeeded': {
      // Webhook may have been missed — log but don't finalize here
      // (the full finalization with receipt/charge update happens via webhook replay)
      logger.warn(
        { txnId: txn.id, piId: pi.id },
        'Stripe PI succeeded but local txn is still PENDING — webhook may have been missed',
      );
      return 'succeeded';
    }

    default:
      return 'unknown';
  }
}
