-- 036 · The six objects and three columns nothing in this repository created (TAB 02)
--
-- ── Why these six and not the other 148 ──────────────────────────────────────
--
-- `npm run schema:authority` splits the 154 runtime DDL statements the older
-- `ddl:inventory` reported as "not owned by a migration" into two very different
-- groups. 148 of them touch an object `scripts/baseline/000-baseline.sql`
-- already declares — that baseline is production's own pg_dump, and
-- `db:verify:embedded` proves a fresh database reaches the current schema by
-- restoring it and applying pending migrations on top. Those statements are
-- redundant and can simply be DELETED when TAB 02 revokes DDL privileges.
--
-- These six could not be, because nothing in the repository builds them. They
-- exist only where this unreleased code has already run, and they are absent
-- from production's dump — so on deploy the application would create them
-- itself, at runtime, on the booking write path. That is the exact behaviour
-- TAB 02 exists to remove, and it fails outright once the application role
-- loses DDL rights.
--
-- ── Fingerprints, not designs ────────────────────────────────────────────────
--
-- Every definition below is copied from the runtime statement it replaces, column
-- for column and default for default, so that applying this migration to a
-- database the application has ALREADY bootstrapped is a genuine no-op rather
-- than a divergence. The sources:
--
--   booking_transitions, idx_booking_transitions_booking,
--   booking_transition_idempotency   src/services/booking/transitionExecutor.ts
--   booking_evidence,
--   idx_booking_evidence_booking_worker   src/services/bookingEvidenceService.ts
--   worker_onboarding                     src/services/technicianService.ts
--   booking_workers cancellation columns  src/services/technicianService.ts
--
-- Do not "improve" a type here. A wider column or an added NOT NULL would make
-- this migration disagree with a database the runtime path already built, and
-- the disagreement would only surface on the one host that matters.
--
-- ── NOT APPLIED by this repository ───────────────────────────────────────────
--
-- The only reachable database is production. This file is authored, gated and
-- committed; applying it is a separate, human-authorised step.
--
-- ⚠ SEQUENCING. The runtime DDL for these objects is deliberately STILL IN
-- PLACE. Deleting it before this migration is applied to production would make
-- booking transitions depend on a migration that has not run — the failure mode
-- migration 034's header warns about, on the booking write path. Order is:
-- apply 036 → verify → then delete the runtime calls in a separate commit.

BEGIN;

-- ── Booking transitions: the canonical state-change ledger ───────────────────
--
-- `state_changed` distinguishes a real move from an event-only action where
-- from_state and to_state are equal by design. Without it two COMPLETED rows
-- read as a booking that completed twice.

