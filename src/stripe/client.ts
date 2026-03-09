/**
 * Stripe SDK client initialization.
 *
 * Secrets are loaded from AWS Secrets Manager via the DATABASE_SECRET_ARN pattern
 * already used in the platform. The STRIPE_SECRET_ARN env var points to a Secrets
 * Manager secret containing { secret_key, publishable_key }.
 *
 * For local dev without real Stripe credentials, the client is created with a
 * placeholder key and all Stripe calls should be guarded by `isStripeConfigured()`.
 */
import Stripe from 'stripe';
import { logger } from '@leasebase/service-common';

let stripeClient: Stripe | null = null;
let stripeSecretKey: string | null = null;
let webhookSecrets: { platform: string; connect: string } | null = null;

/**
 * Parse a Secrets Manager JSON string.
 * In ECS, secrets injected via `valueFrom` arrive as the raw JSON string.
 */
function parseSecret(raw: string | undefined): Record<string, string> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    logger.warn('Failed to parse secret JSON');
    return null;
  }
}

/**
 * Initialize the Stripe client from environment/secrets.
 * Call once at startup.
 */
export function initStripe(): void {
  const apiKeySecret = parseSecret(process.env.STRIPE_SECRET_ARN);
  const webhookSecret = parseSecret(process.env.STRIPE_WEBHOOK_SECRET_ARN);

  stripeSecretKey = apiKeySecret?.secret_key || process.env.STRIPE_SECRET_KEY || null;

  if (stripeSecretKey) {
    stripeClient = new Stripe(stripeSecretKey, {
      apiVersion: '2024-12-18.acacia',
      typescript: true,
      appInfo: {
        name: 'LeaseBase',
        version: '1.0.0',
      },
    });
    logger.info('Stripe client initialized');
  } else {
    logger.warn('Stripe secret key not configured — Stripe features disabled');
  }

  if (webhookSecret) {
    webhookSecrets = {
      platform: webhookSecret.platform_endpoint_secret || '',
      connect: webhookSecret.connect_endpoint_secret || '',
    };
  }
}

/** Get the initialized Stripe client. Throws if not configured. */
export function getStripe(): Stripe {
  if (!stripeClient) {
    throw new Error('Stripe client not initialized. Check STRIPE_SECRET_ARN configuration.');
  }
  return stripeClient;
}

/** Check if Stripe is configured (for graceful degradation in dev). */
export function isStripeConfigured(): boolean {
  return stripeClient !== null;
}

/** Get webhook signing secrets. */
export function getWebhookSecrets(): { platform: string; connect: string } {
  if (!webhookSecrets) {
    throw new Error('Stripe webhook secrets not configured. Check STRIPE_WEBHOOK_SECRET_ARN.');
  }
  return webhookSecrets;
}

/** Get the publishable key (for returning to the frontend if needed). */
export function getPublishableKey(): string | null {
  const apiKeySecret = parseSecret(process.env.STRIPE_SECRET_ARN);
  return apiKeySecret?.publishable_key || process.env.STRIPE_PUBLISHABLE_KEY || null;
}
