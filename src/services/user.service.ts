import { db } from "../config";
import dbQuery from "../db/dbQuery";
import bcrypt from "bcryptjs";
const dbSchema = db.schema;
import dayjs from "dayjs";
import uploadInStorage from "../helpers/firebaseStorageUploader";

const now = dayjs();
const OTP_EXPIRY_MINUTES = 10;

const registerUserInDB = async (user: UserCredentialsReq) => {
    const insertQueryInCredentials = `INSERT INTO ${dbSchema}.user_credentials
      (uid, email, first_name, last_name, "role", created_date, "password", phone_number,
            is_email_verified,
            is_phone_verified)
      VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *;`;

    try {
        const { rows } = await dbQuery.query(insertQueryInCredentials, [
            user.uid,
            user.email,
            user.firstName,
            user.lastName,
            user.role,
            now,
            user.password,
            user.phoneNumber,
            user.isEmailVerified,
            user.isPhoneVerified,
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

export const upsertFirebaseUser = async (payload: {
  uid: string;
  email?: string | null;
  phoneNumber?: string | null;
  firstName?: string;
  lastName?: string;
  role?: string;
}) => {
  const {
    uid,
    email = null,
    phoneNumber = null,
    firstName = "",
    lastName = "",
    role = "2",
  } = payload;

  const result = await dbQuery.query(
    `
    INSERT INTO ${dbSchema}.user_credentials (
      uid,
      email,
      phone_number,
      first_name,
      last_name,
      "role",
      created_date
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (uid)
    DO UPDATE SET
      email = COALESCE(EXCLUDED.email, user_credentials.email),
      phone_number = COALESCE(EXCLUDED.phone_number, user_credentials.phone_number),
      first_name = CASE WHEN EXCLUDED.first_name <> '' THEN EXCLUDED.first_name ELSE user_credentials.first_name END,
      last_name  = CASE WHEN EXCLUDED.last_name  <> '' THEN EXCLUDED.last_name  ELSE user_credentials.last_name  END
    RETURNING *;
    `,
    [
      uid,
      email,
      phoneNumber,
      firstName,
      lastName,
      role,
      now,
    ]
  );
  const dbResponse = formatUserCredentials(result.rows[0]);
  return dbResponse;
};

const getUserCredentialsByEmail = async (email: string, withPassword = false) => {
    const searchQuery = `
      Select 
        c.uid, c.email, c.password, c.first_name, c.last_name, c.role, c.created_date, c.fcm_token
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
    const userQuery = `
        SELECT c.*
        FROM ${dbSchema}.user_credentials c
        WHERE c.is_archive = $1
          AND c.role = ANY($2)
    `;
    const addressQuery = `
        SELECT uid, address_id, address_one, address_two, zip_code, post_town, country, label, is_primary
        FROM ${dbSchema}.user_address
        WHERE uid = ANY($1)
        ORDER BY is_primary DESC, created_at ASC
    `;
    try {
        const { rows } = await dbQuery.query(userQuery, [isArchived, roles]);

        if (!rows || rows.length === 0) {
            return [];
        }

        const uids = rows.map((r: any) => r.uid);
        const { rows: addressRows } = await dbQuery.query(addressQuery, [uids]);

        // Group addresses by uid
        const addressesByUid: Record<string, any[]> = {};
        for (const addr of addressRows) {
            if (!addressesByUid[addr.uid]) addressesByUid[addr.uid] = [];
            addressesByUid[addr.uid].push({
                addressId:  addr.address_id,
                addressOne: addr.address_one,
                addressTwo: addr.address_two,
                zipCode:    addr.zip_code,
                postTown:   addr.post_town,
                country:    addr.country,
                label:      addr.label,
                isPrimary:  addr.is_primary,
            });
        }

        const dbResponse = rows.map((row: any) => {
            delete row.password;
            const formatted = formatUserCredentials(row);
            return {
                ...formatted,
                addresses: addressesByUid[row.uid] || [],
            };
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

const getEmailById = async (userId: string) => {
    const searchQuery = `Select email
      from ${dbSchema}.user_credentials where uid = $1`;

    try {
        const { rows } = await dbQuery.query(searchQuery, [userId]);
        const dbResponse = rows[0].email;
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
    // first_name / last_name come from the provider portal PUT /user/updateprofile body
    const firstName: string | undefined = (profileUpdateReq as any).first_name;
    const lastName: string | undefined = (profileUpdateReq as any).last_name;

    try {
        if (photoFile && photoFile != "") {
            rawUrl = await uploadInStorage("User Profile Photo", `${id}`, photoFile);
        } else {
            rawUrl = photoUrl;
        }

        const { rows } = await dbQuery.query(upsertQuery, [birthdate, gender, rawUrl, id]);

        await updateUserPhoneNumber(phoneNumber, id);

        // Update name fields in user_credentials when provided
        if (id && (firstName || lastName)) {
            await dbQuery.query(
                `UPDATE ${dbSchema}.user_credentials
                 SET first_name = COALESCE(NULLIF($1, ''), first_name),
                     last_name  = COALESCE(NULLIF($2, ''), last_name)
                 WHERE uid = $3`,
                [firstName ?? '', lastName ?? '', id],
            );
        }

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
        phoneNumber: raw.phone_number ?? null,
        fcmToken: raw.fcm_token,
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

const storeEmailOtp = async (email: string, code: string) => {
    const codeHash = await bcrypt.hash(code, 10);

    await dbQuery.query(
        `
        INSERT INTO ${dbSchema}.email_otps (email, code_hash, expires_at)
        VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval)
        `,
        [email, codeHash, OTP_EXPIRY_MINUTES]
    );

    return true;
};

const getLatestValidEmailOtp = async (email: string) => {
    const result = await dbQuery.query(
        `
        SELECT *
        FROM ${dbSchema}.email_otps
        WHERE email = $1
          AND used = FALSE
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [email]
    );

    return result.rows[0] || null;
};

const markEmailOtpAsUsed = async (id: number) => {
    await dbQuery.query(
        `
        UPDATE ${dbSchema}.email_otps
        SET used = TRUE
        WHERE id = $1
        `,
        [id]
    );

    return true;
};

const getUserByEmail = async (email: string) => {
    const result = await dbQuery.query(
        `
        SELECT
            uid AS id,
            email,
            first_name AS "firstName",
            last_name AS "lastName",
            role,
            created_date AS "createdDate",
            phone_number AS "phoneNumber",
            is_email_verified AS "isEmailVerified",
            is_phone_verified AS "isPhoneVerified"
        FROM ${dbSchema}.user_credentials
        WHERE email = $1
        LIMIT 1
        `,
        [email]
    );

    return result.rows[0] || null;
};

const updateEmailVerifiedByUid = async (uid: string, isEmailVerified: boolean) => {
    const result = await dbQuery.query(
        `
        UPDATE ${dbSchema}.user_credentials
        SET is_email_verified = $2
        WHERE uid = $1
        RETURNING
            uid AS id,
            email,
            first_name AS "firstName",
            last_name AS "lastName",
            role,
            created_date AS "createdDate",
            phone_number AS "phoneNumber",
            is_email_verified AS "isEmailVerified",
            is_phone_verified AS "isPhoneVerified"
        `,
        [uid, isEmailVerified]
    );

    return result.rows[0] || null;
};

/**
 * Given a bookingId, returns { email, firstName } for the customer who owns the booking.
 * Used by services that only have bookingId and need to send an email.
 */
const getUserInfoByBookingId = async (bookingId: number): Promise<{ email: string; firstName: string } | null> => {
    const query = `
        SELECT uc.email, uc.first_name AS "firstName"
        FROM ${dbSchema}.bookings b
        JOIN ${dbSchema}.user_credentials uc ON uc.uid = b.user_id
        WHERE b.id = $1
        LIMIT 1
    `;
    try {
        const { rows } = await dbQuery.query(query, [bookingId]);
        return rows[0] || null;
    } catch (error) {
        throw error;
    }
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
    updateUserPhoneNumber,
    storeEmailOtp,
    getLatestValidEmailOtp,
    markEmailOtpAsUsed,
    getUserByEmail,
    updateEmailVerifiedByUid,
    getEmailById,
    getUserInfoByBookingId
};
