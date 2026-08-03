import { firebaseAdmin } from "../middleware/firebaseApp";
import { getAuth as getAuthAdmin } from "firebase-admin/auth";
import {
    getAuth,
    signInWithEmailAndPassword,
    applyActionCode,
    createUserWithEmailAndPassword,
    signOut,
    sendEmailVerification,
    confirmPasswordReset,
    verifyPasswordResetCode,
} from "firebase/auth";
import * as userService from "../services/user.service";
import dbQuery from "../db/dbQuery";
import { db as dbConfig } from "../config";
import { findLinkCollision, AccountLinkRequiredError } from "./accountLinkGuard";
import { mergePhoneIntoExistingAccount } from "./accountLinking";

const dbSchema = dbConfig.schema;

const defaultAuthAdmin = getAuthAdmin(firebaseAdmin);

/**
 * role must be "2" (provider) or "3" (customer/client).
 * Defaults to "2" so existing provider-portal callers that omit role are unaffected.
 * ServanaClient should pass role="3" so new customer accounts are not mis-classified.
 * The ON CONFLICT branch in upsertFirebaseUser does NOT update role, so only
 * brand-new accounts (INSERT path) are affected by this value.
 */
const firebaseAuthLogin = async (idToken: string, role: string = "2") => {
  if (!idToken) {
    throw new Error("Missing Firebase ID token");
  }

  // checkRevoked=true: reject tokens that were revoked server-side after logout.
  // Required for session-restore safety — revokeTokenInFirebase() is called on logout,
  // so a page-reload with a cached-but-revoked token must not re-establish the session.
  const decoded = await defaultAuthAdmin.verifyIdToken(idToken, /* checkRevoked */ true);
  const firebaseUser = await defaultAuthAdmin.getUser(decoded.uid);

  // Derive name from Firebase displayName when available (set during registration).
  // upsertFirebaseUser only overwrites DB name when the provided value is non-empty,
  // so an existing name is preserved if displayName is not set on the Firebase user.
  let firstName = "";
  let lastName = "";
  if (firebaseUser.displayName) {
    const parts = firebaseUser.displayName.trim().split(/\s+/);
    firstName = parts[0] || "";
    lastName = parts.slice(1).join(" ") || "";
  }

  /**
   * Before creating a row for a uid that has never been seen, check whether
   * this identifier already belongs to somebody's existing account.
   *
   * Firebase issues a uid per identifier, so a provider who registered by email
   * and signs in by mobile arrives as a DIFFERENT uid. upsertFirebaseUser keys
   * on uid, so it creates a second account and the person lands in an empty
   * portal — no jobs, no earnings — with nothing having errored. That is how one
   * provider ends up as two half-populated records.
   *
   * Scoped to first-sight uids deliberately. If the uid already has a row this
   * is a returning user and nothing is checked, so no existing sign-in can be
   * affected by this guard however the lookup behaves.
   */
  const { rows: existing } = await dbQuery.query(
    `SELECT 1 FROM ${dbSchema}.user_credentials WHERE uid = $1 LIMIT 1`,
    [firebaseUser.uid]
  );
  if (existing.length === 0) {
    const collision = await findLinkCollision(
      firebaseUser.uid,
      firebaseUser.email || null,
      firebaseUser.phoneNumber || null
    );

    if (collision) {
      /**
       * Mobile collisions are MERGED: this sign-in proved possession of the
       * number, and the account that claims it is the same person. The orphan
       * uid is folded into the existing account so only one uid survives.
       *
       * Email collisions are not merged here. An email sign-in that lands on a
       * different uid than the account holding that address means two Firebase
       * identities exist for one address — which Firebase itself prevents for
       * password auth, so reaching this means a federated provider is involved
       * and the right resolution is not obvious enough to take automatically.
       */
      if (collision.via === "mobile") {
        const merge = await mergePhoneIntoExistingAccount({
          incomingUid: firebaseUser.uid,
          signInProvider: (decoded as any)?.firebase?.sign_in_provider,
          phoneNumber: firebaseUser.phoneNumber || null,
          canonicalUid: collision.existingUid,
        });

        if (merge.merged) {
          // The caller's token belongs to a uid that no longer exists, so it
          // cannot be used to continue. The custom token lets them complete
          // sign-in as the surviving account without a second OTP, having
          // already proven the number seconds ago.
          return {
            data: {
              success: true,
              relinked: true,
              customToken: merge.customToken,
              uid: merge.canonicalUid,
              id: merge.canonicalUid,
              message:
                "This mobile number belongs to your existing account. Signing you into it.",
            },
          };
        }
        console.warn(
          `[link] merge declined for ${firebaseUser.uid}: ${merge.reason}`
        );
      }

      throw new AccountLinkRequiredError(collision.via);
    }
  }

  const dbUser = await userService.upsertFirebaseUser({
    uid: firebaseUser.uid,
    email: firebaseUser.email || null,
    phoneNumber: firebaseUser.phoneNumber || null,
    firstName,
    lastName,
    role,
  });

  // Deny login for archived / disabled provider accounts.
  if (dbUser.isArchived) {
    throw new Error("Your account has been disabled. Please contact Servana support.");
  }

  return {
    data: {
      success: true,
      token: idToken,
      id: firebaseUser.uid,
      uid: firebaseUser.uid,
      role: dbUser.role,
      firstName: dbUser.firstName || "",
      lastName: dbUser.lastName || "",
      fullname: [dbUser.firstName, dbUser.lastName].filter(Boolean).join(" "),
      email: dbUser.email || null,
      phoneNumber: firebaseUser.phoneNumber || null,
      message: "Authenticated successfully",
    },
  };
};
/**
 * Registers a provider who just completed Firebase phone auth.
 * Sets the Firebase displayName so future firebase-login calls preserve the name,
 * then upserts the DB record with the explicit first/last name from the signup form.
 * Returns the same response shape as firebaseAuthLogin.
 *
 * Only used by /auth/provider/register — existing mobile and web login routes are unchanged.
 */
