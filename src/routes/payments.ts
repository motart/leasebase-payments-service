import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  requireAuth, requireRole, validateBody,
  query, queryOne, NotFoundError,
  parsePagination, paginationMeta,
  type AuthenticatedRequest, UserRole,
} from '@leasebase/service-common';

const router = Router();

const createPaymentSchema = z.object({
  leaseId: z.string().min(1),
  amount: z.number().int().min(1),
  currency: z.string().default('usd'),
  method: z.string().optional(),
  ledgerEntryId: z.string().optional(),
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

// POST / - Create payment (admin/PM staff only)
router.post('/', requireAuth, requireRole(UserRole.ORG_ADMIN, UserRole.PM_STAFF), validateBody(createPaymentSchema),
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
