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

// GET / - List payments
router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
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

// POST / - Create payment
router.post('/', requireAuth, validateBody(createPaymentSchema),
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

// GET /:id
router.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const row = await queryOne(`SELECT * FROM payments WHERE id = $1 AND organization_id = $2`, [req.params.id, user.orgId]);
    if (!row) throw new NotFoundError('Payment not found');
    res.json({ data: row });
  } catch (err) { next(err); }
});

// PUT /:id
router.put('/:id', requireAuth, requireRole(UserRole.ORG_ADMIN, UserRole.PM_STAFF),
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

// GET /ledger - List ledger entries
router.get('/ledger', requireAuth, requireRole(UserRole.ORG_ADMIN, UserRole.PM_STAFF, UserRole.OWNER),
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
router.post('/ledger', requireAuth, requireRole(UserRole.ORG_ADMIN, UserRole.PM_STAFF),
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

export { router as paymentsRouter };
