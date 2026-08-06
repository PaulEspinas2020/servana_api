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
import { randomInt } from "crypto";
import { generateOTP } from "../helpers/otp";
import { uploadFileToStorage } from "../helpers/firebaseStorageUploader";
import uploadInStorage from "../helpers/firebaseStorageUploader";
import * as addressService from "../services/address.service";
import { idGenerator } from "../helpers/idGenerator";
import { continueUrlFor } from "../constants/platformContinueUrls";

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
            throw Object.assign(new Error('Invalid email or password.'), { statusCode: 401 });
        }

        if (!firebaseAuthentication.emailVerified) {
            // Admin users (role=1) are invited by other admins, not self-registered.
            // Auto-verify on first login so they can sign in immediately without
            // waiting for an email link they were never sent.
            const dbUserForRoleCheck = await userService.getUserByEmail(email);
            if (dbUserForRoleCheck && Number(dbUserForRoleCheck.role) === 1) {
                await firebaseFunction.updateFirebaseEmailVerified(firebaseAuthentication.uid, true);
                await userService.updateEmailVerifiedByUid(firebaseAuthentication.uid, true);
            } else {
                throw Object.assign(
                    new Error("Email not verified. Please check your inbox for a verification link."),
                    { statusCode: 403 }
                );
            }
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

    const ALLOWED_PUBLIC_ROLES = [2, 3]; // provider=2, client=3; admins must use /auth/add-employees
    if (!ALLOWED_PUBLIC_ROLES.includes(Number(role))) {
        throw Object.assign(new Error("Invalid role. Admin accounts cannot be created via this endpoint."), { statusCode: 403 });
    }

    if (email && (!isValidEmail(email) || !validatePassword(password))) {
        throw "Please enter a valid Email or Password";
    }

    try {

        const userInFirebase = await firebaseFunction.checkUserIfExistInFirebase(email);

        if (userInFirebase) {
            // Generic message — do not reveal whether the email exists in the system.
            throw Object.assign(new Error('Registration failed. Please try again.'), { statusCode: 409 });
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


        // Reached only when `platform !== "mobile"` — the OTP branch above
        // returns before here. So a mobile registration cannot acquire a
        // continueUrl by this path even if one were somehow resolvable for it.
        //
        // `platform` carries two vocabularies (see platformContinueUrls.ts):
        // this call reads it as a destination name, and only 'provider' and
        // 'customer' resolve. The default 'web', which every existing caller
        // sends, resolves to undefined and keeps Firebase's hosted page.
        const verify = await firebaseFunction.sendEmailVerificationFirebase(
            dbRegister.email,
            continueUrlFor('verify', platform),
        );

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
            // verify intentionally excluded from response — link travels via email only
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

    // Always return the same response — never reveal account existence or send status.
    const NEUTRAL = { message: "If this account exists and is unverified, an OTP has been sent.", verificationType: "otp" };

    try {
        const dbUser = await userService.getUserByEmail(email);

        if (!dbUser || dbUser.isEmailVerified) {
            return NEUTRAL;
        }

        try {
            const otpCode = generateOTP();
            await userService.storeEmailOtp(email, otpCode);
            await send(email, "verify_email_otp", {
                otp_code: otpCode,
                first_name: dbUser.firstName,
                email,
            });
        } catch (sendErr: any) {
            // DB / email failure must not reveal itself — log for ops, return neutral to caller.
            console.error('resendEmailOtp: OTP send failed', { email: email?.slice(0, 3) + '***', err: sendErr?.message || sendErr });
        }

        return NEUTRAL;
    } catch (error) {
        throw error;
    }
};

const loginUserInDBAndFirebase = async (email: string, password: string) => {
    try {
        const dbCredentials = await userService.getUserCredentialsByEmail(email, true);
        if (!dbCredentials) {
            throw Object.assign(new Error('Invalid email or password.'), { statusCode: 401 });
        }

        // Archived accounts cannot sign in.
        //
        // Both Firebase sign-in paths already refuse them (firebaseAuthLogin and
        // customerFirebaseLogin check dbUser.isArchived), and the admin portal's
        // archive action is meaningless if this one route ignores it. The lookup
        // did not even select the column, so this path could not have checked.
        if ((dbCredentials as any).isArchived) {
            throw Object.assign(
                new Error('Your account has been disabled. Please contact Servana support.'),
                { statusCode: 403 },
            );
        }

        // Firebase is the authority on the password; the local bcrypt hash is a
        // cache of it. They drift: a customer who resets their password through
        // the Firebase-hosted page changes it in Firebase only, and this compare
        // then fails forever — the account is locked out with "Invalid email or
        // password" while the new password is, from the customer's point of
        // view, correct.
        //
        // So a failed local compare is not authoritative. Ask Firebase, and if
        // Firebase accepts the password, re-sync the stale hash. Only when
        // Firebase also rejects it is the credential actually wrong.
        const localHashMatches = comparePassword(dbCredentials?.password, password);

        const firebaseUser = await firebaseFunction.signInUserAndGetTokeninFirebase(email, password);

        if (!localHashMatches) {
            // Reached only when Firebase authenticated successfully, so the
            // password is correct and the stored hash is simply out of date.
            await userService
                .updateUserPasswordHash(firebaseUser.uid, hashPassword(password))
                .catch(() => {
                    // Non-fatal: the customer is authenticated either way, and
                    // the next successful sign-in will try again.
                });
        }
        // Whitelist only the fields the frontend needs — never spread the full DB row.
        //
        // refreshToken is returned deliberately. `token` is a Firebase ID token
        // and expires after ONE HOUR — verifyAuth rejects it with 401
        // TOKEN_EXPIRED after that. Firebase hands us a refresh token here and
        // this whitelist used to drop it, so every mobile client received a
        // credential it could not renew. Both apps cached it at sign-in and
        // reused it forever, which meant every authenticated route began
        // failing an hour into a session and the apps signed the user out.
        //
        // Clients exchange this at POST /api/auth/refresh. It is a long-lived
        // credential and belongs in secure storage on the device, never in a
        // log or a query string.
        const credentials = {
            token: firebaseUser.token,
            refreshToken: firebaseUser.refreshToken,
            id: firebaseUser.uid,
            uid: firebaseUser.uid,
            email: dbCredentials.email,
            role: dbCredentials.role,
            firstName: dbCredentials.firstName,
            lastName: dbCredentials.lastName,
            isEmailVerified: dbCredentials.isEmailVerified,
        };

        if (dbCredentials.role == 2) {
            // TODO get additional for cleaners
        }

        return credentials;
    } catch (error) {
        throw error;
    }
};

/**
 * `continueUrl` is optional and defaults to today's behaviour — no
 * ActionCodeSettings, so the link ends on Firebase's own hosted page. Both
 * existing callers omit it.
 */
const getAndSendEmailVerificationLink = async (
    email: string,
    firstName = null,
    continueUrl?: string,
) => {
    const verify = await firebaseFunction.sendEmailVerificationFirebase(email, continueUrl);
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

    // Link travels via email only — never returned in the API response
    return { message: "Verification link sent." };
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

export interface EmployeeUpdateInput {
    firstName?: string;
    lastName?: string;
    password?: string;
    photoFile?: string;
    requirementFiles?: Array<{ data: string; name: string }>;
    address?: EmployeeAddress;
}

/**
 * Generates a temporary password for a newly created employee account.
 *
 * C19 §13. This used `Math.random()` to pick each character. That is a
 * non-cryptographic PRNG whose state is recoverable from observed output, so
 * the credential it produced was predictable — and it is a password, handed to
 * a real account, over a channel the recipient does not control.
 *
 * `randomInt` draws from the OS CSPRNG and rejection-samples, so there is no
 * modulo bias across the 59-character alphabet either. Alphabet and length are
 * unchanged.
 */
const generateTempPassword = (): string => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$";
    return Array.from({ length: 12 }, () => chars[randomInt(chars.length)]).join("");
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

        // Role=1 (admin) users are invited by other admins, not through public
        // self-registration. Their email is implicitly trusted, so mark it
        // verified at creation time so they can sign in immediately.
        const isAdmin = role === 1;
        const firebaseUser = await firebaseFunction.registerNewUserInFirebase({
            email, password, firstName, lastName, role,
            ...(isAdmin && { emailVerified: true }),
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
            isEmailVerified: isAdmin,
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

        return { email, success: true, uid: firebaseUser.uid, requirements: uploadedRequirements };
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

const updateEmployee = async (uid: string, updates: EmployeeUpdateInput) => {
    const { firstName, lastName, password, photoFile, requirementFiles, address } = updates;

    const firebaseUser = await firebaseFunction.getFirebaseUserByEmail(
        (await userService.getUserCredentialsByID(uid))?.email || ""
    );
    if (!firebaseUser) throw "Employee not found";

    const tasks: Promise<any>[] = [];

    if (firstName || lastName) {
        const setClause: string[] = [];
        const values: any[] = [];
        let idx = 1;
        if (firstName) { setClause.push(`first_name = $${idx++}`); values.push(firstName); }
        if (lastName)  { setClause.push(`last_name = $${idx++}`);  values.push(lastName);  }
        values.push(uid);
        tasks.push(dbQuery.query(
            `UPDATE ${dbSchema}.user_credentials SET ${setClause.join(", ")} WHERE uid = $${idx} RETURNING *`,
            values
        ));
    }

    if (photoFile) {
        tasks.push(
            uploadInStorage("Employee Profile Photo", uid, photoFile).then((photoUrl) =>
                dbQuery.query(
                    `INSERT INTO ${dbSchema}.user_profile (uid, photo_url)
                     VALUES ($1, $2)
                     ON CONFLICT (uid) DO UPDATE SET photo_url = $2`,
                    [uid, photoUrl]
                )
            )
        );
    }

    if (password) {
        if (!validatePassword(password)) throw "Password does not meet requirements";
        tasks.push(firebaseFunction.updateFirebasePassword(firebaseUser.uid, password));
        tasks.push(dbQuery.query(
            `UPDATE ${dbSchema}.user_credentials SET password = $1 WHERE uid = $2`,
            [hashPassword(password), uid]
        ));
    }

    if (requirementFiles?.length) {
        tasks.push(
            Promise.all(
                requirementFiles.map((file, i) =>
                    uploadFileToStorage("employee-requirements", `${uid}_${i}`, file.data)
                        .then((fileUrl) => ({ fileUrl, fileName: file.name }))
                )
            ).then((uploaded) => technicianService.addWorkerRequirements(uid, uploaded))
        );
    }

    if (address) {
        const existing = await addressService.getAddressesByUserId(uid);
        const primary = existing.find((a: any) => a.isPrimary) || existing[0];

        if (primary) {
            tasks.push(addressService.updateUserAddress(
                {
                    userId: uid,
                    locationId: primary.locationId || idGenerator(6, "LOC"),
                    addressOne: address.addressOne,
                    addressTwo: address.addressTwo || "",
                    zipCode: address.zipCode,
                    postTown: address.postTown,
                    country: address.country,
                    label: address.label || primary.label || "Home",
                    isPrimary: true,
                    lat: address.lat,
                    lon: address.lon,
                },
                uid,
                primary.addressId
            ));
        } else {
            tasks.push(addressService.addUserAddress(
                {
                    userId: uid,
                    locationId: idGenerator(6, "LOC"),
                    addressOne: address.addressOne,
                    addressTwo: address.addressTwo || "",
                    zipCode: address.zipCode,
                    postTown: address.postTown,
                    country: address.country,
                    label: address.label || "Home",
                    isPrimary: true,
                    lat: address.lat,
                    lon: address.lon,
                },
                uid
            ));
        }
    }

    await Promise.all(tasks);
    return { uid, message: "Employee updated successfully." };
};

const forgotPassword = async (email: string, continueUrl?: string) => {
    if (!isValidEmail(email)) {
        throw "Please enter a valid email address";
    }

    const firebaseUser = await firebaseFunction.checkUserIfExistInFirebase(email);
    if (!firebaseUser) {
        return { message: "If an account with that email exists, a password reset link has been sent." };
    }

    const resetLink = await firebaseFunction.generatePasswordResetLink(email, continueUrl);

    const dbUser = await userService.getUserByEmail(email);
    const firstName = dbUser?.firstName || "";

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

    // Verify the oobCode with Firebase (single-use; consumed by this call).
    // Returns the email address associated with the reset link.
    const email = await firebaseFunction.resetPasswordWithCode(oobCode, newPassword);

    // Sync the hashed password in DB so email+password signin stays consistent with Firebase.
    // Non-fatal: oobCode is already consumed so we cannot retry — log and continue.
    // Firebase auth still works even if this sync fails.
    try {
        const firebaseUser = await firebaseFunction.getFirebaseUserByEmail(email);
        if (firebaseUser) {
            const updateQuery = `UPDATE ${dbSchema}.user_credentials SET password = $1 WHERE uid = $2`;
            await dbQuery.query(updateQuery, [hashPassword(newPassword), firebaseUser.uid]);
        }
    } catch (syncErr: any) {
        console.error('resetPassword: DB hash sync failed after Firebase reset', { email: email?.slice(0, 3) + '***', syncErr: syncErr?.message || syncErr });
    }

    return { message: "Password reset successfully." };
};

export { registerUser, loginUserInDBAndFirebase, loggedInUser, getAndSendEmailVerificationLink, changeArchiveStatus,
    verifyEmailOtp, resendEmailOtp, updateFcmToken, addEmployees, updateEmployee, forgotPassword, resetPassword };
