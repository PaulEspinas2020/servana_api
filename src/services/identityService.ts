/**
 * The one place "who is this caller" is answered.
 *
 * Extracted from `providerController.getMe`, which built this projection inline
 * and was therefore the only place it existed. `/api/auth/me` (Provider Web) and
 * `/api/v1/me` (everything new) both call this function, so the two cannot
 * answer differently — which is the whole point of §10. Only the envelope
 * differs between them.
 *
 * The name is deliberately not "user" or "profile": `/api/user/profile` already
 * means something else — the customer profile aggregate with addresses and
 * preferences. This is the identity record and nothing more.
 *
 * §58: no FCM token, no password hash, no auth-provider metadata. A caller
 * learns who they are, not how they authenticate.
 */

import dbQuery from '../db/dbQuery';
import { db } from '../config';

const dbSchema = db.schema;

export interface Identity {
  id: string;
  uid: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  role: number | string | null;
  isEmailVerified: boolean | null;
  phoneNumber: string | null;
}

/**
 * Returns the identity record for a verified uid, or null when the token is
 * valid but no credential row exists.
 *
 * That second case is real and is not a 500: a Firebase user can exist before
 * `upsertFirebaseUser` has run, which is exactly the window a fresh phone
 * sign-in passes through.
 */
export const getIdentity = async (uid: string): Promise<Identity | null> => {
  const result = await dbQuery.query(
    `SELECT uid, email, first_name, last_name, role, is_email_verified, phone_number
       FROM ${dbSchema}.user_credentials WHERE uid = $1 LIMIT 1`,
    [uid],
  );

  if (!result.rows.length) return null;

  const row = result.rows[0];
  return {
    id: row.uid,
    uid: row.uid,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    role: row.role,
    isEmailVerified: row.is_email_verified,
    phoneNumber: row.phone_number,
  };
};
