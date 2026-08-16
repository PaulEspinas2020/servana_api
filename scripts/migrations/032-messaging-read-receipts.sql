-- 032 · Messaging read receipts (TAB 08)
--
-- ONE additive column. `chat.repository.ensureChatLifecycleSchema` performs the
-- same DDL lazily at boot, so whichever runs first wins and the other is a
-- no-op — the arrangement 030 and 031 already have with their services, and for
-- the same reason: the code must not depend on a deploy having run a migration
-- first, and the migration must exist so a DBA can apply it deliberately.
--
-- NOT APPLIED to any database by this repository. The only reachable database is
-- production, which this work is forbidden to touch.
--
-- ── What it is for ───────────────────────────────────────────────────────────
--
-- `chat_participants.last_read_message_id` already records WHERE somebody has
-- read to. It cannot say WHEN, and "seen 10:42" is what a read receipt is; a
-- pointer alone can only produce a checkmark. The column is written by
-- `setLastRead` alongside the pointer it already moves, so there is no second
-- writer and no way for the two to disagree about the same act of reading.
--
-- ── Why it is NULLABLE with no default ───────────────────────────────────────
--
-- Existing rows have read pointers that were set before this column existed, and
-- there is no record of when. NULL means "we do not know", which is true.
-- Defaulting to now() would stamp every historical participant as having read
-- their conversation at deploy time — a fabricated receipt, on a screen whose
-- entire purpose is to tell one person something about another.
--
-- ── Blast radius ─────────────────────────────────────────────────────────────
--
-- ADD COLUMN with no default and no NOT NULL is a catalog-only change in
-- PostgreSQL 11+: no table rewrite, no long lock, safe on a live table. Nothing
-- reads the column except the messaging DTO, which publishes it as
-- `participants[].lastReadAt` and tolerates NULL.
--
-- ── What this does NOT do ────────────────────────────────────────────────────
--
-- It does not add a delivered-at column. There is no per-device acknowledgement
-- channel in this platform, so a `delivered_at` could only ever be a copy of the
-- moment the server wrote the row — a claim about the recipient's device that
-- nothing in the system can support, rendered as a checkmark next to a person's
-- name. `RECEIPT_MODEL` in `services/messaging/messagingPolicy.ts` states that
-- refusal explicitly rather than leaving it as an omission.
--
-- It does not touch `chat_messages`, `chat_conversations` or any index. The
-- partial unique index that makes message sends idempotent
-- (`idx_chat_message_client_idempotency`) was created by the lifecycle ensure in
-- an earlier tab and is unchanged here.

BEGIN;

ALTER TABLE servana.chat_participants
  ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;

COMMENT ON COLUMN servana.chat_participants.last_read_at IS
  'When last_read_message_id last advanced. NULL means the pointer predates this column; '
  'it is never backfilled, because an invented receipt is worse than an absent one.';

COMMIT;

-- ── Verification ─────────────────────────────────────────────────────────────
--
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_schema = 'servana'
--      AND table_name   = 'chat_participants'
--      AND column_name  = 'last_read_at';
--
-- Expected: one row, timestamp with time zone, YES.