const firebaseProviderRegister = async (
  idToken: string,
  firstName: string,
  lastName: string,
) => {
  if (!idToken) { throw new Error("Missing Firebase ID token"); }
  if (!firstName || !lastName) { throw new Error("firstName and lastName are required"); }

  const decoded = await defaultAuthAdmin.verifyIdToken(idToken);
  const firebaseUser = await defaultAuthAdmin.getUser(decoded.uid);

  // Persist the name on the Firebase user record so firebase-login picks it up on next sign-in.
  const displayName = `${firstName.trim()} ${lastName.trim()}`.trim();
  if (displayName) {
    await defaultAuthAdmin.updateUser(firebaseUser.uid, { displayName }).catch(() => {
      // Non-fatal — DB name is the source of truth for the web portal.
    });
  }

  const dbUser = await userService.upsertFirebaseUser({
    uid: firebaseUser.uid,
    email: firebaseUser.email || null,
    phoneNumber: firebaseUser.phoneNumber || null,
    firstName,
    lastName,
    role: "2",
  });

  if (dbUser.isArchived) {
    throw new Error("Your account has been disabled. Please contact Servana support.");
  }

  return {
    data: {
      success: true,
      uid: firebaseUser.uid,
      role: dbUser.role,
      firstName: dbUser.firstName || "",
      lastName: dbUser.lastName || "",
      fullname: [dbUser.firstName, dbUser.lastName].filter(Boolean).join(" "),
      email: dbUser.email || null,
      phoneNumber: firebaseUser.phoneNumber || null,
      message: "Registration successful",
    },
  };
};

/**
 * Customer social sign-in (Google / Facebook).
 * Verifies the Firebase ID token, upserts the customer in user_credentials with role='3'
 * (role is only set on INSERT — existing accounts keep their original role), and returns
 * a session shape compatible with the email/password login response so the Flutter client
 * can parse it identically.
 *
 * The token in the response IS the same Firebase ID token that was sent in — the Servana
 * backend validates Bearer tokens via Firebase Admin verifyIdToken(), so no separate JWT
 * is needed. The caller stores this token and sends it as Authorization: Bearer on every
 * subsequent authenticated request.
 */
