-- Controlled PayMongo integrity deployment.
-- Apply before deploying the matching payment service release.

ALTER TABLE servana.payments
  ADD COLUMN IF NOT EXISTS checkout_attempt INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_attempt INTEGER NOT NULL DEFAULT 0;

ALTER TABLE servana.disbursements
  ADD COLUMN IF NOT EXISTS payout_attempt INTEGER NOT NULL DEFAULT 0;

-- PayMongo retries events. This is the database-level last line of defence;
-- application advisory locks provide deterministic behaviour before the
-- unique constraint is reached.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_webhook_event_id
  ON servana.payments (webhook_event_id)
  WHERE webhook_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_paymongo_checkout_retry
  ON servana.payments (status, updated_at)
  WHERE provider = 'PAYMONGO';

CREATE INDEX IF NOT EXISTS idx_payments_paymongo_payment_resource
  ON servana.payments (provider_payment_id)
  WHERE provider = 'PAYMONGO';
