import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  requireAuth, requireRole, validateBody,
  query, queryOne, NotFoundError,
  parsePagination, paginationMeta,
  type AuthenticatedRequest, UserRole,
  logger,
} from '@leasebase/service-common';
import { getStripe, isStripeConfigured, getPublishableKey } from '../stripe/client';
import { getActiveLeaseForTenant } from '../data/lease-queries';
import { getTenantLeaseLinks, tenantOwnsLease } from '../data/tenant-queries';
import { insertAuditLog } from '../lib/audit';
import { calculateFee } from '../lib/fees';

const router = Router();

// ── Schemas ──────────────────────────────────────────────────────────────────

const checkoutSchema = z.object({
  returnUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

const createChargeSchema = z.object({
  leaseId: z.string().min(1),
  type: z.enum(['RENT', 'SECURITY_DEPOSIT', 'LATE_FEE', 'OTHER']).default('RENT'),
  amount: z.number().int().min(1),
  currency: z.string().default('usd'),
  dueDate: z.string(),
  billingPeriod: z.string().optional(),
  description: z.string().optional(),
});

// ── Owner: List payment transactions ─────────────────────────────────────────

router.get('/', requireAuth, requireRole(UserRole.OWNER), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const pg = parsePagination(req.query as Record<string, unknown>);
    const offset = (pg.page - 1) * pg.limit;
    const [rows, countResult] = await Promise.all([
      query(
        `SELECT pt.*, c.billing_period, c.type AS charge_type, c.due_date AS charge_due_date
         FROM payment_transaction pt
         LEFT JOIN charge c ON pt.charge_id = c.id
         WHERE pt.organization_id = $1${req.query.source ? ' AND pt.source = $4' : ''}
         ORDER BY pt.created_at DESC LIMIT $2 OFFSET $3`,
        req.query.source
          ? [user.orgId, pg.limit, offset, req.query.source]
          : [user.orgId, pg.limit, offset],
      ),
      queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM payment_transaction WHERE organization_id = $1`,
        [user.orgId],
      ),
    ]);
    res.json({ data: rows, meta: paginationMeta(Number(countResult?.count || 0), pg) });
  } catch (err) { next(err); }
});

// ── Owner: List charges ──────────────────────────────────────────────────────

router.get('/charges', requireAuth, requireRole(UserRole.OWNER), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const pg = parsePagination(req.query as Record<string, unknown>);
    const offset = (pg.page - 1) * pg.limit;

    const filters: string[] = ['c.organization_id = $1'];
    const params: unknown[] = [user.orgId];
    let paramIdx = 2;

    if (req.query.status) {
      filters.push(`c.status = $${paramIdx++}`);
      params.push(req.query.status);
    }
    if (req.query.leaseId) {
      filters.push(`c.lease_id = $${paramIdx++}`);
      params.push(req.query.leaseId);
    }

    const where = filters.join(' AND ');
    const [rows, countResult] = await Promise.all([
      query(
        `SELECT * FROM charge c WHERE ${where} ORDER BY c.due_date DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        [...params, pg.limit, offset],
      ),
      queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM charge c WHERE ${where}`,
        params,
      ),
    ]);
    res.json({ data: rows, meta: paginationMeta(Number(countResult?.count || 0), pg) });
  } catch (err) { next(err); }
});

// ── Owner: Create manual charge ──────────────────────────────────────────────

router.post('/charges', requireAuth, requireRole(UserRole.OWNER), validateBody(createChargeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const { leaseId, type, amount, currency, dueDate, billingPeriod, description } = req.body;

      const idempotencyKey = `${leaseId}:${billingPeriod || dueDate}:${type}:manual`;

      const row = await queryOne(
        `INSERT INTO charge (organization_id, lease_id, type, amount, currency, due_date, billing_period, description, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [user.orgId, leaseId, type, amount, currency, dueDate, billingPeriod || null, description || null, idempotencyKey],
      );

      if (!row) {
        return res.status(409).json({ error: { code: 'DUPLICATE_CHARGE', message: 'Charge already exists for this period' } });
      }

      await insertAuditLog({
        organizationId: user.orgId,
        entityType: 'CHARGE',
        entityId: (row as any).id,
        action: 'CREATED',
        newStatus: 'PENDING',
        actorType: 'USER',
        actorId: user.userId,
      });

      res.status(201).json({ data: row });
    } catch (err) { next(err); }
  },
);

// ── Owner: Void a pending charge ─────────────────────────────────────────────

router.put('/charges/:id/void', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne(
        `UPDATE charge SET status = 'VOID', updated_at = NOW()
         WHERE id = $1 AND organization_id = $2 AND status IN ('PENDING', 'OVERDUE')
         RETURNING *`,
        [req.params.id, user.orgId],
      );
      if (!row) throw new NotFoundError('Charge not found or cannot be voided');

      await insertAuditLog({
        organizationId: user.orgId,
        entityType: 'CHARGE',
        entityId: req.params.id,
        action: 'VOIDED',
        newStatus: 'VOID',
        actorType: 'USER',
        actorId: user.userId,
      });

      res.json({ data: row });
    } catch (err) { next(err); }
  },
);

