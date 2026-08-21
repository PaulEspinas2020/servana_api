-- Booking evidence: a replay key, so a retried upload is not a second photo (TAB 07).
--
-- NO TRANSACTION CONTROL — the runner owns the transaction.
--
-- ── The defect ──────────────────────────────────────────────────────────────
--
-- `bookingEvidenceService.attachEvidence` was a plain INSERT with no
-- idempotency key of any kind. A provider on a doorstep whose upload committed
-- and then timed out retries, and the retry files a SECOND piece of evidence
-- against the same requirement.
--
-- The damage is bounded but not avoided. `requirement.maxCount` caps how many
-- files a requirement may hold, so the duplicate either consumes a slot the
-- provider still needs, or — where maxCount is 1 — the retry is refused with
-- TOO_MANY_FILES, which reads as "your upload failed" for an upload that
-- succeeded. Both outcomes are wrong, and evidence is what a dispute is decided
-- on.
--
-- The Master Command states the requirement directly: *"Specify the replay
-- mechanism — a retried upload must not create a second piece of evidence on the
-- same booking."* This is the mechanism.
--
-- ── Why additive, and why the previous build tolerates it ───────────────────
--
-- One NULLABLE column and one PARTIAL index. The running code neither writes
-- nor reads the column, and the index only constrains rows where it is NOT
-- NULL — so every existing row, and every row the current build writes, is
-- unaffected. A rollback to the previous dist needs no database change, which
-- is what keeps this inside expand-migrate-contract.
--
-- ── Why the index is PARTIAL ────────────────────────────────────────────────
--
-- A plain unique index over (booking_id, worker_uid, client_request_id) would
-- treat NULLs as distinct in PostgreSQL and so would not collide today — but it
-- would also index every legacy row for nothing. More importantly, making it
-- partial states the intent: the constraint applies to writes that CARRY a key,
-- and a write without one is a legacy write that this migration does not
-- retroactively govern.
--
-- ── Why the key is scoped by worker too ─────────────────────────────────────
--
-- (booking_id, client_request_id) alone would let one provider's key collide
-- with another's on a reassigned booking, and a collision here does not merely
-- deduplicate — it would silently DROP the second provider's evidence. Scoping
-- by worker_uid makes the key mean "this provider's attempt", which is what a
-- device-generated id actually identifies.

ALTER TABLE servana.booking_evidence
  ADD COLUMN IF NOT EXISTS client_request_id TEXT;

COMMENT ON COLUMN servana.booking_evidence.client_request_id IS
  'Device-generated replay key, set before the first upload attempt and reused by '
  'every retry of that one attempt. NULL for rows written before TAB 07 and for '
  'callers that do not supply one. The partial unique index below is what makes a '
  'retry return the original file rather than filing a second one.';

CREATE UNIQUE INDEX IF NOT EXISTS booking_evidence_client_request_id_unique
  ON servana.booking_evidence (booking_id, worker_uid, client_request_id)
  WHERE client_request_id IS NOT NULL;
