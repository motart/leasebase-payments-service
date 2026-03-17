-- payments_service schema — Phase 1B: Autopay + Payment Methods
-- Additive only. Safe to re-run (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS guards).
--
-- Run as leasebase_admin:
--   psql -h <host> -U leasebase_admin -d leasebase -f db/migrations/003_autopay_phase1b.sql

SET search_path TO payments_service, public;

-- ── payment_method: add Stripe Customer + setup tracking columns ────────────

ALTER TABLE payment_method
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_setup_intent_id TEXT,
  ADD COLUMN IF NOT EXISTS exp_month INTEGER,
  ADD COLUMN IF NOT EXISTS exp_year INTEGER,
  ADD COLUMN IF NOT EXISTS detached_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS status_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_pm_customer
  ON payment_method(stripe_customer_id);

CREATE INDEX IF NOT EXISTS idx_pm_default
  ON payment_method(user_id, organization_id) WHERE is_default = true;

-- ── autopay_enrollment (lease-scoped autopay state) ─────────────────────────

CREATE TABLE IF NOT EXISTS autopay_enrollment (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id     TEXT NOT NULL,
  lease_id            TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  payment_method_id   TEXT REFERENCES payment_method(id),
  status              TEXT NOT NULL DEFAULT 'DISABLED',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(lease_id)
);

CREATE INDEX IF NOT EXISTS idx_ae_org ON autopay_enrollment(organization_id);
CREATE INDEX IF NOT EXISTS idx_ae_user ON autopay_enrollment(user_id);
CREATE INDEX IF NOT EXISTS idx_ae_status ON autopay_enrollment(status) WHERE status = 'ENABLED';

-- ── payment_transaction: add autopay source tracking ────────────────────────

ALTER TABLE payment_transaction
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS autopay_retry_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_pt_source
  ON payment_transaction(source) WHERE source = 'AUTOPAY';

-- ── autopay_attempt_log (dunning / retry audit trail) ───────────────────────

CREATE TABLE IF NOT EXISTS autopay_attempt_log (
  id                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id          TEXT NOT NULL,
  charge_id                TEXT NOT NULL,
  payment_transaction_id   TEXT,
  attempt_number           INTEGER NOT NULL DEFAULT 1,
  scheduled_at             TIMESTAMPTZ,
  status                   TEXT NOT NULL DEFAULT 'PENDING',
  failure_reason           TEXT,
  next_retry_at            TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aal_charge ON autopay_attempt_log(charge_id);
CREATE INDEX IF NOT EXISTS idx_aal_status ON autopay_attempt_log(status) WHERE status IN ('PENDING', 'FAILED');
CREATE INDEX IF NOT EXISTS idx_aal_next_retry ON autopay_attempt_log(next_retry_at) WHERE next_retry_at IS NOT NULL AND status = 'FAILED';
