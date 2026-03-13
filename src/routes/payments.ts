import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  requireAuth, requireRole, validateBody,
  query, queryOne, NotFoundError,
  parsePagination, paginationMeta,
  type AuthenticatedRequest, UserRole,
  logger,
} from '@leasebase/service-common';
import { getStripe, isStripeConfigured } from '../stripe/client';

const router = Router();

const createPaymentSchema = z.object({
  leaseId: z.string().min(1),
  amount: z.number().int().min(1),
  currency: z.string().default('usd'),
  method: z.string().optional(),
  ledgerEntryId: z.string().optional(),
});

const checkoutSchema = z.object({
  returnUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

const createLedgerSchema = z.object({
  leaseId: z.string().min(1),
  type: z.enum(['CHARGE', 'PAYMENT', 'CREDIT']),
  amount: z.number().int().min(1),
  currency: z.string().default('usd'),
  dueDate: z.string(),
  description: z.string().optional(),
});

// GET / - List payments (admin only; tenants use /mine)
router.get('/', requireAuth, requireRole(UserRole.OWNER), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const pg = parsePagination(req.query as Record<string, unknown>);
    const offset = (pg.page - 1) * pg.limit;
    const [rows, countResult] = await Promise.all([
      query(`SELECT * FROM payments WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [user.orgId, pg.limit, offset]),
      queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM payments WHERE organization_id = $1`, [user.orgId]),
    ]);
    res.json({ data: rows, meta: paginationMeta(Number(countResult?.count || 0), pg) });
  } catch (err) { next(err); }
});

// POST / - Create payment (OWNER only)
router.post('/', requireAuth, requireRole(UserRole.OWNER), validateBody(createPaymentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const { leaseId, amount, currency, method, ledgerEntryId } = req.body;
      const row = await queryOne(
        `INSERT INTO payments (organization_id, lease_id, amount, currency, method, ledger_entry_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'PENDING') RETURNING *`,
        [user.orgId, leaseId, amount, currency, method || null, ledgerEntryId || null]
      );
      res.status(201).json({ data: row });
    } catch (err) { next(err); }
  }
);

// ── Tenant-scoped routes (MUST be above /:id to prevent Express param shadowing) ──

// GET /mine - Tenant's own payments (resolved via JWT → tenant_profiles → lease_id)
router.get('/mine', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const pg = parsePagination(req.query as Record<string, unknown>);
    const offset = (pg.page - 1) * pg.limit;

    // Resolve tenant's lease(s) via tenant_profiles compat view,
    // then return payments scoped to those leases within the org.
    const [rows, countResult] = await Promise.all([
      query(
        `SELECT p.id, p.organization_id, p.lease_id, p.amount, p.currency,
                p.method, p.status, p.ledger_entry_id, p.created_at, p.updated_at
         FROM payments p
         JOIN tenant_profiles tp ON p.lease_id = tp.lease_id
         JOIN public."User" u ON tp.user_id = u.id
         WHERE tp.user_id = $1 AND u."organizationId" = $2
         ORDER BY p.created_at DESC
         LIMIT $3 OFFSET $4`,
        [user.userId, user.orgId, pg.limit, offset],
      ),
      queryOne<{ count: string }>(
        `SELECT COUNT(*) as count
         FROM payments p
         JOIN tenant_profiles tp ON p.lease_id = tp.lease_id
         JOIN public."User" u ON tp.user_id = u.id
         WHERE tp.user_id = $1 AND u."organizationId" = $2`,
        [user.userId, user.orgId],
      ),
    ]);

    res.json({ data: rows, meta: paginationMeta(Number(countResult?.count || 0), pg) });
  } catch (err) { next(err); }
});

