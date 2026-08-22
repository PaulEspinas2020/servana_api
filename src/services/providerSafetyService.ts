/**
 * Provider SAFETY — incidents and check-ins, as one implementation.
 *
 * ## Why this exists
 *
 * The incident write lived inline in `providerController`, so publishing a
 * canonical route meant either a second copy of the rule (§10) or extracting
 * it. This is the extraction: legacy and v1 now call the same function and
 * differ only in what they do with its verdict.
 *
 * ## The defect that was found while extracting it
 *
 * De-duplication was a check-then-act:
 *
 *     const existing = await col.findOne({ uid, clientIncidentId });
 *     if (existing) return 409;
 *     ...
 *     await col.insertOne(doc);
 *
 * Two concurrent retries — which is the NORMAL case on the lossy link a
 * provider reports an incident from — can both pass the `findOne` and both
 * insert. There is no unique index anywhere in this codebase (`createIndex`
 * appears nowhere), so nothing downstream collapses them either.
 *
 * The Master Command names this exact requirement: *"the clients will retry on
 * a lossy link and must not create duplicate incidents"*. It was not met.
 *
 * Two changes close it, and BOTH are needed:
 *
 *   1. `findOneAndUpdate` with `$setOnInsert` and `upsert: true`, which is
 *      atomic for a single document. That alone collapses the ordinary
 *      sequential retry.
 *   2. A UNIQUE index on `(uid, clientIncidentId)`. Without it, two upserts
 *      that both miss can still both insert — MongoDB's upsert is only
 *      insert-once when a unique index makes the second one fail. The duplicate
 *      key error is then caught and the original returned.
 *
 * ## What a duplicate MEANS, per surface
 *
 * The two callers want different answers and both are defensible, so the
 * decision is the CALLER'S and this function only reports the fact:
 *
 *   - Legacy `/api/provider/safety/incidents` answers **409**, unchanged. Five
 *     clients read that route and §4 does not permit changing what it returns.
 *   - Canonical `/api/v1/provider/safety/incidents` **replays**: it returns the
 *     original incident with 200. For a safety report that is the right answer.
 *     A provider whose first attempt committed and then timed out retries, and a
 *     409 rendered as "failed" tells them their incident was never filed — on
 *     the one report where believing that is most dangerous.
 *
 * ## What is deliberately NOT here
 *
 * Nothing in this module reads another provider's incidents. Every function
 * takes the uid from its caller, which takes it from a verified token, and the
 * queries are scoped on it. There is no parameter with which to name another
 * account.
 */

import mongoDb from '../db/mongodbQuery';

/** Stages a provider may check in at. Closed — a typo must not become a stage. */
export const CHECK_IN_STAGES = ['en_route', 'arrived', 'started', 'completed'] as const;
export type CheckInStage = (typeof CHECK_IN_STAGES)[number];

export const INCIDENTS_COLLECTION = 'provider_safety_incidents';
export const CHECK_INS_COLLECTION = 'worker_safety_checkins';

/**
 * The emergency lines shown to a provider in trouble.
 *
 * STATIC and market-wide: it names no account, reads no row and is identical
 * for every caller, so it is cacheable and carries no personal data at all.
 *
 * The disclaimer is not decoration. Servana cannot dispatch emergency services,
 * and a safety screen that implied otherwise would be the most dangerous copy in
 * the product.
 */
export const PROVIDER_EMERGENCY_CONFIG = Object.freeze({
  locale: 'en-PH',
  country: 'Philippines',
  lines: Object.freeze([
    { label: 'National Emergency Hotline', number: 'tel:911', dialLabel: '911', description: 'Fire, medical emergency, police' },
    { label: 'Philippine National Police', number: 'tel:117', dialLabel: '117', description: 'Police assistance' },
    { label: 'Bureau of Fire Protection', number: 'tel:160', dialLabel: '160', description: 'Fire and rescue' },
  ]),
  disclaimer:
    'Tapping a number opens your device dialer. Servana cannot dispatch emergency services on your behalf.',
});

export class SafetyError extends Error {
  constructor(
    readonly code: 'SAFETY_FIELD_REQUIRED' | 'SAFETY_FIELD_INVALID' | 'SAFETY_STAGE_INVALID',
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = 'SafetyError';
  }
}

/**
 * Ensure the unique index the atomic write relies on.
 *
 * Memoized per process and FAIL-OPEN by design. An index that cannot be created
 * — no permission, a pre-existing duplicate pair — must not stop a provider
 * filing an incident. Without it the upsert still collapses the ordinary
 * sequential retry, which is the overwhelmingly common case; what is lost is
 * only the guarantee under true concurrency. Refusing the write instead would
 * trade a rare duplicate for a certain silence, on a safety path.
 *
 * The failure is logged loudly rather than swallowed, because "the index is not
 * there" is exactly the fact somebody needs when a duplicate does appear.
 */
let indexReady: Promise<void> | null = null;

export const ensureSafetyIndexes = (): Promise<void> => {
  if (indexReady) return indexReady;
  indexReady = (async () => {
    try {
      const col = (await mongoDb).collection(INCIDENTS_COLLECTION);
      await col.createIndex({ uid: 1, clientIncidentId: 1 }, { unique: true, name: 'uid_clientIncidentId_unique' });
    } catch (error: any) {
      // eslint-disable-next-line no-console
      console.error(
        '[safety] could not ensure the unique incident index; duplicate reports are possible ' +
        'under concurrent retries:',
        error?.message,
      );
    }
  })();
  return indexReady;
};

