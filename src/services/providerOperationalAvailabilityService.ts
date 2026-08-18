/**
 * ProviderOperationalAvailabilityService
 *
 * Canonical owner of provider online/offline state.
 * Every write to worker_locations.is_online goes through this service
 * so that persistence metadata and audit events are always recorded.
 *
 * Persistence contract:
 *   - worker_locations (MongoDB) remains the dispatch gate (is_online flag).
 *   - provider_operational_availability (PostgreSQL) stores metadata.
 *   - Audit events go into provider_auto_online_events (existing table).
 *
 * Once a provider explicitly goes Online, they remain Online until they
 * explicitly select Offline. Socket disconnect, logout, and heartbeat
 * timeout do NOT change availability_status.
 *
 * ESM 3.2.25 constraint: no ?? or ?. operators.
 */

import dbQuery from '../db/dbQuery';
import { db } from '../config';
import mongoDb from '../db/mongodbQuery';

const s = db.schema;

// ── Source values ─────────────────────────────────────────────────────────────

export type AvailabilitySource =
  | 'provider_explicit'
  | 'auto_online'
  | 'admin_forced_offline'
  | 'system_override'
  | 'migrated';

// ── Schema (TAB 02) ───────────────────────────────────────────────────────────
//
// `provider_operational_availability` was created here at runtime by
// `ensureAvailabilitySchema`, memoised in a module-level promise and awaited at
// the top of `setOnline`, `setOffline` and the admin override. That function is
// gone, and so are those three awaits.
//
// The table comes from `scripts/baseline/000-baseline.sql:2506` — production's own
// dump. `npm run db:verify:embedded` proves a fresh database reaches it.
//
// Worth knowing since this file no longer states the shape: `version` is an
// optimistic-concurrency counter and `changed_at` is what the auto-online engine
// compares against. Neither is nullable, and both have defaults, so a write that
// omits them is still correct.

// ── Audit helper ──────────────────────────────────────────────────────────────

