import { Request, Response, NextFunction } from "express";
import { sendAuthError } from "../errors/authErrors";
import dbQuery from "../db/dbQuery";
import { db } from "../config";
import { isProviderRole } from "../constants/providerRoles";

const schema = db.schema;

/**
 * Refuses the provider self-service surface to anyone who is not a provider.
 *
 * Command 6, masterlist S-01 / PROVIDER_ACCOUNT_ACCESS_MATRIX A-01.
 *
 * Every route in `provider.routes.ts` was `verifyAuth` only. The handlers scope
 * their queries by the token's uid, so this was not a cross-account leak — a
 * customer calling `/provider/earnings` got their own (empty) earnings, not
 * somebody else's. What they got was the whole provider surface: dashboard,
 * ledger, payout settings, safety incidents, onboarding submission.
 *
 * The answer was already published and simply not enforced. `/provider/
 * account-state` has told a non-provider `ROLE_NOT_PERMITTED` since Command 6
 * shipped, and both clients route on it. This middleware makes the rest of the
 * surface agree with what that endpoint already says, using the same
 * PROVIDER_ROLES set so the two cannot drift.
 *
 * ── Why this is safe to enable now, stated as evidence rather than belief ──
 * Production, read 2026-08-04: 109 accounts — role 1 × 6 (admin), role 2 × 70
 * (provider), role 3 × 31 (customer), role 6 × 2. No role 4 exists yet. `role`
 * is NOT NULL and every row carries one, so there is no null-role population to
 * strand. The two role-6 accounts have no onboarding case, no bookings and no
 * activation row, and `/provider/account-state` already refuses them.
 *
 * That evidence matters because tightening the sibling middleware once took the
 * platform down: `requireActiveProvider` collapsed a NULL `account_status` to
 * `""`, and every account predating that column got 403 on every operational
 * route. The failure landed on the first guarded call after a successful
 * sign-in, so it read as "session expired" and pointed at auth rather than at
 * authorization. The lesson kept here is that "nobody should be affected" has
 * to be a query result, not an assumption.
 *
 * NOT applied to three things, each for its own reason:
 *   - `/provider/account-state` — the discovery endpoint. A non-provider must
 *     be able to ask why they are refused; answering with a bare 403 would
 *     leave the app with nothing to route on.
 *   - `/admin/provider/reconciliation` — role 1, guarded by verifyRoles([1]).
 *   - `/booking/:id/provider-location` and `/booking/:id/provider` — the
 *     customer app calls these to track the provider on a booking it owns.
 *
 * Fails closed on an unknown actor, and RETRY-able on a lookup failure: a
 * database blip must not read as "you are not a provider", which is a verdict a
 * person cannot act on.
 */
const requireProviderRole = async (
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
      `SELECT "role" FROM ${schema}.user_credentials WHERE uid = $1`,
      [uid]
    );

    // No row is an authenticated token with no account behind it. Unknown
    // actors do not get the provider surface.
    if (rows.length === 0 || !isProviderRole(rows[0].role)) {
      sendAuthError(
        res,
        "ROLE_NOT_PERMITTED",
        "This account is not a Servana provider account."
      );
      return;
    }

    next();
  } catch {
    // Transient, and it must not masquerade as a verdict.
    sendAuthError(res, "ACCOUNT_STATUS_UNAVAILABLE");
  }
};

export default requireProviderRole;
