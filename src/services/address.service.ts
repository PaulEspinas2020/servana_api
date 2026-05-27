import { db } from "../config";
import dbQuery from "../db/dbQuery";
import mongoDb from "../db/mongodbQuery";

const dbSchema = db.schema;
import dayjs from "dayjs";
import { idGenerator } from "../helpers/idGenerator";

const addUserAddress = async (userAddressReq: UserAddressReq, uid: string) => {
    const insertQuery = `INSERT INTO ${dbSchema}.user_address
        (address_id, uid, location_id, address_one, address_two, zip_code, post_town, country, created_by, updated_by, label, is_primary)
        VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning *`;

    const { userId, locationId, addressOne, addressTwo, zipCode, postTown, country, label, isPrimary, lat, lon } =
        userAddressReq;

    const addressId = idGenerator(6, "CAD");
    const now = dayjs().unix();

    try {
        const { rows } = await dbQuery.query(insertQuery, [
            addressId,
            userId,
            locationId,
            addressOne,
            addressTwo,
            zipCode,
            postTown,
            country,
            uid,
            uid,
            label,
            isPrimary,
        ]);

        if (!rows || rows.length == 0) throw "Failed to insert address";

        // Add to mongoDB
        await addLocationInDB(locationId, addressId, lat, lon);

        const dbResponse = await formattedAddress(rows[0]);
        return dbResponse;
    } catch (error) {
        throw error;
    }
};

const updateUserAddress = async (userAddressReq: UserAddressReq, uid: string, addressId: string) => {
    const updateQuery = `UPDATE ${dbSchema}.user_address
        SET location_id = $1, address_one = $2, address_two = $3, zip_code = $4, post_town = $5, 
            country = $6, updated_at = $7, updated_by = $8, label = $9, is_primary = $10
        WHERE address_id = $11 returning *`;

    const { locationId, addressOne, addressTwo, zipCode, postTown, country, label, isPrimary, lat, lon } =
        userAddressReq;

    const now = dayjs().unix();

    try {
        const { rows } = await dbQuery.query(updateQuery, [
            locationId,
            addressOne,
            addressTwo,
            zipCode,
            postTown,
            country,
            now,
            uid,
            label,
            isPrimary,
            addressId,
        ]);

        if (!rows || rows.length == 0) throw "Failed to update address";

        // update in mongoDB
        await updateLocationInDB(locationId, addressId, lat, lon);

        const dbResponse = await formattedAddress(rows[0]);
        return dbResponse;
    } catch (error) {
        throw error;
    }
};

const addLocationInDB = async (locationId: string, addressId: string, lat: number, lon: number) => {
    const collection = (await mongoDb).collection("addresses");

    try {
        return collection.updateOne(
            { addressId }, // ✅ single unique key
            {
                $set: {
                    locationId,
                    addressId,
                    loc: {
                        type: "Point",
                        coordinates: [lon, lat], // ✅ [lon, lat]
                    },
                    updatedAt: new Date(),
                },
                $setOnInsert: {
                    createdAt: new Date(),
                },
            },
            { upsert: true }
        );

    } catch (error) {
        throw error;
    }
};

const updateLocationInDB = async (locationId: string, addressId: string, lat: number, lon: number) => {
    const collection = (await mongoDb).collection("addresses");

    try {
        return collection.updateOne(
            { addressId },
            {
                $set: {
                    locationId,
                    loc: {
                        type: "Point",
                        coordinates: [lon, lat],
                    },
                    updatedAt: new Date(),
                },
            }
        );
    } catch (error) {
        throw error;
    }
};

