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

/**
 * EXPORTED so a test can prove it, not merely read it.
 *
 * This function is the whole of the UTC guarantee for this API: every
 * `timestamp` and `timestamptz` reaching a client passes through it. TAB 03 of
 * the Admin API Master Command asks for exactly that — "make it a
 * serialisation-level guarantee, not a convention" — and the guarantee already
 * existed here. What did not exist was anything that would notice if it stopped
 * being true. See `tests/utc-designator.test.ts`.
 */
export const asUtcIso = (value: string | null): string | null => {
    if (value === null) return null;

    /**
     * Postgres emits a TWO-digit offset. ECMAScript requires ±hh:mm.
     *
     * This is the whole defect. The previous guard was
     * `/[Zz]$|[+-]\d{2}:?\d{2}$/` — four offset digits, minimum. With the
     * session pinned to UTC, Postgres renders a `timestamptz` as
     *
     *     2026-08-11 11:03:23.421016+00
     *
     * which is TWO digits, so `hasZone` was false. The function then took the
     * naive branch and appended `Z` to a string that already carried an offset,
     * producing `…+00Z`; `new Date()` refused that, and the guard at the end
     * handed back the ORIGINAL string untouched.
     *
     * So every `timestamptz` in this API — every `accepted_at`, `arrived_at`,
     * `cancelled_at`, `confirmed_at` — reached clients in Postgres' native
     * format, which is precisely the string the contract tells clients they will
     * never receive: *"ISO 8601 with a UTC designator. Never Postgres' native
     * 2026-08-11 11:03:23.421016+00."*
     *
     * V8 happens to parse that form through its legacy non-ISO path, which is
     * why nothing looked broken. It is not ISO 8601 — a space separator instead
     * of `T`, and a bare `±hh` offset — and JavaScriptCore rejects it, so the
     * same booking read on iOS Safari is an Invalid Date where Chrome is fine.
     * The naive `timestamp without time zone` branch always worked; only the
     * type that carries the zone was broken, which is the harder one to notice.
     *
     * The order below matters. Widen the offset FIRST, then test for a zone:
     * testing first and widening after would take the naive branch for exactly
     * the inputs this exists to fix.
     */
    const withT = value.replace(' ', 'T');
    const widened = withT.replace(/([+-]\d{2})$/, '$1:00');
    const hasZone = /(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(widened);

    // `timestamp without time zone` arrives with no offset. It is stored UTC, so
    // say so explicitly rather than letting the client guess.
    const iso = hasZone ? widened : `${widened}Z`;
    const d = new Date(iso);
    // Unparseable input is handed back UNCHANGED rather than turned into an
    // epoch date. A wrong value an operator can see is recoverable; a
    // confidently fabricated one is not.
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