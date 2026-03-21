import { db } from "../config";
import dbQuery from "../db/dbQuery";
import dayjs from "dayjs";
import { comparePassword, hashPassword, isValidEmail, validatePassword } from "../helpers/validation";
import * as firebaseFunction from "../services/firebaseFunctions.service";
import * as userService from "../services/user.service";
import { send } from "../helpers/mailer";
import bcrypt from "bcryptjs";
import { generateOTP } from "../helpers/otp";

const now = dayjs();
const dbSchema = db.schema;

const loggedInUser = async (email: string, password: string) => {
    let credentials;

    try {
        if (!isValidEmail(email) || !validatePassword(password)) {
            throw Error("Please enter a valid Email or Password");
        }

        const firebaseAuthentication = await firebaseFunction.checkUserIfExistInFirebase(email);
        if (!firebaseAuthentication) {
            throw Error("User does not exist. Please Register.");
        }

        if (!firebaseAuthentication.emailVerified) {
            throw Error("Please Verify Email with the link sent to your registered email address.");
        }

        credentials = await loginUserInDBAndFirebase(email, password);

        // if (credentials.role == 2) {
        //     const cleanerProfile = await cleanerService.getCleanerProfileByUID(credentials.id);
        //     return {
        //         ...credentials,
        //         cleanerId: cleanerProfile?.cleanerId,
        //     };
        // }

        return credentials;
    } catch (error) {
        throw error;
    }
};

const registerUser = async (user: UserCredentialsReq) => {
    const { email, password, firstName, lastName, role, platform = "web" } = user;
    let userData;
    let dbData;
    let dbRegister;

    if (!email || !password || !firstName || !lastName || !role) {
        throw "Missing required parameters";
    }

    if (email && (!isValidEmail(email) || !validatePassword(password))) {
        throw "Please enter a valid Email or Password";
    }

    try {

        const userInFirebase = await firebaseFunction.checkUserIfExistInFirebase(email);

        if (userInFirebase) {
            throw "User is already Registered. Please login instead.";
        }

        // Use this if we have different mailer
        userData = await firebaseFunction.registerNewUserInFirebase(user);
        if (!userData) {
            throw "Failed to create user in Firebase";
        }

        dbData = {
            uid: userData.uid,
            email: userData.email || "",
            password: hashPassword(password),
            firstName,
            lastName,
            role,
            phoneNumber: userData.phoneNumber || null,
            isEmailVerified: false,
            isPhoneVerified: !!userData.phoneNumber,
        };
        dbRegister = await userService.registerUserInDB(dbData);
        if (!dbRegister) {
            await firebaseFunction.deleteFirebaseUser(userData.uid);
            throw "Failed to Create User in DB";
        }
        if (platform === "mobile") {
            const otpCode = generateOTP();

            await userService.storeEmailOtp(dbRegister.email, otpCode);

            send(dbRegister.email, "verify_email_otp", {
                otp_code: otpCode,
                first_name: dbRegister.firstName,
                email: dbRegister.email,
            });

            return {
                dbRegister,
                verificationType: "otp",
                message: "User created successfully. OTP sent to email.",
            };
        }


        const verify = await firebaseFunction.sendEmailVerificationFirebase(dbRegister.email);

        if (!verify) {
            throw "User created but failed to generate Verification link";
        }

        send(dbRegister.email, "verify_email", {
            verify_url: verify + `&role=${role}`,
            first_name: dbRegister.firstName,
            email: dbRegister.email,
        });

        return {
            dbRegister,
            verify,
            verificationType: "link",
            message: "User created successfully. Verification link sent to email.",
        };
    } catch (error) {
        throw error;
    }
};

const verifyEmailOtp = async (payload: { email: string; otp: string }) => {
    const { email, otp } = payload;

    if (!email || !otp) {
        throw "Missing required parameters";
    }

    try {
        const otpRow = await userService.getLatestValidEmailOtp(email);

        if (!otpRow) {
            throw "Invalid or expired OTP";
        }

        const isMatch = await bcrypt.compare(otp, otpRow.code_hash);

        if (!isMatch) {
            throw "Invalid or expired OTP";
        }

        await userService.markEmailOtpAsUsed(otpRow.id);

        const firebaseUser = await firebaseFunction.getFirebaseUserByEmail(email);

        if (!firebaseUser) {
            throw "User not found in Firebase";
        }

        await firebaseFunction.updateFirebaseEmailVerified(firebaseUser.uid, true);

        const updatedUser = await userService.updateEmailVerifiedByUid(firebaseUser.uid, true);

        return {
            user: updatedUser,
            verificationType: "otp",
            message: "Email verified successfully.",
        };
    } catch (error) {
        throw error;
    }
};

const resendEmailOtp = async (payload: { email: string }) => {
    const { email } = payload;

    if (!email) {
        throw "Missing required parameters";
    }

    try {
        const dbUser = await userService.getUserByEmail(email);

        if (!dbUser) {
            throw "User not found";
        }

        if (dbUser.isEmailVerified) {
            throw "Email is already verified";
        }

        const otpCode = generateOTP();

        await userService.storeEmailOtp(email, otpCode);

        await send(email, "verify_email_otp", {
            otp_code: otpCode,
            first_name: dbUser.firstName,
            email,
        });

        return {
            message: "OTP resent successfully.",
            verificationType: "otp",
        };
    } catch (error) {
        throw error;
    }
};

const loginUserInDBAndFirebase = async (email: string, password: string) => {
    try {
        const dbCredentials = await userService.getUserCredentialsByEmail(email, true);
        if (!dbCredentials) {
            throw Error("User does not exist");
        }

        if (!comparePassword(dbCredentials?.password, password)) {
            throw Error("Please enter a valid Password");
        }

        const firebaseUser = await firebaseFunction.signInUserAndGetTokeninFirebase(email, password);
        delete dbCredentials.password;
        const credentials = {
            token: firebaseUser.token,
            refreshToken: firebaseUser.refreshToken,
            ...dbCredentials,
            id: firebaseUser.uid,
        };

        if (dbCredentials.role == 2) {
            // TODO get additional for cleaners
        }

        return credentials;
    } catch (error) {
        throw error;
    }
};

const getAndSendEmailVerificationLink = async (email: string, firstName = null) => {
    const verify = await firebaseFunction.sendEmailVerificationFirebase(email);
    if (!verify) {
        throw Error("Failed Verification");
    }

    if (!firstName) {
        firstName = await userService.getNameByEmail(email);
    }

    send(email, "verify_email", {
        verify_url: verify,
        name: firstName,
        email,
    });

    return verify;
};

const changeArchiveStatus = async (userId: string, archiveStatus: boolean) => {
    const updateQuery = `UPDATE ${dbSchema}.user_credentials SET is_archive = $1 WHERE uid = $2 returning *`;

    try {
        const { rows } = await dbQuery.query(updateQuery, [archiveStatus, userId]);
        const dbResponse = rows;
        return dbResponse;
    } catch (error) {
        throw error;
    }
};

export { registerUser, loginUserInDBAndFirebase, loggedInUser, getAndSendEmailVerificationLink, changeArchiveStatus, 
    verifyEmailOtp, resendEmailOtp };
