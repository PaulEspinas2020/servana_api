-- 033 · Domain event outbox and account device tokens (TAB 09)
--
-- The controlled path for the schema that `services/events/eventOutbox.ts` and
-- `services/events/deviceTokenService.ts` also ensure lazily at first use. Both
-- are IF NOT EXISTS, so whichever runs first wins and the other is a no-op —
-- the same arrangement 030, 031 and 032 have with their services, and for the
-- same reason: the code must not depend on a deploy having run a migration
-- first, and the migration must exist so a DBA can apply it deliberately.
--
-- NOT APPLIED to any database by this repository. The only reachable database is
-- production, which this work is forbidden to touch.
--
-- ── What this does NOT do ───────────────────────────────────────────────────
--
-- It does not backfill. The outbox starts empty and covers facts that happen
-- from here on. Backfilling would mean synthesising events for bookings that
-- completed months ago and then projecting notifications for them — every
-- affected person's phone buzzing about a job from last spring. An event log
-- that starts today is correct; one that invents a history is not.
--
-- It does not migrate `provider_notification_device_tokens` or
-- `user_credentials.fcm_token`. Both are still WRITTEN and still READ by the
-- send path: a device registered through a legacy route before this shipped is
-- in exactly one of those places, and dropping it would silently stop that
-- person's push. `deviceTokenService.tokensFor` returns the UNION, and the
-- legacy stores can be retired later by measurement.
--
-- It does not touch `provider_notifications`, `customer_notifications` or
-- `admin_notifications`. Those keep their live writers and readers; TAB 09
-- unifies the CONTRACT over them, not the storage.

BEGIN;

-- ─── 1. The transactional outbox ─────────────────────────────────────────────
--
-- One row per domain fact. Written INSIDE the producing transaction where the
-- producer has one (the booking state machine does), so a rolled-back
-- transition cannot leave an event that notifies somebody about a job that does
-- not exist.

CREATE TABLE IF NOT EXISTS servana.domain_event_outbox (
  id            BIGSERIAL PRIMARY KEY,
  event_name    VARCHAR(64)  NOT NULL,
  event_version INTEGER      NOT NULL DEFAULT 1,
  dedupe_key    TEXT,
  refs          JSONB        NOT NULL DEFAULT '{}'::jsonb,
  display       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  metadata      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  status        VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
  attempts      INTEGER      NOT NULL DEFAULT 0,
  last_error    TEXT,
  occurred_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  dispatched_at TIMESTAMPTZ
);

-- The dispatcher's working set. Partial, because DISPATCHED rows are the
-- overwhelming majority within a day and indexing them would grow an index
-- nobody queries.
CREATE INDEX IF NOT EXISTS idx_domain_event_outbox_pending
  ON servana.domain_event_outbox (status, id)
  WHERE status = 'PENDING';

-- Publish-side idempotency. Partial, because most facts have no natural key and
-- two genuinely separate facts must both be publishable; where a producer CAN
-- name the fact, a retried publish becomes a no-op rather than a second event.
CREATE UNIQUE INDEX IF NOT EXISTS uq_domain_event_outbox_dedupe
  ON servana.domain_event_outbox (event_name, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

COMMENT ON TABLE servana.domain_event_outbox IS
  'Transactional outbox for canonical domain events. Projected into notifications by '
  'services/events/notificationProjector. Rows are retained after dispatch as the '
  'audit trail of what the platform reacted to.';

COMMENT ON COLUMN servana.domain_event_outbox.refs IS
  'Canonical entity ids only - bookingId, serviceId (Catalog V2), conversationId, reviewId. '
  'Never a screen name and never service_family_id; the publisher refuses both.';

COMMENT ON COLUMN servana.domain_event_outbox.display IS
  'Safe display substitutions, bounded and control-stripped at publish. Never a customer '
  'name, address, phone or note - these reach a push payload, which the OS renders on a '
  'lock screen before the app decides anything.';

-- ─── 2. Account-scoped device tokens ─────────────────────────────────────────
--
-- Providers had a token TABLE and therefore multi-device push. Customers had a
-- single COLUMN, so a customer signed in on a phone and a tablet only ever
-- received push on whichever signed in last - silently, with no error anywhere.
-- Same platform, same feature, two implementations, one of them broken.
--
-- The token is the PRIMARY KEY, not (uid, token). A device can only be signed
-- into one account at a time, so registering a token another account holds MOVES
-- it. Keying on the pair would let a shared or resold handset accumulate owners
-- and receive both accounts' notifications - a cross-account leak with a lock
-- screen attached.

CREATE TABLE IF NOT EXISTS servana.account_device_tokens (
  token       TEXT PRIMARY KEY,
  uid         VARCHAR(128) NOT NULL,
  platform    VARCHAR(16),
  app         VARCHAR(32),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_device_tokens_uid
  ON servana.account_device_tokens (uid);

COMMENT ON TABLE servana.account_device_tokens IS
  'Canonical push device registry for every account regardless of role. The legacy '
  'provider table and user_credentials.fcm_token are dual-written and still read; '
  'deviceTokenService.tokensFor returns the union until both can be retired by measurement.';


-- ── Ownership ────────────────────────────────────────────────────────────────
--
-- The deploy applies migrations as `psql -U admin`, so a table created that way
-- already belongs to `admin` and this is belt-and-braces. It is stated anyway
-- because the failure it guards against was a migration applied BY HAND as
-- `sudo -u postgres psql`: 29 of 116 tables ended up owned by `postgres`, the
-- app had no privileges on them, and provider document upload returned a bare
-- 500 for every provider until somebody read the catalog. An explicit owner
-- makes this migration correct regardless of who runs it.

ALTER TABLE servana.domain_event_outbox OWNER TO admin;
ALTER TABLE servana.account_device_tokens OWNER TO admin;

COMMIT;

-- ── Verification ─────────────────────────────────────────────────────────────
--
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'servana'
--      AND table_name IN ('domain_event_outbox', 'account_device_tokens');
--
-- Expected: two rows.
--
--   SELECT indexname FROM pg_indexes
--    WHERE schemaname = 'servana' AND tablename = 'domain_event_outbox';
--
-- Expected to include idx_domain_event_outbox_pending and
-- uq_domain_event_outbox_dedupe.
--
-- ── Operating the backlog ────────────────────────────────────────────────────
--
-- Published-minus-dispatched is the only number that says whether the platform
-- is still reacting to itself. A dispatcher that stopped looks exactly like a
-- quiet day until this is read:
--
--   SELECT status, COUNT(*), MIN(occurred_at)
--     FROM servana.domain_event_outbox
--    GROUP BY status;
--
-- A growing PENDING count with an old MIN(occurred_at) is a stalled dispatcher.
-- FAILED rows have exhausted MAX_DISPATCH_ATTEMPTS and need a human: read
-- last_error, fix the cause, then set status back to 'PENDING' to retry.
