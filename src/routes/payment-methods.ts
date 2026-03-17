/**
 * Payment Method management routes.
 *
 * POST /setup-intent          — Create SetupIntent (+ Stripe Customer if needed)
 * POST /setup-intent/complete — Confirm and persist PM locally (idempotent; webhook is authoritative)
 * GET  /                      — List tenant's saved payment methods
 * PATCH /:id/default          — Set one PM as default (clears previous)
 * DELETE /:id                 — Detach PM from Stripe and mark DETACHED locally
 *
 * All routes are tenant-authenticated (requireAuth), scoped by JWT userId + orgId.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  requireAuth, validateBody,
  query, queryOne, getPool, NotFoundError,
  type AuthenticatedRequest,
  logger,
} from '@leasebase/service-common';
import { getStripe, isStripeConfigured, getPublishableKey } from '../stripe/client';
import { getOrCreateStripeCustomer } from '../lib/stripe-customers';
import { insertAuditLog } from '../lib/audit';

const router = Router();

// ── POST /setup-intent ───────────────────────────────────────────────────────

router.post(
  '/setup-intent',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isStripeConfigured()) {
        return res.status(503).json({
          error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' },
        });
      }

      const user = (req as AuthenticatedRequest).user;
      const stripe = getStripe();

      // Get or create Stripe Customer on PLATFORM account
      const customerId = await getOrCreateStripeCustomer(user.userId, user.orgId, user.email);

      // Create SetupIntent scoped to this customer
      const setupIntent = await stripe.setupIntents.create({
        customer: customerId,
        payment_method_types: ['card'],
        metadata: {
          leasebase_user_id: user.userId,
          leasebase_org_id: user.orgId,
        },
      });

      logger.info(
        { userId: user.userId, setupIntentId: setupIntent.id, customerId },
        'SetupIntent created for payment method setup',
      );

      res.status(201).json({
        data: {
          clientSecret: setupIntent.client_secret,
          setupIntentId: setupIntent.id,
          customerId,
          publishableKey: getPublishableKey(),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /setup-intent/complete ──────────────────────────────────────────────

const completeSchema = z.object({
  setupIntentId: z.string().min(1),
});

router.post(
  '/setup-intent/complete',
  requireAuth,
  validateBody(completeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isStripeConfigured()) {
        return res.status(503).json({
          error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' },
        });
      }

      const user = (req as AuthenticatedRequest).user;
      const { setupIntentId } = req.body;
      const stripe = getStripe();

      // Retrieve the SetupIntent to get the PaymentMethod
      const setupIntent = await stripe.setupIntents.retrieve(setupIntentId, {
        expand: ['payment_method'],
      });

      if (setupIntent.status !== 'succeeded') {
        return res.status(422).json({
          error: {
            code: 'SETUP_NOT_COMPLETE',
            message: `SetupIntent status is '${setupIntent.status}', expected 'succeeded'`,
          },
        });
      }

      const pm = setupIntent.payment_method;
      if (!pm || typeof pm === 'string') {
        return res.status(422).json({
          error: { code: 'NO_PAYMENT_METHOD', message: 'SetupIntent has no expanded payment method' },
        });
      }

      // Idempotent upsert: check if this PM already exists locally
      const existingPm = await queryOne<{ id: string }>(
        `SELECT id FROM payment_method WHERE stripe_payment_method_id = $1`,
        [pm.id],
      );
      if (existingPm) {
        const row = await queryOne(
          `SELECT * FROM payment_method WHERE id = $1`,
          [existingPm.id],
        );
        return res.json({ data: row });
      }

      // Extract metadata
      const card = pm.card;
      const customerId = typeof setupIntent.customer === 'string'
        ? setupIntent.customer
        : (setupIntent.customer as any)?.id ?? null;

      // Count existing methods — first method becomes default
      const countResult = await queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM payment_method
         WHERE user_id = $1 AND organization_id = $2 AND status = 'ACTIVE'`,
        [user.userId, user.orgId],
      );
      const isFirst = Number(countResult?.count || 0) === 0;

      const row = await queryOne(
        `INSERT INTO payment_method
           (organization_id, user_id, stripe_payment_method_id, stripe_customer_id,
            stripe_setup_intent_id, type, last4, brand, exp_month, exp_year,
            fingerprint, is_default, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'ACTIVE')
         ON CONFLICT (stripe_payment_method_id) DO UPDATE
           SET updated_at = NOW()
         RETURNING *`,
        [
          user.orgId,
          user.userId,
          pm.id,
          customerId,
          setupIntentId,
          pm.type,
          card?.last4 ?? null,
          card?.brand ?? null,
          card?.exp_month ?? null,
          card?.exp_year ?? null,
          card?.fingerprint ?? null,
          isFirst, // first method is automatically default
        ],
      );

      await insertAuditLog({
        organizationId: user.orgId,
        entityType: 'PAYMENT_METHOD' as any,
        entityId: (row as any).id,
        action: 'CREATED' as any,
        newStatus: 'ACTIVE',
        metadata: { stripe_payment_method_id: pm.id, type: pm.type, is_default: isFirst },
        actorType: 'USER',
        actorId: user.userId,
      });

      logger.info(
        { userId: user.userId, pmId: pm.id, type: pm.type, isDefault: isFirst },
        'Payment method saved locally',
      );

      res.status(201).json({ data: row });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET / ────────────────────────────────────────────────────────────────────

router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const rows = await query(
      `SELECT id, type, last4, brand, exp_month, exp_year, is_default, status, created_at
       FROM payment_method
       WHERE user_id = $1 AND organization_id = $2 AND status = 'ACTIVE'
       ORDER BY is_default DESC, created_at DESC`,
      [user.userId, user.orgId],
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:id/default ───────────────────────────────────────────────────────

router.patch('/:id/default', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Verify ownership + active status
      const pm = await client.query(
        `SELECT id, status FROM payment_method
         WHERE id = $1 AND user_id = $2 AND organization_id = $3
         FOR UPDATE`,
        [req.params.id, user.userId, user.orgId],
      );

      if (pm.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFoundError('Payment method not found');
      }

      if (pm.rows[0].status !== 'ACTIVE') {
        await client.query('ROLLBACK');
        return res.status(422).json({
          error: { code: 'INACTIVE_METHOD', message: 'Cannot set an inactive method as default' },
        });
      }

      // Clear previous default
      await client.query(
        `UPDATE payment_method SET is_default = false, updated_at = NOW()
         WHERE user_id = $1 AND organization_id = $2 AND is_default = true`,
        [user.userId, user.orgId],
      );

      // Set new default
      const result = await client.query(
        `UPDATE payment_method SET is_default = true, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [req.params.id],
      );

      // Update autopay enrollment if exists — point it to the new default
      await client.query(
        `UPDATE autopay_enrollment SET payment_method_id = $1, updated_at = NOW()
         WHERE user_id = $2 AND organization_id = $3 AND status = 'ENABLED'`,
        [req.params.id, user.userId, user.orgId],
      );

      await client.query('COMMIT');

      await insertAuditLog({
        organizationId: user.orgId,
        entityType: 'PAYMENT_METHOD' as any,
        entityId: req.params.id,
        action: 'STATUS_CHANGED' as any,
        newStatus: 'DEFAULT',
        actorType: 'USER',
        actorId: user.userId,
      });

      res.json({ data: result.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// ── DELETE /:id ──────────────────────────────────────────────────────────────

router.delete('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;

    // Check if method is tied to active autopay enrollment
    const activeAutopay = await queryOne<{ id: string }>(
      `SELECT id FROM autopay_enrollment
       WHERE payment_method_id = $1 AND status = 'ENABLED'`,
      [req.params.id],
    );
    if (activeAutopay) {
      return res.status(409).json({
        error: {
          code: 'AUTOPAY_ACTIVE',
          message: 'Cannot remove a payment method that is currently used for autopay. Disable autopay first.',
        },
      });
    }

    // Get the PM row
    const pm = await queryOne<{ id: string; stripe_payment_method_id: string; is_default: boolean }>(
      `SELECT id, stripe_payment_method_id, is_default FROM payment_method
       WHERE id = $1 AND user_id = $2 AND organization_id = $3 AND status = 'ACTIVE'`,
      [req.params.id, user.userId, user.orgId],
    );
    if (!pm) {
      throw new NotFoundError('Payment method not found');
    }

    // Detach from Stripe
    if (isStripeConfigured()) {
      const stripe = getStripe();
      try {
        await stripe.paymentMethods.detach(pm.stripe_payment_method_id);
      } catch (err) {
        // If already detached or not found, continue
        logger.warn({ err, pmId: pm.stripe_payment_method_id }, 'Stripe detach failed (may already be detached)');
      }
    }

    // Mark as DETACHED locally
    const row = await queryOne(
      `UPDATE payment_method
       SET status = 'DETACHED', is_default = false, detached_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id],
    );

    // If it was default, promote next active method
    if (pm.is_default) {
      await queryOne(
        `UPDATE payment_method SET is_default = true, updated_at = NOW()
         WHERE user_id = $1 AND organization_id = $2 AND status = 'ACTIVE'
         AND id != $3
         ORDER BY created_at ASC LIMIT 1`,
        [user.userId, user.orgId, req.params.id],
      );
    }

    await insertAuditLog({
      organizationId: user.orgId,
      entityType: 'PAYMENT_METHOD' as any,
      entityId: req.params.id,
      action: 'STATUS_CHANGED' as any,
      oldStatus: 'ACTIVE',
      newStatus: 'DETACHED',
      actorType: 'USER',
      actorId: user.userId,
    });

    res.json({ data: row });
  } catch (err) {
    next(err);
  }
});

export { router as paymentMethodsRouter };
