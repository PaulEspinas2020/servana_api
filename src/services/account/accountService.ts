/**
 * The canonical account record and the customer profile extension.
 *
 * ## What `/me` is, and what it deliberately is not
 *
 * `/me` is identity, contact and a verification summary. It carries a `profiles`
 * POINTER — which role extensions exist for this account — and not their
 * contents, because a `/me` that carried the provider's compliance state and the
 * customer's addresses would be fetched by every screen, used by almost none,
 * and cached, logged and shipped to analytics everywhere.
 *
 * `ME_EXCLUSIONS` in the policy names each excluded thing and the endpoint that
 * owns it, and `tests/account-contract.test.ts` asserts the real projection
 * against that list — so the gate is checked rather than promised.
 *
 * ## One writer, not two
 *
 * The PATCH delegates to `user.service.updateUserProfile`, which is the function
 * `/api/user/updateprofile` already calls. Writing the columns here instead
 * would be a second writer for one row, and the two would disagree the first
 * time either grew a rule — which is exactly how `first_name` came to be
 * settable from three different body shapes.
 */

import dbQuery from '../../db/dbQuery';
import { db } from '../../config';
import { getIdentity, type Identity } from '../identityService';
import * as userService from '../user.service';
import { isProviderRole } from '../../constants/providerRoles';
import {
  CUSTOMER_WRITABLE_FIELDS,
  ME_WRITABLE_FIELDS,
  type AccountSeat,
} from './accountPolicy';

const s = db.schema;

export class AccountError extends Error {
  constructor(
    readonly code:
      | 'ACCOUNT_NOT_FOUND'
      | 'ACCOUNT_FIELD_NOT_WRITABLE'
      | 'ACCOUNT_FIELD_INVALID',
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

// ─── Seat resolution ──────────────────────────────────────────────────────────

/**
 * Roles 0 and 1 are staff. The same predicate `notificationInbox` and
 * `chat.service` use.
 */
const STAFF_ROLES = new Set(['0', '1']);

export const seatFor = (viewerUid: string, subjectUid: string, viewerRole: unknown): AccountSeat => {
  if (viewerUid === subjectUid) return 'self';
  if (STAFF_ROLES.has(String(viewerRole ?? '').trim())) return 'admin';
  return 'otherCustomer';
};

export const roleKindOf = (role: unknown): 'customer' | 'provider' =>
  isProviderRole(role) ? 'provider' : 'customer';

// ─── /me ──────────────────────────────────────────────────────────────────────

export interface AccountProfilePointer {
  /** Which role extension applies. */
  kind: 'customer' | 'provider';
  /** Where its contents live. A pointer, never the contents. */
  endpoint: string;
}

export interface AccountDto {
  uid: string;
  email: string | null;
  phoneNumber: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  photoUrl: string | null;
  role: number | string | null;
  accountStatus: string | null;
  isEmailVerified: boolean;
  isPhoneVerified: boolean;
  /** Which role-specific profile exists, and where to fetch it. NOT its contents. */
  profiles: AccountProfilePointer[];
}

const displayNameOf = (first: string | null, last: string | null): string | null => {
  const name = [first, last].map((p) => (p ?? '').trim()).filter(Boolean).join(' ');
  return name || null;
};

/**
 * The extra columns `/me` needs beyond the identity record.
 *
 * Named explicitly rather than `SELECT *`. The credential row carries the FCM
 * token and auth-provider metadata; a star select is one schema change away from
 * publishing them, and `NEVER_PROJECTED` would then be a list nothing enforced.
 */
const accountExtras = async (uid: string) => {
  const { rows } = await dbQuery.query(
    `SELECT uc.account_status, uc.is_mobile_verified, up.photo_url
       FROM ${s}.user_credentials uc
       LEFT JOIN ${s}.user_profile up ON up.uid = uc.uid
      WHERE uc.uid = $1
      LIMIT 1`,
    [uid],
  );
  return rows[0] ?? {};
};

export const getAccount = async (uid: string): Promise<AccountDto> => {
  const identity: Identity | null = await getIdentity(uid);
  if (!identity) {
    throw new AccountError('ACCOUNT_NOT_FOUND', 'No account record exists for this identity yet.', 404);
  }
  const extras = await accountExtras(uid);
  const kind = roleKindOf(identity.role);

  return {
    uid: identity.uid,
    email: identity.email,
    phoneNumber: identity.phoneNumber,
    firstName: identity.firstName,
    lastName: identity.lastName,
    displayName: displayNameOf(identity.firstName, identity.lastName),
    photoUrl: extras.photo_url ?? null,
    role: identity.role,
    accountStatus: extras.account_status ?? null,
    isEmailVerified: identity.isEmailVerified === true,
    // The column is absent on older databases; absent means unverified, which is
    // the safe reading — never treat "we do not know" as verified.
    isPhoneVerified: extras.is_mobile_verified === true,
    profiles: [
      {
        kind,
        endpoint: kind === 'provider'
          ? '/api/v1/provider/profile'
          : '/api/v1/customer/profile',
      },
    ],
  };
};

/**
 * Change the account record.
 *
 * Only `ME_WRITABLE_FIELDS` are accepted, BY NAME. An unknown or non-writable
 * field is refused rather than ignored: silently dropping `email` from a PATCH
 * leaves the caller believing they changed a verified identifier, which is worse
 * than telling them they cannot.
 */
export const patchAccount = async (
  uid: string,
  patch: Record<string, unknown>,
): Promise<AccountDto> => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new AccountError('ACCOUNT_FIELD_INVALID', 'Body must be a JSON object.', 400);
  }

