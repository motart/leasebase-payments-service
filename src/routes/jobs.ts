/**
 * Scheduler job endpoints — invoked by EventBridge Scheduler via internal ALB.
 *
 * POST /jobs/generate-charges  — Create rent charges for active leases
 * POST /jobs/mark-overdue      — Transition past-due charges to OVERDUE
 *
 * Auth: X-Internal-Service-Key header (not JWT).
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { query, queryOne, getPool, logger } from '@leasebase/service-common';
import { getActiveLeasesForChargeGeneration, type ActiveLeaseForBilling } from '../data/lease-queries';
import { insertAuditLog } from '../lib/audit';

const router = Router();
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

// ── Internal auth middleware ─────────────────────────────────────────────────

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

// ── Job execution framework ──────────────────────────────────────────────────

interface JobResult {
  processed: number;
  failed: number;
  skipped: number;
  errors?: string[];
}

/**
 * Execute a scheduled job with:
 *  1. PostgreSQL advisory lock (prevents concurrent runs)
 *  2. job_execution tracking (audit trail)
 *  3. Per-item error isolation
 */
async function executeJob(
  jobName: string,
  metadata: Record<string, unknown>,
  fn: () => Promise<JobResult>,
): Promise<{ executionId: string; status: string; result: JobResult } | { skipped: true }> {
  const pool = getPool();
  const lockClient = await pool.connect();

  try {
    // Acquire advisory lock keyed by job name hash — non-blocking
    const lockResult = await lockClient.query(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS acquired`,
      [jobName],
    );
    const acquired = lockResult.rows[0]?.acquired;

    if (!acquired) {
      logger.info({ jobName }, 'Advisory lock not acquired — another instance is running');
      return { skipped: true };
    }

    // Insert job_execution row
    const execRow = await queryOne<{ id: string }>(
      `INSERT INTO job_execution (job_name, status, metadata)
       VALUES ($1, 'RUNNING', $2) RETURNING id`,
      [jobName, JSON.stringify(metadata)],
    );
    const executionId = execRow!.id;

    let result: JobResult;
    let status: string;
    try {
      result = await fn();
      status = result.failed > 0 ? 'PARTIAL' : 'COMPLETED';
    } catch (err) {
      result = { processed: 0, failed: 0, skipped: 0, errors: [(err as Error).message] };
      status = 'FAILED';
      logger.error({ err, jobName, executionId }, 'Job failed');
    }

    // Update job_execution
    await queryOne(
      `UPDATE job_execution
       SET status = $1, completed_at = NOW(),
           items_processed = $2, items_failed = $3, items_skipped = $4,
           error_summary = $5
       WHERE id = $6`,
      [
        status,
        result.processed,
        result.failed,
        result.skipped,
        result.errors?.join('; ') || null,
        executionId,
      ],
    );

    logger.info({ jobName, executionId, status, ...result }, 'Job execution completed');
    return { executionId, status, result };
  } finally {
    // Release advisory lock
    await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [jobName]);
    lockClient.release();
  }
}

// ── POST /jobs/generate-charges ──────────────────────────────────────────────

router.post('/generate-charges', requireInternalKey, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const now = new Date();
    // Billing period: 1st of current month
    const billingPeriod = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const billingPeriodStr = billingPeriod.toISOString().split('T')[0]; // YYYY-MM-DD

    // Default due date: 1st of the month at midnight UTC
    const dueDate = billingPeriod.toISOString();

    const outcome = await executeJob(
      'generate-charges',
      { billing_period: billingPeriodStr, triggered_at: now.toISOString() },
      async (): Promise<JobResult> => {
        const leases = await getActiveLeasesForChargeGeneration(billingPeriod);
        let processed = 0;
        let failed = 0;
        let skipped = 0;
        const errors: string[] = [];

        for (const lease of leases) {
          try {
            const created = await createChargeForLease(lease, billingPeriodStr, dueDate);
            if (created) {
              processed++;
            } else {
              skipped++; // idempotent no-op
            }
          } catch (err) {
            failed++;
            errors.push(`lease=${lease.lease_id}: ${(err as Error).message}`);
            logger.error(
              { err, leaseId: lease.lease_id, billingPeriod: billingPeriodStr },
              'Failed to create charge for lease',
            );
          }
        }

        return { processed, failed, skipped, errors: errors.length > 0 ? errors : undefined };
      },
    );

    if ('skipped' in outcome) {
      return res.json({ skipped: true, message: 'Another instance is already running' });
    }

    res.json({
      execution_id: outcome.executionId,
      status: outcome.status,
      ...outcome.result,
    });
  } catch (err) { next(err); }
});

async function createChargeForLease(
  lease: ActiveLeaseForBilling,
  billingPeriodStr: string,
  dueDate: string,
): Promise<boolean> {
  const idempotencyKey = `${lease.lease_id}:${billingPeriodStr}:RENT`;

  const row = await queryOne<{ id: string }>(
    `INSERT INTO charge
      (organization_id, lease_id, tenant_user_id, type, amount, currency, billing_period, due_date, description, idempotency_key)
     VALUES ($1, $2, $3, 'RENT', $4, 'usd', $5::date, $6, $7, $8)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      lease.org_id,
      lease.lease_id,
      lease.tenant_user_id,
      lease.monthly_rent,
      billingPeriodStr,
      dueDate,
      `Rent for ${billingPeriodStr}`,
      idempotencyKey,
    ],
  );

  if (!row) return false; // already existed

  await insertAuditLog({
    organizationId: lease.org_id,
    entityType: 'CHARGE',
    entityId: row.id,
    action: 'CREATED',
    newStatus: 'PENDING',
    metadata: { billing_period: billingPeriodStr, lease_id: lease.lease_id, job: 'generate-charges' },
    actorType: 'SYSTEM',
  });

  return true;
}