// ── Tenant: List own payment transactions ────────────────────────────────────

router.get('/mine', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const pg = parsePagination(req.query as Record<string, unknown>);
    const offset = (pg.page - 1) * pg.limit;

    const links = await getTenantLeaseLinks(user.userId, user.orgId);
    if (links.length === 0) {
      return res.json({ data: [], meta: paginationMeta(0, pg) });
    }

    const leaseIds = links.map((l) => l.lease_id);
    const placeholders = leaseIds.map((_, i) => `$${i + 1}`).join(',');

    const [rows, countResult] = await Promise.all([
      query(
        `SELECT pt.*, c.billing_period, c.type AS charge_type
         FROM payment_transaction pt
         LEFT JOIN charge c ON pt.charge_id = c.id
         WHERE pt.lease_id IN (${placeholders})
         ORDER BY pt.created_at DESC
         LIMIT $${leaseIds.length + 1} OFFSET $${leaseIds.length + 2}`,
        [...leaseIds, pg.limit, offset],
      ),
      queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM payment_transaction WHERE lease_id IN (${placeholders})`,
        leaseIds,
      ),
    ]);

    res.json({ data: rows, meta: paginationMeta(Number(countResult?.count || 0), pg) });
  } catch (err) { next(err); }
});

// ── Tenant: List own charges ─────────────────────────────────────────────────

router.get('/mine/charges', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const pg = parsePagination(req.query as Record<string, unknown>);
    const offset = (pg.page - 1) * pg.limit;

    const links = await getTenantLeaseLinks(user.userId, user.orgId);
    if (links.length === 0) {
      return res.json({ data: [], meta: paginationMeta(0, pg) });
    }

    const leaseIds = links.map((l) => l.lease_id);
    const placeholders = leaseIds.map((_, i) => `$${i + 1}`).join(',');

    const [rows, countResult] = await Promise.all([
      query(
        `SELECT * FROM charge WHERE lease_id IN (${placeholders}) ORDER BY due_date DESC LIMIT $${leaseIds.length + 1} OFFSET $${leaseIds.length + 2}`,
        [...leaseIds, pg.limit, offset],
      ),
      queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM charge WHERE lease_id IN (${placeholders})`,
        leaseIds,
      ),
    ]);

    res.json({ data: rows, meta: paginationMeta(Number(countResult?.count || 0), pg) });
  } catch (err) { next(err); }
});

// ── Tenant: Stripe Checkout for rent payment ─────────────────────────────────

