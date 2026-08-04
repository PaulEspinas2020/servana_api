import { db } from "../config";
import dbQuery from "../db/dbQuery";

const dbSchema = db.schema;

/**
 * Duplicate-submission protection for booking creation.
 *
 * ## Why the customer path needed this
 *
 * ServanaClient already generates a key per booking draft and sends it as
 * `X-Idempotency-Key` (draft_repository.getOrCreateIdempotencyKey, held until
 * the backend confirms). The backend read the header nowhere, so a retry created
 * a second booking — and a second payment row alongside it.
 *
 * That is not a theoretical race. The app targets Philippine mobile networks,
 * the submit call is the slowest in the flow, and the client's own recovery layer
 * exists precisely because requests there are expected to time out and be
 * retried. A timeout that actually succeeded server-side charged the customer
 * twice and dispatched two providers.
 *
 * The admin create-booking flow has had this since it was written; it required
 * `idempotencyKey` in the body and rejected calls without one. The customer path
 * was simply never given the same treatment, and the two now share both the
 * table and this module rather than growing a second implementation (§9, §17).
 *
 * ## Scope
 *
 * Keys are scoped to the ACTOR. Two customers cannot collide on a shared key,
 * and one customer replaying their own key gets their own booking back rather
 * than a stranger's. The uniqueness constraint enforces that rather than the
 * application trusting itself.
 */

/** The maximum a caller may send. Matches the column width. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 64;

/**
 * Normalises a caller-supplied key, or null when there is nothing usable.
 *
 * An absent key is allowed: the header is optional, older clients do not send
 * it, and refusing those requests would break every shipped app to fix a
 * duplicate-submission bug. Callers that pass null simply get no protection.
 */
export const normaliseIdempotencyKey = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) return null;
  return trimmed;
};

/**
 * The booking this (key, actor) pair already created, or null.
 *
 * Called before doing any work, so a retry costs one indexed lookup rather than
 * a full create.
 */
export const findBookingByIdempotencyKey = async (
  key: string | null,
  actorUid: string | null | undefined,
): Promise<number | null> => {
  if (!key || !actorUid) return null;

  const res = await dbQuery.query(
    `SELECT booking_id FROM ${dbSchema}.booking_create_idempotency
      WHERE idempotency_key = $1 AND actor_uid = $2
      LIMIT 1`,
    [key, actorUid],
  );

  return res.rowCount ? Number(res.rows[0].booking_id) : null;
};

/**
 * Records the key against the booking it produced.
 *
 * `ON CONFLICT DO NOTHING` because two genuinely concurrent submissions can both
 * pass the pre-flight check. The loser of that race keeps its own booking; the
 * row simply records whichever landed first. Closing that window completely
 * would need the insert inside the booking transaction, which the customer path
 * does not currently own — so this narrows the window rather than eliminating
 * it, and the pre-flight check handles the overwhelmingly common case of a
 * user-visible retry seconds later.
 *
 * Never throws. A booking that succeeded must not be reported as failed because
 * bookkeeping did not persist.
 */
export const recordIdempotentBooking = async (
  key: string | null,
  actorUid: string | null | undefined,
  bookingId: number | null | undefined,
): Promise<void> => {
  if (!key || !actorUid || !bookingId) return;

  try {
    await dbQuery.query(
      `INSERT INTO ${dbSchema}.booking_create_idempotency
         (idempotency_key, actor_uid, booking_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [key, actorUid, bookingId],
    );
  } catch {
    // Deliberately swallowed — see above.
  }
};