const getAllAddressesOfUser = async (userId: string, role: string) => {
    let searchQuery: string;
    let params: any[];
    console.log("with role", role);
    if (role === '1') {
        // Admin: fetch addresses of all users with role 3
        console.log("Admin fetching all addresses of users with role 3");
        searchQuery = `
            SELECT ua.* FROM ${dbSchema}.user_address ua
            INNER JOIN ${dbSchema}.user_credentials u ON u.uid = ua.uid
            WHERE u.role = '3';
        `;
        params = [];
    } else if (role === '3') {
        // Regular user: fetch only their own address
        searchQuery = `SELECT * FROM ${dbSchema}.user_address WHERE uid = $1;`;
        params = [userId];
    } else {
        return [];
    }

    try {
        const { rows } = await dbQuery.query(searchQuery, params);
        console.log("Fetched addresses from DB for user", userId, "with role", role, ":", rows);

        if (!rows || rows.length === 0) return [];

        return await Promise.all(rows.map(async (row: any) => await formattedAddress(row)));
    } catch (error) {
        throw error;
    }
};

const getAddressByAddressId = async (addressId: string) => {
    const searchQuery = `SELECT * from ${dbSchema}.user_address WHERE address_id = $1;`;

    try {
        const { rows } = await dbQuery.query(searchQuery, [addressId]);

        if (!rows || rows.length == 0) return null;

        const dbResponse = await formattedAddress(rows[0]);
        return dbResponse;
    } catch (error) {
        throw error;
    }
};

const makeAddressPrimary = async (addressId: string) => {
    const searchQuery = `UPDATE ${dbSchema}.user_address SET is_primary = true WHERE address_id = $1 returning *`;

    try {
        const { rows } = await dbQuery.query(searchQuery, [addressId]);

        if (!rows || rows.length == 0) throw "Failed to update address";

        const dbResponse = await formattedAddress(rows[0]);
        return dbResponse;
    } catch (error) {
        throw error;
    }
};

const makeOtherAddressNotPrimary = async (addressId: string, userId: string) => {
    const updateQuery = `UPDATE ${dbSchema}.user_address SET is_primary = false WHERE uid = $2 and address_id NOT IN ($1) returning *`;
    try {
        const { rows } = await dbQuery.query(updateQuery, [addressId, userId]);
        const dbResponse = rows;
        return dbResponse;
    } catch (error) {
        throw error;
    }
};

const deleteAddress = async (addressId: string) => {
    const searchQuery = `DELETE FROM ${dbSchema}.user_address WHERE address_id = $1`;

    try {
        await dbQuery.query(searchQuery, [addressId]);
        return "success";
    } catch (error) {
        throw error;
    }
};

const getLatLonByLocationId = async (locationId: string) => {
    const collection = (await mongoDb).collection("addresses"); 

    try {
        const result = await collection.findOne({ locationId: locationId }, { projection: { loc: 1 } });
        if (!result) throw "Location not found";
        return result.loc.coordinates; // returns [lon, lat]
    } catch (error) {
        throw error;
    }
}

const formattedAddress = async (raw: any) => {
    const coordinates = await getLatLonByLocationId(raw.location_id);

    return {
        addressId: raw.address_id,
        userId: raw.user_id,
        locationId: raw.location_id,
        addressOne: raw.address_one,
        addressTwo: raw.address_two,
        zipCode: raw.zip_code,
        postTown: raw.post_town,
        country: raw.country,
        label: raw.label,
        isPrimary: raw.is_primary,
        lon: coordinates ? coordinates[0] : null,
        lat: coordinates ? coordinates[1] : null,
        createdAt: raw.created_at,
        createdBy: raw.created_by,
        updatedAt: raw.updated_at,
        updatedBy: raw.updated_by
    };
};

const getAddressesByUserId = async (userId: string) => {
    const searchQuery = `
        SELECT * FROM ${dbSchema}.user_address
        WHERE uid = $1
        ORDER BY is_primary DESC, created_at ASC
    `;
    try {
        const { rows } = await dbQuery.query(searchQuery, [userId]);
        if (!rows || rows.length === 0) return [];
        return Promise.all(rows.map(formattedAddress));
    } catch (error) {
        throw error;
    }
};

export {
    addUserAddress,
    updateUserAddress,
    getAllAddressesOfUser,
    getAddressByAddressId,
    getAddressesByUserId,
    makeAddressPrimary,
    deleteAddress,
    makeOtherAddressNotPrimary,
    getLatLonByLocationId
};