const customerFirebaseLogin = async (idToken: string) => {
  if (!idToken) { throw new Error("Missing Firebase ID token"); }

  const decoded = await defaultAuthAdmin.verifyIdToken(idToken);
  const firebaseUser = await defaultAuthAdmin.getUser(decoded.uid);

  let firstName = "";
  let lastName = "";
  if (firebaseUser.displayName) {
    const parts = firebaseUser.displayName.trim().split(/\s+/);
    firstName = parts[0] || "";
    lastName = parts.slice(1).join(" ") || "";
  }

  const dbUser = await userService.upsertFirebaseUser({
    uid: firebaseUser.uid,
    email: firebaseUser.email || null,
    phoneNumber: firebaseUser.phoneNumber || null,
    firstName,
    lastName,
    role: "3",
  });

  if (dbUser.isArchived) {
    throw Object.assign(
      new Error("Your account has been disabled. Please contact Servana support."),
      { disabled: true },
    );
  }

  const fullname = [dbUser.firstName, dbUser.lastName].filter(Boolean).join(" ");

  return {
    status: "success",
    data: {
      token: idToken,
      id: firebaseUser.uid,
      customerID: firebaseUser.uid,
      fullname,
      phoneNumber: dbUser.phoneNumber || firebaseUser.phoneNumber || "",
      mobileNumber: dbUser.phoneNumber || firebaseUser.phoneNumber || "",
      email: dbUser.email || firebaseUser.email || "",
      emailAddress: dbUser.email || firebaseUser.email || "",
    },
  };
};

const checkUserIfExistInFirebase = async (email: string) => {
    return defaultAuthAdmin
        .getUserByEmail(email)
        .then((user) => {
            return user;
        })
        .catch((err) => {
            return null;
        });
};

/**
 * Normalises a Philippine mobile number to E.164, or returns null.
 *
 * firebase-admin requires a leading '+' (utils/validator.js isPhoneNumber) and
 * rejects anything else — including the empty string, because it checks
 * `typeof !== 'undefined'` rather than truthiness. Customers type 09171234567,
 * which is the normal local form and which firebase-admin will not take.
 */
const toE164PH = (raw: unknown): string | null => {
    if (typeof raw !== "string") return null;
    const digits = raw.replace(/[^\d+]/g, "");
    if (!digits) return null;
    if (/^\+63\d{10}$/.test(digits)) return digits;      // +639171234567
    if (/^63\d{10}$/.test(digits)) return `+${digits}`;   // 639171234567
    if (/^0\d{10}$/.test(digits)) return `+63${digits.slice(1)}`; // 09171234567
    if (/^\+\d{8,15}$/.test(digits)) return digits;       // already E.164, other country
    return null;
};

/**
 * Creates the Firebase auth user for a registration.
 *
 * ## This used to spread the whole request body
 *
 *     createUser({ ...user, displayName })
 *
 * Two P0s came out of that single line.
 *
 * 1. SIGN-UP WAS BROKEN. ServanaClient always sends `phoneNumber` and defaults
 *    it to '' for a field its own UI labels "(optional)"
 *    (http_backend.dart:130). firebase-admin rejects '' and rejects
 *    '09171234567', so every email/password customer registration failed unless
 *    the customer happened to type '+63…'. The controller collapsed the error
 *    to "Registration failed. Please try again.", naming no field.
 *
 * 2. MASS ASSIGNMENT. Every other key the caller sent reached the SDK too,
 *    including `emailVerified` — so a registration could self-verify its own
 *    address and skip the OTP gate that sign-in enforces.
 *
 * An explicit payload fixes both, and is the reason to prefer whitelists over
 * spreads at any boundary where the object came from a request.
 */
