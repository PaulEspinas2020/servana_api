-- An explicit, server-controlled classification for release-smoke bookings.
--
-- TAB 04 changed locking, assignment persistence, timelines, compatibility
-- projections and state transitions. Proving that against production needs a
-- real write lifecycle, and there is nowhere else it can be proven — the whole
-- point is the behaviour of the real database under the real executor.
--
-- But production carries 109 bookings and has never recorded a completion. An
-- unmarked smoke booking reaching COMPLETED would become the platform's FIRST
-- completion: synthetic, indistinguishable from real, and the first data point
-- for completion rate, provider acceptance rate and everything downstream. The
-- marker exists so the smoke can be run without contaminating the very metrics
-- it is meant to validate.
--
-- ## Why a column and not an inference
--
-- Nothing may deduce synthetic status from an email address, a customer name, a
-- provider name or an id range. Every one of those is a heuristic that a real
-- customer can eventually collide with — a real person named "Test", an id that
-- happens to fall in a reserved band — and the failure mode is silent: real
-- revenue quietly dropped from a report. An explicit boolean cannot collide.
--
-- ## Server-controlled
--
-- DEFAULT false, NOT NULL. No client may set or change it: no request body is
-- read into this column, enforced by `tests/booking-synthetic-marker.test.ts`.
-- Only a deliberate server-side path marks a booking synthetic.
--
-- ## What it changes, and what it must NOT change
--
-- It changes accounting, reporting and external-risk treatment. It changes
-- NOTHING about lifecycle semantics: a synthetic booking runs the same
-- canonical executor, produces the same booking_workers mutations, the same
-- booking_transitions, the same booking_tracking projections and the same
-- canonicalState. A separate "test transition" path would prove nothing about
-- the code that actually runs.
--
-- Additive and defaulted, so every existing row is real by construction and no
-- shipped client is affected. No BEGIN/COMMIT — the runner wraps each migration.

ALTER TABLE servana.bookings
  ADD COLUMN IF NOT EXISTS is_synthetic BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN servana.bookings.is_synthetic IS
  'Release-smoke / test booking. Server-controlled, never client-settable. Excluded from business reporting by servana booking reporting policy; lifecycle semantics are unchanged.';

-- Partial index: the reporting predicate is `is_synthetic = false`, which
-- matches virtually every row, so an index on the common case would never be
-- used. Indexing only the rare TRUE rows makes "find the smoke bookings"
-- instant for audit, which is the one lookup that actually needs help.
CREATE INDEX IF NOT EXISTS idx_bookings_synthetic
  ON servana.bookings (id)
  WHERE is_synthetic = true;
