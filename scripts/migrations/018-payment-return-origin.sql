-- Records which return origin a PayMongo checkout session was created for.
-- Apply before deploying the matching payment service release.
--
-- `3ef4518` resolves the return origin per request from an allowlist, but all
-- three checkout paths reuse a PENDING session for two hours WITHOUT consulting
-- it. A session created for one origin is therefore handed to a caller from
-- another, and the payer is returned to the wrong application after paying.
--
-- Storing the origin on the payment row lets reuse require a match. NULL means
-- "the configured default", which is what every caller that sends no Origin
-- header resolves to — native mobile and the scheduler's retry job — so
-- existing rows read correctly without a backfill.

ALTER TABLE servana.payments
  ADD COLUMN IF NOT EXISTS return_origin TEXT;

COMMENT ON COLUMN servana.payments.return_origin IS
  'Allowlisted return origin this checkout session was created for. NULL = the configured PAYMONGO_RETURN_URL default. Never a caller-supplied string; only an entry from paymentReturnOrigin.ts.';
