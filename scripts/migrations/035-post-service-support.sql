-- 035 · Post-service support cases (TAB 12)
--
-- ONE additive table. `services/reviews/postServiceSupportService.ensureSupportSchema`
-- performs the same DDL lazily at first use, so whichever runs first wins and
-- the other is a no-op — the convention every tab since 029 has used, and for
-- the same reason: the code must not depend on a deploy having run a migration
-- first, and the migration must exist so a DBA can apply it deliberately.
--
-- NOT APPLIED to any database by this repository. The only reachable database is
-- production, which this work is forbidden to touch.
--
-- ── What it is for ───────────────────────────────────────────────────────────
--
-- A customer whose job went wrong needs somewhere to say so that is ATTACHED to
-- the booking. The existing support surfaces are not that:
--
--   * `support_tickets` (customerSupportService) is general contact and carries
--     no booking id, so a quality complaint raised through it arrives with no
--     way to see which visit it is about;
--   * `provider_support_cases` is a provider's own account or a job they
--     worked — a different party asking a different question.
--
-- ── Why BILLING is stored here and handled elsewhere ─────────────────────────
--
-- `routed_to` records where a case is actually handled. A BILLING category is
-- accepted, stored, and routed to the finance domain — the response names
-- POST /api/v1/bookings/:bookingId/refunds.
--
-- Handling it here would mean a second refund path with its own eligibility
-- rules beside the one `bookingPaymentService` enforces, and a refund granted
-- under different rules from the ones reconciliation checks is a break nobody
-- can close. Refusing it outright would be worse in the other direction: the
-- customer has a real problem and no button.
--
-- ── What this does NOT do ────────────────────────────────────────────────────
--
-- It does not touch `customer_reviews`, `review_moderation_cases`,
-- `review_reports` or `service_review_dimensions`. Those are the live review
-- tables from migration 012 and are unchanged by this tab; TAB 12 corrects how
-- one of them is QUERIED (see the note below) and adds nothing to any of them.
--
-- It does not backfill. There is no historical source of booking-scoped cases to
-- backfill from — the general ticket table has no booking id, which is the whole
-- reason this exists.
--
-- ── A correction this tab made, which needs no migration ─────────────────────
--
-- `customerReviewService.getBookingForReview` resolved a booking's service
-- through `service_options.service_id`, which `catalogPublicService` documents
-- as a foreign key to `service_families` — legacy coarse provenance.
-- `service_review_dimensions.service_id` REFERENCES `servana.services(id)`, the
-- Catalog V2 canonical identity. Two different id spaces, so service-specific
-- dimensions silently never matched.
--
-- The fix is in code — the query now uses `bookingCanonicalServiceSql` — and
-- needs no schema change, because the SCHEMA was always right. Only the read
-- was wrong. No stored review carries a bad service id: reviews do not store one.

BEGIN;

CREATE TABLE IF NOT EXISTS servana.booking_support_cases (
  case_id           BIGSERIAL PRIMARY KEY,
  booking_id        BIGINT       NOT NULL,
  customer_uid      VARCHAR(128) NOT NULL,
  provider_uid      VARCHAR(128),
  category          VARCHAR(40)  NOT NULL,
  severity          VARCHAR(16)  NOT NULL DEFAULT 'normal',
  routed_to         VARCHAR(16)  NOT NULL DEFAULT 'support',
  state             VARCHAR(24)  NOT NULL DEFAULT 'OPEN',
  summary           VARCHAR(200) NOT NULL,
  detail            TEXT,
  client_request_id VARCHAR(128),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_booking_support_cases_booking
  ON servana.booking_support_cases (booking_id, created_at DESC);

-- Idempotency at the database. A customer on a flaky connection retrying
-- "report a problem" must not open three cases for one complaint — a human then
-- triages the same incident three times and the customer is asked the same
-- questions twice. Partial, because a case raised without a request id is still
-- a legitimate case.
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_support_cases_request
  ON servana.booking_support_cases (customer_uid, client_request_id)
  WHERE client_request_id IS NOT NULL;

COMMENT ON TABLE servana.booking_support_cases IS
  'Post-service support cases attached to a concluded booking. Distinct from support_tickets '
  '(general contact, no booking id) and provider_support_cases (a different party). '
  'routed_to = finance means the case records a complaint the finance domain resolves.';

COMMENT ON COLUMN servana.booking_support_cases.routed_to IS
  'support | finance. A BILLING case is stored here and RESOLVED by the refund/dispute '
  'domain; this table never moves money.';


-- ── Ownership ────────────────────────────────────────────────────────────────
--
-- The deploy applies migrations as `psql -U admin`, so a table created that way
-- already belongs to `admin` and this is belt-and-braces. It is stated anyway
-- because the failure it guards against was a migration applied BY HAND as
-- `sudo -u postgres psql`: 29 of 116 tables ended up owned by `postgres`, the
-- app had no privileges on them, and provider document upload returned a bare
-- 500 for every provider until somebody read the catalog. An explicit owner
-- makes this migration correct regardless of who runs it.

ALTER TABLE servana.booking_support_cases OWNER TO admin;

COMMIT;

-- ── Verification ─────────────────────────────────────────────────────────────
--
--   SELECT column_name, data_type
--     FROM information_schema.columns
--    WHERE table_schema = 'servana' AND table_name = 'booking_support_cases'
--    ORDER BY ordinal_position;
--
-- ── Operating ────────────────────────────────────────────────────────────────
--
-- Open cases needing a human, most urgent first:
--
--   SELECT case_id, booking_id, category, severity, created_at
--     FROM servana.booking_support_cases
--    WHERE state = 'OPEN'
--    ORDER BY (severity = 'elevated') DESC, created_at ASC;
--
-- Cases routed to finance that are still open here are complaints the finance
-- domain has not resolved. They are NOT refunds in flight — check the refund
-- reviews for those:
--
--   SELECT COUNT(*) FROM servana.booking_support_cases
--    WHERE routed_to = 'finance' AND state = 'OPEN';
