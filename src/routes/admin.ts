/**
 * Admin diagnostics and operational tooling.
 *
 * All routes require X-Internal-Service-Key (same as job routes).
 *
 * GET  /admin/status              — System overview: DB, Stripe, recent jobs
 * GET  /admin/job-executions      — Recent job execution history
 * GET  /admin/webhook-events      — Recent webhook events (filter by status)
 * POST /admin/webhook-replay/:id  — Replay a single failed webhook by stripe_event_id
 * POST /admin/webhook-replay-failed — Batch-replay all FAILED webhooks
 * GET  /admin/autopay-overview    — Autopay enrollment + attempt stats
 * GET  /admin/payment-stats       — Payment transaction aggregate stats
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { query, queryOne, getPool, logger, checkDbConnection } from '@leasebase/service-common';
import { isStripeConfigured, getStripe } from '../stripe/client';

const router = Router();
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

// ── Auth middleware (same as jobs) ────────────────────────────────────────────

function requireInternalKey(req: Request, res: Response, next: NextFunction): void {
  if (!INTERNAL_SERVICE_KEY) {
    res.status(503).json({ error: 'Internal service key not configured' });
    return;
  }
  const key = req.headers['x-internal-service-key'] as string;
  if (key !== INTERNAL_SERVICE_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

router.use(requireInternalKey);

// ── GET /admin/status ────────────────────────────────────────────────────────

router.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const dbOk = await checkDbConnection().then(() => true).catch(() => false);

    const stripeOk = isStripeConfigured();

    const recentJobs = await query<{
      job_name: string; status: string; started_at: string;
      items_processed: number; items_failed: number;
    }>(
      `SELECT job_name, status, started_at, items_processed, items_failed
       FROM job_execution ORDER BY started_at DESC LIMIT 5`,
    );

    const webhookStats = await queryOne<{
      total: string; received: string; processed: string; failed: string;
    }>(
      `SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE status = 'RECEIVED')::text AS received,
        COUNT(*) FILTER (WHERE status = 'PROCESSED')::text AS processed,
        COUNT(*) FILTER (WHERE status = 'FAILED')::text AS failed
       FROM webhook_event
       WHERE created_at > NOW() - INTERVAL '24 hours'`,
    );

    res.json({
      status: dbOk && stripeOk ? 'HEALTHY' : 'DEGRADED',
      checks: { database: dbOk, stripe_configured: stripeOk },
      recent_jobs: recentJobs,
      webhook_stats_24h: webhookStats,
      timestamp: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// ── GET /admin/job-executions ────────────────────────────────────────────────

router.get('/job-executions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const jobName = req.query.job_name as string | undefined;

    const rows = await query<{
      id: string; job_name: string; status: string;
      started_at: string; completed_at: string | null;
      items_processed: number; items_failed: number; items_skipped: number;
      error_summary: string | null; metadata: any;
    }>(
      `SELECT id, job_name, status, started_at, completed_at,
              items_processed, items_failed, items_skipped, error_summary, metadata
       FROM job_execution
       WHERE ($1::text IS NULL OR job_name = $1)
       ORDER BY started_at DESC LIMIT $2`,
      [jobName || null, limit],
    );

    res.json({ executions: rows, count: rows.length });
  } catch (err) { next(err); }
});

// ── GET /admin/webhook-events ────────────────────────────────────────────────

router.get('/webhook-events', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const status = req.query.status as string | undefined;

    const rows = await query<{
      id: string; stripe_event_id: string; event_type: string;
      status: string; retry_count: number; error_message: string | null;
      created_at: string; processed_at: string | null;
    }>(
      `SELECT id, stripe_event_id, event_type, status, retry_count, error_message, created_at, processed_at
       FROM webhook_event
       WHERE ($1::text IS NULL OR status = $1)
       ORDER BY created_at DESC LIMIT $2`,
      [status || null, limit],
    );

    res.json({ events: rows, count: rows.length });
  } catch (err) { next(err); }
});

// ── POST /admin/webhook-replay/:id ───────────────────────────────────────────

router.post('/webhook-replay/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const stripeEventId = req.params.id;

    const event = await queryOne<{
      id: string; stripe_event_id: string; payload: any; status: string; retry_count: number;
    }>(
      `SELECT id, stripe_event_id, payload, status, retry_count FROM webhook_event WHERE stripe_event_id = $1`,
      [stripeEventId],
    );

    if (!event) {
      return res.status(404).json({ error: 'Webhook event not found' });
    }

    if (event.status === 'PROCESSED') {
      return res.json({ message: 'Event already processed', status: event.status });
    }

    // Reset to RECEIVED so the handler can re-process
    await queryOne(
      `UPDATE webhook_event SET status = 'RECEIVED', error_message = NULL WHERE stripe_event_id = $1`,
      [stripeEventId],
    );

    // Re-fetch event from Stripe for fresh data
    const stripe = getStripe();
    let stripeEvent;
    try {
      stripeEvent = await stripe.events.retrieve(stripeEventId);
    } catch (err) {
      // Fall back to stored payload
      logger.warn({ err, stripeEventId }, 'Could not fetch event from Stripe, using stored payload');
      stripeEvent = event.payload;
    }

    // Dynamically import and call the handler
    const { replayWebhookEvent } = await import('../lib/webhook-replay');
    const result = await replayWebhookEvent(stripeEvent);

    res.json({
      replayed: true,
      stripe_event_id: stripeEventId,
      result,
    });
  } catch (err) { next(err); }
});

// ── POST /admin/webhook-replay-failed ────────────────────────────────────────

router.post('/webhook-replay-failed', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const maxRetries = parseInt(req.query.max_retries as string) || 3;
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);

    const failedEvents = await query<{
      id: string; stripe_event_id: string; payload: any; retry_count: number;
    }>(
      `SELECT id, stripe_event_id, payload, retry_count
       FROM webhook_event
       WHERE status = 'FAILED' AND retry_count < $1
       ORDER BY created_at ASC LIMIT $2`,
      [maxRetries, limit],
    );

    const results: Array<{ stripe_event_id: string; success: boolean; error?: string }> = [];
    const { replayWebhookEvent } = await import('../lib/webhook-replay');

    for (const evt of failedEvents) {
      try {
        await replayWebhookEvent(evt.payload);
        results.push({ stripe_event_id: evt.stripe_event_id, success: true });
      } catch (err) {
        results.push({
          stripe_event_id: evt.stripe_event_id,
          success: false,
          error: (err as Error).message,
        });
      }
    }

    res.json({
      total: failedEvents.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    });
  } catch (err) { next(err); }
});

// ── GET /admin/autopay-overview ──────────────────────────────────────────────

router.get('/autopay-overview', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const enrollmentStats = await queryOne<{
      total: string; enabled: string; disabled: string;
    }>(
      `SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE status = 'ENABLED')::text AS enabled,
        COUNT(*) FILTER (WHERE status = 'DISABLED')::text AS disabled
       FROM autopay_enrollment`,
    );

    const attemptStats = await queryOne<{
      total: string; succeeded: string; failed: string; pending: string;
    }>(
      `SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE status = 'SUCCEEDED')::text AS succeeded,
        COUNT(*) FILTER (WHERE status = 'FAILED')::text AS failed,
        COUNT(*) FILTER (WHERE status = 'PENDING')::text AS pending
       FROM autopay_attempt_log
       WHERE created_at > NOW() - INTERVAL '30 days'`,
    );

    const recentAttempts = await query<{
      id: string; charge_id: string; attempt_number: number;
      status: string; failure_reason: string | null; created_at: string;
    }>(
      `SELECT id, charge_id, attempt_number, status, failure_reason, created_at
       FROM autopay_attempt_log
       ORDER BY created_at DESC LIMIT 10`,
    );

    res.json({
      enrollment: enrollmentStats,
      attempts_30d: attemptStats,
      recent_attempts: recentAttempts,
    });
  } catch (err) { next(err); }
});

// ── GET /admin/payment-stats ─────────────────────────────────────────────────

router.get('/payment-stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = await queryOne<{
      total: string; succeeded: string; failed: string; pending: string;
      manual: string; autopay: string; total_amount: string;
    }>(
      `SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE status = 'SUCCEEDED')::text AS succeeded,
        COUNT(*) FILTER (WHERE status = 'FAILED')::text AS failed,
        COUNT(*) FILTER (WHERE status = 'PENDING')::text AS pending,
        COUNT(*) FILTER (WHERE source = 'MANUAL')::text AS manual,
        COUNT(*) FILTER (WHERE source = 'AUTOPAY')::text AS autopay,
        COALESCE(SUM(amount) FILTER (WHERE status = 'SUCCEEDED'), 0)::text AS total_amount
       FROM payment_transaction
       WHERE created_at > NOW() - INTERVAL '30 days'`,
    );

    res.json({ stats_30d: stats });
  } catch (err) { next(err); }
});

export const adminRouter = router;
