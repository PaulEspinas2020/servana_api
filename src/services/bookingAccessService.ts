import { db } from "../config";
import dbQuery from "../db/dbQuery";

const dbSchema = db.schema;

/**
 * Booking-scoped authorization.
 *
 * Answers one question: may this authenticated actor touch this booking?
 *
 * Before this existed, the customer-facing booking and payment routes carried no
 * authorization at all — `GET /api/:id` returned any booking to any caller, and
 * several controllers had the ownership argument commented out
 * (`getBookingById(bookingId /*, userId *\/)`). Booking ids are sequential
 * integers, so that made every customer's name, phone number and home address
 * enumerable.
 *
 * Hard rule §11: IDs are identifiers, not authorization, and we fail closed when
 * ownership is ambiguous. Hard rule §12: a hidden button is not authorization —
 * the check lives here, server-side, and applies no matter who calls.
 */

export type BookingActorRole = "customer" | "provider" | "admin";

export class BookingAccessError extends Error {
  constructor(
    message: string,
    readonly statusCode: 403 | 404,
    readonly code: "BOOKING_NOT_FOUND" | "BOOKING_ACCESS_DENIED",
  ) {
    super(message);
    this.name = "BookingAccessError";
  }
}

const ACTIVE_WORKER_STATUSES = [
  "ASSIGNED",
  "ACCEPTED",
  "IN_PROGRESS",
  "COMPLETED",
];

/**
 * Resolves the actor's relationship to a booking, or null if they have none.
 *
 * Permitted relationships:
 *  - `customer` — `bookings.user_id` matches the actor.
 *  - `provider` — the actor holds an active `booking_workers` row for it. A
 *    declined or cancelled assignment does NOT grant access, so a provider who
 *    turned a job down (or was reassigned away) loses visibility, per §22.
 *  - `admin`    — role 1 in `user_credentials`.
 *
 * Guest bookings (`guest_customer_id`, admin-created per §8) have no `user_id`.
 * A guest has no Servana login and therefore no token, so they cannot reach
 * these routes at all — such bookings stay visible to the assigned provider and
 * to admins only. That is deliberate: a guest is served by phone/Messenger, not
 * by the app.
 */
export const resolveBookingAccess = async (
  bookingId: number,
  actorUid: string | null | undefined,
): Promise<BookingActorRole | null> => {
  if (!actorUid) return null;
  if (!Number.isInteger(bookingId) || bookingId <= 0) return null;

  const bookingRes = await dbQuery.query(
    `SELECT user_id FROM ${dbSchema}.bookings WHERE id = $1`,
    [bookingId],
  );
  if (!bookingRes.rowCount) {
    throw new BookingAccessError("Booking not found", 404, "BOOKING_NOT_FOUND");
  }

  const ownerUid: string | null = bookingRes.rows[0].user_id ?? null;
  if (ownerUid && ownerUid === actorUid) return "customer";

  const workerRes = await dbQuery.query(
    `SELECT 1 FROM ${dbSchema}.booking_workers
      WHERE booking_id = $1 AND worker_uid = $2 AND status = ANY($3::text[])
      LIMIT 1`,
    [bookingId, actorUid, ACTIVE_WORKER_STATUSES],
  );
  if (workerRes.rowCount) return "provider";

  const roleRes = await dbQuery.query(
    `SELECT "role" FROM ${dbSchema}.user_credentials WHERE uid = $1`,
    [actorUid],
  );
  if (roleRes.rowCount && Number(roleRes.rows[0].role) === 1) return "admin";

  return null;
};

/**
 * Throws unless the actor may touch the booking.
 *
 * A booking that exists but is not yours returns 403 rather than 404. The ids
 * are sequential, so 404-on-forbidden would leak existence by omission anyway
 * while making real "deleted booking" bugs impossible to tell apart.
 */
export const assertBookingAccess = async (
  bookingId: number,
  actorUid: string | null | undefined,
): Promise<BookingActorRole> => {
  const role = await resolveBookingAccess(bookingId, actorUid);
  if (!role) {
    throw new BookingAccessError(
      "You do not have access to this booking",
      403,
      "BOOKING_ACCESS_DENIED",
    );
  }
  return role;
};

/** Express helper: maps a BookingAccessError onto a safe response (§21). */
export const sendBookingAccessError = (res: any, e: unknown): boolean => {
  if (e instanceof BookingAccessError) {
    res.status(e.statusCode).json({
      success: false,
      code: e.code,
      message: e.message,
    });
    return true;
  }
  return false;
};
