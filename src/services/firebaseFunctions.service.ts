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
} from "firebase/auth";

const defaultAuthAdmin = getAuthAdmin(firebaseAdmin);

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
    } catch (err) {
        throw "Email " + err;
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

export { checkUserIfExistInFirebase, registerNewUserInFirebase, sendEmailVerificationFirebase, signInUserAndGetTokeninFirebase };
