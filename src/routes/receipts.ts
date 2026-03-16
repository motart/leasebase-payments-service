/**
 * Receipt endpoints.
 *
 * GET /mine/receipts       — Tenant: list own receipts
 * GET /mine/receipts/:id   — Tenant: receipt detail
 * GET /receipts            — Owner: list all org receipts (filterable)
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  requireAuth, requireRole,
  query, queryOne, NotFoundError,
  parsePagination, paginationMeta,
  type AuthenticatedRequest, UserRole,
} from '@leasebase/service-common';
import { getTenantLeaseLinks } from '../data/tenant-queries';

const router = Router();

// ── Tenant: List own receipts ────────────────────────────────────────────────

router.get('/mine/receipts', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
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
        `SELECT r.id, r.receipt_number, r.amount, r.currency, r.payment_method_summary,
                r.property_name, r.unit_number, r.billing_period, r.created_at
         FROM receipt r
         WHERE r.lease_id IN (${placeholders})
         ORDER BY r.created_at DESC
         LIMIT $${leaseIds.length + 1} OFFSET $${leaseIds.length + 2}`,
        [...leaseIds, pg.limit, offset],
      ),
      queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM receipt WHERE lease_id IN (${placeholders})`,
        leaseIds,
      ),
    ]);

    res.json({ data: rows, meta: paginationMeta(Number(countResult?.count || 0), pg) });
  } catch (err) { next(err); }
});

// ── Tenant: Receipt detail ───────────────────────────────────────────────────

router.get('/mine/receipts/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;

    const receipt = await queryOne<{
      id: string;
      lease_id: string;
      receipt_number: string;
      amount: number;
      currency: string;
      payment_method_summary: string | null;
      property_name: string | null;
      unit_number: string | null;
      billing_period: string | null;
      created_at: string;
      charge_id: string | null;
      payment_transaction_id: string;
    }>(
      `SELECT r.* FROM receipt r WHERE r.id = $1`,
      [req.params.id],
    );

    if (!receipt) throw new NotFoundError('Receipt not found');

    // Verify tenant owns the lease
    const links = await getTenantLeaseLinks(user.userId, user.orgId);
    const leaseIds = links.map((l) => l.lease_id);
    if (!leaseIds.includes(receipt.lease_id)) {
      throw new NotFoundError('Receipt not found');
    }

    res.json({ data: receipt });
  } catch (err) { next(err); }
});

// ── Owner: List all org receipts ─────────────────────────────────────────────

router.get('/receipts', requireAuth, requireRole(UserRole.OWNER), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const pg = parsePagination(req.query as Record<string, unknown>);
    const offset = (pg.page - 1) * pg.limit;

    const filters: string[] = ['r.organization_id = $1'];
    const params: unknown[] = [user.orgId];
    let paramIdx = 2;

    if (req.query.leaseId) {
      filters.push(`r.lease_id = $${paramIdx++}`);
      params.push(req.query.leaseId);
    }
    if (req.query.tenantUserId) {
      filters.push(`r.tenant_user_id = $${paramIdx++}`);
      params.push(req.query.tenantUserId);
    }

    const where = filters.join(' AND ');
    const [rows, countResult] = await Promise.all([
      query(
        `SELECT r.* FROM receipt r WHERE ${where} ORDER BY r.created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        [...params, pg.limit, offset],
      ),
      queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM receipt r WHERE ${where}`,
        params,
      ),
    ]);

    res.json({ data: rows, meta: paginationMeta(Number(countResult?.count || 0), pg) });
  } catch (err) { next(err); }
});

export { router as receiptsRouter };
