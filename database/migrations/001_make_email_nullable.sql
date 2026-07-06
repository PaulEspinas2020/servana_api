-- Make user_credentials.email nullable to support phone-only provider registration.
-- Run once on production PostgreSQL.
-- Safe to run multiple times (IF EXISTS guard on the NOT NULL constraint).

ALTER TABLE user_credentials
  ALTER COLUMN email DROP NOT NULL;

-- Verify
SELECT column_name, is_nullable
FROM information_schema.columns
WHERE table_name = 'user_credentials' AND column_name = 'email';
-- Expected: is_nullable = 'YES'