const emitAuditEvent = async (
  providerUid: string,
  eventType: string,
  before: object,
  after: object,
  actorType: string,
  actorUid: string | null,
  reason: string | null,
): Promise<void> => {
  try {
    await dbQuery.query(
      `INSERT INTO ${s}.provider_auto_online_events
         (provider_uid, event_type, before, after, reason, actor_type, actor_uid, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        providerUid,
        eventType,
        JSON.stringify(before),
        JSON.stringify(after),
        reason,
        actorType,
        actorUid,
      ],
    );
  } catch (_e) {
    // Audit failure must never block the primary operation.
  }
};

// ── Core operations ───────────────────────────────────────────────────────────

export const setOnline = async (
  providerUid: string,
  source: AvailabilitySource,
  actorUid: string | null,
  actorRole: string,
  reason: string | null,
  coords: { latitude: number; longitude: number } | null,
): Promise<void> => {
  // 1. MongoDB write — preserve existing loc if present, apply coords only if
  //    no real location exists yet.
  const col = (await mongoDb).collection('worker_locations');
  const existing = await col.findOne({ uid: providerUid }, { projection: { loc: 1 } });
  const existingLoc = existing && existing.loc ? existing.loc : null;

  let loc;
  if (existingLoc) {
    loc = existingLoc;
  } else if (coords) {
    loc = { type: 'Point', coordinates: [coords.longitude, coords.latitude] };
  } else {
    loc = { type: 'Point', coordinates: [120.9842195, 14.5994643] };
  }

  // When activated by the auto-online engine, also stamp the auto_online fields so
  // that mergeAutoBookableProviders (dispatch) and the Admin 360 auto-online tab
  // continue to read them correctly.
  const baseSet: Record<string, any> = {
    uid: providerUid,
    is_online: true,
    loc: loc,
    availability_source: source,
    changed_by_uid: actorUid,
    changed_by_role: actorRole,
    changed_at: new Date(),
    updatedAt: new Date(),
  };

  if (source === 'auto_online') {
    baseSet['auto_online'] = true;
    baseSet['auto_online_reason'] = 'auto_online_all_time_all_area';
  }

  await col.updateOne(
    { uid: providerUid },
    { $set: baseSet },
    { upsert: true },
  );

  // 2. PostgreSQL metadata write.
  const pgResult = await dbQuery.query(
    `SELECT availability_status, version FROM ${s}.provider_operational_availability
     WHERE provider_uid = $1`,
    [providerUid],
  );

  const prevStatus = pgResult.rows.length > 0 ? pgResult.rows[0].availability_status : 'offline';
  const prevVersion = pgResult.rows.length > 0 ? pgResult.rows[0].version : 0;

  await dbQuery.query(
    `INSERT INTO ${s}.provider_operational_availability
       (provider_uid, availability_status, availability_source, changed_by_uid,
        changed_by_role, changed_at, reason, version, updated_at)
     VALUES ($1, 'online', $2, $3, $4, NOW(), $5, 1, NOW())
     ON CONFLICT (provider_uid) DO UPDATE SET
       availability_status = 'online',
       availability_source = EXCLUDED.availability_source,
       changed_by_uid      = EXCLUDED.changed_by_uid,
       changed_by_role     = EXCLUDED.changed_by_role,
       changed_at          = NOW(),
       reason              = EXCLUDED.reason,
       version             = ${s}.provider_operational_availability.version + 1,
       updated_at          = NOW()`,
    [providerUid, source, actorUid, actorRole, reason],
  );

  // 3. Audit event.
  const eventType = source === 'auto_online'
    ? 'PROVIDER.AVAILABILITY.AUTO_ONLINE'
    : 'PROVIDER.AVAILABILITY.WENT_ONLINE';

  await emitAuditEvent(
    providerUid,
    eventType,
    { availabilityStatus: prevStatus, version: prevVersion },
    { availabilityStatus: 'online', source: source },
    actorRole,
    actorUid,
    reason,
  );
};

export const setOffline = async (
  providerUid: string,
  source: AvailabilitySource,
  actorUid: string | null,
  actorRole: string,
  reason: string | null,
): Promise<void> => {
  // 1. MongoDB write.
  const col = (await mongoDb).collection('worker_locations');

  const updateFields: Record<string, any> = {
    is_online: false,
    availability_source: source,
    changed_by_uid: actorUid,
    changed_by_role: actorRole,
    changed_at: new Date(),
    updatedAt: new Date(),
  };

  await col.updateOne(
    { uid: providerUid },
    { $set: updateFields },
    { upsert: true },
  );

  // 2. PostgreSQL metadata write.
  const pgResult = await dbQuery.query(
    `SELECT availability_status, version FROM ${s}.provider_operational_availability
     WHERE provider_uid = $1`,
    [providerUid],
  );

  const prevStatus = pgResult.rows.length > 0 ? pgResult.rows[0].availability_status : 'online';
  const prevVersion = pgResult.rows.length > 0 ? pgResult.rows[0].version : 0;

  await dbQuery.query(
    `INSERT INTO ${s}.provider_operational_availability
       (provider_uid, availability_status, availability_source, changed_by_uid,
        changed_by_role, changed_at, reason, version, updated_at)
     VALUES ($1, 'offline', $2, $3, $4, NOW(), $5, 1, NOW())
     ON CONFLICT (provider_uid) DO UPDATE SET
       availability_status = 'offline',
       availability_source = EXCLUDED.availability_source,
       changed_by_uid      = EXCLUDED.changed_by_uid,
       changed_by_role     = EXCLUDED.changed_by_role,
       changed_at          = NOW(),
       reason              = EXCLUDED.reason,
       version             = ${s}.provider_operational_availability.version + 1,
       updated_at          = NOW()`,
    [providerUid, source, actorUid, actorRole, reason],
  );

  // 3. Audit event.
  const eventType = source === 'admin_forced_offline'
    ? 'PROVIDER.AVAILABILITY.FORCED_OFFLINE'
    : 'PROVIDER.AVAILABILITY.WENT_OFFLINE';

  await emitAuditEvent(
    providerUid,
    eventType,
    { availabilityStatus: prevStatus, version: prevVersion },
    { availabilityStatus: 'offline', source: source },
    actorRole,
    actorUid,
    reason,
  );
};

export const getStatus = async (
  providerUid: string,
): Promise<{
  availabilityStatus: 'online' | 'offline';
  availabilitySource: string;
  changedByUid: string | null;
  changedByRole: string | null;
  changedAt: Date | null;
  reason: string | null;
  version: number;
  updatedAt: Date | null;
}> => {
  // MongoDB is authoritative for the live flag.
  const col = (await mongoDb).collection('worker_locations');
  const doc = await col.findOne(
    { uid: providerUid },
    { projection: { is_online: 1, updatedAt: 1 } },
  );

  // PG has the metadata.
  const pgResult = await dbQuery.query(
    `SELECT availability_status, availability_source, changed_by_uid,
            changed_by_role, changed_at, reason, version
     FROM ${s}.provider_operational_availability
     WHERE provider_uid = $1`,
    [providerUid],
  );

  const isOnline = doc && doc.is_online ? true : false;
  const pg = pgResult.rows.length > 0 ? pgResult.rows[0] : null;

  return {
    availabilityStatus: isOnline ? 'online' : 'offline',
    availabilitySource: pg ? pg.availability_source : 'migrated',
    changedByUid: pg ? pg.changed_by_uid : null,
    changedByRole: pg ? pg.changed_by_role : null,
    changedAt: doc && doc.updatedAt ? doc.updatedAt : null,
    reason: pg ? pg.reason : null,
    version: pg ? pg.version : 0,
    updatedAt: doc && doc.updatedAt ? doc.updatedAt : null,
  };
};
