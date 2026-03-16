-- payments_service schema v2 — Phase 1 Payments
-- Introduces the charge/obligation + payment_transaction separation,
-- receipt, job_execution, audit log, and Phase 1B payment_method stub.
--
-- Idempotent: safe to re-run (IF NOT EXISTS / DO NOTHING guards).
-- Run as leasebase_admin:
--   psql -h <host> -U leasebase_admin -d leasebase -f db/migrations/002_schema_v2.sql

SET search_path TO payments_service, public;

-- ── Rename legacy tables (keep for rollback safety) ─────────────────────────

ALTER TABLE IF EXISTS payments RENAME TO _legacy_payments;
ALTER TABLE IF EXISTS ledger_entries RENAME TO _legacy_ledger_entries;

-- ── payment_account: add default_fee_percent ────────────────────────────────

ALTER TABLE payment_account
  ADD COLUMN IF NOT EXISTS default_fee_percent INTEGER NOT NULL DEFAULT 100;
  -- 100 basis points = 1% platform fee

-- ── charge (obligation — what a tenant owes) ────────────────────────────────

CREATE TABLE IF NOT EXISTS charge (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id   TEXT NOT NULL,
  lease_id          TEXT NOT NULL,
  tenant_user_id    TEXT,
  type              TEXT NOT NULL DEFAULT 'RENT',
  amount            INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'usd',
  billing_period    DATE,
  due_date          TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL DEFAULT 'PENDING',
  amount_paid       INTEGER NOT NULL DEFAULT 0,
  description       TEXT,
  idempotency_key   TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_charge_org ON charge(organization_id);
CREATE INDEX IF NOT EXISTS idx_charge_lease ON charge(lease_id);
CREATE INDEX IF NOT EXISTS idx_charge_status ON charge(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_charge_due ON charge(due_date) WHERE status IN ('PENDING', 'OVERDUE');
CREATE INDEX IF NOT EXISTS idx_charge_tenant ON charge(tenant_user_id);
CREATE INDEX IF NOT EXISTS idx_charge_period ON charge(organization_id, billing_period);

-- ── payment_transaction (collection attempt) ────────────────────────────────

CREATE TABLE IF NOT EXISTS payment_transaction (
  id                         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id            TEXT NOT NULL,
  charge_id                  TEXT REFERENCES charge(id),
  lease_id                   TEXT NOT NULL,
  tenant_user_id             TEXT,
  amount                     INTEGER NOT NULL,
  currency                   TEXT NOT NULL DEFAULT 'usd',
  method                     TEXT,
  status                     TEXT NOT NULL DEFAULT 'PENDING',
  stripe_payment_intent_id   TEXT UNIQUE,
  stripe_checkout_session_id TEXT,
  stripe_charge_id           TEXT,
  failure_code               TEXT,
  failure_message            TEXT,
  application_fee_amount     INTEGER DEFAULT 0,
  idempotency_key            TEXT NOT NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_pt_org ON payment_transaction(organization_id);
CREATE INDEX IF NOT EXISTS idx_pt_charge ON payment_transaction(charge_id);
CREATE INDEX IF NOT EXISTS idx_pt_lease ON payment_transaction(lease_id);
CREATE INDEX IF NOT EXISTS idx_pt_stripe_pi ON payment_transaction(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_pt_tenant ON payment_transaction(tenant_user_id);

-- ── payment_audit_log (immutable, append-only) ──────────────────────────────

CREATE TABLE IF NOT EXISTS payment_audit_log (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id   TEXT NOT NULL,
  entity_type       TEXT NOT NULL,
  entity_id         TEXT NOT NULL,
  action            TEXT NOT NULL,
  old_status        TEXT,
  new_status        TEXT,
  metadata          JSONB DEFAULT '{}',
  actor_type        TEXT NOT NULL DEFAULT 'SYSTEM',
  actor_id          TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pal_org ON payment_audit_log(organization_id);
CREATE INDEX IF NOT EXISTS idx_pal_entity ON payment_audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_pal_created ON payment_audit_log(organization_id, created_at);

-- ── receipt (Phase 1 first-class) ───────────────────────────────────────────

CREATE SEQUENCE IF NOT EXISTS receipt_number_seq START WITH 1;

CREATE TABLE IF NOT EXISTS receipt (
  id                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id          TEXT NOT NULL,
  payment_transaction_id   TEXT NOT NULL UNIQUE REFERENCES payment_transaction(id),
  charge_id                TEXT REFERENCES charge(id),
  lease_id                 TEXT NOT NULL,
  tenant_user_id           TEXT NOT NULL,
  receipt_number           TEXT NOT NULL,
  amount                   INTEGER NOT NULL,
  currency                 TEXT NOT NULL DEFAULT 'usd',
  payment_method_summary   TEXT,
  property_name            TEXT,
  unit_number              TEXT,
  billing_period           DATE,
  sent_at                  TIMESTAMPTZ,
  email_sent_to            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_receipt_org ON receipt(organization_id);
CREATE INDEX IF NOT EXISTS idx_receipt_tenant ON receipt(tenant_user_id);
CREATE INDEX IF NOT EXISTS idx_receipt_number ON receipt(receipt_number);

-- ── job_execution (scheduler tracking) ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS job_execution (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  job_name        TEXT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'RUNNING',
  items_processed INTEGER NOT NULL DEFAULT 0,
  items_failed    INTEGER NOT NULL DEFAULT 0,
  items_skipped   INTEGER NOT NULL DEFAULT 0,
  error_summary   TEXT,
  metadata        JSONB DEFAULT '{}',
  lock_key        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_je_name_started ON job_execution(job_name, started_at DESC);

-- ── payment_method (Phase 1B stub — created empty) ──────────────────────────

CREATE TABLE IF NOT EXISTS payment_method (
  id                        TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id           TEXT NOT NULL,
  user_id                   TEXT NOT NULL,
  stripe_payment_method_id  TEXT NOT NULL UNIQUE,
  type                      TEXT NOT NULL,
  last4                     TEXT,
  brand                     TEXT,
  bank_name                 TEXT,
  is_default                BOOLEAN NOT NULL DEFAULT false,
  status                    TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pm_user ON payment_method(user_id, organization_id);
