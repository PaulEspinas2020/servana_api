-- Controlled replacement for the legacy runtime-additive lifecycle bootstrap.
-- Nullable columns preserve every existing row and every shipped API client.

ALTER TABLE servana.booking_workers
  ADD COLUMN IF NOT EXISTS en_route_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_booking_workers_current_assignment
  ON servana.booking_workers (booking_id, assigned_at DESC, id DESC);
