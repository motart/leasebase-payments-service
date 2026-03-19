/**
 * Stripe Customer management.
 *
 * Customers live on the PLATFORM Stripe account (not connected accounts).
 * PaymentMethods are attached to platform-level customers; autopay uses
 * transfer_data.destination for connected-account settlement.
 */
import { queryOne, logger } from '@leasebase/service-common';
import { getStripe } from '../stripe/client';

/**
 * Get or create a Stripe Customer on the platform account for a given user.
 *
 * Lookup priority:
 *  1. Existing payment_method row with stripe_customer_id (fastest)
 *  2. Create new Stripe Customer
 *
 * Returns the Stripe customer ID.
 */
export async function getOrCreateStripeCustomer(
  userId: string,
  orgId: string,
  email: string,
): Promise<string> {
  // 1. Check if this user already has a customer ID stored locally
  const existing = await queryOne<{ stripe_customer_id: string }>(
    `SELECT stripe_customer_id FROM payment_method
     WHERE user_id = $1 AND organization_id = $2 AND stripe_customer_id IS NOT NULL
     LIMIT 1`,
    [userId, orgId],
  );

  if (existing?.stripe_customer_id) {
    return existing.stripe_customer_id;
  }

  // 2. Create a new Stripe Customer on the platform account
  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email,
    metadata: {
      leasebase_user_id: userId,
      leasebase_org_id: orgId,
    },
  });

  logger.info(
    { userId, orgId, customerId: customer.id },
    'Stripe Customer created on platform account',
  );

  return customer.id;
}