CREATE TABLE IF NOT EXISTS servana.booking_transitions (
  id             BIGSERIAL PRIMARY KEY,
  booking_id     INTEGER     NOT NULL,
  action         TEXT        NOT NULL,
  from_state     TEXT        NOT NULL,
  to_state       TEXT        NOT NULL,
  actor_role     TEXT        NOT NULL,
  actor_uid      TEXT,
  provider_uid   TEXT,
  reason         TEXT,
  metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  correlation_id TEXT,
  state_changed  BOOLEAN     NOT NULL DEFAULT TRUE,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_transitions_booking
  ON servana.booking_transitions (booking_id, occurred_at);

-- ── Transition idempotency ───────────────────────────────────────────────────
--
-- The primary key is what makes a retried transition a replay rather than a
-- second state change. `request_digest` is what makes a REUSED key carrying a
-- DIFFERENT payload a conflict rather than somebody else's answer returned to
-- the wrong caller.

CREATE TABLE IF NOT EXISTS servana.booking_transition_idempotency (
  actor_uid       TEXT        NOT NULL,
  booking_id      INTEGER     NOT NULL,
  action          TEXT        NOT NULL,
  idempotency_key TEXT        NOT NULL,
  request_digest  TEXT        NOT NULL,
  result          JSONB       NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (actor_uid, booking_id, action, idempotency_key)
);

-- ── Booking evidence ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS servana.booking_evidence (
  id               SERIAL PRIMARY KEY,
  booking_id       INTEGER     NOT NULL,
  worker_uid       TEXT        NOT NULL,
  requirement_code VARCHAR(60) NOT NULL,
  stage            VARCHAR(30) NOT NULL,
  file_url         TEXT        NOT NULL,
  mime_type        VARCHAR(60) NOT NULL,
  bytes            INTEGER     NOT NULL,
  state            VARCHAR(20) NOT NULL DEFAULT 'UPLOADED',
  review_note      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at       TIMESTAMPTZ
);

-- Every read is "this booking, this provider".
CREATE INDEX IF NOT EXISTS idx_booking_evidence_booking_worker
  ON servana.booking_evidence (booking_id, worker_uid);

-- ── Worker onboarding ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS servana.worker_onboarding (
  worker_uid      TEXT PRIMARY KEY,
  status          TEXT        NOT NULL DEFAULT 'pending',
  current_step    TEXT        NOT NULL DEFAULT 'personal_info',
  completed_steps JSONB       NOT NULL DEFAULT '[]',
  step_data       JSONB       NOT NULL DEFAULT '{}',
  submitted_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── booking_workers: the cancellation columns 027 left behind ────────────────
--
-- `technicianService.ensureCancellationColumns` adds these at runtime and its own
-- comment says they are "queued for a real migration alongside 027's arrival
-- columns". 027 shipped the arrival columns and these were not included, so they
-- are the one part of the provider-cancel path whose schema is still created by
-- the request that uses it. Additive and nullable: no backfill, and a row that
-- predates them reads as never cancelled, which is correct.

ALTER TABLE servana.booking_workers
  ADD COLUMN IF NOT EXISTS cancelled_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_reason_code VARCHAR(60),
  ADD COLUMN IF NOT EXISTS cancellation_note        TEXT;

COMMENT ON TABLE servana.booking_transitions IS
  'Canonical ledger of booking state changes, written only by '
  'services/booking/transitionExecutor. state_changed=false marks an event-only '
  'action where from_state equals to_state by design.';

COMMENT ON TABLE servana.booking_transition_idempotency IS
  'Replay guard for booking transitions. A reused key with a different '
  'request_digest is a conflict, not a replay.';

-- ── Ownership ────────────────────────────────────────────────────────────────
--
-- Required from migration 029 onward. The deploy applies migrations as
-- `psql -U admin`, so this is belt-and-braces — but on 2026-08-10 provider
-- document upload returned a bare 500 for every provider because 29 of 116
-- tables had been created by hand as `sudo -u postgres psql` and the app had no
-- privileges on them. An explicit owner makes this correct regardless of who
-- runs it.

ALTER TABLE servana.booking_transitions            OWNER TO admin;
ALTER TABLE servana.booking_transition_idempotency OWNER TO admin;
ALTER TABLE servana.booking_evidence               OWNER TO admin;
ALTER TABLE servana.worker_onboarding              OWNER TO admin;

COMMIT;

-- ── Verification ─────────────────────────────────────────────────────────────
--
-- All four tables present and owned by admin:
--
--   SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
--     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'servana'
--      AND c.relname IN ('booking_transitions','booking_transition_idempotency',
--                        'booking_evidence','worker_onboarding')
--    ORDER BY c.relname;
--
-- Expected: four rows, owner `admin` on each.
--
-- The three cancellation columns:
--
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_schema = 'servana' AND table_name = 'booking_workers'
--      AND column_name LIKE 'cancel%'
--    ORDER BY column_name;
--
-- Expected: cancellation_note, cancellation_reason_code, cancelled_at — all YES.
--
-- ── After applying ───────────────────────────────────────────────────────────
--
-- Only then remove the runtime DDL these replace, and lower the budgets in
-- tests/schema-authority.test.ts and tests/runtime-ddl-budget.test.ts in the
-- same commit. `npm run schema:authority` should report UNMANAGED 0.
