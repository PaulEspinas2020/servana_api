import { db } from "../config";
import dbQuery from "../db/dbQuery";
import dayjs from "dayjs";
import { comparePassword, hashPassword, isValidEmail, validatePassword } from "../helpers/validation";
import * as firebaseFunction from "../services/firebaseFunctions.service";
import * as userService from "../services/user.service";
import { send } from "../helpers/mailer";

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
    const { email, password, firstName, lastName, role } = user;
    let userData;
    let dbData;
    let dbRegister;

    if (email && (!isValidEmail(email) || !validatePassword(password))) {
        throw "Please enter a valid Email or Password";
    }

    try {
        if (email && password) {
            const userInFirebase = await firebaseFunction.checkUserIfExistInFirebase(email);

            if (userInFirebase) {
                throw "User is already Registered. Please login instead.";
            }

            // Use this if we have different mailer
            userData = await firebaseFunction.registerNewUserInFirebase(user);

            if (userData) {
                dbData = {
                    uid: userData.uid,
                    email: userData.email || "",
                    password: hashPassword(password),
                    firstName,
                    lastName,
                    role,
                };
                dbRegister = await userService.registerUserInDB(dbData);
            }
        } else {
            throw "Missing required parameters";
        }

        if (!dbRegister) {
            throw "Failed to Create User in DB";
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

        return dbRegister;
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

export { registerUser, loginUserInDBAndFirebase, loggedInUser, getAndSendEmailVerificationLink, changeArchiveStatus };
