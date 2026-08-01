import { db } from "../config";
import dbQuery from "../db/dbQuery";
import { toCamel } from "../helpers/idGenerator";
const dbSchema = db.schema;

export const getAllServices = async () => {
    const r = `SELECT id, name, category, created_at FROM ${dbSchema}.services ORDER BY name`;

    try {
        const res = await dbQuery.query(r, []);
        const toCamelRows = (rows: any[]) => rows.map(toCamel);
        return toCamelRows(res.rows);
    } catch (error) {
        throw error;

    }
};

export const getServicesSimpleList = async () => {
    const res = await dbQuery.query(
        `SELECT id, name FROM ${dbSchema}.services ORDER BY name`,
        []
    );
    return res.rows as { id: number; name: string }[];
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
      AND so.is_active = true
    ORDER BY so.level_2, so.level_3
    `,
        [serviceId]
    );

    const addonRes = await dbQuery.query(
        `
    SELECT *
    FROM ${dbSchema}.service_options
    WHERE service_id = $1
      AND option_type = 'ADD_ON'
      AND is_active = true
    ORDER BY level_2, level_3
    `,
        [serviceId]
    );

    const addonsByParent: Record<number, any[]> = {};
    for (const a of addonRes.rows) {
        const addon = toCamel(a);
        if (!addon.parentOptionId) continue;
        addonsByParent[addon.parentOptionId] = addonsByParent[addon.parentOptionId] || [];
        addonsByParent[addon.parentOptionId].push(addon);
    }

    return mainRes.rows.map((opt: { id: number }) => {
        const option = toCamel(opt);

        return {
            ...option,
            addons: addonsByParent[option.id] || [],
        }
    });
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
    date: string
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
    return {
        covered: !!match,
        nearest: r.rows[0] || null,
        matched: match || null,
    };
};

export const createFullService = async (payload: any) => {

    try {
        /**
         * 1. Create Service
         */
        const serviceRes = await dbQuery.query(
            `
      INSERT INTO ${dbSchema}.services (name, category)
      VALUES ($1, $2)
      RETURNING id
      `,
            [payload.name, payload.category]
        );

        const serviceId = serviceRes.rows[0].id;

        /**
         * 2. Insert MAIN options (Level 2 + Level 3)
         */
        for (const lvl2 of payload.options) {
            for (const item of lvl2.items) {
                const mainRes = await dbQuery.query(
                    `
          INSERT INTO ${dbSchema}.service_options
          (service_id, option_type, level_2, level_3, base_price, unit)
          VALUES ($1, 'MAIN', $2, $3, $4, $5)
          RETURNING id
          `,
                    [serviceId, lvl2.level2, item.level3, item.base_price, item.unit]
                );

                const mainOptionId = mainRes.rows[0].id;

                /**
                 * 3. Insert meta (inclusions/exclusions)
                 */
                await dbQuery.query(
                    `
          INSERT INTO ${dbSchema}.service_option_meta
          (service_option_id, inclusions, exclusions)
          VALUES ($1, $2, $3)
          `,
                    [
                        mainOptionId,
                        JSON.stringify(item.inclusions || []),
                        JSON.stringify(item.exclusions || []),
                    ]
                );

                /**
                 * 4. Insert ADD-ONS
                 */
                if (item.addons?.length) {
                    for (const addon of item.addons) {
                        await dbQuery.query(
                            `
              INSERT INTO ${dbSchema}.service_options
              (service_id, option_type, level_2, level_3, base_price, unit, parent_option_id)
              VALUES ($1, 'ADD_ON', $2, $3, $4, $5, $6)
              `,
                            [
                                serviceId,
                                lvl2.level2,
                                addon.level3,
                                addon.base_price,
                                addon.unit,
                                mainOptionId,
                            ]
                        );
                    }
                }
            }
        }

        return {
            success: true,
            serviceId,
            message: "Service created successfully",
        };
    } catch (error) {
        throw error;
    }
};

export const updateFullService = async (
    serviceId: number,
    payload: any
) => {
    try {
        /**
         * 1. Validate service exists
         */
        const existing = await dbQuery.query(
            `SELECT id FROM ${dbSchema}.services WHERE id = $1`,
            [serviceId]
        );

        if (existing.rowCount === 0) {
            throw new Error("Service not found");
        }

        /**
         * 2. Block update if any existing booking references an option from this service
         */
        const bookingCheck = await dbQuery.query(
            `
            SELECT 1 FROM ${dbSchema}.bookings
            WHERE service_option_id IN (
              SELECT id FROM ${dbSchema}.service_options WHERE service_id = $1
            )
            LIMIT 1
            `,
            [serviceId]
        );

        if (bookingCheck.rowCount > 0) {
            throw new Error(
                "Cannot replace service options — existing bookings reference them. " +
                "Add new options instead of modifying existing ones."
            );
        }

        /**
         * 3. Update main service name/category
         */
        await dbQuery.query(
            `
      UPDATE ${dbSchema}.services
      SET name = $1,
          category = $2
      WHERE id = $3
      `,
            [payload.name, payload.category, serviceId]
        );

        /**
         * 4. DELETE OLD OPTIONS (safe — no bookings reference them)
         * Order matters because of FK constraints
         */

        // delete meta first
        await dbQuery.query(
            `
      DELETE FROM ${dbSchema}.service_option_meta
      WHERE service_option_id IN (
        SELECT id FROM ${dbSchema}.service_options WHERE service_id = $1
      )
      `,
            [serviceId]
        );

        // delete options (addons + main)
        await dbQuery.query(
            `DELETE FROM ${dbSchema}.service_options WHERE service_id = $1`,
            [serviceId]
        );

        /**
         * 5. RE-INSERT (same as create logic)
         */
        for (const lvl2 of payload.options) {
            for (const item of lvl2.items) {
                const mainRes = await dbQuery.query(
                    `
          INSERT INTO ${dbSchema}.service_options
          (service_id, option_type, level_2, level_3, base_price, unit)
          VALUES ($1, 'MAIN', $2, $3, $4, $5)
          RETURNING id
          `,
                    [serviceId, lvl2.level2, item.level3, item.base_price, item.unit]
                );

                const mainOptionId = mainRes.rows[0].id;

                // meta
                await dbQuery.query(
                    `
          INSERT INTO ${dbSchema}.service_option_meta
          (service_option_id, inclusions, exclusions)
          VALUES ($1, $2, $3)
          `,
                    [
                        mainOptionId,
                        JSON.stringify(item.inclusions || []),
                        JSON.stringify(item.exclusions || []),
                    ]
                );

                // addons
                if (item.addons?.length) {
                    for (const addon of item.addons) {
                        await dbQuery.query(
                            `
              INSERT INTO ${dbSchema}.service_options
              (service_id, option_type, level_2, level_3, base_price, unit, parent_option_id)
              VALUES ($1, 'ADD_ON', $2, $3, $4, $5, $6)
              `,
                            [
                                serviceId,
                                lvl2.level2,
                                addon.level3,
                                addon.base_price,
                                addon.unit,
                                mainOptionId,
                            ]
                        );
                    }
                }
            }
        }

        return {
            success: true,
            serviceId,
            message: "Service updated successfully",
        };
    } catch (error) {
        throw error;
    }
};

export const hardDeleteService = async (serviceId: number) => {
    try {
        // Validate no bookings reference any option belonging to this service
        const bookingCheck = await dbQuery.query(
            `
            SELECT 1 FROM ${dbSchema}.bookings
            WHERE service_option_id IN (
              SELECT id FROM ${dbSchema}.service_options WHERE service_id = $1
            )
            LIMIT 1
            `,
            [serviceId]
        );

        if (bookingCheck.rowCount > 0) {
            throw new Error("Service is in use by existing bookings and cannot be deleted");
        }

        const res = await dbQuery.query(
            `SELECT id FROM ${dbSchema}.services WHERE id = $1`,
            [serviceId]
        );

        if (res.rowCount === 0) {
            throw new Error("Service not found");
        }

        /**
         * DELETE ORDER (VERY IMPORTANT)
         */

        // 1. delete meta
        await dbQuery.query(
            `
      DELETE FROM ${dbSchema}.service_option_meta
      WHERE service_option_id IN (
        SELECT id FROM ${dbSchema}.service_options WHERE service_id = $1
      )
      `,
            [serviceId]
        );

        // 2. delete options (addons + main)
        await dbQuery.query(
            `DELETE FROM ${dbSchema}.service_options WHERE service_id = $1`,
            [serviceId]
        );

        // 3. delete service
        await dbQuery.query(
            `DELETE FROM ${dbSchema}.services WHERE id = $1`,
            [serviceId]
        );

        return {
            success: true,
            message: "Service permanently deleted",
        };
    } catch (error) {
        throw error;
    }
};

/**
 * Groups flat service_options rows into the nested catalog shape the customer
 * app renders.
 *
 * ## The keys are camelCase by the time they arrive here
 *
 * getFullServiceCatalog runs every row through `toCamel`
 * (helpers/idGenerator.ts:13-20), so `level_2` is already `level2` and `level_3`
 * is already `level3`. This function read the SNAKE spellings, which are
 * undefined on a camelCased object — and `JSON.stringify` omits undefined, so
 * the keys vanished from the wire entirely rather than arriving as null.
 *
 * Live production response before this fix:
 *
 *     "options": [{ "items": [{ "level3id": 130, "unit": "per unit",
 *                               "base_price": 3190, "addons": [] }] }]
 *
 * Every option group and every item shipped NAMELESS. `parityMiddleware` cannot
 * paper over it: fieldParity.ts:397 skips undefined before aliasing, so it can
 * rescue a renamed key but never an absent one.
 *
 * The customer-visible effect was total. search_repository.dart:29-30 drops any
 * group whose level2 is empty, so the search cache was always empty and every
 * query rendered "No services match your search." — a complete data-layer
 * failure presented as a legitimate empty result (§20).
 *
 * The tell was inside this function all along: `opt.basePrice` on the next line
 * is camelCase and works. Two keys were missed when the rest were converted.
 *
 * Both spellings are accepted below so this cannot break again if a caller ever
 * passes raw rows that have not been through toCamel.
 */
export const transformServiceCatalog = (services: any[]) => {

    return services.map(service => {

        const level2Map: Record<string, any> = {};

        for (const opt of service.options) {

            const level2 = opt.level2 ?? opt.level_2;

            if (!level2Map[level2]) {
                level2Map[level2] = {
                    level2,
                    items: [],
                };
            }

            level2Map[level2].items.push({
                level3id: opt.id,
                level3: opt.level3 ?? opt.level_3,
                unit: opt.unit,
                base_price: Number(opt.basePrice),
                inclusions: opt.inclusions || [],
                exclusions: opt.exclusions || [],
                addons: (opt.addons || []).map((a: any) => ({
                    level3id: a.id,
                    level3: a.level3 ?? a.level_3,
                    unit: a.unit,
                    base_price: Number(a.basePrice),
                })),
            });
        }

        return {
            serviceId: service.serviceId,
            name: service.options?.[0]?.serviceName || null,
            category: service.options?.[0]?.serviceCategory || null,
            options: Object.values(level2Map),
        };
    });
};

export const getFullServiceCatalog = async () => {

    const mainRes = await dbQuery.query(`
        SELECT
            so.*,
            s.name AS service_name,
            s.category AS service_category,
            COALESCE(m.inclusions, '[]'::jsonb) AS inclusions,
            COALESCE(m.exclusions, '[]'::jsonb) AS exclusions
        FROM ${dbSchema}.service_options so
        LEFT JOIN ${dbSchema}.services s
            ON s.id = so.service_id
        LEFT JOIN ${dbSchema}.service_option_meta m
            ON m.service_option_id = so.id
        WHERE so.option_type = 'MAIN'
        ORDER BY so.service_id, so.level_2, so.level_3
    `, []);

    const addonRes = await dbQuery.query(`
        SELECT *
        FROM ${dbSchema}.service_options
        WHERE option_type = 'ADD_ON'
        ORDER BY service_id, level_2, level_3
    `, []);

    const addonsByParent: Record<number, any[]> = {};
    for (const a of addonRes.rows) {
        const addon = toCamel(a);
        if (!addon.parentOptionId) continue;

        if (!addonsByParent[addon.parentOptionId]) {
            addonsByParent[addon.parentOptionId] = [];
        }

        addonsByParent[addon.parentOptionId].push(addon);
    }

    const servicesMap: Record<number, any> = {};

    for (const opt of mainRes.rows) {
        const option = toCamel(opt);

        const serviceId = option.serviceId;

        if (!servicesMap[serviceId]) {
            servicesMap[serviceId] = {
                serviceId,
                name: option.serviceName,         
                category: option.serviceCategory, 
                options: [],
            };
        }

        servicesMap[serviceId].options.push({
            ...option,
            addons: addonsByParent[option.id] || [],
        });
    }

    return Object.values(servicesMap);
};