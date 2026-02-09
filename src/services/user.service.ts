import { db } from "../config";
import dbQuery from "../db/dbQuery";
const dbSchema = db.schema;
import dayjs from "dayjs";
import uploadInStorage from "../helpers/firebaseStorageUploader";

const now = dayjs();

const registerUserInDB = async (user: UserCredentialsReq) => {
    const insertQueryInCredentials = `INSERT INTO ${dbSchema}.user_credentials
      (uid, email, first_name, last_name, "role", created_date, "password")
      VALUES($1, $2, $3, $4, $5, $6, $7) returning *;`;

    try {
        const { rows } = await dbQuery.query(insertQueryInCredentials, [
            user.uid,
            user.email,
            user.firstName,
            user.lastName,
            user.role,
            now,
            user.password,
        ]);

        if (!rows && rows.length == 0) {
            throw "User not save in DB";
        }

        if (user && user.role == 2) {
            await updateUserProfile({
                id: user.uid,
            });
        }

        const dbResponse = formatUserCredentials(rows[0]);
        return dbResponse;
    } catch (error) {
        throw error;
    }
};

const getUserCredentialsByEmail = async (email: string, withPassword = false) => {
    const searchQuery = `
      Select 
        c.uid, c.email, c.password, c.first_name, c.last_name, c.role, c.created_date
      from ${dbSchema}.user_credentials c
      where c.email = $1`;

    try {
        const { rows } = await dbQuery.query(searchQuery, [email]);

        if (!rows && rows.length == 0) {
            return null;
        }
        const dbResponse = formatUserCredentials(rows[0]);

        if (withPassword) {
            return {
                ...dbResponse,
                password: rows[0].password,
            };
        }
        return dbResponse;
    } catch (error) {
        throw error;
    }
};

const getUserCredentialsByID = async (uid: string, withPassword = false) => {
    const searchQuery = `
      Select 
        c.uid, c.email, c.password, c.first_name, c.last_name, c.role, c.created_date
      from ${dbSchema}.user_credentials c
      where c.uid = $1`;

    try {
        const { rows } = await dbQuery.query(searchQuery, [uid]);

        if (!rows && rows.length == 0) {
            return null;
        }
        const dbResponse = formatUserCredentials(rows[0]);

        if (withPassword) {
            return {
                ...dbResponse,
                password: rows[0].password,
            };
        }
        return dbResponse;
    } catch (error) {
        throw error;
    }
};

const getAllUserByRole = async (roles: number[], isArchived = false) => {
    const searchQuery = `Select * from ${dbSchema}.user_credentials c where 
      c.is_archive = $1 and c.role = ANY($2)`;
    try {
        const { rows } = await dbQuery.query(searchQuery, [isArchived, roles]);

        if (!rows && rows.length == 0) {
            return [];
        }

        const dbResponse = rows.map((row: any) => {
            delete row.password;
            return formatUserCredentials(row);
        });

        return dbResponse;
    } catch (error) {
        console.log(error);
        throw error;
    }
};

const getNameByEmail = async (email: string) => {
    const searchQuery = `Select first_name
      from ${dbSchema}.user_credentials where email = $1`;

    try {
        const { rows } = await dbQuery.query(searchQuery, [email]);
        const dbResponse = rows[0].first_name;
        return dbResponse;
    } catch (error: any) {
        throw Error(error);
    }
};

const getRoleById = async (id: string) => {
    const searchQuery = `Select role
      from ${dbSchema}.user_credentials where uid = $1`;

    try {
        const { rows } = await dbQuery.query(searchQuery, [id]);
        const dbResponse = rows[0].role;
        return dbResponse;
    } catch (error: any) {
        throw Error(error);
    }
};

const getUserCount = async () => {
    const searchQuery = `Select count(*) as count
      from ${dbSchema}.user_credentials uc where uc.role in (2, 3)`;

    try {
        const { rows } = await dbQuery.query(searchQuery, []);
        const dbResponse = rows[0].count;
        return dbResponse;
    } catch (error: any) {
        throw Error(error);
    }
};

const getUserProfile = async (uid: string) => {
    const searchQuery = `SELECT uc.*, up.birthdate, up.gender, up.photo_url from ${dbSchema}.user_credentials uc
        LEFT JOIN ${dbSchema}.user_profile up on uc.uid = up.uid
        WHERE uc.uid = $1`;

    try {
        const { rows } = await dbQuery.query(searchQuery, [uid]);

        if (!rows && rows.length == 0) return null;

        const dbResponse = formatUserProfile(rows[0]);
        return dbResponse;
    } catch (error) {
        throw error;
    }
};

const updateUserProfile = async (profileUpdateReq: ProfileUpdateReq) => {
    let rawUrl = null;

    const upsertQuery = `INSERT INTO ${dbSchema}.user_profile (birthdate, gender, photo_url, uid)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (uid)
            DO UPDATE SET birthdate=$1, gender=$2, photo_url=$3 returning *`;

    const { birthdate, photoUrl, photoFile, gender, id, phoneNumber } = profileUpdateReq;

    try {
        if (photoFile && photoFile != "") {
            rawUrl = await uploadInStorage("User Profile Photo", `${id}`, photoFile);
        } else {
            rawUrl = photoUrl;
        }

        const { rows } = await dbQuery.query(upsertQuery, [birthdate, gender, rawUrl, id]);

        await updateUserPhoneNumber(phoneNumber, id);

        if (!rows && rows.length == 0) throw Error("User profile update failed");

        const dbResponse = formatUserProfile(rows[0]);
        return dbResponse;
    } catch (error) {
        throw error;
    }
};

const updateUserPhoneNumber = async (phoneNumber: string | undefined, uid: string | undefined) => {
    const insertQuery = `UPDATE ${dbSchema}.user_credentials SET phone_number =$1 WHERE uid = $2 returning *`;

    try {
        const { rows } = await dbQuery.query(insertQuery, [phoneNumber, uid]);

        if (!rows && rows.length == 0) throw "Failed to update phone number";

        const dbResponse = formatUserProfile(rows[0]);
        return dbResponse;
    } catch (error) {
        throw error;
    }
};

const formatUserCredentials = (raw: any): UserCredentials => {
    return {
        id: raw.uid,
        email: raw.email,
        firstName: raw.first_name,
        lastName: raw.last_name,
        role: raw.role,
        createdDate: raw.created_date,
        isArchived: raw.is_archive,
        phoneNumber: parseInt(raw.phone_number),
    };
};

const formatUserProfile = (raw: any) => {
    const credentials = formatUserCredentials(raw);
    return {
        ...credentials,
        birthdate: raw.birthdate,
        gender: raw.gender,
        photoUrl: raw.photo_url,
    };
};

export {
    registerUserInDB,
    getUserCredentialsByEmail,
    getAllUserByRole,
    getNameByEmail,
    getRoleById,
    getUserCredentialsByID,
    getUserCount,
    getUserProfile,
    updateUserProfile,
    updateUserPhoneNumber
};
