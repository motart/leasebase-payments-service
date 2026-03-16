/**
 * Platform fee calculation.
 *
 * Pure function — no side effects, no Stripe calls.
 * Fee amount is calculated at collection time and stored on the payment_transaction.
 */

/**
 * Calculate the platform fee in cents.
 * @param amountCents - The charge amount in cents.
 * @param feePercent - The fee in basis points (e.g. 100 = 1%).
 * @returns Fee in cents, rounded to nearest cent.
 */
export function calculateFee(amountCents: number, feePercent: number): number {
  return Math.round((amountCents * feePercent) / 10000);
}
