-- payments_service schema initialization
-- Idempotent: safe to re-run on existing databases (IF NOT EXISTS guards).
--
-- Run as leasebase_admin:
--   psql -h <host> -U leasebase_admin -d leasebase -f db/migrations/001_init.sql

CREATE SCHEMA IF NOT EXISTS payments_service;
SET search_path TO payments_service, public;

-- ── payments ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS payments (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id  TEXT NOT NULL,
  lease_id         TEXT NOT NULL,
  tenant_profile_id TEXT,
  ledger_entry_id  TEXT,
  amount           INTEGER NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'usd',
  method           TEXT,
  status           TEXT NOT NULL DEFAULT 'PENDING',
  stripe_payment_intent_id TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_org_id
  ON payments(organization_id);
CREATE INDEX IF NOT EXISTS idx_payments_lease_id
  ON payments(lease_id);

-- ── ledger_entries ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ledger_entries (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id  TEXT NOT NULL,
  lease_id         TEXT NOT NULL,
  type             TEXT NOT NULL,
  amount           INTEGER NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'usd',
  due_date         TIMESTAMPTZ NOT NULL,
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'PENDING',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_org_id
  ON ledger_entries(organization_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_lease_id
  ON ledger_entries(lease_id);

-- ── payment_account (Stripe Connect) ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS payment_account (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id           TEXT NOT NULL,
  stripe_account_id TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'ONBOARDING_INCOMPLETE',
  charges_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  payouts_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  capabilities     JSONB DEFAULT '{}',
  requirements     JSONB DEFAULT '{}',
  payout_schedule  JSONB DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_account_org_id
  ON payment_account(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_account_stripe_id
  ON payment_account(stripe_account_id);

-- ── webhook_event (Stripe webhook idempotency) ─────────────────────────────

CREATE TABLE IF NOT EXISTS webhook_event (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  stripe_event_id  TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  api_version      TEXT,
  stripe_account_id TEXT,
  payload          JSONB NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'RECEIVED',
  error_message    TEXT,
  processed_at     TIMESTAMPTZ,
  retry_count      INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_event_stripe_id
  ON webhook_event(stripe_event_id);
