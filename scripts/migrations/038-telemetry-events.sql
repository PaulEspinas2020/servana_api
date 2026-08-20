-- Worker-app telemetry events (TAB 06).
--
-- Additive only: one new table, no change to any existing one. The previous
-- build tolerates this schema completely, which is what keeps it inside the
-- expand-migrate-contract rule and what lets a rollback restore the old dist
-- without touching the database.
--
-- ── Why the data lives here and not with a third party ──────────────────────
--
-- docs/TELEMETRY_DECISION.md carries the full reasoning. In short: the payload
-- still contains bookingRef, and RA 10173 s3(g) makes information personal when
-- an identity "can be reasonably and directly ascertained by the entity holding
-- the information". Servana holds the bookings table. Keeping the rows in the
-- database they already relate to adds no processor, no cross-border transfer
-- and no NPC registration.
--
-- ── Retention is a decision, and it is 90 days ──────────────────────────────
--
-- Data minimisation is not only about which fields are collected but for how
-- long they are kept. Without a stated period an event stream becomes a
-- permanent behavioural record of identifiable providers by default rather than
-- by decision. 90 days answers every question these events exist for — did
-- activation finish, are jobs reaching completion, which failure class is
-- rising — and answers none that needs a year.
--
-- The sweep is NOT installed by this migration. A DELETE on a schedule that
-- nobody has watched run is the same species of unwatched machinery this
-- programme keeps finding, so it is listed in
-- docs/MASTER_TODO_MANUAL_TASKS.md as work with an owner rather than shipped
-- here unobserved.

CREATE TABLE IF NOT EXISTS servana.telemetry_events (
  id            BIGSERIAL PRIMARY KEY,

  -- Closed vocabulary, enforced by the handler rather than by a CHECK. A CHECK
  -- would turn adding an event into a migration, and the failure mode of an
  -- unknown event is a dropped row, not a corrupt one.
  event         TEXT        NOT NULL,

  -- From the VERIFIED TOKEN, never from the payload. The client is forbidden to
  -- send `uid` at all, so a client cannot attribute an event to somebody else.
  -- Nullable because an event may outlive the account that produced it.
  actor_uid     TEXT        NULL,

  -- Scrubbed, allowlisted, scalar-valued. No free text: no message, no stack
  -- trace, no note. A reporter that accepts a stack trace accepts whatever the
  -- strings in it happen to contain.
  properties    JSONB       NOT NULL DEFAULT '{}'::jsonb,

  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The two queries this table exists to answer, and no speculative third.
--   "what happened in the last N days, by event"  -> (occurred_at, event)
--   "what happened to this provider"              -> (actor_uid, occurred_at)
CREATE INDEX IF NOT EXISTS telemetry_events_occurred_event_idx
  ON servana.telemetry_events (occurred_at DESC, event);

CREATE INDEX IF NOT EXISTS telemetry_events_actor_idx
  ON servana.telemetry_events (actor_uid, occurred_at DESC)
  WHERE actor_uid IS NOT NULL;

COMMENT ON TABLE servana.telemetry_events IS
  'Scrubbed worker-app events. Personal data under RA 10173 (actor_uid, and bookingRef is re-identifiable). Retention 90 days — see docs/TELEMETRY_DECISION.md.';

-- Ownership is explicit from migration 029 onward: a table created by whichever
-- role the deploy happened to connect as is a table whose grants nobody decided.
ALTER TABLE servana.telemetry_events OWNER TO admin;
