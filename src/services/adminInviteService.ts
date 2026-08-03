import { firebaseAdmin } from "../middleware/firebaseApp";
import { getAuth as getAuthAdmin } from "firebase-admin/auth";
import dbQuery from "../db/dbQuery";
import { db } from "../config";
import { send } from "../helpers/mailer";
import { normalizeEmail } from "../helpers/phoneIdentifier";
import { createAdminUser } from "./adminPermissionService";

const s = db.schema;
const auth = getAuthAdmin(firebaseAdmin);

/**
 * Where the invitation link returns the invitee after they set a password.
 *
 * Env-driven so staging does not send people to production. The default is the
 * live portal, because an invitation that lands nowhere is worse than one that
 * lands on the real sign-in page.
 */
const adminPortalUrl = process.env.ADMIN_PORTAL_URL || "https://admin.servana.com.ph";

/**
 * Invite an admin by email address.
 *
 * The portal's "New admin user" form required a **Firebase UID**, which meant
 * the person had to already exist in Firebase Authentication — created by hand,
 * out of band, before anyone could grant them access. That is the chicken and
 * egg this removes: you cannot get a uid without an account, and nobody creates
 * the account because the form asks for the uid.
 *
 * The Admin SDK can do both halves. `createUser` returns the uid, and
 * `generatePasswordResetLink` produces a single-use, expiring link that Firebase
 * itself validates — so no invite-token table, no expiry column, no cleanup job,
 * and no home-grown token to get wrong.
 *
 * The link is emailed to the INVITEE, never returned to the inviter. That is
 * what makes inviting an existing address safe: an admin can trigger a set-
 * password link for someone else's address, but only the owner of that mailbox
 * can use it.
 */

export type InviteResult = {
  adminUid: string;
  email: string;
  created: boolean; // false when the Firebase account already existed
  emailSent: boolean;
};

/** Roles that must never be silently converted into an admin. */
const PROTECTED_ROLES: Record<number, string> = {
  2: "provider",
  3: "customer",
};

export async function inviteAdminUser(
  input: {
    email: string;
    displayName?: string | null;
    isSuperAdmin?: boolean;
  },
  actorUid: string,
  actorName: string | null,
  requestId: string | null
): Promise<InviteResult> {
  const email = normalizeEmail(input.email);
  if (!email) {
    throw Object.assign(new Error("A valid email address is required"), {
      code: "INVALID_REQUEST",
    });
  }

  // ── Resolve or create the Firebase account ────────────────────────────────
  let uid: string;
  let created = false;

  try {
    const existing = await auth.getUserByEmail(email);
    uid = existing.uid;
  } catch (e: any) {
    if (e?.code !== "auth/user-not-found") throw e;
    const record = await auth.createUser({
      email,
      emailVerified: false,
      displayName: input.displayName ?? undefined,
      // No password. The invitee sets one through the link, so a password is
      // never chosen by the inviter, never transmitted, and never known by
      // anyone but the account owner.
    });
    uid = record.uid;
    created = true;
  }

  // ── Refuse to convert a provider or customer into an admin ────────────────
  //
  // createAdminUser upserts `user_credentials.role = 1`. If this email already
  // belongs to a provider, that single statement silently destroys their
  // provider access — every provider query scopes on role, so they would sign
  // in to an admin portal and lose their jobs, earnings and history in one
  // click, with no warning and nothing to undo it.
  //
  // Whether an operator should be able to hold both roles is a real question,
  // but it is not one to answer by accident.
  const { rows } = await dbQuery.query(
    `SELECT role::int AS role FROM ${s}.user_credentials WHERE uid = $1`,
    [uid]
  );
  const currentRole = rows[0]?.role;
  if (currentRole && PROTECTED_ROLES[currentRole]) {
    throw Object.assign(
      new Error(
        `That email already belongs to a ${PROTECTED_ROLES[currentRole]} account. ` +
          `Granting admin access would remove their ${PROTECTED_ROLES[currentRole]} access. ` +
          `Use a different address for admin access.`
      ),
      { code: "IDENTIFIER_CONFLICT" }
    );
  }

  // ── Create the admin record (existing path, unchanged) ────────────────────
  await createAdminUser(
    {
      adminUid: uid,
      email,
      displayName: input.displayName ?? null,
      isSuperAdmin: input.isSuperAdmin ?? false,
    },
    actorUid,
    actorName,
    requestId
  );

  // ── Send the invitation ───────────────────────────────────────────────────
  //
  // Deliberately AFTER the admin record exists. If the email fails, the invite
  // can be resent; if the record failed after a successful email, the invitee
  // would follow a working link into an account with no admin access and no way
  // to tell why.
  const emailSent = await sendInviteEmail(email, input.displayName ?? null, actorName);

  return { adminUid: uid, email, created, emailSent };
}

/**
 * Generate a fresh set-password link and email it.
 *
 * Also used by the resend path. Firebase invalidates prior links for the same
 * address when a new one is issued, so resending is safe and does not leave a
 * second live link in an old inbox.
 */
export async function sendInviteEmail(
  email: string,
  displayName: string | null,
  invitedBy: string | null
): Promise<boolean> {
  try {
    const link = await auth.generatePasswordResetLink(email, {
      url: `${adminPortalUrl}/portal/login`,
      handleCodeInApp: false,
    });

    await send(email, "employee_invite", {
      name: displayName || email.split("@")[0],
      invited_by: invitedBy || "the Servana team",
      action_url: link,
      portal_url: adminPortalUrl,
    });
    return true;
  } catch (e: any) {
    // Never fail the invitation because the mail hop failed. The admin record
    // exists and is usable; the operator can resend. Logged without the link,
    // which is a credential (§22).
    console.error(
      `[admin-invite] could not send invitation to a ${email.split("@")[1] ?? "?"} address: ${e?.message}`
    );
    return false;
  }
}

/** Resend an invitation to an admin who has not signed in yet. */
export async function resendAdminInvite(
  adminUid: string,
  actorName: string | null
): Promise<{ emailSent: boolean }> {
  const { rows } = await dbQuery.query(
    `SELECT email, display_name FROM ${s}.admin_users WHERE admin_uid = $1`,
    [adminUid]
  );
  const row = rows[0];
  if (!row) {
    throw Object.assign(new Error("Admin user not found"), { code: "NOT_FOUND" });
  }
  const emailSent = await sendInviteEmail(row.email, row.display_name ?? null, actorName);
  return { emailSent };
}
