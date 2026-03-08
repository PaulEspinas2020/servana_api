import { db } from "../config";
import dbQuery from "../db/dbQuery";
const dbSchema = db.schema;

export const getAllServices = async () => {
    const r = `SELECT id, name, category, created_at FROM ${dbSchema}.services ORDER BY name`;

    try {
        const res = await dbQuery.query(r, []);
        return res.rows;
    } catch (error) {
        throw error;

    }
};

export const getLevel2List = async (serviceId: number) => {
    const r = await dbQuery.query(
        `
    SELECT DISTINCT level_2
    FROM ${dbSchema}.service_options
    WHERE service_id = $1
      AND option_type = 'MAIN'
      AND level_2 IS NOT NULL
    ORDER BY level_2
    `,
        [serviceId]
    );
    type Level2Row = { level_2: string };

    return r.rows.map((x: Level2Row) => x.level_2);
};

export const getOptionsWithAddons = async (serviceId: number) => {
    // MAIN options + meta
    const mainRes = await dbQuery.query(
        `
    SELECT
      so.*,
      COALESCE(m.inclusions, '[]'::jsonb) AS inclusions,
      COALESCE(m.exclusions, '[]'::jsonb) AS exclusions
    FROM ${dbSchema}.service_options so
    LEFT JOIN ${dbSchema}.service_option_meta m
      ON m.service_option_id = so.id
    WHERE so.service_id = $1
      AND so.option_type = 'MAIN'
    ORDER BY so.level_2, so.level_3
    `,
        [serviceId]
    );

    // ADD_ON options grouped by parent_option_id
    const addonRes = await dbQuery.query(
        `
    SELECT *
    FROM ${dbSchema}.service_options
    WHERE service_id = $1
      AND option_type = 'ADD_ON'
    ORDER BY level_2, level_3
    `,
        [serviceId]
    );

    const addonsByParent: Record<number, any[]> = {};
    for (const a of addonRes.rows) {
        if (!a.parent_option_id) continue;
        addonsByParent[a.parent_option_id] = addonsByParent[a.parent_option_id] || [];
        addonsByParent[a.parent_option_id].push(a);
    }

    return mainRes.rows.map((opt: { id: number }) => ({
        ...opt,
        addons: addonsByParent[opt.id] || [],
    }));
};

export const getBranchesByService = async (serviceId: number) => {
    const res = await dbQuery.query(
        `
    SELECT id, name, address, city
    FROM ${dbSchema}.branches
    WHERE service_id=$1
      AND is_active=true
    ORDER BY name
    `,
        [serviceId]
    );

    return res.rows;
};

export const getAvailableSlots = async (
    branchId: number,
    date: string // "2026-02-20"
) => {
    const res = await dbQuery.query(
        `
    SELECT
      bs.slot_time,
      bs.max_capacity,
      COUNT(b.id) FILTER (
        WHERE DATE(b.schedule)=DATE($2)
          AND TO_CHAR(b.schedule, 'HH24:MI')=TO_CHAR(bs.slot_time, 'HH24:MI')
          AND b.status IN ('PENDING_OTP','CONFIRMED','WORKER_ASSIGNED','EN_ROUTE','ARRIVED','IN_PROGRESS')
      ) AS booked_count
    FROM ${dbSchema}.branch_slots bs
    LEFT JOIN ${dbSchema}.bookings b
      ON b.branch_id = bs.branch_id
    WHERE bs.branch_id=$1
    GROUP BY bs.slot_time, bs.max_capacity
    ORDER BY bs.slot_time
    `,
        [branchId, date]
    );

    return res.rows.map((row: any) => ({
        slot_time: row.slot_time,
        available: row.booked_count < row.max_capacity,
        remaining_capacity: row.max_capacity - row.booked_count
    }));
};

export const createSlot = async (
    branchId: number,
    slotTime: string,
    maxCapacity: number
) => {
    const res = await dbQuery.query(
        `
    INSERT INTO ${dbSchema}.branch_slots (branch_id, slot_time, max_capacity)
    VALUES ($1,$2,$3)
    RETURNING *
    `,
        [branchId, slotTime, maxCapacity]
    );

    return res.rows[0];
};

export const createCoverageGeo = async (payload: {
    service_id: number;
    center_lat: number;
    center_lon: number;
    radius_km: number;
    is_active?: boolean;
}) => {
    const r = await dbQuery.query(
        `
    INSERT INTO ${dbSchema}.service_coverage_geo
      (service_id, center_lat, center_lon, radius_km, is_active)
    VALUES ($1,$2,$3,$4,$5)
    RETURNING *
    `,
        [
            payload.service_id,
            payload.center_lat,
            payload.center_lon,
            payload.radius_km,
            payload.is_active ?? true,
        ]
    );
    return r.rows[0];
};

export const listCoverageGeoByService = async (serviceId: number) => {
    const r = await dbQuery.query(
        `
    SELECT *
    FROM ${dbSchema}.service_coverage_geo
    WHERE service_id=$1
    ORDER BY id DESC
    `,
        [serviceId]
    );
    return r.rows;
};

export const checkCoverageGeo = async (serviceId: number, lat: number, lon: number) => {
    const r = await dbQuery.query(
        `
        SELECT
            id,
            radius_km,
            (
            6371 * acos(
                LEAST(
                1,
                GREATEST(
                    -1,
                    cos(radians($1)) * cos(radians(center_lat)) *
                    cos(radians(center_lon) - radians($2)) +
                    sin(radians($1)) * sin(radians(center_lat))
                )
                )
            )
            ) AS distance_km
        FROM ${dbSchema}.service_coverage_geo
        WHERE service_id=$3 AND is_active=true
        ORDER BY distance_km ASC
        `,
        [lat, lon, serviceId]
    );

    const match = r.rows.find((x: any) => Number(x.distance_km) <= Number(x.radius_km));
    console.log("Coverage check:", { covered: !!match, nearest: r.rows[0] || null, matched: match || null });
    return {
        covered: !!match,
        nearest: r.rows[0] || null,
        matched: match || null,
    };
};