  const keys = Object.keys(patch);
  const rejected = keys.filter((key) => !ME_WRITABLE_FIELDS.includes(key));
  if (rejected.length) {
    throw new AccountError(
      'ACCOUNT_FIELD_NOT_WRITABLE',
      `Not writable here: ${rejected.join(', ')}. Writable: ${ME_WRITABLE_FIELDS.join(', ')}.`,
      422,
    );
  }
  if (!keys.length) return getAccount(uid);

  for (const key of keys) {
    const value = patch[key];
    if (value !== null && typeof value !== 'string') {
      throw new AccountError('ACCOUNT_FIELD_INVALID', `${key} must be a string or null.`, 422);
    }
    if (typeof value === 'string' && value.length > 255) {
      throw new AccountError('ACCOUNT_FIELD_INVALID', `${key} is too long.`, 422);
    }
  }

  /**
   * `displayName` is DERIVED from the name parts, not stored.
   *
   * Storing it too would be a third place a person's name lives, and the three
   * would disagree the first time one write path forgot to update all of them.
   * A caller that sends `displayName` is asking to change their name, so it is
   * split into the parts that are actually stored.
   */
  const body: Record<string, unknown> = { id: uid };
  if ('firstName' in patch) body.first_name = patch.firstName;
  if ('lastName' in patch) body.last_name = patch.lastName;
  if ('photoUrl' in patch) body.photoUrl = patch.photoUrl;
  if ('displayName' in patch && !('firstName' in patch) && !('lastName' in patch)) {
    body.fullname = patch.displayName;
  }

  // ONE writer. `user.service.updateUserProfile` is what the legacy route calls.
  await userService.updateUserProfile(body as never);
  return getAccount(uid);
};

// ─── Customer profile ─────────────────────────────────────────────────────────

export interface CustomerProfileDto {
  uid: string;
  birthDate: string | null;
  gender: string | null;
  photoUrl: string | null;
  /** The address flagged default, so a client needs one call to render checkout. */
  defaultAddressId: string | null;
  addressCount: number;
}

export const getCustomerProfile = async (uid: string): Promise<CustomerProfileDto> => {
  const { rows } = await dbQuery.query(
    `SELECT up.birthdate, up.gender, up.photo_url,
            (SELECT ua.address_id FROM ${s}.user_address ua
              WHERE ua.uid = $1 AND ua.is_primary = TRUE
              ORDER BY ua.created_at ASC LIMIT 1) AS default_address_id,
            (SELECT COUNT(*)::int FROM ${s}.user_address ua2 WHERE ua2.uid = $1) AS address_count
       FROM ${s}.user_credentials uc
       LEFT JOIN ${s}.user_profile up ON up.uid = uc.uid
      WHERE uc.uid = $1
      LIMIT 1`,
    [uid],
  );
  if (!rows.length) {
    throw new AccountError('ACCOUNT_NOT_FOUND', 'No account record exists for this identity yet.', 404);
  }
  const row = rows[0];
  return {
    uid,
    birthDate: row.birthdate ?? null,
    gender: row.gender ?? null,
    photoUrl: row.photo_url ?? null,
    defaultAddressId: row.default_address_id ?? null,
    addressCount: Number(row.address_count ?? 0),
  };
};

export const patchCustomerProfile = async (
  uid: string,
  patch: Record<string, unknown>,
): Promise<CustomerProfileDto> => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new AccountError('ACCOUNT_FIELD_INVALID', 'Body must be a JSON object.', 400);
  }

  const keys = Object.keys(patch);
  const rejected = keys.filter((key) => !CUSTOMER_WRITABLE_FIELDS.includes(key));
  if (rejected.length) {
    throw new AccountError(
      'ACCOUNT_FIELD_NOT_WRITABLE',
      // `defaultAddressId` is the one people will try, so the message names
      // where it actually lives rather than only refusing.
      `Not writable here: ${rejected.join(', ')}. ` +
        'The default address is set through POST /api/v1/customer/addresses/:addressId/default.',
      422,
    );
  }
  if (!keys.length) return getCustomerProfile(uid);

  const body: Record<string, unknown> = { id: uid };
  if ('birthDate' in patch) body.birthdate = patch.birthDate;
  if ('gender' in patch) body.gender = patch.gender;
  if ('photoUrl' in patch) body.photoUrl = patch.photoUrl;

  await userService.updateUserProfile(body as never);
  return getCustomerProfile(uid);
};
