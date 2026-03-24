/**
 * Stripe Connect routes.
 *
 * POST /connect/session   — Create Account Session for embedded onboarding
 * GET  /connect/status    — Get connected account status (with Stripe reconciliation)
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  requireAuth, requireRole,
  queryOne,
  type AuthenticatedRequest, UserRole,
  logger,
} from '@leasebase/service-common';
import { getStripe, isStripeConfigured, getPublishableKey } from '../stripe/client';
import { reconcilePaymentAccount } from '../lib/reconcile-payment-account';
import { metricReconciliationTriggered } from '../lib/metrics';

const router = Router();

// ── POST /connect/session — Create embedded onboarding session (Account Sessions API)

router.post(
  '/session',
  requireAuth,
  requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isStripeConfigured()) {
        return res.status(503).json({
          error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' },
        });
      }

      const user = (req as AuthenticatedRequest).user;
      const stripe = getStripe();

      // Fetch or create payment account + Stripe account
      let account = await queryOne<{ id: string; stripe_account_id: string; status: string }>(
        `SELECT id, stripe_account_id, status FROM payment_account WHERE org_id = $1`,
        [user.orgId],
      );

      if (!account) {
        const stripeAccount = await stripe.accounts.create({
          type: 'express',
          capabilities: {
            card_payments: { requested: true },
            us_bank_account_ach_payments: { requested: true },
            transfers: { requested: true },
          },
          metadata: { leasebase_org_id: user.orgId },
        });

        account = (await queryOne(
          `INSERT INTO payment_account (org_id, stripe_account_id, status)
           VALUES ($1, $2, 'ONBOARDING_INCOMPLETE') RETURNING id, stripe_account_id, status`,
          [user.orgId, stripeAccount.id],
        )) as typeof account;

        logger.info({ orgId: user.orgId, stripeAccountId: stripeAccount.id }, 'Stripe Express account created for embedded onboarding');
      }

      // Create Account Session for embedded onboarding component
      const accountSession = await stripe.accountSessions.create({
        account: account!.stripe_account_id,
        components: {
          account_onboarding: { enabled: true },
        },
      });

      logger.info(
        { event: 'payment.onboarding_session_created', orgId: user.orgId, stripeAccountId: account!.stripe_account_id },
        'payment.onboarding_session_created',
      );

      res.status(201).json({
        data: {
          clientSecret: accountSession.client_secret,
          publishableKey: getPublishableKey(),
          accountId: account!.stripe_account_id,
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
  requireRole(UserRole.OWNER),
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

      // Always reconcile with Stripe truth for accurate status
      if (account.status !== 'ACTIVE' && isStripeConfigured()) {
        const reconciled = await reconcilePaymentAccount(account, user.orgId);
        if (reconciled) {
          metricReconciliationTriggered({ orgId: user.orgId, trigger: 'connect_status', oldStatus: account.status, newStatus: reconciled.status });
          account.status = reconciled.status as typeof account.status;
          account.charges_enabled = true;
          account.payouts_enabled = true;
        }
      }

      // Fetch live requirements from Stripe for detailed status
      let currentlyDue: string[] = [];
      let pendingVerification: string[] = [];
      let disabledReason: string | null = null;

      if (isStripeConfigured()) {
        try {
          const stripe = getStripe();
          const stripeAcct = await stripe.accounts.retrieve(account.stripe_account_id);
          currentlyDue = stripeAcct.requirements?.currently_due ?? [];
          pendingVerification = stripeAcct.requirements?.pending_verification ?? [];
          disabledReason = stripeAcct.requirements?.disabled_reason ?? null;
        } catch {
          // Best-effort — return local data if Stripe call fails
        }
      }

      const isActive = account.status === 'ACTIVE';
      const isActionRequired = currentlyDue.length > 0 || account.status === 'RESTRICTED';

      logger.info(
        { event: 'payment.connect_status_checked', orgId: user.orgId, status: account.status },
        'payment.connect_status_checked',
      );

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
          currently_due: currentlyDue,
          pending_verification: pendingVerification,
          disabled_reason: disabledReason,
          is_active: isActive,
          is_action_required: isActionRequired,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

export { router as connectRouter };
