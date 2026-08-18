-- 037 · Drop the redundant GLOBAL unique constraints on notification_key (TAB 02)
--
-- ── The defect ───────────────────────────────────────────────────────────────
--
-- `notification_key` idempotency is supposed to be OWNER-scoped: two providers
-- can each receive a notification carrying the same key. That is what
-- `uq_provider_notifications_owner_key (worker_uid, notification_key)` and
-- `uq_customer_notifications_owner_key (user_uid, notification_key)` express,
-- and what every insert relies on:
--
--   INSERT INTO provider_notifications (...)
--   ON CONFLICT (worker_uid, notification_key) DO NOTHING
--
-- Migration 015 created those indexes and tried to remove the old global
-- constraint with:
--
--   ALTER TABLE ... DROP CONSTRAINT IF EXISTS provider_notifications_notification_key_key;
--
-- That name does not exist. Production carries
-- `provider_notifications_notification_key_key1` … `_key37` and
-- `customer_notifications_notification_key_key1` … `_key2` — 39 constraints,
-- every one of them UNIQUE (notification_key) with no owner column. The
-- unsuffixed name was never present, so the DROP has always been a no-op, and
-- `notification.service.ts` repeats the same ineffective DROP at runtime.
--
-- ── Why it matters ───────────────────────────────────────────────────────────
--
-- `ON CONFLICT (worker_uid, notification_key)` names ONE inference target. A
-- violation of a DIFFERENT unique constraint is not absorbed by it — it is
-- raised as 23505. So any notification key that is deterministic and NOT
-- worker-scoped fails for every recipient after the first:
--
--   scheduler.ts:184           daily_active_bookings_${day}   one key per DAY
--   chat.service.ts:277        booking_chat_created_${bookingId}
--   adminBookingService.ts:254 provider_assigned_${bookingId}
--
-- The daily digest is the clearest case: one key per day, so exactly one
-- provider can be notified and every subsequent insert raises.
--
-- ── What this does ───────────────────────────────────────────────────────────
--
-- Enumerates the constraints rather than naming 39 of them, so it is correct
-- whatever suffixes a given database actually carries, and idempotent.
--
-- It drops ONLY:
--   * contype = 'u'  (unique CONSTRAINTS, never indexes)
--   * on exactly one column, which is `notification_key`
--
-- The owner-scoped guarantees are INDEXES, not constraints, so they cannot be
-- matched here. The single-column test is what keeps a composite
-- (owner, notification_key) constraint safe if one is ever added as a
-- constraint rather than an index. Primary keys are contype = 'p'.
--
-- NOT APPLIED by this repository. Requires the same explicit authorisation as
-- 030–035, and it is DESTRUCTIVE — read the verification queries below first
-- and record the counts before and after.

BEGIN;

DO $migration$
DECLARE
  target   record;
  dropped  int := 0;
BEGIN
  FOR target IN
    SELECT c.conname, t.relname
      FROM pg_constraint c
      JOIN pg_class     t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'servana'
       AND t.relname IN ('provider_notifications', 'customer_notifications')
       AND c.contype  = 'u'
       AND array_length(c.conkey, 1) = 1
       AND (
             SELECT a.attname
               FROM pg_attribute a
              WHERE a.attrelid = t.oid
                AND a.attnum   = c.conkey[1]
           ) = 'notification_key'
  LOOP
    EXECUTE format('ALTER TABLE servana.%I DROP CONSTRAINT %I', target.relname, target.conname);
    dropped := dropped + 1;
  END LOOP;

  RAISE NOTICE 'dropped % redundant global unique constraint(s) on notification_key', dropped;
END
$migration$;

-- Re-assert the owner-scoped guarantees. Both already exist in production; this
-- is here so a database that somehow lacks them does not come out of this
-- migration with NO uniqueness at all.
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_notifications_owner_key
  ON servana.provider_notifications (worker_uid, notification_key);

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_notifications_owner_key
  ON servana.customer_notifications (user_uid, notification_key);

COMMIT;

-- ── Verification ─────────────────────────────────────────────────────────────
--
-- BEFORE: expect 37 on provider_notifications, 2 on customer_notifications.
-- AFTER:  expect 0 for both.
--
--   SELECT t.relname, count(*)
--     FROM pg_constraint c
--     JOIN pg_class t ON t.oid = c.conrelid
--     JOIN pg_namespace n ON n.oid = t.relnamespace
--    WHERE n.nspname = 'servana'
--      AND t.relname IN ('provider_notifications','customer_notifications')
--      AND c.contype = 'u'
--      AND array_length(c.conkey, 1) = 1
--    GROUP BY t.relname;
--
-- The owner-scoped indexes must SURVIVE — expect both rows:
--
--   SELECT indexname FROM pg_indexes
--    WHERE schemaname = 'servana'
--      AND indexname IN ('uq_provider_notifications_owner_key',
--                        'uq_customer_notifications_owner_key');
--
-- ── After applying ───────────────────────────────────────────────────────────
--
-- Nothing in the application needs changing afterwards. The runtime DROP in
-- `notification.service.ts` was removed in the same commit that authored this
-- migration, because it never worked: it named the unsuffixed constraint, which
-- has never existed. Removing a statement that was always a no-op cannot change
-- behaviour, and leaving it would have implied production was already fixed.
