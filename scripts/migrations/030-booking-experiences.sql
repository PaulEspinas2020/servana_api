-- 030 · Booking experiences (TAB 06)
--
-- The controlled path for the schema `src/services/booking/experienceStore.ts`
-- also ensures lazily. Both are IF NOT EXISTS, so whichever runs first wins and
-- the other is a no-op — the same arrangement 026-otp-purpose.sql has with
-- `otpService.ensureOtpPurposeColumn`, and for the same reason: the code must
-- not depend on a deploy having run a migration first, and the migration must
-- exist so a DBA can apply it deliberately.
--
-- NOT APPLIED to any database by this repository. The only reachable database is
-- production, which this work is forbidden to touch.
--
-- Nothing here alters `bookings`. The codes stay in the columns they have always
-- lived in (`otp_code`, `worker_code`); this adds the evidence around them.

BEGIN;

-- ─── 1. The booking-code audit log ───────────────────────────────────────────
--
-- Simultaneously the AUDIT §63 asks for and the STATE the policy reads: the
-- newest ISSUED row dates the current code (expiry), its distance from now gates
-- a resend (cooldown), and the FAILED rows after it are the attempt count.
--
-- The code itself is NOT stored. The plaintext already lives on the booking row
-- where the compare-and-swap needs it; a second copy here would be a credential
-- in an audit table, which is what audit tables are least able to protect.

CREATE TABLE IF NOT EXISTS servana.booking_otp_events (
  id          SERIAL PRIMARY KEY,
  booking_id  INTEGER NOT NULL,
  purpose     VARCHAR(40) NOT NULL,
  event       VARCHAR(20) NOT NULL,
  actor_uid   TEXT,
  actor_role  VARCHAR(24),
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_otp_events_scope
  ON servana.booking_otp_events (booking_id, purpose, created_at DESC);

-- ─── 2. Reschedule proposals ─────────────────────────────────────────────────
--
-- One row per attempt to move a booking, ACCEPTED or REFUSED. Before this, a
-- reschedule was a bare `UPDATE bookings SET schedule` with no record of who
-- asked, what it was before, or why — so two admins moving one booking produced
-- a silent winner.
--
-- `status` also holds PENDING_PROVIDER, which is unreachable while
-- experiencePolicy.RESCHEDULE_REQUIRES_PROVIDER_ACCEPTANCE is false. It exists
-- so turning the operator's policy around later is a flag flip and a test rather
-- than a migration.

CREATE TABLE IF NOT EXISTS servana.booking_reschedule_requests (
  id                SERIAL PRIMARY KEY,
  booking_id        INTEGER NOT NULL,
  previous_schedule TIMESTAMPTZ,
  proposed_schedule TIMESTAMPTZ NOT NULL,
  reason_code       VARCHAR(40),
  reason            TEXT,
  status            VARCHAR(24) NOT NULL,
  refusal_code      VARCHAR(40),
  requested_by      TEXT,
  requested_role    VARCHAR(24) NOT NULL,
  decided_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_reschedule_booking
  ON servana.booking_reschedule_requests (booking_id, created_at DESC);

-- ─── 3. Disputes gain a canonical vocabulary ─────────────────────────────────
--
-- `booking_escalations` is NOT recreated or replaced. The admin portal reads
-- every existing column, `deriveCanonicalState` returns DISPUTED from an
-- unresolved row, and the payout hold reads the same fact. A second dispute
-- table would have given admin, provider and customer different answers to "is
-- this booking disputed?".
--
--   category        the standardized vocabulary, distinct from the legacy
--                   free-form reason_code admins have been writing.
--   opened_by_role  which seat raised it. actor_uid alone cannot say.
--   state_snapshot  the service and financial state AT OPENING (§66) — a dispute
--                   argued three weeks later is argued against a booking that
--                   has since moved.

ALTER TABLE servana.booking_escalations ADD COLUMN IF NOT EXISTS category       VARCHAR(40);
ALTER TABLE servana.booking_escalations ADD COLUMN IF NOT EXISTS opened_by_role VARCHAR(24);
ALTER TABLE servana.booking_escalations ADD COLUMN IF NOT EXISTS state_snapshot JSONB;

-- ─── 4. At most ONE unresolved dispute per booking ───────────────────────────
--
-- §66 requires duplicate prevention. The service checks first and gives the good
-- error message; this makes the check mean something when two people report the
-- same problem within a second of each other. A check followed by an insert is a
-- race with a window — §68 asks for one authoritative outcome, and only the
-- database can give it.
--
-- WARNING FOR THE APPLIER: this will FAIL if any booking already carries two
-- unresolved escalations. That is a real data condition to resolve, not a
-- constraint to drop — resolve or merge the duplicates first:
--
--   SELECT booking_id, COUNT(*) FROM servana.booking_escalations
--    WHERE resolved_at IS NULL GROUP BY booking_id HAVING COUNT(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_escalations_one_open
  ON servana.booking_escalations (booking_id)
  WHERE resolved_at IS NULL;


-- ── Ownership ────────────────────────────────────────────────────────────────
--
-- The deploy applies migrations as `psql -U admin`, so a table created that way
-- already belongs to `admin` and this is belt-and-braces. It is stated anyway
-- because the failure it guards against was a migration applied BY HAND as
-- `sudo -u postgres psql`: 29 of 116 tables ended up owned by `postgres`, the
-- app had no privileges on them, and provider document upload returned a bare
-- 500 for every provider until somebody read the catalog. An explicit owner
-- makes this migration correct regardless of who runs it.

ALTER TABLE servana.booking_otp_events OWNER TO admin;
ALTER TABLE servana.booking_reschedule_requests OWNER TO admin;

COMMIT;