// ── POST /checkout — Stripe Checkout Session for tenant rent payment ─────────

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

      // 1. Resolve tenant's active lease via tenant_profiles → lease_service.leases
      const lease = await queryOne<{
        lease_id: string;
        monthly_rent: number;
        org_id: string;
      }>(
        `SELECT l.id AS lease_id, l.monthly_rent, l.org_id
         FROM lease_service.leases l
         JOIN tenant_profiles tp ON tp.lease_id = l.id
         WHERE tp.user_id = $1 AND l.org_id = $2 AND l.status = 'ACTIVE'`,
        [user.userId, user.orgId],
      );

      if (!lease) {
        throw new NotFoundError('No active lease found');
      }

      // 2. Get org's connected Stripe account
      const account = await queryOne<{ stripe_account_id: string }>(
        `SELECT stripe_account_id FROM payment_account WHERE org_id = $1 AND status = 'ACTIVE'`,
        [user.orgId],
      );

      if (!account) {
        return res.status(422).json({
          error: { code: 'NO_PAYMENT_ACCOUNT', message: 'Property manager has not set up payments' },
        });
      }

      // 3. Create Stripe Checkout Session via Connect (destination charge)
      const stripe = getStripe();
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: { name: 'Monthly Rent' },
              unit_amount: lease.monthly_rent,
            },
            quantity: 1,
          },
        ],
        payment_intent_data: {
          application_fee_amount: Math.round(lease.monthly_rent * 0.01),
          transfer_data: { destination: account.stripe_account_id },
        },
        success_url: returnUrl,
        cancel_url: cancelUrl,
        client_reference_id: lease.lease_id,
        metadata: {
          lease_id: lease.lease_id,
          tenant_user_id: user.userId,
          org_id: user.orgId,
        },
      });

      // 4. Record PENDING payment
      await queryOne(
        `INSERT INTO payments (organization_id, lease_id, amount, currency, method, status)
         VALUES ($1, $2, $3, 'usd', 'stripe_checkout', 'PENDING')`,
        [user.orgId, lease.lease_id, lease.monthly_rent],
      );

      logger.info(
        { leaseId: lease.lease_id, sessionId: session.id, amount: lease.monthly_rent },
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

// ── Ledger routes (MUST be above /:id to prevent Express param shadowing) ───

// GET /ledger - List ledger entries
router.get('/ledger', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const pg = parsePagination(req.query as Record<string, unknown>);
      const offset = (pg.page - 1) * pg.limit;
      const [rows, countResult] = await Promise.all([
        query(`SELECT * FROM ledger_entries WHERE organization_id = $1 ORDER BY due_date DESC LIMIT $2 OFFSET $3`,
          [user.orgId, pg.limit, offset]),
        queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM ledger_entries WHERE organization_id = $1`, [user.orgId]),
      ]);
      res.json({ data: rows, meta: paginationMeta(Number(countResult?.count || 0), pg) });
    } catch (err) { next(err); }
  }
);

// POST /ledger - Create ledger entry
router.post('/ledger', requireAuth, requireRole(UserRole.OWNER),
  validateBody(createLedgerSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const { leaseId, type, amount, currency, dueDate, description } = req.body;
      const row = await queryOne(
        `INSERT INTO ledger_entries (organization_id, lease_id, type, amount, currency, due_date, description, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING') RETURNING *`,
        [user.orgId, leaseId, type, amount, currency, dueDate, description || null]
      );
      res.status(201).json({ data: row });
    } catch (err) { next(err); }
  }
);

// ── Single-payment routes (/:id AFTER named routes) ─────────────────────────

// GET /:id
router.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const row = await queryOne(`SELECT * FROM payments WHERE id = $1 AND organization_id = $2`, [req.params.id, user.orgId]);
    if (!row) throw new NotFoundError('Payment not found');

    // TENANT must own the payment (via tenant_profiles → lease_id)
    if (user.role === UserRole.TENANT) {
      const ownership = await queryOne(
        `SELECT user_id FROM tenant_profiles WHERE user_id = $1 AND lease_id = $2`,
        [user.userId, (row as any).lease_id],
      );
      if (!ownership) throw new NotFoundError('Payment not found');
    }

    res.json({ data: row });
  } catch (err) { next(err); }
});

// PUT /:id
router.put('/:id', requireAuth, requireRole(UserRole.OWNER),
  validateBody(z.object({ status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELED']).optional(), method: z.string().optional() })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const { status, method } = req.body;
      const row = await queryOne(
        `UPDATE payments SET status = COALESCE($1, status), method = COALESCE($2, method), updated_at = NOW()
         WHERE id = $3 AND organization_id = $4 RETURNING *`,
        [status, method, req.params.id, user.orgId]
      );
      if (!row) throw new NotFoundError('Payment not found');
      res.json({ data: row });
    } catch (err) { next(err); }
  }
);

export { router as paymentsRouter };
