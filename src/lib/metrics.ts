/**
 * Structured payment metrics via logger.
 *
 * Each metric is a structured log entry with:
 *  - event: machine-parseable event name
 *  - standard context fields (orgId, leaseId, chargeId, etc.)
 *  - logged at INFO level for metric events, WARN for anomalies
 *
 * These can be parsed by CloudWatch Logs Insights, Datadog, or any
 * JSON log aggregator for dashboards and alerting.
 */
import { logger } from '@leasebase/service-common';

export interface PaymentContext {
  orgId?: string;
  leaseId?: string;
  chargeId?: string;
  tenantUserId?: string;
  paymentIntentId?: string;
  transactionId?: string;
  amount?: number;
  [key: string]: unknown;
}

function emit(event: string, ctx: PaymentContext, level: 'info' | 'warn' = 'info'): void {
  const entry = { event, ...ctx };
  if (level === 'warn') {
    logger.warn(entry, `payment.${event}`);
  } else {
    logger.info(entry, `payment.${event}`);
  }
}

// ── Payment lifecycle ────────────────────────────────────────────────────────

export function metricIntentCreated(ctx: PaymentContext): void {
  emit('intent_created', ctx);
}

export function metricIntentSucceeded(ctx: PaymentContext): void {
  emit('intent_succeeded', ctx);
}

export function metricIntentFailed(ctx: PaymentContext): void {
  emit('intent_failed', ctx, 'warn');
}

export function metricIntentProcessing(ctx: PaymentContext): void {
  emit('intent_processing', ctx);
}

// ── Reconciliation ───────────────────────────────────────────────────────────

export function metricReconciliationTriggered(ctx: PaymentContext & { trigger: string; oldStatus?: string; newStatus?: string }): void {
  emit('reconciliation_triggered', ctx);
}

export function metricStaleIntentCleared(ctx: PaymentContext & { piStatus?: string }): void {
  emit('stale_intent_cleared', ctx, 'warn');
}

// ── Guardrails ───────────────────────────────────────────────────────────────

export function metricPreflightBlocked(ctx: PaymentContext & { issues: string[] }): void {
  emit('preflight_blocked', ctx);
}

export function metricCheckoutBlocked(ctx: PaymentContext & { reason: string }): void {
  emit('checkout_blocked', ctx, 'warn');
}
