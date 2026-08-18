-- Canary. Changes NOTHING; it exists to make the deploy's migration step
-- actually authenticate.
--
-- The step runs `psql -h 127.0.0.1 -U admin` with the DB_PASSWORD repository
-- secret, but it only invokes psql for migrations that have no .done marker.
-- With nothing pending it skips every file and exits 0 — so an ordinary deploy
-- reports a green migration step whether the secret is right or wrong. That is
-- a false green, and it is why the credential drift on 2026-08-10 was invisible
-- until a real migration (018) finally needed to run and failed.
--
-- One unmarked file forces one authenticated connection. If the secret is
-- correct this passes and is marked done; if it is wrong the step fails and the
-- pipeline stops BEFORE the PM2 restart, leaving production untouched — which
-- is exactly what happened with 018 and is the behaviour we want.
--
-- Safe to run against any database at any time: it reads one constant and
-- writes nothing.

SELECT 1 AS deploy_credential_ok;
