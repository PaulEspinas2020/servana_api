-- One-time codes gain an explicit PURPOSE.
--
-- NO TRANSACTION CONTROL — the runner owns the transaction.
-- MUST run through the deployment migration step under the `admin` role.
--
-- Why this is safe for the code currently running:
--   Purely additive, with a DEFAULT. Every existing row becomes
--   REGISTRATION_VERIFICATION, which is what every existing row already is —
--   registration verification is the only thing that has ever written to this
--   table. No read changes meaning and no row changes value.
--
-- Why the application ALSO ensures this column:
--   `services/otpService.ts` runs the same two statements lazily, memoised and
--   AWAITED by every OTP read and write. That is deliberate belt and braces,
--   not duplication:
--
--     - This file is the controlled path, applied with the rest of a deploy.
--     - The lazy ensure means the code cannot reach a database where the column
--       is missing, whatever order things land in.
--
--   A rename that is not atomic with its deploy has taken this platform's
--   production down once already. Both statements are IF NOT EXISTS, so
--   whichever runs first wins and the other is a no-op.
--
-- Why a default rather than a NOT NULL backfill in two steps:
--   The table is small, short-lived (codes expire in ten minutes and are swept)
--   and written only by the registration path. A DEFAULT on ADD COLUMN is a
--   catalogue-only operation in PostgreSQL 11+, so it does not rewrite the
--   table and does not need the two-step dance.
--
-- Reverse:
--   ALTER TABLE servana.email_otps DROP COLUMN IF EXISTS purpose;
--   DROP INDEX IF EXISTS servana.idx_email_otps_email_purpose;

ALTER TABLE servana.email_otps
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'REGISTRATION_VERIFICATION';

-- Covers the only read shape: newest unused, unexpired code for an address and
-- a purpose. Without it, adding `purpose` to the WHERE turns an index scan into
-- a filter on every verification attempt.
CREATE INDEX IF NOT EXISTS idx_email_otps_email_purpose
  ON servana.email_otps (email, purpose, used, expires_at);

COMMENT ON COLUMN servana.email_otps.purpose IS
  'What the code entitles the holder to do: REGISTRATION_VERIFICATION, '
  'PASSWORD_RESET or SENSITIVE_CHANGE. Every read is scoped to one, so a code '
  'minted for one decision can never satisfy another. Values are a contract — '
  'append, never rename. See src/services/otpService.ts.';