const registerNewUserInFirebase = async (user: any) => {
    const phoneNumber = toE164PH(user?.phoneNumber);

    const payload: {
        email: string;
        password: string;
        displayName: string;
        phoneNumber?: string;
    } = {
        email: user.email,
        password: user.password,
        displayName: `${user.firstName} ${user.lastName}`,
    };

    // Omitted entirely when absent or unparseable — firebase-admin only
    // validates the key when it is present, so omission is what makes an
    // optional field actually optional.
    if (phoneNumber) payload.phoneNumber = phoneNumber;

    return defaultAuthAdmin
        .createUser(payload)
        .then(async (userData) => {
            return userData;
        })
        .catch((error) => {
            console.log("Firebase Error");
            console.log(error);
            throw error;
        });
};

const sendEmailVerificationFirebase = async (email: string) => {
    try {
        const link = await defaultAuthAdmin.generateEmailVerificationLink(email);
        return link;
    } catch (err: any) {
        console.error('sendEmailVerificationFirebase failed:', err?.code || err?.message || err);
        throw "Failed to generate verification link";
    }
};

const revokeTokenInFirebase = (uid: string) => {
    return defaultAuthAdmin.revokeRefreshTokens(uid);
};

const signInUserAndGetTokeninFirebase = async (email: string, password: string) => {
    let token, refreshToken;

    try {
        const auth = getAuth();

        const { user } = await signInWithEmailAndPassword(auth, email, password);

        if (!user.emailVerified) {
            revokeTokenInFirebase(user.uid);
            const errorMessage = "Please Verify Email with the link sent to your registered email address.";
            throw Error(errorMessage);
        }

        if (auth) {
            token = await auth?.currentUser?.getIdToken();
            refreshToken = auth?.currentUser?.refreshToken;
        }

        const firebaseUser = {
            uid: user.uid,
            token,
            refreshToken,
        };

        return firebaseUser;
    } catch (err) {
        throw err;
    }
};

const getFirebaseUserByEmail = async (email: string) => {
    try {
        return await defaultAuthAdmin.getUserByEmail(email);
    } catch (error: any) {
        if (error.code === "auth/user-not-found") {
            return null;
        }
        throw error;
    }
};

const updateFirebaseEmailVerified = async (uid: string, emailVerified: boolean) => {
    return await defaultAuthAdmin.updateUser(uid, {
        emailVerified,
    });
};

const deleteFirebaseUser = async (uid: string) => {
    return await defaultAuthAdmin.deleteUser(uid);
};

const generatePasswordResetLink = async (email: string, continueUrl?: string): Promise<string> => {
    const actionCodeSettings = continueUrl ? { url: continueUrl } : undefined;
    return defaultAuthAdmin.generatePasswordResetLink(email, actionCodeSettings);
};

const updateFirebasePassword = async (uid: string, newPassword: string): Promise<void> => {
    await defaultAuthAdmin.updateUser(uid, { password: newPassword });
};

/**
 * Verifies a Firebase password reset oobCode and applies the new password in one step.
 * Returns the email address the code was issued for (needed to sync DB).
 * The oobCode is single-use — it is consumed by confirmPasswordReset.
 */
const resetPasswordWithCode = async (oobCode: string, newPassword: string): Promise<string> => {
    const auth = getAuth();
    const email = await verifyPasswordResetCode(auth, oobCode);
    await confirmPasswordReset(auth, oobCode, newPassword);
    return email;
};

const getFirebaseUserByUid = async (uid: string) => {
    return await defaultAuthAdmin.getUser(uid);
};

export {
    toE164PH,
    checkUserIfExistInFirebase,
    registerNewUserInFirebase,
    sendEmailVerificationFirebase,
    signInUserAndGetTokeninFirebase,
    firebaseAuthLogin,
    firebaseProviderRegister,
    customerFirebaseLogin,
    getFirebaseUserByEmail,
    getFirebaseUserByUid,
    updateFirebaseEmailVerified,
    deleteFirebaseUser,
    generatePasswordResetLink,
    updateFirebasePassword,
    revokeTokenInFirebase,
    resetPasswordWithCode,
};
