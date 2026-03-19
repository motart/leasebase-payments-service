/**
 * Autopay enrollment routes.
 *
 * GET  /  — Get autopay enrollment for tenant's active lease
 * PATCH / — Enable or disable autopay (requires active default payment method)
 *
 * Autopay is lease-scoped: each lease has at most one enrollment row.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  requireAuth, validateBody,
  queryOne,
  type AuthenticatedRequest,
  logger,
} from '@leasebase/service-common';
import { getActiveLeaseForTenant } from '../data/lease-queries';
import { insertAuditLog } from '../lib/audit';

const router = Router();

// ── GET / — Get autopay status ───────────────────────────────────────────────

router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;

    // Resolve tenant → active lease
    const lease = await getActiveLeaseForTenant(user.userId, user.orgId);
    if (!lease) {
      return res.json({
        data: { enabled: false, lease_id: null, payment_method: null },
      });
    }

    // Get enrollment
    const enrollment = await queryOne<{
      id: string;
      status: string;
      payment_method_id: string | null;
      lease_id: string;
    }>(
      `SELECT ae.id, ae.status, ae.payment_method_id, ae.lease_id
       FROM autopay_enrollment ae
       WHERE ae.lease_id = $1 AND ae.user_id = $2`,
      [lease.lease_id, user.userId],
    );

    // Get default payment method info
    const defaultPm = await queryOne<{
      id: string;
      type: string;
      last4: string | null;
      brand: string | null;
    }>(
      `SELECT id, type, last4, brand FROM payment_method
       WHERE user_id = $1 AND organization_id = $2 AND is_default = true AND status = 'ACTIVE'`,
      [user.userId, user.orgId],
    );

    res.json({
      data: {
        enabled: enrollment?.status === 'ENABLED',
        status: enrollment?.status ?? 'DISABLED',
        lease_id: lease.lease_id,
        enrollment_id: enrollment?.id ?? null,
        payment_method: defaultPm ? {
          id: defaultPm.id,
          type: defaultPm.type,
          last4: defaultPm.last4,
          brand: defaultPm.brand,
        } : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── PATCH / — Enable or disable autopay ──────────────────────────────────────

const updateSchema = z.object({
  enabled: z.boolean(),
});

router.patch('/', requireAuth, validateBody(updateSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const { enabled } = req.body;

      // Resolve tenant → active lease
      const lease = await getActiveLeaseForTenant(user.userId, user.orgId);
      if (!lease) {
        return res.status(404).json({
          error: { code: 'NO_ACTIVE_LEASE', message: 'No active lease found' },
        });
      }

      if (enabled) {
        // Require a default payment method to enable autopay
        const defaultPm = await queryOne<{ id: string }>(
          `SELECT id FROM payment_method
           WHERE user_id = $1 AND organization_id = $2 AND is_default = true AND status = 'ACTIVE'`,
          [user.userId, user.orgId],
        );

        if (!defaultPm) {
          return res.status(422).json({
            error: {
              code: 'NO_DEFAULT_METHOD',
              message: 'You must set a default payment method before enabling autopay',
            },
          });
        }

        // Upsert enrollment
        const row = await queryOne(
          `INSERT INTO autopay_enrollment
             (organization_id, lease_id, user_id, payment_method_id, status)
           VALUES ($1, $2, $3, $4, 'ENABLED')
           ON CONFLICT (lease_id) DO UPDATE
             SET status = 'ENABLED', payment_method_id = $4, updated_at = NOW()
           RETURNING *`,
          [user.orgId, lease.lease_id, user.userId, defaultPm.id],
        );

        await insertAuditLog({
          organizationId: user.orgId,
          entityType: 'CHARGE' as any, // reuse closest entity type
          entityId: lease.lease_id,
          action: 'STATUS_CHANGED' as any,
          newStatus: 'AUTOPAY_ENABLED',
          metadata: { payment_method_id: defaultPm.id },
          actorType: 'USER',
          actorId: user.userId,
        });

        logger.info(
          { userId: user.userId, leaseId: lease.lease_id, pmId: defaultPm.id },
          'Autopay enabled for lease',
        );

        return res.json({ data: row });
      }

      // Disable autopay
      const row = await queryOne(
        `UPDATE autopay_enrollment
         SET status = 'DISABLED', updated_at = NOW()
         WHERE lease_id = $1 AND user_id = $2
         RETURNING *`,
        [lease.lease_id, user.userId],
      );

      if (row) {
        await insertAuditLog({
          organizationId: user.orgId,
          entityType: 'CHARGE' as any,
          entityId: lease.lease_id,
          action: 'STATUS_CHANGED' as any,
          newStatus: 'AUTOPAY_DISABLED',
          actorType: 'USER',
          actorId: user.userId,
        });
      }

      logger.info(
        { userId: user.userId, leaseId: lease.lease_id },
        'Autopay disabled for lease',
      );

      res.json({
        data: row ?? { status: 'DISABLED', lease_id: lease.lease_id },
      });
    } catch (err) {
      next(err);
    }
  },
);

export { router as autopayRouter };
