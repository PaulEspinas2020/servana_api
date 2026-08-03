import pg from 'pg';
import { db } from "../config";

const Pool = pg.Pool;

/**
 * Timestamps come back as UTC ISO 8601 strings, always.
 *
 * Without this the Pool inherits whatever `TimeZone` the server session happens
 * to carry, and node-postgres parses `timestamp`/`timestamptz` into a JS Date
 * using the NODE process's local zone. Both are environment-dependent, so the
 * same row could serialise differently on a developer laptop, on the Linode box
 * and in CI — and the API contract has no way to state what a client is
 * receiving.
 *
 * Servana operates in Asia/Manila (UTC+8), which makes this more than academic:
 * a booking scheduled at 08:00 Manila is 00:00 UTC, so getting the zone wrong
 * moves a job across a day boundary. "Today's jobs" then differs between the
 * provider's phone and the server.
 *
 * The fix is to stop parsing entirely and hand the client an unambiguous string:
 *
 *   1114 = timestamp without time zone
 *   1184 = timestamp with time zone
 *   1082 = date  (kept as YYYY-MM-DD; a date has no zone and must not become
 *          a Date object, which would attach one)
 *
 * Clients then parse ISO 8601 with an explicit offset, which is what
 * SERVANA_PROVIDER_API_CONTRACT.md section 17 promises.
 */
const TIMESTAMP_OID = 1114;
const TIMESTAMPTZ_OID = 1184;
const DATE_OID = 1082;

const asUtcIso = (value: string | null): string | null => {
    if (value === null) return null;
    // `timestamp without time zone` arrives with no offset. It is stored UTC, so
    // say so explicitly rather than letting the client guess.
    const hasZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(value);
    const iso = hasZone ? value : `${value.replace(' ', 'T')}Z`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? value : d.toISOString();
};

pg.types.setTypeParser(TIMESTAMP_OID, asUtcIso);
pg.types.setTypeParser(TIMESTAMPTZ_OID, asUtcIso);
pg.types.setTypeParser(DATE_OID, (v: string | null) => v);

const pool = new Pool({
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    keepAlive: true,
    user: db.user,
    port: db.port ? parseInt(db.port): 5432,
    host: db.host,
    database: db.database,
    password: db.password,
    // Pin the session zone too, so anything computed IN SQL — NOW(), date_trunc,
    // an interval comparison — agrees with the parsers above instead of
    // depending on the server's default.
    options: '-c timezone=UTC'
})

export { pool };

export default {
    /**
     * DB Query
     * @param {object} req
     * @param {object} res
     * @returns {object} object
     */
     
    query(queryText: string, params?: any): Promise<any> {
        return new Promise((resolve, reject) => {
            pool.query(queryText, params)
                .then((res) => {
                    resolve(res);
                })
                .catch((err) => {
                    console.log(err);
                    reject(err);
                })
        })
    }
}