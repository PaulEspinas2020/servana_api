/**
 * Backend-derived profile completion (§109).
 *
 * ## Why this exists
 *
 * Welcome cards and onboarding checklists were each deciding for themselves what
 * "complete" meant. One client counted a profile photo, another did not, and
 * neither could see the document review state at all — so a provider with three
 * rejected documents saw a green tick and a "start accepting jobs" button that
 * produced no jobs, because matching could not select them.
 *
 * A client cannot compute this. Document review state, service qualification and
 * availability all live behind endpoints a welcome card does not call, and two of
 * the three are what matching actually selects on. So the backend derives it and
 * the client renders it.
 *
 * ## percent vs canProceed
 *
 * `percent` counts every requirement including the cosmetic ones, because that
 * is what a progress bar means to a person. `canProceed` counts only the
 * BLOCKING ones, because that is what the product gates on. Conflating them is
 * how a client shows "80% complete" next to a button that does not work — the
 * two numbers answer different questions and the policy declares both.
 */

import dbQuery from '../../db/dbQuery';
import { db } from '../../config';
import { getIdentity } from '../identityService';
import { computeCompletion, type CompletionState } from './accountPolicy';
import { roleKindOf } from './accountService';
import { getAvailability, listDocuments, listServices } from './providerProfileService';

const s = db.schema;

/**
 * The completion state for one account.
 *
 * Every input is READ, never assumed. A requirement that cannot be evaluated
 * resolves to false — under-claiming completion rather than over-claiming it,
 * because the cost of the two is not symmetric: an account told it is incomplete
 * checks again, and an account told it is complete stops.
 */
export const getCompletion = async (uid: string): Promise<CompletionState & {
  uid: string;
  /** Where to go to satisfy each missing requirement. */
  next: Record<string, string>;
}> => {
  const identity = await getIdentity(uid);
  const role = roleKindOf(identity?.role);

  const hasName = !!(identity?.firstName ?? '').trim() || !!(identity?.lastName ?? '').trim();
  const hasVerifiedContact = identity?.isEmailVerified === true
    || (await isPhoneVerified(uid));
  const hasPhoto = await hasProfilePhoto(uid);

  if (role === 'customer') {
    const state = computeCompletion({
      role,
      hasName,
      hasVerifiedContact,
      hasPhoto,
      hasAddress: (await addressCount(uid)) > 0,
    });
    return { ...state, uid, next: nextSteps(state) };
  }

  // Provider. Documents, services and availability are exactly what matching
  // selects on, which is why an incomplete provider is invisible rather than
  // merely unpolished.
  const [documents, services, availability] = await Promise.all([
    listDocuments(uid).catch(() => []),
    listServices(uid).catch(() => []),
    getAvailability(uid).catch(() => null),
  ]);

  const requiredDocuments = documents.filter((d) => d.required);
  const acceptedStatuses = new Set(['approved', 'accepted', 'verified']);
  const hasRequiredDocuments = requiredDocuments.length > 0
    && requiredDocuments.every((d) => acceptedStatuses.has(String(d.status).toLowerCase()));

  const state = computeCompletion({
    role,
    hasName,
    hasVerifiedContact,
    hasPhoto,
    hasRequiredDocuments,
    hasServices: services.some((service) => service.isActive),
    hasAvailability: availability?.hasUsableSchedule === true,
  });

  return { ...state, uid, next: nextSteps(state) };
};

/**
 * Where a person goes to satisfy each missing requirement.
 *
 * Returned as canonical ENDPOINTS rather than screen names: a screen name is a
 * client's implementation detail and breaks the moment a route is renamed, which
 * is the same reason the deep-link contract keys on canonical ids.
 */
const REQUIREMENT_ENDPOINTS: Readonly<Record<string, string>> = Object.freeze({
  name: 'PATCH /api/v1/me',
  contact: 'the identifier verification workflow',
  photo: 'PATCH /api/v1/me',
  address: 'POST /api/v1/customer/addresses',
  documents: 'GET /api/v1/provider/documents',
  services: 'GET /api/v1/provider/services',
  availability: 'PATCH /api/v1/provider/availability',
});

const nextSteps = (state: CompletionState): Record<string, string> => {
  const next: Record<string, string> = {};
  // BLOCKING first, then the rest — the order a checklist should show them in,
  // decided here rather than by each client sorting differently.
  for (const id of [...state.blockedBy, ...state.missing]) {
    if (next[id]) continue;
    next[id] = REQUIREMENT_ENDPOINTS[id] ?? 'PATCH /api/v1/me';
  }
  return next;
};

// ─── Inputs ───────────────────────────────────────────────────────────────────

const addressCount = async (uid: string): Promise<number> => {
  try {
    const { rows } = await dbQuery.query(
      `SELECT COUNT(*)::int AS count FROM ${s}.user_address WHERE uid = $1`,
      [uid],
    );
    return Number(rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
};

const hasProfilePhoto = async (uid: string): Promise<boolean> => {
  try {
    const { rows } = await dbQuery.query(
      `SELECT photo_url FROM ${s}.user_profile WHERE uid = $1 LIMIT 1`,
      [uid],
    );
    return !!String(rows[0]?.photo_url ?? '').trim();
  } catch {
    return false;
  }
};

const isPhoneVerified = async (uid: string): Promise<boolean> => {
  try {
    const { rows } = await dbQuery.query(
      `SELECT is_mobile_verified FROM ${s}.user_credentials WHERE uid = $1 LIMIT 1`,
      [uid],
    );
    return rows[0]?.is_mobile_verified === true;
  } catch {
    return false;
  }
};
