-- 031 · Financial ledger events (TAB 07)
--
-- The controlled path for the schema `src/services/finance/financeLedger.ts`
-- also ensures lazily, and which `adminFinanceService.ensureFinanceSchema` calls
-- at boot. Both are IF NOT EXISTS, so whichever runs first wins and the other is
-- a no-op — the same arrangement 030-booking-experiences.sql has with
-- `experienceStore.ensureExperienceSchema`, and for the same reason: the code
-- must not depend on a deploy having run a migration first, and the migration
-- must exist so a DBA can apply it deliberately.
--
-- NOT APPLIED to any database by this repository. The only reachable database is
-- production, which this work is forbidden to touch.
--
-- ── What this does NOT do ───────────────────────────────────────────────────
--
-- It does not backfill. The event log starts empty and covers money that moves
-- from here on; history stays derivable from the source rows through
-- `computeBookingFinance`, which is why the reconciliation checks that read the
-- log are written to ignore bookings that predate it rather than flagging every
-- payout ever made. Backfilling would require reconstructing occurred_at values
-- that were never recorded, and an audit log of invented timestamps is worse
-- than a short one.
--
-- It does not alter `payments`, `disbursements` or `bookings`. Those are the
-- live tables every client and every report reads; this adds the record BESIDE
-- them.

BEGIN;

-- ─── 1. The append-only financial event log ──────────────────────────────────
--
-- One row per financial fact. Amounts are NUMERIC(12,2) to match `payments` and
-- `disbursements` exactly — a ledger that stores money in a different type from
-- the tables it reconciles introduces rounding differences that then have to be
-- explained as breaks.

CREATE TABLE IF NOT EXISTS servana.finance_ledger_events (
  id                    BIGSERIAL PRIMARY KEY,
  event_key             TEXT NOT NULL,
  event_type            TEXT NOT NULL,
  booking_id            INTEGER NOT NULL,
  payment_id            INTEGER,
  disbursement_id       INTEGER,
  additional_request_id INTEGER,
  provider_uid          TEXT,
  customer_uid          TEXT,
  counterparty          TEXT NOT NULL,
  direction             TEXT NOT NULL,
  amount                NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency              TEXT NOT NULL DEFAULT 'PHP',
  economic_model        TEXT,
  reason_code           TEXT,
  processor_reference   TEXT,
  detail                JSONB,
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 2. Idempotency ──────────────────────────────────────────────────────────
--
-- THE guarantee that one financial fact produces one row. Every writer composes
-- its key from the FACT (`payment:47:captured`) and never from the attempt, so a
-- PayMongo webhook retry, a double-clicked admin approval and a scheduler tick
-- that overlaps the previous one all collide here and insert once.
--
-- A unique INDEX rather than a constraint so `ON CONFLICT (event_key)` in the
-- writer resolves against it without naming a constraint that a future rename
-- could break.

CREATE UNIQUE INDEX IF NOT EXISTS finance_ledger_event_key_uidx
  ON servana.finance_ledger_events (event_key);

CREATE INDEX IF NOT EXISTS finance_ledger_booking_idx
  ON servana.finance_ledger_events (booking_id);
CREATE INDEX IF NOT EXISTS finance_ledger_provider_idx
  ON servana.finance_ledger_events (provider_uid);
CREATE INDEX IF NOT EXISTS finance_ledger_type_idx
  ON servana.finance_ledger_events (event_type);
CREATE INDEX IF NOT EXISTS finance_ledger_occurred_idx
  ON servana.finance_ledger_events (occurred_at DESC);

-- ─── 3. Append-only, enforced by the database ────────────────────────────────
--
-- "Immutable" as a code convention means "immutable until somebody writes an
-- UPDATE". §78 asks for row-level audit of the financial record, and a record
-- that can be edited is not an audit, it is a draft.
--
-- The trigger refuses UPDATE and DELETE alike. A correction is a new
-- compensating event, which is how ledgers have always worked — and it is also
-- what makes `LEDGER_EVENT_AMOUNT_MISMATCH` actionable: the check tells an
-- operator which writer disagreed with the source row, and the fix is upstream
-- rather than a quiet edit of the evidence.

CREATE OR REPLACE FUNCTION servana.finance_ledger_events_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'finance_ledger_events is append-only: % on row % is refused. Record a compensating event instead.',
    TG_OP, COALESCE(OLD.id, NEW.id);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_finance_ledger_append_only ON servana.finance_ledger_events;

CREATE TRIGGER trg_finance_ledger_append_only
  BEFORE UPDATE OR DELETE ON servana.finance_ledger_events
  FOR EACH ROW EXECUTE FUNCTION servana.finance_ledger_events_append_only();


-- ── Ownership ────────────────────────────────────────────────────────────────
--
-- The deploy applies migrations as `psql -U admin`, so a table created that way
-- already belongs to `admin` and this is belt-and-braces. It is stated anyway
-- because the failure it guards against was a migration applied BY HAND as
-- `sudo -u postgres psql`: 29 of 116 tables ended up owned by `postgres`, the
-- app had no privileges on them, and provider document upload returned a bare
-- 500 for every provider until somebody read the catalog. An explicit owner
-- makes this migration correct regardless of who runs it.

ALTER TABLE servana.finance_ledger_events OWNER TO admin;

COMMIT;

-- ── After applying ───────────────────────────────────────────────────────────
--
-- Run the reconciliation engine once and read the report:
--
--   POST /api/admin/finance/reconciliation/run
--   GET  /api/v1/admin/finance/reconciliation
--
-- Expect INTERNAL_FIXER_JOB_WITH_PROVIDER_PAYOUT to fire for any internal fixer
-- who already has a disbursement. Those rows predate the writer-side refusal
-- added in this tab and are the historical population §73 describes; they are
-- listed so an operator can decide each one, not closed automatically.