router.post(
  '/checkout',
  requireAuth,
  requireRole(UserRole.TENANT),
  validateBody(checkoutSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isStripeConfigured()) {
        return res.status(503).json({
          error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' },
        });
      }

      const user = (req as AuthenticatedRequest).user;
      const { returnUrl, cancelUrl } = req.body;

      // 1. Resolve tenant → active lease (via abstraction seam)
      const lease = await getActiveLeaseForTenant(user.userId, user.orgId);
      if (!lease) {
        throw new NotFoundError('No active lease found');
      }

      // Guard: lease has no rent configured (lease is the canonical rent source)
      if (lease.rent_amount == null || lease.rent_amount <= 0) {
        logger.warn(
          { leaseId: lease.lease_id, rentAmount: lease.rent_amount },
          'Checkout blocked — lease has no rent amount configured',
        );
        return res.status(422).json({
          error: {
            code: 'NO_RENT_CONFIGURED',
            message: 'Rent amount is not configured for this lease. Contact your property owner.',
          },
        });
      }

      // 2. Find or create PENDING charge for current billing period
      const now = new Date();
      const billingPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const idempotencyKey = `${lease.lease_id}:${billingPeriod}:RENT`;

      let charge = await queryOne<{ id: string; amount: number; status: string }>(
        `SELECT id, amount, status FROM charge WHERE idempotency_key = $1`,
        [idempotencyKey],
      );

      if (!charge) {
        charge = await queryOne<{ id: string; amount: number; status: string }>(
          `INSERT INTO charge (organization_id, lease_id, tenant_user_id, type, amount, currency, billing_period, due_date, idempotency_key, description)
           VALUES ($1, $2, $3, 'RENT', $4, 'usd', $5::date, $5::date, $6, $7)
           ON CONFLICT (idempotency_key) DO UPDATE SET id = charge.id
           RETURNING id, amount, status`,
          [user.orgId, lease.lease_id, user.userId, lease.rent_amount, billingPeriod, idempotencyKey, `Rent for ${billingPeriod}`],
        );

        await insertAuditLog({
          organizationId: user.orgId,
          entityType: 'CHARGE',
          entityId: charge!.id,
          action: 'CREATED',
          newStatus: 'PENDING',
          actorType: 'SYSTEM',
        });
      }

      // Guard: charge already paid
      if (charge!.status === 'PAID') {
        return res.status(409).json({
          error: { code: 'ALREADY_PAID', message: 'This charge has already been paid' },
        });
      }

      // Guard: payment already in progress
      const existingTxn = await queryOne<{ id: string }>(
        `SELECT id FROM payment_transaction
         WHERE charge_id = $1 AND status IN ('PENDING', 'PROCESSING')`,
        [charge!.id],
      );
      if (existingTxn) {
        return res.status(409).json({
          error: { code: 'PAYMENT_IN_PROGRESS', message: 'A payment is already in progress for this charge' },
        });
      }

      // 3. Get org's connected Stripe account + fee config
      const account = await queryOne<{ stripe_account_id: string; default_fee_percent: number }>(
        `SELECT stripe_account_id, default_fee_percent FROM payment_account WHERE org_id = $1 AND status = 'ACTIVE'`,
        [user.orgId],
      );
      if (!account) {
        return res.status(422).json({
          error: { code: 'NO_PAYMENT_ACCOUNT', message: 'The property owner has not enabled payments yet. Contact them for assistance.' },
        });
      }

      // Phase 1: amount is always charge.amount (no partial payments)
      const chargeAmount = charge!.amount;
      const feeAmount = calculateFee(chargeAmount, account.default_fee_percent);
      const txnIdempotencyKey = `txn:${charge!.id}:${Date.now()}`;

      // 4. Create Stripe Checkout Session (destination charge)
      const stripe = getStripe();
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: { name: 'Monthly Rent' },
              unit_amount: chargeAmount,
            },
            quantity: 1,
          },
        ],
        payment_intent_data: {
          application_fee_amount: feeAmount,
          transfer_data: { destination: account.stripe_account_id },
        },
        success_url: returnUrl,
        cancel_url: cancelUrl,
        client_reference_id: lease.lease_id,
        metadata: {
          charge_id: charge!.id,
          lease_id: lease.lease_id,
          tenant_user_id: user.userId,
          org_id: user.orgId,
        },
      });

      // 5. Create payment_transaction (PENDING)
      const txn = await queryOne<{ id: string }>(
        `INSERT INTO payment_transaction
          (organization_id, charge_id, lease_id, tenant_user_id, amount, currency, method, status,
           stripe_checkout_session_id, application_fee_amount, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, 'usd', 'STRIPE_CHECKOUT', 'PENDING', $6, $7, $8)
         RETURNING id`,
        [user.orgId, charge!.id, lease.lease_id, user.userId, chargeAmount, session.id, feeAmount, txnIdempotencyKey],
      );

      await insertAuditLog({
        organizationId: user.orgId,
        entityType: 'PAYMENT_TRANSACTION',
        entityId: txn!.id,
        action: 'CREATED',
        newStatus: 'PENDING',
        metadata: { stripe_checkout_session_id: session.id, charge_id: charge!.id },
        actorType: 'USER',
        actorId: user.userId,
      });

      logger.info(
        { chargeId: charge!.id, txnId: txn!.id, sessionId: session.id, amount: chargeAmount },
        'Stripe Checkout Session created for tenant rent payment',
      );

      res.status(201).json({
        data: {
          checkoutUrl: session.url,
          sessionId: session.id,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── Owner: Get Stripe publishable key ────────────────────────────────────────

router.get('/connect/publishable-key', requireAuth, requireRole(UserRole.OWNER),
  (_req: Request, res: Response) => {
    const key = getPublishableKey();
    if (!key) {
      return res.status(503).json({ error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe publishable key not available' } });
    }
    res.json({ data: { publishableKey: key } });
  },
);

// ── Single payment transaction by ID ─────────────────────────────────────────

router.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const row = await queryOne(
      `SELECT pt.*, c.billing_period, c.type AS charge_type
       FROM payment_transaction pt
       LEFT JOIN charge c ON pt.charge_id = c.id
       WHERE pt.id = $1 AND pt.organization_id = $2`,
      [req.params.id, user.orgId],
    );
    if (!row) throw new NotFoundError('Payment transaction not found');

    // TENANT must own the payment via lease
    if (user.role === UserRole.TENANT) {
      const owns = await tenantOwnsLease(user.userId, (row as any).lease_id);
      if (!owns) throw new NotFoundError('Payment transaction not found');
    }

    res.json({ data: row });
  } catch (err) { next(err); }
});

export { router as paymentsRouter };
