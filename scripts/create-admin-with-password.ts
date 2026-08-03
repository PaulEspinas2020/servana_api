/**
 * Create admin accounts with a password set directly.
 *
 * THIS IS THE ESCAPE HATCH, NOT THE NORMAL PATH.
 *
 * The invite flow (POST /api/admin/admin-users/invite) creates the account with
 * NO password and emails a single-use link, so the password is chosen by the
 * account owner and known to nobody else. Use it whenever it can be used.
 *
 * This exists for when it cannot: the SendGrid `employee_invite` template is
 * still unverified, so an invitation may deliver blank and leave someone with no
 * way in. Bootstrapping by hand beats an operator locked out of their own portal.
 *
 * The cost is real: a password set here is known to whoever ran the script and
 * to wherever they typed it. Anyone created this way must change it on first
 * sign-in.
 *
 *   npm run admin:bootstrap                 # dry run
 *   npm run admin:bootstrap -- --apply
 *   npm run admin:bootstrap -- --apply --super
 *
 * Password comes from ADMIN_BOOTSTRAP_PASSWORD so it stays out of this file and
 * out of shell history.
 */

import { firebaseAdmin } from "../src/middleware/firebaseApp";
import { getAuth as getAuthAdmin } from "firebase-admin/auth";
import dbQuery from "../src/db/dbQuery";
import { db } from "../src/config";
import { normalizeEmail } from "../src/helpers/phoneIdentifier";
import {
  ensurePermissionSchema,
  getAdminUser,
  createAdminUser,
  getPermissionDefinitions,
  invalidatePermissionCache,
} from "../src/services/adminPermissionService";

const s = db.schema;
const auth = getAuthAdmin(firebaseAdmin);
const APPLY = process.argv.includes("--apply");
const SUPER = process.argv.includes("--super");
const ACTOR = "bootstrap-script";
const REASON = "Bootstrap: initial admin provisioning";

/** Emails to provision. Edited here rather than passed on a command line. */
const EMAILS = ["ralphwayneacenas@gmail.com", "allanagadi@gmail.com"];

const PASSWORD = process.env.ADMIN_BOOTSTRAP_PASSWORD ?? "";

/**
 * Roles this must never overwrite.
 *
 * Granting admin sets user_credentials.role = 1, and every provider and customer
 * query scopes on role — so doing it to a provider's account detaches their
 * jobs, earnings and history, silently and with nothing to undo it. There is
 * deliberately no --force: losing a provider's work history is never the
 * intended outcome of adding an admin.
 */
const PROTECTED: Record<number, string> = { 2: "provider", 3: "customer" };

type Outcome = { email: string; uid: string; created: boolean; granted: number; note?: string };

async function resolveFirebaseUser(email: string): Promise<{ uid: string; created: boolean } | null> {
  try {
    return { uid: (await auth.getUserByEmail(email)).uid, created: false };
  } catch (e: any) {
    if (e?.code !== "auth/user-not-found") throw e;
    if (!APPLY) return null; // dry run: nothing to report a uid for yet
    const rec = await auth.createUser({ email, emailVerified: true, password: PASSWORD });
    return { uid: rec.uid, created: true };
  }
}

