-- Preserve superseded PayMongo checkout session ids so a payment against an
-- older session can still be matched by the webhook.
-- Apply before deploying the matching payment service release.
--
-- THE DEFECT THIS CLOSES — money received and never recorded.
--
-- `payments.provider_payment_id` holds the CHECKOUT SESSION id (`cs_…`) while a
-- payment is PENDING, and the webhook locates the row by it. When a session is
-- superseded — the stored one is over two hours old, or FAILED, or (since
-- b8b663e) was built for a different return origin — createCheckoutSession
-- OVERWRITES `provider_payment_id` and `raw_response` with the new session's.
-- The old id then exists nowhere on the row.
--
-- The old session stays payable at PayMongo. If the customer pays it — an old
-- tab, a second device — the webhook's UPDATE matches nothing, the fallback
-- SELECT (which only reads provider_payment_id and the two raw_response paths,
-- all now holding the NEW session) matches nothing either, and the handler
-- throws "PayMongo checkout session not found". That returns 500, so PayMongo
-- retries the event forever and the booking is never marked PAID. The customer
-- has been charged.
--
-- Demonstrated against this database before the fix: with only the new id on
-- the row, an event for the old session matches no row; with the old id
-- preserved, the same event matches correctly, and the `ROUND(amount*100)`
-- guard still refuses an event whose amount disagrees.
--
-- TEXT[] rather than a side table on purpose: the webhook match must stay a
-- single indexed predicate inside the existing UPDATE ... RETURNING, which is
-- what makes it atomic. A join would either widen the transaction or split the
-- match across two statements.

ALTER TABLE servana.payments
  ADD COLUMN IF NOT EXISTS superseded_session_ids TEXT[];

COMMENT ON COLUMN servana.payments.superseded_session_ids IS
  'PayMongo checkout session ids (cs_...) this payment previously used, appended when a session is superseded. The webhook matches against these as well as provider_payment_id, so a payment made against an older session is still recorded. Never contains pay_ ids.';

-- The webhook matches with `superseded_session_ids @> ARRAY[$1]`, which this
-- index serves. It must NOT be written `$1 = ANY(COALESCE(col, '{}'))`:
-- wrapping the column in a function makes the index unusable, which a planner
-- check caught only after the index had been written and claimed to work.
-- `NULL @> ARRAY[x]` is NULL, which WHERE treats as false — the same "no
-- superseded ids, no match" behaviour, without defeating the index.
CREATE INDEX IF NOT EXISTS idx_payments_superseded_session_ids
  ON servana.payments USING GIN (superseded_session_ids)
  WHERE superseded_session_ids IS NOT NULL;
