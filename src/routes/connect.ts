/**
 * Stripe Connect onboarding routes.
 *
 * POST /connect/onboard   — Create/resume Express account onboarding
 * GET  /connect/status     — Get connected account status
 * POST /connect/dashboard-link — Generate Express Dashboard login link
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  requireAuth, requireRole, validateBody,
  queryOne, NotFoundError,
  type AuthenticatedRequest, UserRole,
  logger,
} from '@leasebase/service-common';
import { getStripe, isStripeConfigured } from '../stripe/client';

const router = Router();

// ── Schemas ──────────────────────────────────────────────────────────────────

const onboardSchema = z.object({
  return_url: z.string().url(),
  refresh_url: z.string().url(),
});

// ── POST /connect/onboard ────────────────────────────────────────────────────

router.post(
  '/onboard',
  requireAuth,
  requireRole(UserRole.ORG_ADMIN, UserRole.OWNER),
  validateBody(onboardSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isStripeConfigured()) {
        return res.status(503).json({
          error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' },
        });
      }

      const user = (req as AuthenticatedRequest).user;
      const { return_url, refresh_url } = req.body;
      const stripe = getStripe();

      // Check for existing payment account
      let account = await queryOne<{
        id: string;
        stripe_account_id: string;
        status: string;
      }>(
        `SELECT id, stripe_account_id, status FROM payment_account WHERE org_id = $1`,
        [user.orgId],
      );

      // If already fully active, return 409
      if (account?.status === 'ACTIVE') {
        return res.status(409).json({
          error: { code: 'ALREADY_ONBOARDED', message: 'Payment account is already active' },
          data: { status: account.status },
        });
      }

      // Create Stripe Express account if none exists
      if (!account) {
        const stripeAccount = await stripe.accounts.create({
          type: 'express',
          capabilities: {
            card_payments: { requested: true },
            us_bank_account_ach_payments: { requested: true },
            transfers: { requested: true },
          },
          metadata: {
            leasebase_org_id: user.orgId,
          },
        });

        account = (await queryOne(
          `INSERT INTO payment_account (org_id, stripe_account_id, status)
           VALUES ($1, $2, 'ONBOARDING_INCOMPLETE') RETURNING id, stripe_account_id, status`,
          [user.orgId, stripeAccount.id],
        )) as typeof account;

        logger.info({ orgId: user.orgId, stripeAccountId: stripeAccount.id }, 'Stripe Express account created');
      }

      // Generate Account Link
      const accountLink = await stripe.accountLinks.create({
        account: account!.stripe_account_id,
        return_url,
        refresh_url,
        type: 'account_onboarding',
      });

      res.status(201).json({
        data: {
          url: accountLink.url,
          expires_at: new Date(accountLink.expires_at * 1000).toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /connect/status ──────────────────────────────────────────────────────

router.get(
  '/status',
  requireAuth,
  requireRole(UserRole.ORG_ADMIN, UserRole.OWNER, UserRole.PM_STAFF),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;

      const account = await queryOne<{
        id: string;
        stripe_account_id: string;
        status: string;
        charges_enabled: boolean;
        payouts_enabled: boolean;
        capabilities: Record<string, string>;
        requirements: Record<string, unknown>;
        payout_schedule: Record<string, unknown>;
      }>(
        `SELECT id, stripe_account_id, status, charges_enabled, payouts_enabled,
                capabilities, requirements, payout_schedule
         FROM payment_account WHERE org_id = $1`,
        [user.orgId],
      );

      if (!account) {
        return res.json({
          data: { status: 'NOT_STARTED' },
        });
      }

      res.json({
        data: {
          account_id: account.id,
          stripe_account_id: account.stripe_account_id,
          status: account.status,
          charges_enabled: account.charges_enabled,
          payouts_enabled: account.payouts_enabled,
          requirements: account.requirements,
          capabilities: account.capabilities,
          default_payout_schedule: account.payout_schedule,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /connect/dashboard-link ─────────────────────────────────────────────

router.post(
  '/dashboard-link',
  requireAuth,
  requireRole(UserRole.ORG_ADMIN, UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isStripeConfigured()) {
        return res.status(503).json({
          error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' },
        });
      }

      const user = (req as AuthenticatedRequest).user;
      const stripe = getStripe();

      const account = await queryOne<{ stripe_account_id: string }>(
        `SELECT stripe_account_id FROM payment_account WHERE org_id = $1`,
        [user.orgId],
      );

      if (!account) {
        throw new NotFoundError('No payment account found for this organization');
      }

      const loginLink = await stripe.accounts.createLoginLink(account.stripe_account_id);

      res.json({ data: { url: loginLink.url } });
    } catch (err) {
      next(err);
    }
  },
);

export { router as connectRouter };