export interface IncidentInput {
  clientIncidentId: string;
  category: string;
  severity: string;
  description: string;
  bookingId?: string | null;
  immediateDanger?: boolean;
  providerSafe?: boolean | null;
  workStopped?: boolean;
  emergencyServicesContacted?: boolean | null;
}

export interface IncidentResult {
  incidentId: string;
  providerSafeReference: string;
  state: string;
  /** True when this call matched an incident already filed under the same key. */
  replayed: boolean;
}

const requireText = (value: unknown, field: string): string => {
  const text = String(value ?? '').trim();
  if (!text) throw new SafetyError('SAFETY_FIELD_REQUIRED', `${field} is required.`, 400);
  return text;
};

/**
 * File a safety incident, or return the one already filed under this key.
 *
 * `clientIncidentId` is REQUIRED and is the whole replay story. It is generated
 * on the device before the first attempt, so every retry of one report carries
 * the same key and collapses onto one document.
 */
export const submitIncident = async (
  uid: string,
  input: IncidentInput,
): Promise<IncidentResult> => {
  const clientIncidentId = requireText(input.clientIncidentId, 'clientIncidentId').slice(0, 128);
  const category = requireText(input.category, 'category').slice(0, 64);
  const severity = requireText(input.severity, 'severity').slice(0, 32);
  const description = requireText(input.description, 'description');
  if (description.length < 10) {
    throw new SafetyError(
      'SAFETY_FIELD_INVALID',
      'description must be at least 10 characters.',
      400,
    );
  }

  await ensureSafetyIndexes();
  const col = (await mongoDb).collection(INCIDENTS_COLLECTION);

  const year = new Date().getFullYear();
  const ref = `SAF-${year}-${Date.now().toString(36).slice(-5).toUpperCase()}`;
  const incidentId = `inc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();

  /**
   * `$setOnInsert` for EVERYTHING, so a replay mutates nothing.
   *
   * A `$set` here would let a retry overwrite the original report — including
   * its `reportedAt`, which is the moment a provider says something happened.
   * On a safety record that is evidence, and a retry must not move it.
   */
  const document = {
    uid,
    incidentId,
    clientIncidentId,
    providerSafeReference: ref,
    bookingId: input.bookingId ? String(input.bookingId) : null,
    category,
    severity,
    state: 'submitted',
    immediateDanger: !!input.immediateDanger,
    providerSafe: input.providerSafe !== undefined ? input.providerSafe : null,
    workStopped: !!input.workStopped,
    emergencyServicesContacted:
      input.emergencyServicesContacted !== undefined ? input.emergencyServicesContacted : null,
    description: description.slice(0, 2000),
    reportedAt: now,
    updatedAt: now,
    hasUnreadUpdate: false,
  };

  const read = (doc: any): IncidentResult => ({
    incidentId: String(doc.incidentId),
    providerSafeReference: String(doc.providerSafeReference),
    state: String(doc.state ?? 'submitted'),
    replayed: String(doc.incidentId) !== incidentId,
  });

  try {
    const result: any = await col.findOneAndUpdate(
      { uid, clientIncidentId },
      { $setOnInsert: document },
      { upsert: true, returnDocument: 'after' },
    );
    // Driver versions differ on whether the document is returned bare or under
    // `.value`. Reading both is cheaper than pinning a driver version, and a
    // wrong guess here would report every first submission as a replay.
    const doc = result?.value ?? result;
    if (doc && doc.incidentId) return read(doc);
    // Upsert reported nothing readable. Re-read rather than assume.
    const stored = await col.findOne({ uid, clientIncidentId });
    if (stored) return read(stored);
    throw new SafetyError('SAFETY_FIELD_INVALID', 'The incident could not be stored.', 500);
  } catch (error: any) {
    // Duplicate key: another concurrent attempt won the race. That is a
    // SUCCESS for the caller — their incident is filed — so re-read and return
    // it rather than surfacing a storage error on a safety path.
    if (error?.code === 11000) {
      const stored = await col.findOne({ uid, clientIncidentId });
      if (stored) return read(stored);
    }
    throw error;
  }
};

/** The caller's own incidents, newest first. */
export const listIncidents = async (uid: string, limit = 50) => {
  const col = (await mongoDb).collection(INCIDENTS_COLLECTION);
  return col
    .find({ uid })
    .sort({ reportedAt: -1 })
    .limit(Math.max(1, Math.min(100, limit)))
    .toArray();
};

export interface CheckInResult {
  bookingId: string;
  stage: CheckInStage;
  checkedInAt: string;
}

/**
 * Record that the provider is safe at a stage of a job.
 *
 * Deliberately APPEND-ONLY and deliberately not deduplicated: two check-ins at
 * the same stage are two facts about two moments, and collapsing them would
 * discard the later one — which on this path is the more recent evidence that
 * somebody is still safe. The replay mechanism is `none-accepted`, and that is
 * a decision rather than an omission.
 */
export const recordCheckIn = async (
  uid: string,
  input: { bookingId: unknown; stage: unknown },
): Promise<CheckInResult> => {
  const bookingId = requireText(input.bookingId, 'bookingId');
  const stage = String(input.stage ?? '');
  if (!(CHECK_IN_STAGES as readonly string[]).includes(stage)) {
    throw new SafetyError(
      'SAFETY_STAGE_INVALID',
      `stage must be one of: ${CHECK_IN_STAGES.join(', ')}.`,
      400,
    );
  }
  const checkedInAt = new Date().toISOString();
  const col = (await mongoDb).collection(CHECK_INS_COLLECTION);
  await col.insertOne({ uid, bookingId, stage, checkedInAt });
  return { bookingId, stage: stage as CheckInStage, checkedInAt };
};