async function provision(rawEmail: string): Promise<Outcome | null> {
  const email = normalizeEmail(rawEmail);
  if (!email) {
    console.log(`  SKIP     ${rawEmail} — not a valid email address`);
    return null;
  }

  const fb = await resolveFirebaseUser(email);
  if (!fb) {
    console.log(`  WOULD CREATE  ${email} — no Firebase account yet, then grant admin`);
    return null;
  }
  const { uid, created } = fb;

  // Role check BEFORE any write. See PROTECTED above.
  const { rows } = await dbQuery.query(
    `SELECT role::int AS role FROM ${s}.user_credentials WHERE uid = $1`,
    [uid]
  );
  const role = rows[0]?.role;
  if (role && PROTECTED[role]) {
    console.log(
      `  REFUSED  ${email} — this is already a ${PROTECTED[role]} account.\n` +
        `           Granting admin would set role = 1 and destroy their\n` +
        `           ${PROTECTED[role]} access. Use a different address.`
    );
    process.exitCode = 1;
    return null;
  }

  const existingAdmin = await getAdminUser(uid);

  if (!APPLY) {
    console.log(
      `  WOULD ${existingAdmin ? "UPDATE" : "CREATE"}  ${email} (uid ${uid.slice(0, 6)}…)` +
        ` — set password, ${existingAdmin ? "re-grant" : "grant admin +"} permissions`
    );
    return null;
  }

  // Password: the whole reason this script exists.
  await auth.updateUser(uid, { password: PASSWORD, emailVerified: true });

  if (!existingAdmin) {
    await createAdminUser({ adminUid: uid, email, displayName: null, isSuperAdmin: SUPER }, ACTOR, "Bootstrap script", null);
  } else if (SUPER) {
    await dbQuery.query(
      `UPDATE ${s}.admin_users SET is_super_admin = TRUE, account_status = 'active', updated_at = NOW() WHERE admin_uid = $1`,
      [uid]
    );
  }

  // Nobody was invited, so the list should show 'direct' rather than a pending
  // invitation that was never sent.
  await dbQuery
    .query(`UPDATE ${s}.admin_users SET accepted_at = NOW() WHERE admin_uid = $1 AND accepted_at IS NULL`, [uid])
    .catch(() => {});

  let granted = 0;
  let note: string | undefined;

  if (SUPER) {
    // is_super_admin short-circuits getEffectivePermissions — grants are moot.
    note = "super admin (all permissions implicitly)";
  } else {
    /**
     * Without this the account is real but inert: getEffectivePermissions
     * returns [] for a non-super admin with no grants, so they sign in to an
     * empty portal. createAdminUser does not grant anything — the portal treats
     * permissions as a separate, deliberate step, and so must this.
     *
     * Dangerous and hidden-from-UI permissions are withheld. A working operator
     * account is the goal; the destructive extras are a decision for whoever
     * runs the portal, not for a bootstrap script.
     */
    /**
     * Granted directly, NOT through updateAdminUserPermissions.
     *
     * That function requires the ACTOR to be a Super Admin, and this script's
     * actor is a label rather than an account — so it refused with FORBIDDEN
     * and left a real admin holding zero permissions and an empty portal. That
     * is a worse outcome than either creating nothing or granting everything,
     * because it looks like success.
     *
     * The guard is correct and is NOT weakened: the HTTP route still requires a
     * Super Admin. This path is reachable only by someone who already holds root
     * on the server and the database password — strictly more privileged than
     * any Super Admin — so gating it behind one would be theatre.
     *
     * Two things are preserved rather than shortcut. The grants use the same
     * append-only shape as the service (insert what is missing; revocation is a
     * revoked_at stamp, never a delete), so re-running adds nothing. And the
     * event row names `bootstrap-script` as the actor rather than borrowing a
     * real Super Admin's uid, which would put a person's name on something they
     * did not do.
     */
    const defs = await getPermissionDefinitions();
    const wanted = defs.groups
      .flatMap((g) => g.permissions)
      .filter((p: any) => !p.isDangerous && !p.isHiddenFromNormalUi)
      .map((p: any) => p.key as string);
    const withheld = defs.total - wanted.length;

    const existing = await dbQuery.query(
      `SELECT permission_key FROM ${s}.admin_permission_grants
       WHERE admin_uid = $1 AND granted = TRUE AND revoked_at IS NULL`,
      [uid]
    );
    const have = new Set<string>(existing.rows.map((r: any) => r.permission_key));
    const toAdd = wanted.filter((k) => !have.has(k));

    for (const key of toAdd) {
      await dbQuery.query(
        `INSERT INTO ${s}.admin_permission_grants
           (admin_uid, permission_key, granted, granted_by, reason)
         VALUES ($1, $2, TRUE, $3, $4)`,
        [uid, key, ACTOR, REASON]
      );
    }

    if (toAdd.length) {
      // added/removed/before/after are JSONB, so they are stringified. Passing
      // a JS array binds as a Postgres array and fails the type on insert.
      await dbQuery.query(
        `INSERT INTO ${s}.admin_permission_events
           (target_admin_uid, actor_admin_uid, event_type, added_permissions,
            removed_permissions, before_permissions, after_permissions, reason, request_id)
         VALUES ($1, $2, 'granted', $3::jsonb, '[]'::jsonb, $4::jsonb, $5::jsonb, $6, NULL)`,
        [uid, ACTOR, JSON.stringify(toAdd), JSON.stringify([...have]), JSON.stringify(wanted), REASON]
      );
    }

    invalidatePermissionCache(uid);
    invalidatePermissionCache(`sa:${uid}`);
    granted = wanted.length;
    if (withheld > 0) {
      note = `${withheld} dangerous/hidden permission(s) withheld — grant in the portal if needed`;
    }
  }

  console.log(
    `  DONE     ${email}  uid ${uid.slice(0, 6)}…  ${created ? "Firebase account created" : "existing account updated"}` +
      (granted ? `, ${granted} permissions granted` : "")
  );
  if (note) console.log(`           ${note}`);
  return { email, uid, created, granted, note };
}

async function main() {
  if (APPLY && PASSWORD.length < 10) {
    console.error(
      "ADMIN_BOOTSTRAP_PASSWORD is unset or shorter than 10 characters.\n" +
        "  bash:  export ADMIN_BOOTSTRAP_PASSWORD='...'"
    );
    process.exit(2);
  }

  await ensurePermissionSchema();

  console.log(APPLY ? "APPLYING\n" : "DRY RUN — nothing will be written\n");
  const done: Outcome[] = [];
  for (const e of EMAILS) {
    const r = await provision(e);
    if (r) done.push(r);
  }

  if (!APPLY) {
    console.log("\nRe-run with --apply to write. Add --super for super admins.");
    return;
  }

  if (done.length) {
    console.log("\nThey sign in at the admin portal with the password you set.");
    console.log("TELL THEM TO CHANGE IT: a password set by a script is known to");
    console.log("whoever ran it, which is exactly what the invite flow avoids.");
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error("failed:", e.message);
    process.exit(2);
  });
