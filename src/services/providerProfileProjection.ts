import dbQuery from "../db/dbQuery";
import { db } from "../config";
/**
 * Projection for `GET /api/workers/:uid`.
 *
 * One endpoint, one response shape, three audiences. The full payload carries
 * the provider's email, phone, birthdate, gender, home addresses, compliance
 * documents, complete booking history — which names every customer they have
 * ever served — plus their disbursement ledger and earnings summary. The route
 * had no auth, so anyone holding a provider uid could read all of it.
 *
 * The same financial data is gated with verifyAuth + verifyOwnership elsewhere
 * in the very same router (technician.routes.ts:44-46), where it is labelled
 * "financial data". This endpoint simply predated that and was never revisited.
 *
 * The customer app consumes it to render a name and a phone number on the
 * booking detail screen, and a name while polling for assignment. So the fix is
 * not to deny customers — it is to give each audience only what it asks for.
 */

export type ProviderProfileAudience = 'self' | 'admin' | 'other';

/**
 * Fields a customer may see about the provider on their job.
 *
 * `phoneNumber` is included deliberately. The customer needs to reach the
 * provider who is coming to their home, and removing it would be a functional
 * regression in the live app. It is still narrower than it should be: the right
 * shape is booking-scoped, the way `GET /booking/:bookingId/provider-location`
 * works, so a customer gets the contact details of *their* provider rather than
 * of any provider whose uid they can name. Tracked as a follow-up; this change
 * removes the catastrophic surface without waiting for that redesign.
 */
const PUBLIC_FIELDS = [
  'uid',
  'firstName',
  'lastName',
  'name',
  'phoneNumber',
  'photoUrl',
  'photo_url',
  'first_name',
  'last_name',
  'phone_number',
  'roleName',
  'role_name',
] as const;

/**
 * Everything below is removed for a non-self, non-admin caller. Listed
 * explicitly rather than inferred, so adding a column to the underlying query
 * does not silently widen what a customer receives — a new field is withheld by
 * default and has to be added to PUBLIC_FIELDS on purpose.
 */
export const projectProviderProfile = (
  profile: Record<string, any> | null,
  audience: ProviderProfileAudience,
): Record<string, any> | null => {
  if (!profile) return null;
  if (audience === 'self' || audience === 'admin') return profile;

  const out: Record<string, any> = {};
  for (const key of PUBLIC_FIELDS) {
    if (key in profile && profile[key] != null) out[key] = profile[key];
  }

  // Services are the provider's advertised capabilities, not private data, and
  // the booking screen may reasonably show what they do. Names only — no
  // assignment timestamps, which would leak roster history.
  if (Array.isArray(profile.services)) {
    out.services = profile.services.map((s: any) => ({
      id: s?.id,
      name: s?.name,
      category: s?.category,
    }));
  }

  return out;
};

/**
 * What a customer must never receive. Exported so the test can assert absence
 * without restating the list, and so the intent is greppable from the finding.
 */
export const WITHHELD_FROM_OTHERS = [
  'email',
  'birthdate',
  'gender',
  'isArchive',
  'is_archive',
  'isEmailVerified',
  'is_email_verified',
  'createdDate',
  'created_date',
  'addresses',
  'requirements',
  'bookingHistory',
  'disbursementHistory',
  'earningsSummary',
] as const;

/**
 * Who is asking about whom.
 *
 * Moved here from technicianController so it can be used without importing a
 * controller — that import pulled in the Mongo client at module load and broke
 * any test that only wanted the projection. It is projection logic; it belongs
 * with the projector.
 *
 * Fails closed: an unknown actor, or a role lookup that errors, is "other".
 */
export const resolveProviderAudience = async (
  actorUid: string | undefined,
  subjectUid: string,
): Promise<"self" | "admin" | "other"> => {
  if (!actorUid) return "other";
  if (actorUid === subjectUid) return "self";
  try {
    const { rows } = await dbQuery.query(
      `SELECT "role" FROM ${db.schema}.user_credentials WHERE uid = $1`,
      [actorUid],
    );
    if (rows.length && Number(rows[0].role) === 1) return "admin";
  } catch {
    // A role lookup failure must not widen access.
    return "other";
  }
  return "other";
};