// ── POST /jobs/mark-overdue ──────────────────────────────────────────────────

router.post('/mark-overdue', requireInternalKey, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const now = new Date();

    const outcome = await executeJob(
      'mark-overdue',
      { triggered_at: now.toISOString() },
      async (): Promise<JobResult> => {
        // Find all PENDING charges with due_date in the past
        const overdueCharges = await query<{ id: string; organization_id: string }>(
          `SELECT id, organization_id FROM charge
           WHERE status = 'PENDING' AND due_date < NOW()`,
          [],
        );

        if (overdueCharges.length === 0) {
          return { processed: 0, failed: 0, skipped: 0 };
        }

        let processed = 0;
        let failed = 0;
        const errors: string[] = [];

        for (const charge of overdueCharges) {
          try {
            await queryOne(
              `UPDATE charge SET status = 'OVERDUE', updated_at = NOW()
               WHERE id = $1 AND status = 'PENDING'`,
              [charge.id],
            );

            await insertAuditLog({
              organizationId: charge.organization_id,
              entityType: 'CHARGE',
              entityId: charge.id,
              action: 'STATUS_CHANGED',
              oldStatus: 'PENDING',
              newStatus: 'OVERDUE',
              metadata: { job: 'mark-overdue' },
              actorType: 'SYSTEM',
            });

            processed++;
          } catch (err) {
            failed++;
            errors.push(`charge=${charge.id}: ${(err as Error).message}`);
            logger.error({ err, chargeId: charge.id }, 'Failed to mark charge as overdue');
          }
        }

        return { processed, failed, skipped: 0, errors: errors.length > 0 ? errors : undefined };
      },
    );

    if ('skipped' in outcome) {
      return res.json({ skipped: true, message: 'Another instance is already running' });
    }

    res.json({
      execution_id: outcome.executionId,
      status: outcome.status,
      ...outcome.result,
    });
  } catch (err) { next(err); }
});

export { router as jobsRouter };
