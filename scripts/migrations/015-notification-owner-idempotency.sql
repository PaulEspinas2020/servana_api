-- Notification idempotency is scoped to its recipient.
-- The legacy single-column UNIQUE constraints caused a fan-out notification
-- with the same deterministic key to reach only the first provider/customer.

CREATE TABLE IF NOT EXISTS servana.provider_notification_device_tokens (
  token TEXT PRIMARY KEY,
  worker_uid VARCHAR(128) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pndt_worker_uid
  ON servana.provider_notification_device_tokens (worker_uid);

DO $migration$
BEGIN
  IF to_regclass('servana.provider_notifications') IS NOT NULL THEN
    ALTER TABLE servana.provider_notifications
      DROP CONSTRAINT IF EXISTS provider_notifications_notification_key_key;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_notifications_owner_key
      ON servana.provider_notifications (worker_uid, notification_key);
  END IF;

  IF to_regclass('servana.customer_notifications') IS NOT NULL THEN
    ALTER TABLE servana.customer_notifications
      DROP CONSTRAINT IF EXISTS customer_notifications_notification_key_key;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_notifications_owner_key
      ON servana.customer_notifications (user_uid, notification_key);
  END IF;
END
$migration$;
