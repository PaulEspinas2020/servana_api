-- Booking lifecycle timestamps, as a controlled migration.
--
-- These four columns are currently created by LAZY DDL: technicianService's
-- `ensureArrivalColumns()` issues ALTER TABLE ... ADD COLUMN IF NOT EXISTS on
-- the first arrival transition after a deploy, memoised for the process
-- lifetime. That worked while technicianService was the only writer, because
-- every one of its entry points awaited it first.
--
-- It stopped being sufficient when the canonical executor began writing these
-- columns. `POST /api/v1/provider/jobs/:id/{accept,en-route,arrived}` goes
-- straight to `transitionBooking`, which deliberately does NOT perform schema
-- repair — a booking transition must not be able to alter schema. So on a
-- fresh database whose first arrival-family call arrives over /api/v1, the
-- lazy DDL has never run and the write fails on a missing column.
--
-- Making the columns real closes that. All four are nullable and additive:
-- every existing row keeps its values, and every shipped client reads the same
-- fields it always did.
--
-- `ensureArrivalColumns()` is deliberately NOT deleted in the same change.
-- It is idempotent and harmless once these exist, and removing it before this
-- migration is applied to production would reintroduce the very gap it covers.
-- It is deleted in a later commit, once this has been applied and verified.
--
-- No BEGIN/COMMIT here: the runner wraps each migration in its own
-- transaction, and an inner COMMIT would end it early and defeat the dry run.

ALTER TABLE servana.booking_workers
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS en_route_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS arrived_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ;

COMMENT ON COLUMN servana.booking_workers.accepted_at IS
  'When the provider accepted the assignment. Written by the canonical transition executor.';
COMMENT ON COLUMN servana.booking_workers.en_route_at IS
  'When the provider set out. Written by the canonical transition executor.';
COMMENT ON COLUMN servana.booking_workers.arrived_at IS
  'When the provider reached the address. Written by the canonical transition executor.';
COMMENT ON COLUMN servana.booking_workers.declined_at IS
  'When the provider declined the assignment. Written by the canonical transition executor.';
