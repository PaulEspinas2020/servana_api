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

  const decoded = await defaultAuthAdmin.verifyIdToken(idToken);
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

const registerNewUserInFirebase = async (user: any) => {
    return defaultAuthAdmin
        .createUser({ ...user, displayName: user.firstName + " " + user.lastName })
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
