-- 034 · Account settings (TAB 10)
--
-- ONE additive table. `services/account/accountSettingsService.ensureSettingsSchema`
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
-- There was no server-side settings store. Locale, time zone and privacy choices
-- were held per-client, so Customer Web and Customer Mobile each remembered a
-- different language for the same person and neither could tell the backend.
-- Notification preferences were the only server-side setting, and they lived in
-- `provider_notification_preferences` behind a provider-role gate — for a table
-- that is keyed on a uid and has no role column.
--
-- ── Why key/value and not a column per setting ───────────────────────────────
--
-- A typed column per setting means a migration per setting, and this table will
-- grow. A single JSONB blob means no way to see what an account has actually
-- chosen without parsing it, and no way to index or audit one setting.
--
-- Key/value with a composite primary key gives per-setting upserts, per-setting
-- `updated_at`, and a readable row. Values are TEXT and are coerced on read
-- against the type the catalog's declared default implies — the catalog in
-- `services/account/accountPolicy.ts` is the schema, and it is executable.
--
-- ── What this does NOT do ────────────────────────────────────────────────────
--
-- It does not migrate `provider_notification_preferences`. That table keeps its
-- rows, its writer and its readers; `/me/settings` POINTS at it rather than
-- copying the nine categories, because a second preference model is exactly what
-- TAB 09 existed to prevent.
--
-- It does not backfill. An account with no row gets the catalog defaults, which
-- is what it would have been given anyway — writing a row per account to store
-- the defaults would be a table full of rows that say nothing.
--
-- It does not touch `user_credentials`, `user_profile` or `user_address`. Those
-- are the live tables every client reads; this adds the settings BESIDE them.

BEGIN;

CREATE TABLE IF NOT EXISTS servana.account_settings (
  uid         VARCHAR(128) NOT NULL,
  setting_id  VARCHAR(64)  NOT NULL,
  value       TEXT,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (uid, setting_id)
);

CREATE INDEX IF NOT EXISTS idx_account_settings_uid
  ON servana.account_settings (uid);

COMMENT ON TABLE servana.account_settings IS
  'Per-account settings: locale, time zone, privacy. One row per (account, setting). '
  'Notification preferences are NOT here - they remain in provider_notification_preferences '
  'and /me/settings points at them rather than copying them.';

COMMENT ON COLUMN servana.account_settings.value IS
  'Stored as TEXT and coerced on read against the type the catalog default implies. '
  'The catalog is services/account/accountPolicy.ts SETTINGS_CATALOG, which is executable '
  'and which the generated SETTINGS_V1_CONTRACT.md is rendered from.';


-- ── Ownership ────────────────────────────────────────────────────────────────
--
-- The deploy applies migrations as `psql -U admin`, so a table created that way
-- already belongs to `admin` and this is belt-and-braces. It is stated anyway
-- because the failure it guards against was a migration applied BY HAND as
-- `sudo -u postgres psql`: 29 of 116 tables ended up owned by `postgres`, the
-- app had no privileges on them, and provider document upload returned a bare
-- 500 for every provider until somebody read the catalog. An explicit owner
-- makes this migration correct regardless of who runs it.

ALTER TABLE servana.account_settings OWNER TO admin;

COMMIT;

-- ── Verification ─────────────────────────────────────────────────────────────
--
--   SELECT column_name, data_type
--     FROM information_schema.columns
--    WHERE table_schema = 'servana' AND table_name = 'account_settings'
--    ORDER BY ordinal_position;
--
-- Expected: uid, setting_id, value, updated_at.
--
-- ── Operating ────────────────────────────────────────────────────────────────
--
-- Which settings accounts have actually changed away from the default:
--
--   SELECT setting_id, value, COUNT(*)
--     FROM servana.account_settings
--    GROUP BY setting_id, value
--    ORDER BY setting_id, COUNT(*) DESC;
--
-- A setting_id appearing here that is not in SETTINGS_CATALOG is a row written
-- by an older build after the catalog dropped it. The read path ignores unknown
-- ids, so such rows are inert; delete them deliberately rather than on a timer.
