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
import { getStripe, isStripeConfigured } from '../stripe/client';
import { calculateFee } from '../lib/fees';

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
          // Skip leases with no rent configured (lease is the canonical rent source)
          if (lease.rent_amount == null || lease.rent_amount <= 0) {
            skipped++;
            logger.warn(
              { leaseId: lease.lease_id, rentAmount: lease.rent_amount, unitNumber: lease.unit_number },
              'Skipping charge generation — lease has no rent amount configured',
            );
            continue;
          }

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
      lease.rent_amount,
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

// ── POST /jobs/autopay-sweep ─────────────────────────────────────────────────

interface AutopayEligibleCharge {
  charge_id: string;
  charge_amount: number;
  charge_currency: string;
  charge_status: string;
  lease_id: string;
  org_id: string;
  tenant_user_id: string;
  stripe_payment_method_id: string;
  stripe_customer_id: string;
  stripe_account_id: string;
  default_fee_percent: number;
  payment_method_id: string;
}

router.post('/autopay-sweep', requireInternalKey, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isStripeConfigured()) {
      return res.status(503).json({ error: 'Stripe not configured' });
    }

    const now = new Date();

    const outcome = await executeJob(
      'autopay-sweep',
      { triggered_at: now.toISOString() },
      async (): Promise<JobResult> => {
        // Find all charges eligible for autopay:
        // - charge is PENDING or OVERDUE
        // - charge.due_date <= NOW
        // - autopay_enrollment is ENABLED for that lease
        // - default payment method is ACTIVE
        // - no existing PENDING/PROCESSING/SUCCEEDED payment_transaction for this charge
        // - org has an active payment_account (connected account)
        const eligible = await query<AutopayEligibleCharge>(
          `SELECT
             c.id AS charge_id,
             c.amount AS charge_amount,
             c.currency AS charge_currency,
             c.status AS charge_status,
             c.lease_id,
             c.organization_id AS org_id,
             c.tenant_user_id,
             pm.stripe_payment_method_id,
             pm.stripe_customer_id,
             pm.id AS payment_method_id,
             pa.stripe_account_id,
             pa.default_fee_percent
           FROM charge c
           JOIN autopay_enrollment ae ON ae.lease_id = c.lease_id AND ae.status = 'ENABLED'
           JOIN payment_method pm ON pm.id = ae.payment_method_id AND pm.status = 'ACTIVE'
           JOIN payment_account pa ON pa.org_id = c.organization_id AND pa.status = 'ACTIVE'
           WHERE c.status IN ('PENDING', 'OVERDUE')
             AND c.due_date <= NOW()
             AND NOT EXISTS (
               SELECT 1 FROM payment_transaction pt
               WHERE pt.charge_id = c.id
                 AND pt.status IN ('PENDING', 'PROCESSING', 'SUCCEEDED')
             )
           ORDER BY c.due_date ASC`,
          [],
        );

        let processed = 0;
        let failed = 0;
        let skipped = 0;
        const errors: string[] = [];

        for (const item of eligible) {
          try {
            const created = await executeAutopaySingle(item);
            if (created) {
              processed++;
            } else {
              skipped++;
            }
          } catch (err) {
            failed++;
            errors.push(`charge=${item.charge_id}: ${(err as Error).message}`);
            logger.error(
              { err, chargeId: item.charge_id, leaseId: item.lease_id },
              'Autopay sweep failed for charge',
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

/**
 * Execute a single autopay attempt for one charge.
 * Uses row-level locking to prevent race conditions.
 */
async function executeAutopaySingle(item: AutopayEligibleCharge): Promise<boolean> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Row-level lock on charge — re-verify eligibility
    const chargeRow = await client.query(
      `SELECT id, status, amount, amount_paid
       FROM charge WHERE id = $1 FOR UPDATE`,
      [item.charge_id],
    );
    const charge = chargeRow.rows[0];

    if (!charge || charge.status === 'PAID' || charge.status === 'VOID') {
      await client.query('ROLLBACK');
      return false; // no longer eligible
    }

    // Double-check no existing successful/pending transaction
    const existingTxn = await client.query(
      `SELECT id FROM payment_transaction
       WHERE charge_id = $1 AND status IN ('PENDING', 'PROCESSING', 'SUCCEEDED')
       FOR UPDATE`,
      [item.charge_id],
    );
    if (existingTxn.rows.length > 0) {
      await client.query('ROLLBACK');
      return false; // already has an active transaction
    }

    // Create off-session PaymentIntent on PLATFORM account
    // with transfer_data.destination to connected account
    const stripe = getStripe();
    const chargeAmount = charge.amount - charge.amount_paid; // remaining balance
    const feeAmount = calculateFee(chargeAmount, item.default_fee_percent);
    const idempotencyKey = `autopay:${item.charge_id}:${Date.now()}`;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: chargeAmount,
      currency: item.charge_currency,
      customer: item.stripe_customer_id,
      payment_method: item.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      application_fee_amount: feeAmount,
      transfer_data: {
        destination: item.stripe_account_id,
      },
      metadata: {
        charge_id: item.charge_id,
        lease_id: item.lease_id,
        tenant_user_id: item.tenant_user_id,
        org_id: item.org_id,
        source: 'AUTOPAY',
      },
    }, {
      idempotencyKey,
    });

    // Insert payment_transaction (PENDING — webhook will finalize)
    const txnIdempotencyKey = `autopay-txn:${item.charge_id}:${paymentIntent.id}`;
    const txnResult = await client.query(
      `INSERT INTO payment_transaction
         (organization_id, charge_id, lease_id, tenant_user_id, amount, currency,
          method, status, stripe_payment_intent_id, application_fee_amount,
          source, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, 'CARD_AUTOPAY', 'PENDING', $7, $8, 'AUTOPAY', $9)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        item.org_id, item.charge_id, item.lease_id, item.tenant_user_id,
        chargeAmount, item.charge_currency,
        paymentIntent.id, feeAmount, txnIdempotencyKey,
      ],
    );

    if (txnResult.rows[0]) {
      // Record initial autopay attempt
      await client.query(
        `INSERT INTO autopay_attempt_log
           (organization_id, charge_id, payment_transaction_id, attempt_number, status, scheduled_at)
         VALUES ($1, $2, $3, 1, 'PENDING', NOW())`,
        [item.org_id, item.charge_id, txnResult.rows[0].id],
      );

      // Audit log
      await client.query(
        `INSERT INTO payment_audit_log
           (organization_id, entity_type, entity_id, action, new_status, metadata, actor_type)
         VALUES ($1, 'PAYMENT_TRANSACTION', $2, 'CREATED', 'PENDING', $3, 'SYSTEM')`,
        [
          item.org_id,
          txnResult.rows[0].id,
          JSON.stringify({
            source: 'AUTOPAY',
            stripe_payment_intent_id: paymentIntent.id,
            charge_id: item.charge_id,
          }),
        ],
      );
    }

    await client.query('COMMIT');

    logger.info(
      {
        chargeId: item.charge_id,
        txnId: txnResult.rows[0]?.id,
        piId: paymentIntent.id,
        amount: chargeAmount,
      },
      'Autopay PaymentIntent created for charge',
    );

    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── POST /jobs/retry-failed-autopay ──────────────────────────────────────────

router.post('/retry-failed-autopay', requireInternalKey, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isStripeConfigured()) {
      return res.status(503).json({ error: 'Stripe not configured' });
    }

    const now = new Date();

    const outcome = await executeJob(
      'retry-failed-autopay',
      { triggered_at: now.toISOString() },
      async (): Promise<JobResult> => {
        // Find failed autopay transactions eligible for retry:
        // - source = AUTOPAY
        // - status = FAILED
        // - autopay_retry_count < 3
        // - has a next_retry_at in autopay_attempt_log that is <= NOW
        // - the charge is still unpaid
        // - autopay enrollment is still ENABLED
        // Use DISTINCT ON to pick only the latest failed txn per charge,
        // preventing double-processing when multiple old FAILED txns exist.
        const retryable = await query<{
          txn_id: string;
          charge_id: string;
          lease_id: string;
          org_id: string;
          tenant_user_id: string;
          autopay_retry_count: number;
          stripe_payment_method_id: string;
          stripe_customer_id: string;
          stripe_account_id: string;
          default_fee_percent: number;
          charge_amount: number;
          charge_amount_paid: number;
          charge_currency: string;
        }>(
          `SELECT DISTINCT ON (pt.charge_id)
             pt.id AS txn_id,
             pt.charge_id,
             pt.lease_id,
             pt.organization_id AS org_id,
             pt.tenant_user_id,
             pt.autopay_retry_count,
             pm.stripe_payment_method_id,
             pm.stripe_customer_id,
             pa.stripe_account_id,
             pa.default_fee_percent,
             c.amount AS charge_amount,
             c.amount_paid AS charge_amount_paid,
             c.currency AS charge_currency
           FROM payment_transaction pt
           JOIN charge c ON c.id = pt.charge_id
           JOIN autopay_enrollment ae ON ae.lease_id = pt.lease_id AND ae.status = 'ENABLED'
           JOIN payment_method pm ON pm.id = ae.payment_method_id AND pm.status = 'ACTIVE'
           JOIN payment_account pa ON pa.org_id = pt.organization_id AND pa.status = 'ACTIVE'
           WHERE pt.source = 'AUTOPAY'
             AND pt.status = 'FAILED'
             AND pt.autopay_retry_count < 3
             AND c.status IN ('PENDING', 'OVERDUE')
             AND NOT EXISTS (
               SELECT 1 FROM payment_transaction pt2
               WHERE pt2.charge_id = pt.charge_id
                 AND pt2.status IN ('PENDING', 'PROCESSING', 'SUCCEEDED')
                 AND pt2.id != pt.id
             )
             AND EXISTS (
               SELECT 1 FROM autopay_attempt_log aal
               WHERE aal.charge_id = pt.charge_id
                 AND aal.next_retry_at IS NOT NULL
                 AND aal.next_retry_at <= NOW()
             )
           ORDER BY pt.charge_id, pt.autopay_retry_count DESC, pt.created_at DESC`,
          [],
        );

        let processed = 0;
        let failed = 0;
        let skipped = 0;
        const errors: string[] = [];

        for (const item of retryable) {
          try {
            await executeRetryAttempt(item);
            processed++;
          } catch (err) {
            failed++;
            errors.push(`txn=${item.txn_id}: ${(err as Error).message}`);
            logger.error(
              { err, txnId: item.txn_id, chargeId: item.charge_id },
              'Autopay retry failed',
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

async function executeRetryAttempt(item: {
  txn_id: string;
  charge_id: string;
  lease_id: string;
  org_id: string;
  tenant_user_id: string;
  autopay_retry_count: number;
  stripe_payment_method_id: string;
  stripe_customer_id: string;
  stripe_account_id: string;
  default_fee_percent: number;
  charge_amount: number;
  charge_amount_paid: number;
  charge_currency: string;
}): Promise<void> {
  const stripe = getStripe();
  const newRetryCount = item.autopay_retry_count + 1;
  const chargeAmount = item.charge_amount - item.charge_amount_paid;
  const feeAmount = calculateFee(chargeAmount, item.default_fee_percent);
  const idempotencyKey = `autopay-retry:${item.charge_id}:${newRetryCount}:${Date.now()}`;

  // Create new PaymentIntent for the retry
  const paymentIntent = await stripe.paymentIntents.create({
    amount: chargeAmount,
    currency: item.charge_currency,
    customer: item.stripe_customer_id,
    payment_method: item.stripe_payment_method_id,
    off_session: true,
    confirm: true,
    application_fee_amount: feeAmount,
    transfer_data: {
      destination: item.stripe_account_id,
    },
    metadata: {
      charge_id: item.charge_id,
      lease_id: item.lease_id,
      tenant_user_id: item.tenant_user_id,
      org_id: item.org_id,
      source: 'AUTOPAY',
      retry_number: String(newRetryCount),
    },
  }, {
    idempotencyKey,
  });

  // Insert new payment_transaction for this retry
  const txnIdempotencyKey = `autopay-retry-txn:${item.charge_id}:${paymentIntent.id}`;
  await queryOne(
    `INSERT INTO payment_transaction
       (organization_id, charge_id, lease_id, tenant_user_id, amount, currency,
        method, status, stripe_payment_intent_id, application_fee_amount,
        source, autopay_retry_count, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, 'CARD_AUTOPAY', 'PENDING', $7, $8, 'AUTOPAY', $9, $10)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      item.org_id, item.charge_id, item.lease_id, item.tenant_user_id,
      chargeAmount, item.charge_currency,
      paymentIntent.id, feeAmount, newRetryCount, txnIdempotencyKey,
    ],
  );

  // Record retry attempt in autopay_attempt_log
  const nextRetryAt = newRetryCount < 3 ? getRetryDate(newRetryCount) : null;
  await queryOne(
    `INSERT INTO autopay_attempt_log
       (organization_id, charge_id, payment_transaction_id, attempt_number, status, scheduled_at, next_retry_at)
     VALUES ($1, $2, $3, $4, 'PENDING', NOW(), $5)`,
    [item.org_id, item.charge_id, paymentIntent.id, newRetryCount + 1, nextRetryAt],
  );

  logger.info(
    {
      chargeId: item.charge_id,
      retryNumber: newRetryCount,
      piId: paymentIntent.id,
      amount: chargeAmount,
    },
    'Autopay retry PaymentIntent created',
  );
}

/** Compute the next retry date for the dunning schedule. */
function getRetryDate(retryCount: number): string | null {
  const delayDays = [1, 3, 5]; // after retry 1: +1d, retry 2: +3d, retry 3: +5d
  const delay = delayDays[retryCount];
  if (delay === undefined) return null;
  const next = new Date();
  next.setDate(next.getDate() + delay);
  return next.toISOString();
}

export { router as jobsRouter };
