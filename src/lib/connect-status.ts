/**
 * Shared helper: derive local payment_account status from Stripe account state.
 *
 * Used by both:
 *  - webhook handler (account.updated) — real-time updates
 *  - GET /connect/status — self-healing reconciliation fallback
 *
 * Keeps the mapping in one place to prevent drift.
 */
import type Stripe from 'stripe';

export interface DerivedConnectState {
  status: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  capabilities: string; // JSON string
  requirements: string; // JSON string
}

/**
 * Map a Stripe Account object to the local payment_account fields.
 */
export function deriveConnectState(account: Stripe.Account): DerivedConnectState {
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

  return {
    status,
    charges_enabled: !!account.charges_enabled,
    payouts_enabled: !!account.payouts_enabled,
    capabilities: JSON.stringify(account.capabilities || {}),
    requirements: JSON.stringify(account.requirements || {}),
  };
}
