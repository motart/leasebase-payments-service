/**
 * Webhook replay helper.
 *
 * Re-processes a Stripe event through the same handler logic as the webhook
 * endpoint, but without signature verification (since replays come from
 * the admin API, not Stripe).
 */
import type Stripe from 'stripe';
import { queryOne, logger } from '@leasebase/service-common';

/**
 * Replay a webhook event. Delegates to the platform event handler.
 *
 * The event is expected to be a full Stripe event object (either fetched
 * fresh from the Stripe API or loaded from the webhook_event table).
 *
 * Returns the processing result or throws on failure.
 */
export async function replayWebhookEvent(
  event: Stripe.Event | Record<string, any>,
): Promise<{ status: string; event_type: string }> {
  const eventId = event.id as string;
  const eventType = (event as any).type as string;

  logger.info({ eventId, eventType }, 'Replaying webhook event');

  try {
    // Dynamically import to avoid circular dependency
    const { handlePlatformEventReplay } = await import('../routes/webhooks');
    await handlePlatformEventReplay(event as Stripe.Event);

    // Mark as PROCESSED
    await queryOne(
      `UPDATE webhook_event SET status = 'PROCESSED', processed_at = NOW(), retry_count = retry_count + 1
       WHERE stripe_event_id = $1`,
      [eventId],
    );

    logger.info({ eventId, eventType }, 'Webhook event replayed successfully');
    return { status: 'PROCESSED', event_type: eventType };
  } catch (err) {
    // Mark as FAILED with error
    await queryOne(
      `UPDATE webhook_event SET status = 'FAILED', error_message = $1, retry_count = retry_count + 1
       WHERE stripe_event_id = $2`,
      [(err as Error).message, eventId],
    ).catch(() => {});

    logger.error({ err, eventId, eventType }, 'Webhook replay failed');
    throw err;
  }
}
