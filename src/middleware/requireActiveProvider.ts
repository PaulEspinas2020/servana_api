import { Request, Response, NextFunction } from "express";
import { sendAuthError, AUTH_ERRORS } from "../errors/authErrors";
import dbQuery from "../db/dbQuery";
import { db } from "../config";

const schema = db.schema;

/**
 * Refuses an operational request from a provider who is not permitted to work.
 *
 * Suspension was a CLIENT-SIDE state. The app resolves `account_status` into an
 * AppStartState and routes a suspended provider to a status screen — but their
 * Firebase token stays valid, `verifyAuth` keeps passing, and the backend kept
 * serving. Anyone holding that token, including the suspended provider with any
 * HTTP client, could still accept bookings, start jobs and move their location.
 *
 * Routing is not authorization. This is the check that makes a suspension mean
 * something on the server.
 *
 * Deliberately narrow: it gates OPERATIONAL actions — taking work, doing work,
 * moving money. It is NOT applied to a provider reading their own profile,
 * their documents, or their support tickets, because a suspended provider needs
 * to see why they were suspended and to upload what fixes it. Locking them out
 * of that would make suspension unrecoverable and generate support load for no
 * security benefit.
 *
 * Fails closed. An unreadable status, a missing row or a database error denies:
 * the alternative is that a transient outage silently grants operational access
 * to every suspended account at once.
 */

/** Statuses that may perform operational actions. */
const WORKING_STATUSES = new Set(["active", "approved"]);

/**
 * Statuses that explicitly may not, kept separate from "unknown" so the denial
 * reason can be accurate and the client can route to the right screen.
 */
const BLOCKED_REASON: Record<string, string> = {
  suspended: "PROVIDER_SUSPENDED",
  rejected: "PROVIDER_REJECTED",
  disabled: "PROVIDER_DISABLED",
  archived: "PROVIDER_DISABLED",
  pending: "PROVIDER_NOT_APPROVED",
  under_review: "PROVIDER_NOT_APPROVED",
};

const requireActiveProvider = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const uid = (req as any).user?.uid as string | undefined;
  if (!uid) {
    sendAuthError(res, "UNAUTHENTICATED");
    return;
  }

  try {
    const { rows } = await dbQuery.query(
      `SELECT account_status FROM ${schema}.user_credentials WHERE uid = $1`,
      [uid]
    );

    // No row at all is a genuinely unknown actor and still denies.
    if (rows.length === 0) {
      sendAuthError(res, "PROVIDER_NOT_APPROVED");
      return;
    }

    /**
     * A row whose account_status was NEVER SET is a legacy account, not a
     * blocked one, and must be allowed.
     *
     * This shipped as a production outage. `String(rows[0]?.account_status ?? "")`
     * collapsed NULL to "", which is not in WORKING_STATUSES, so every account
     * predating the column got 403 on every operational route. It was invisible
     * in testing because those accounts sign in fine — the failure lands on the
     * FIRST guarded call afterwards, which the portal surfaces as "your session
     * expired", pointing at auth rather than at authorization.
     *
     * It hit phone sign-in hardest: Firebase issues a uid per identifier, so
     * signing in by mobile creates a NEW row via upsertFirebaseUser, which does
     * not set account_status. Those accounts were blocked from their very first
     * request while email sign-in kept working, which is why it looked like a
     * mobile-only bug.
     *
     * Failing closed is still right for an UNKNOWN status — that is a value
     * somebody wrote deliberately and this code does not understand. Absence is
     * different: it means nothing was ever written, and yesterday that account
     * worked. Suspension is unaffected, because suspending writes an explicit
     * status.
     */
    const raw = rows[0].account_status;
    if (raw === null || raw === undefined || String(raw).trim() === "") {
      next();
      return;
    }

    const status = String(raw).toLowerCase();

    if (WORKING_STATUSES.has(status)) {
      next();
      return;
    }

    // Deliberately does not echo the raw status value: the client routes on the
    // code, and the message is shown to a person. Each code carries its own
    // recovery action, so a disabled account is sent to support while a
    // suspended one is sent to its status screen — the distinction that makes
    // these codes worth emitting at all.
    const code = (BLOCKED_REASON[status] ?? "PROVIDER_NOT_APPROVED") as keyof typeof AUTH_ERRORS;
    sendAuthError(res, code, "Your account is not currently permitted to perform this action.");
  } catch {
    // A status lookup that fails must not widen access.
    // A status lookup that fails must not widen access, but it IS transient —
    // so it routes to RETRY rather than parking the person on a status screen
    // that will never change.
    sendAuthError(res, "ACCOUNT_STATUS_UNAVAILABLE");
  }
};

export default requireActiveProvider;
