/**
 * Reconcile a local payment_account row against Stripe truth.
 *
 * Used by:
 *  - GET /connect/status  (owner checks their setup)
 *  - POST /checkout       (tenant attempts payment — Phase 0 self-healing)
 *
 * If the local status differs from what Stripe reports, the local row is
 * updated and the reconciled status is returned. If Stripe is unavailable
 * or reconciliation fails, returns null (caller uses local state).
 */
import { queryOne, logger } from '@leasebase/service-common';
import { getStripe, isStripeConfigured } from '../stripe/client';
import { deriveConnectState } from './connect-status';

export interface PaymentAccountRow {
  id: string;
  stripe_account_id: string;
  status: string;
  default_fee_percent?: number;
}

export interface ReconciledAccount {
  stripe_account_id: string;
  default_fee_percent: number;
  status: string;
}

/**
 * Attempt to reconcile a non-ACTIVE payment_account against Stripe truth.
 *
 * Returns the reconciled account fields needed by checkout if Stripe confirms
 * ACTIVE, or null if the account is genuinely not ready.
 *
 * Best-effort: Stripe API failures are caught and logged — returns null.
 */
export async function reconcilePaymentAccount(
  account: PaymentAccountRow,
  orgId: string,
): Promise<ReconciledAccount | null> {
  if (!isStripeConfigured()) return null;

  try {
    const stripe = getStripe();
    const stripeAcct = await stripe.accounts.retrieve(account.stripe_account_id);
    const derived = deriveConnectState(stripeAcct);

    if (derived.status !== account.status) {
      await queryOne(
        `UPDATE payment_account
         SET status = $1, charges_enabled = $2, payouts_enabled = $3,
             capabilities = $4, requirements = $5, updated_at = NOW()
         WHERE id = $6`,
        [
          derived.status,
          derived.charges_enabled,
          derived.payouts_enabled,
          derived.capabilities,
          derived.requirements,
          account.id,
        ],
      );

      logger.info(
        { orgId, oldStatus: account.status, newStatus: derived.status, trigger: 'reconciliation' },
        'Payment account reconciled from Stripe truth',
      );
    }

    if (derived.status === 'ACTIVE') {
      return {
        stripe_account_id: account.stripe_account_id,
        default_fee_percent: account.default_fee_percent ?? 100,
        status: 'ACTIVE',
      };
    }

    return null;
  } catch (err) {
    logger.warn(
      { err, orgId, stripeAccountId: account.stripe_account_id },
      'Payment account reconciliation failed — using local state',
    );
    return null;
  }
}
