import dbQuery from "../db/dbQuery";
import { db } from "../config";

const s = db.schema;

/**
 * Invitation state, in its own module to break a cycle.
 *
 * adminInviteService needs to stamp `invited_at`; adminPermissionService needs
 * to stamp `accepted_at` from the shared admin-request hook. Putting either
 * function in either service made the two import each other, which works only
 * because the call happens at runtime rather than at module load — a property
 * that holds until someone moves a call into an initialiser.
 *
 * Both now depend on this, and this depends on neither.
 */

/**
 * Invitation-tracking columns.
 *
 * `admin_users` recorded who was created and when, but nothing about whether
 * the person ever arrived. An operator inviting someone had no way to tell a
 * working account from one whose invitation went to a mistyped address or a
 * spam folder — the row looks identical either way, which is exactly the
 * situation where nobody notices for a week.
 *
 * Two columns, both nullable and additive:
 *   invited_at   — set when an invitation is sent (and on each resend)
 *   accepted_at  — set on the invitee's first authenticated request
 *
 * "Pending" is derived, not stored: invited_at IS NOT NULL AND accepted_at IS
 * NULL. A derived state cannot drift out of sync with the events that produce
 * it, which a status column would.
 */
let inviteColumnsReady: Promise<void> | null = null;

export const ensureInviteColumns = (): Promise<void> => {
  inviteColumnsReady ??= dbQuery
    .query(
      `ALTER TABLE ${s}.admin_users
         ADD COLUMN IF NOT EXISTS invited_at  TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ`,
      []
    )
    .then(() => undefined)
    .catch((e: any) => {
      inviteColumnsReady = null;
      throw e;
    });
  return inviteColumnsReady;
};

/**
 * Record that an invited admin has arrived.
 *
 * Called on an authenticated admin request. Written once — `accepted_at IS
 * NULL` in the predicate — so it records FIRST arrival rather than most recent
 * activity, which `last_activity_at` already covers elsewhere.
 *
 * Never throws: this is bookkeeping, and a failure here must not turn a working
 * admin session into an error.
 */
export const markInviteAccepted = async (adminUid: string): Promise<void> => {
  try {
    await ensureInviteColumns();
    await dbQuery.query(
      `UPDATE ${s}.admin_users
       SET accepted_at = NOW()
       WHERE admin_uid = $1 AND accepted_at IS NULL AND invited_at IS NOT NULL`,
      [adminUid]
    );
  } catch {
    /* bookkeeping only */
  }
};

