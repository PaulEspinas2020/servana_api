import { db } from "../config";
import dbQuery from "../db/dbQuery";
import dayjs from "dayjs";
import { comparePassword, hashPassword, isValidEmail, validatePassword } from "../helpers/validation";
import * as firebaseFunction from "../services/firebaseFunctions.service";
import * as userService from "../services/user.service";
import * as serviceService from "../services/serviceService";
import * as technicianService from "../services/technicianService";
import { send } from "../helpers/mailer";
import bcrypt from "bcryptjs";
import { generateOTP } from "../helpers/otp";
import { uploadFileToStorage } from "../helpers/firebaseStorageUploader";
import * as addressService from "../services/address.service";
import { idGenerator } from "../helpers/idGenerator";

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
    const { email, password, firstName, lastName, role, platform = "web", serviceIds } = user;
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

            if (role == 2 && serviceIds?.length) {
                await technicianService.assignServicesToEmployee(userData.uid, [Number(serviceIds[0])]);
            }

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

const updateFcmToken = async (userId: string, fcmToken: string) => {
    const updateQuery = `UPDATE ${dbSchema}.user_credentials SET fcm_token = $1 WHERE uid = $2 returning *`;

    try {
        const { rows } = await dbQuery.query(updateQuery, [fcmToken, userId]);
        const dbResponse = rows;
        return dbResponse;
    } catch (error) {
        throw error;
    }
}

export interface EmployeeAddress {
    addressOne: string;
    addressTwo?: string;
    zipCode: string;
    postTown: string;
    country: string;
    label?: string;
    lat: number;
    lon: number;
}

export interface EmployeeInput {
    email: string;
    password?: string;
    firstName: string;
    lastName: string;
    role?: number;
    requirementFiles?: Array<{ data: string; name: string }>;  // base64 data URIs
    address?: EmployeeAddress;
}

const generateTempPassword = (): string => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$";
    return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
};

const addEmployees = async (employees: EmployeeInput[]) => {
   
    const allServiceIds = (await serviceService.getServicesSimpleList()).map((s) => s.id);

    const processOne = async (emp: EmployeeInput) => {
        const { email, firstName, lastName, role = 2 } = emp;
        const password = emp.password || generateTempPassword();

        if (!isValidEmail(email)) {
            return { email, success: false, error: "Invalid email address" };
        }

        const existing = await firebaseFunction.checkUserIfExistInFirebase(email);
        if (existing) {
            return { email, success: false, error: "User already exists" };
        }

        const firebaseUser = await firebaseFunction.registerNewUserInFirebase({
            email, password, firstName, lastName, role,
        });

        if (!firebaseUser) {
            return { email, success: false, error: "Failed to create user in Firebase" };
        }

        const dbUser = await userService.registerUserInDB({
            uid: firebaseUser.uid,
            email: firebaseUser.email || email,
            password: hashPassword(password),
            firstName,
            lastName,
            role,
            phoneNumber: null,
            isEmailVerified: false,
            isPhoneVerified: false,
        });

        if (!dbUser) {
            await firebaseFunction.deleteFirebaseUser(firebaseUser.uid);
            return { email, success: false, error: "Failed to create user in DB" };
        }

        const otpCode = generateOTP();

        const [uploadedRequirements] = await Promise.all([
            emp.requirementFiles?.length
                ? Promise.all(
                    emp.requirementFiles.map((file, i) =>
                        uploadFileToStorage("employee-requirements", `${firebaseUser.uid}_${i}`, file.data)
                            .then((fileUrl) => ({ fileUrl, fileName: file.name }))
                    )
                ).then(async (uploaded) => {
                    await technicianService.addWorkerRequirements(firebaseUser.uid, uploaded);
                    return uploaded;
                })
                : Promise.resolve([] as Array<{ fileUrl: string; fileName: string }>),

            emp.address
                ? addressService.addUserAddress(
                    {
                        userId: firebaseUser.uid,
                        locationId: idGenerator(6, "LOC"),
                        addressOne: emp.address.addressOne,
                        addressTwo: emp.address.addressTwo || "",
                        zipCode: emp.address.zipCode,
                        postTown: emp.address.postTown,
                        country: emp.address.country,
                        label: emp.address.label || "Home",
                        isPrimary: true,
                        lat: emp.address.lat,
                        lon: emp.address.lon,
                    },
                    firebaseUser.uid
                )
                : Promise.resolve(),

            userService.storeEmailOtp(email, otpCode),

            role === 2 && allServiceIds.length
                ? technicianService.assignServicesToEmployee(firebaseUser.uid, allServiceIds)
                : Promise.resolve(),
        ]);

        send(email, "employee_invite", { email, password, otp_code: otpCode, first_name: firstName });

        return { email, success: true, requirements: uploadedRequirements };
    };

    return Promise.all(
        employees.map(async (emp) => {
            try {
                return await processOne(emp);
            } catch (error: any) {
                return { email: emp.email, success: false, error: error?.message || String(error) };
            }
        })
    );
};

const forgotPassword = async (email: string, redirectUrl?: string) => {
    if (!isValidEmail(email)) {
        throw "Please enter a valid email address";
    }

    const firebaseUser = await firebaseFunction.checkUserIfExistInFirebase(email);
    if (!firebaseUser) {
        return { message: "If an account with that email exists, a password reset link has been sent." };
    }

    // When a redirectUrl is provided (e.g. from the provider app), the reset link
    // routes the user directly back to that platform's reset-password page with the
    // oobCode as a query param. Without it, Firebase's default hosted page is used —
    // preserving existing behavior for the client app and admin portal.
    const actionCodeSettings = redirectUrl
        ? { url: redirectUrl, handleCodeInApp: true }
        : undefined;

    const resetLink = await firebaseFunction.generatePasswordResetLink(email, actionCodeSettings);

    const dbUser = await userService.getUserByEmail(email);
    const firstName = dbUser ? dbUser.firstName : "";

    send(email, "forgot_password", {
        reset_url: resetLink,
        first_name: firstName,
        email,
    });

    return { message: "If an account with that email exists, a password reset link has been sent." };
};

const resetPassword = async (payload: { oobCode: string; newPassword: string }) => {
    const { oobCode, newPassword } = payload;

    if (!oobCode || !newPassword) {
        throw "Missing required parameters";
    }

    if (!validatePassword(newPassword)) {
        throw "Password does not meet requirements";
    }

    // verifyPasswordResetCode confirms the oobCode is valid then consumeS it via confirmPasswordReset.
    // Returns the email the code was issued for so we can sync the DB hash.
    const email = await firebaseFunction.resetPasswordWithCode(oobCode, newPassword);

    const firebaseUser = await firebaseFunction.getFirebaseUserByEmail(email);
    if (firebaseUser) {
        await dbQuery.query(
            `UPDATE ${dbSchema}.user_credentials SET password = $1 WHERE uid = $2`,
            [hashPassword(newPassword), firebaseUser.uid]
        );
    }

    return { message: "Password reset successfully." };
};

export { registerUser, loginUserInDBAndFirebase, loggedInUser, getAndSendEmailVerificationLink, changeArchiveStatus,
    verifyEmailOtp, resendEmailOtp, updateFcmToken, addEmployees, forgotPassword, resetPassword };
