/**
 * Why an assignment response did not apply.
 *
 * Command 18 §12/§47. `acceptJob` and `declineJob` update `booking_workers`
 * with a compare-and-swap:
 *
 *   UPDATE booking_workers SET status = 'ACCEPTED'
 *   WHERE booking_id = $1 AND worker_uid = $2 AND status = 'ASSIGNED'
 *
 * That CAS is already correct concurrency control — two providers racing, or
 * one provider double-tapping, cannot both match `status = 'ASSIGNED'`. The
 * defect was never the race; it was what happened afterwards.
 *
 * On a miss the services threw a bare Error and both controllers caught it into
 * `500 { message: "Server error" }`. So a double-tap, an offer that expired, a
 * booking admin reassigned, and a genuine database fault were indistinguishable
 * to every client — and a duplicate tap is not a server error at all.
 *
 * This classifies the miss by reading the current row, so the caller can tell
 * "you already did this" (idempotent success, §52 requires acceptance and
 * decline to be idempotent) apart from "this is no longer yours" (409 with a
 * reason the UI can actually explain).
 *
 * §12 forbids revealing which provider received the booking, so no branch here
 * returns another provider's identity — only that it is no longer the caller's.
 */
import dbQuery from "../db/dbQuery";
import { db } from "../config";

const dbSchema = db.schema;

export type BookingResponseIntent = "ACCEPT" | "DECLINE";

export type BookingResponseConflictCode =
  /** The caller already recorded this exact response. Idempotent success. */
  | "ALREADY_ACCEPTED_BY_YOU"
  | "ALREADY_DECLINED_BY_YOU"
  /** The caller responded, but the other way. Not retryable. */
  | "ALREADY_RESPONDED"
  /** The row moved past the response stage — work already under way. */
  | "ALREADY_IN_PROGRESS"
  /** No ASSIGNED row for this caller: reassigned, withdrawn, or never theirs. */
  | "NO_LONGER_ASSIGNED"
  /** The booking itself is gone. */
  | "BOOKING_CANCELLED";

/** Codes that mean "the caller's intent is already satisfied". */
const IDEMPOTENT_CODES = new Set<BookingResponseConflictCode>([
  "ALREADY_ACCEPTED_BY_YOU",
  "ALREADY_DECLINED_BY_YOU",
]);

export class BookingResponseConflict extends Error {
  readonly code: BookingResponseConflictCode;
  /** The caller's own row status, or null when they have none. */
  readonly currentStatus: string | null;
  /** Provider-facing text. Never names another provider. */
  readonly providerMessage: string;

  constructor(
    code: BookingResponseConflictCode,
    currentStatus: string | null,
    providerMessage: string
  ) {
    super(providerMessage);
    this.name = "BookingResponseConflict";
    this.code = code;
    this.currentStatus = currentStatus;
    this.providerMessage = providerMessage;
  }

  /** True when the caller's intent already holds — respond 200, not 409. */
  get isAlreadySatisfied(): boolean {
    return IDEMPOTENT_CODES.has(this.code);
  }

  get httpStatus(): number {
    return this.isAlreadySatisfied ? 200 : 409;
  }
}

const MESSAGES: Record<BookingResponseConflictCode, string> = {
  ALREADY_ACCEPTED_BY_YOU: "You have already accepted this booking.",
  ALREADY_DECLINED_BY_YOU: "You have already declined this booking.",
  ALREADY_RESPONDED: "You have already responded to this assignment.",
  ALREADY_IN_PROGRESS: "This booking has already moved past the response stage.",
  NO_LONGER_ASSIGNED: "This assignment is no longer awaiting your response.",
  BOOKING_CANCELLED: "This booking has been cancelled.",
};

/**
 * Reads current state and explains why the compare-and-swap found no row.
 *
 * Called only after a miss, so it costs nothing on the success path.
 */
export async function classifyResponseMiss(
  bookingId: number,
  workerUid: string,
  intent: BookingResponseIntent
): Promise<BookingResponseConflict> {
  const mine = await dbQuery.query(
    `SELECT status FROM ${dbSchema}.booking_workers
     WHERE booking_id = $1 AND worker_uid = $2
     ORDER BY id DESC LIMIT 1`,
    [bookingId, workerUid]
  );

  const current: string | null = mine.rows[0]?.status ?? null;
  const status = String(current ?? "").toUpperCase();

  if (status === "ACCEPTED") {
    // Accepting twice is the caller's intent already satisfied. Declining
    // after accepting is a different action and must not be silently accepted.
    const code: BookingResponseConflictCode =
      intent === "ACCEPT" ? "ALREADY_ACCEPTED_BY_YOU" : "ALREADY_RESPONDED";
    return new BookingResponseConflict(code, current, MESSAGES[code]);
  }

  if (status === "DECLINED") {
    const code: BookingResponseConflictCode =
      intent === "DECLINE" ? "ALREADY_DECLINED_BY_YOU" : "ALREADY_RESPONDED";
    return new BookingResponseConflict(code, current, MESSAGES[code]);
  }

  if (status === "IN_PROGRESS" || status === "COMPLETED") {
    return new BookingResponseConflict(
      "ALREADY_IN_PROGRESS",
      current,
      MESSAGES.ALREADY_IN_PROGRESS
    );
  }

  if (status === "CANCELED" || status === "CANCELLED") {
    return new BookingResponseConflict(
      "BOOKING_CANCELLED",
      current,
      MESSAGES.BOOKING_CANCELLED
    );
  }

  // No row of the caller's at all, or an unrecognised status. Either way the
  // assignment is not theirs to answer — and §12 forbids saying whose it is.
  return new BookingResponseConflict(
    "NO_LONGER_ASSIGNED",
    current,
    MESSAGES.NO_LONGER_ASSIGNED
  );
}
