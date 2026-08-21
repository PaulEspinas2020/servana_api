/**
 * Job evidence: what a booking requires, and what has been supplied.
 *
 * Command 19 §17–§19 and §29.
 *
 * ── Distinct from provider compliance documents ───────────────────────────
 * `provider_requirement_definitions` already exists for ONBOARDING — an ID, a
 * permit, documents that belong to the provider and are checked once. Job
 * evidence belongs to a BOOKING: before/after photos of one visit, valid for
 * that visit only. Different lifetime, different owner, different reviewer.
 *
 * The vocabulary deliberately mirrors that table (`is_required`,
 * `accepted_mime_types`, `provider_facing_title`) so the two read as siblings
 * rather than as rival designs.
 *
 * ── Upload is not approval ────────────────────────────────────────────────
 * §19 is explicit: "Uploading must not automatically mean accepted when review
 * is required." The state machine below keeps `UPLOADED` and `ACCEPTED`
 * separate, and completion readiness (§34) counts satisfied requirements, not
 * uploaded files.
 */
import dbQuery from "../db/dbQuery";
import { uploadFileToStorage } from "../helpers/firebaseStorageUploader";
import { validateDataUri, AllowedUploadMime } from "../helpers/fileSignature";
import { stripImageMetadata } from "../helpers/stripImageMetadata";
import { db } from "../config";

const dbSchema = db.schema;

export type EvidenceStage = "BEFORE_SERVICE" | "AFTER_SERVICE";

export type EvidenceState =
  /** Nothing supplied yet. */
  | "REQUIRED"
  /** A file is attached but not reviewed. NOT the same as accepted. */
  | "UPLOADED"
  /** Reviewed and satisfactory. */
  | "ACCEPTED"
  /** Reviewed and rejected; the provider must replace it. */
  | "REJECTED";

export interface EvidenceRequirement {
  code: string;
  stage: EvidenceStage;
  providerFacingTitle: string;
  description: string;
  isRequired: boolean;
  minCount: number;
  maxCount: number;
  acceptedMimeTypes: string[];
  maxBytes: number;
}

/**
 * Ceiling for one evidence photo.
 *
 * The client compresses to ~1.2 MB before uploading (ImageBudget.evidence): a
 * phone camera produces 3-12 MB per shot, evidence takes two per booking, and
 * none of that resolution shows a work area or a meter reading any better.
 *
 * This is the BACKSTOP, not the target — deliberately several times the client
 * budget so a legitimate upload never trips it, while still refusing the
 * 10 MB-per-photo case the old limit allowed. A client that stops compressing
 * gets rejected here rather than quietly tripling storage.
 */
const EVIDENCE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The default requirement set.
 *
 * Server-driven per §17, but deliberately a small honest default rather than
 * an invented per-service matrix: there is no service-level evidence policy in
 * the catalog to read from, and fabricating one would put requirements in front
 * of providers that no operator ever chose.
 *
 * When a policy source exists, `requirementsForBooking` is the single place
 * that changes.
 */
const DEFAULT_REQUIREMENTS: EvidenceRequirement[] = [
  {
    code: "BEFORE_PHOTO",
    stage: "BEFORE_SERVICE",
    providerFacingTitle: "Photo before starting",
    description:
      "One clear photo of the work area before you begin. This protects you if the customer reports pre-existing damage.",
    isRequired: true,
    minCount: 1,
    maxCount: 5,
    acceptedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    maxBytes: EVIDENCE_MAX_BYTES,
  },
  {
    code: "AFTER_PHOTO",
    stage: "AFTER_SERVICE",
    providerFacingTitle: "Photo after finishing",
    description: "One clear photo of the completed work.",
    isRequired: true,
    minCount: 1,
    maxCount: 5,
    acceptedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    maxBytes: EVIDENCE_MAX_BYTES,
  },
];

// `ensureEvidenceSchema` created `booking_evidence` and its index on the
// first evidence read or write of every process. Migration 036 owns both,
// with an identical definition.
//
// ORDERING: deploy.yml runs `migrations:apply` after build and BEFORE the PM2
// restart, so 036 lands before any code that reads this table is serving.

/** Requirements applicable to a booking. */
export function requirementsForBooking(): EvidenceRequirement[] {
  return DEFAULT_REQUIREMENTS;
}

export function findRequirement(code: string): EvidenceRequirement | null {
  return (
    DEFAULT_REQUIREMENTS.find(
      (r) => r.code === String(code ?? "").toUpperCase()
    ) ?? null
  );
}

export interface EvidenceItem {
  id: string;
  requirementCode: string;
  stage: string;
  state: EvidenceState;
  mimeType: string;
  bytes: number;
  createdAt: string | null;
  reviewNote: string | null;
}

/**
 * Whether a requirement is satisfied.
 *
 * §19/§34. `UPLOADED` counts toward satisfaction because no reviewer exists
 * yet — but `REJECTED` never does, and the two states stay distinct so that
 * introducing review later is a policy change here rather than a schema
 * migration. A rejected file must be replaced, not merely present.
 */
export function isRequirementSatisfied(
  req: EvidenceRequirement,
  items: EvidenceItem[]
): boolean {
  if (!req.isRequired) return true;
  const usable = items.filter(
    (i) => i.requirementCode === req.code && i.state !== "REJECTED"
  );
  return usable.length >= req.minCount;
}

/** Requirement codes still blocking a stage. */
export function blockingRequirements(
  stage: EvidenceStage,
  items: EvidenceItem[]
): string[] {
  return requirementsForBooking()
    .filter((r) => r.stage === stage)
    .filter((r) => !isRequirementSatisfied(r, items))
    .map((r) => r.code);
}

/** Live evidence for a booking, newest first. Removed rows are excluded. */
export async function listEvidence(
  bookingId: number,
  workerUid: string
): Promise<EvidenceItem[]> {
  const res = await dbQuery.query(
    `SELECT id, requirement_code, stage, state, mime_type, bytes,
            created_at, review_note
       FROM ${dbSchema}.booking_evidence
      WHERE booking_id = $1 AND worker_uid = $2 AND removed_at IS NULL
      ORDER BY id DESC`,
    [bookingId, workerUid]
  );
  return res.rows.map((r: any) => ({
    id: String(r.id),
    requirementCode: r.requirement_code,
    stage: r.stage,
    state: r.state,
    mimeType: r.mime_type,
    bytes: Number(r.bytes),
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    reviewNote: r.review_note ?? null,
  }));
}

/** The projection, in one place, so a fresh insert and a replay read identically. */
const toEvidenceItem = (r: any): EvidenceItem => ({
  id: String(r.id),
  requirementCode: r.requirement_code,
  stage: r.stage,
  state: r.state,
  mimeType: r.mime_type,
  bytes: Number(r.bytes),
  createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  reviewNote: r.review_note ?? null,
});

/**
 * Attach evidence, or return what a previous attempt already attached.
 *
 * ## The defect this closes
 *
 * This was a plain INSERT with no idempotency key. A provider on a doorstep
 * whose upload committed and then timed out retries, and the retry filed a
 * SECOND piece of evidence against the same requirement.
 *
 * `requirement.maxCount` bounded the damage without avoiding it: the duplicate
 * either consumed a slot the provider still needed, or — where maxCount is 1 —
 * the retry was refused with TOO_MANY_FILES, which reads as "your upload
 * failed" for an upload that succeeded. Evidence is what a dispute is decided
 * on, so both outcomes are wrong.
 *
 * ## The mechanism
 *
 * `clientRequestId` is generated on the device BEFORE the first attempt and
 * reused by every retry of it. `ON CONFLICT DO NOTHING` against the partial
 * unique index from migration 043 makes the second insert a no-op, and the
 * original row is then re-read and returned. The caller cannot tell a replay
 * from a first write except by `replayed`, which is the point.
 *
 * OPTIONAL rather than required, deliberately. The legacy route has shipped
 * without it and five clients call it; demanding one would break them. A write
 * that carries no key behaves exactly as before — which is also why the index
 * is partial.
 */
export async function attachEvidence(params: {
  bookingId: number;
  workerUid: string;
  requirement: EvidenceRequirement;
  fileUrl: string;
  mimeType: string;
  bytes: number;
  clientRequestId?: string | null;
}): Promise<EvidenceItem & { replayed: boolean }> {
  const clientRequestId = params.clientRequestId?.trim() || null;

  const res = await dbQuery.query(
    `INSERT INTO ${dbSchema}.booking_evidence
       (booking_id, worker_uid, requirement_code, stage, file_url, mime_type, bytes, state, client_request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'UPLOADED', $8)
     ON CONFLICT DO NOTHING
     RETURNING id, requirement_code, stage, state, mime_type, bytes, created_at, review_note`,
    [
      params.bookingId,
      params.workerUid,
      params.requirement.code,
      params.requirement.stage,
      params.fileUrl,
      params.mimeType,
      params.bytes,
      clientRequestId,
    ]
  );

  if (res.rowCount) return { ...toEvidenceItem(res.rows[0]), replayed: false };

  /**
   * The insert was collapsed. That can only happen when a key was supplied and
   * a row already carries it, so re-read and return the ORIGINAL.
   *
   * Without a key there is no conflict target and nothing to collapse, so
   * reaching here with a null key means something else refused the write — and
   * inventing a success for it would be worse than the error.
   */
  if (!clientRequestId) {
    throw new Error('Evidence could not be stored.');
  }

  const existing = await dbQuery.query(
    `SELECT id, requirement_code, stage, state, mime_type, bytes, created_at, review_note
       FROM ${dbSchema}.booking_evidence
      WHERE booking_id = $1 AND worker_uid = $2 AND client_request_id = $3
      LIMIT 1`,
    [params.bookingId, params.workerUid, clientRequestId]
  );
  if (!existing.rowCount) throw new Error('Evidence could not be stored.');
  return { ...toEvidenceItem(existing.rows[0]), replayed: true };
}

/**
 * What a previous attempt filed under this key, or null.
 *
 * Read BEFORE the expensive part of an upload — the base64 decode, the
 * magic-byte validation, the EXIF strip and the storage write. A retry that has
 * already succeeded should not pay for all of that again, and more importantly
 * should not upload a second copy of the bytes to storage only for the row to
 * be collapsed afterwards.
 */
export async function findEvidenceByClientRequestId(
  bookingId: number,
  workerUid: string,
  clientRequestId: string,
): Promise<EvidenceItem | null> {
  const key = clientRequestId?.trim();
  if (!key) return null;
  const res = await dbQuery.query(
    `SELECT id, requirement_code, stage, state, mime_type, bytes, created_at, review_note
       FROM ${dbSchema}.booking_evidence
      WHERE booking_id = $1 AND worker_uid = $2 AND client_request_id = $3
      LIMIT 1`,
    [bookingId, workerUid, key]
  );
  return res.rowCount ? toEvidenceItem(res.rows[0]) : null;
}

/**
 * Soft-removes evidence.
 *
 * Scoped by worker_uid so one provider cannot remove another's file even with
 * a guessed id, and soft rather than hard so the audit trail survives a
 * provider replacing a photo (§38).
 */
export async function removeEvidence(
  bookingId: number,
  workerUid: string,
  evidenceId: number
): Promise<boolean> {
  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.booking_evidence
        SET removed_at = NOW()
      WHERE id = $1 AND booking_id = $2 AND worker_uid = $3 AND removed_at IS NULL`,
    [evidenceId, bookingId, workerUid]
  );
  return (res.rowCount ?? 0) > 0;
}

/** How many live files a requirement already holds — enforces `maxCount`. */
export function countFor(code: string, items: EvidenceItem[]): number {
  return items.filter((i) => i.requirementCode === code).length;
}


/**
 * The states a booking accepts evidence in.
 *
 * Evidence belongs to a visit IN PROGRESS. A booking that is finished, declined
 * or cancelled must not accept new files — otherwise a provider could attach
 * "proof" to a job after the fact, which is exactly what a dispute must not be
 * decided on.
 */
export const EVIDENCE_ACCEPTING_STATES = Object.freeze([
  'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS',
]);

export class EvidenceError extends Error {
  constructor(
    readonly code:
      | 'NOT_ACCEPTING_EVIDENCE'
      | 'UNKNOWN_REQUIREMENT'
      | 'TOO_MANY_FILES'
      | 'EVIDENCE_FILE_INVALID',
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'EvidenceError';
  }
}

export interface SubmitEvidenceInput {
  bookingId: number;
  workerUid: string;
  /** The worker's status on this booking, already established by the caller. */
  workerStatus: string;
  requirementCode: string;
  /** A data URI. Validated against the requirement's MIME allow-list by MAGIC BYTES. */
  file: unknown;
  clientRequestId?: string | null;
}

/**
 * The whole evidence upload, as ONE implementation.
 *
 * Extracted from `providerController.uploadBookingEvidence` so the canonical
 * route does not become a second copy of these rules (§10). Every check that
 * was there is here, in the same order, with the same codes.
 *
 * ## The replay check comes FIRST
 *
 * Before the base64 decode, the magic-byte validation, the EXIF strip and the
 * storage write. A retry that already succeeded must not pay for any of that
 * again, and — the part that matters — must not upload a second copy of the
 * bytes to storage only for the database row to be collapsed afterwards. That
 * would leave an orphaned object nobody references and nobody deletes.
 *
 * ## The EXIF strip is not optional
 *
 * A photo taken at a customer's address carries GPS in EXIF by default. Storing
 * it would attach a precise home location to every file, so the bytes are
 * rewritten before they reach storage rather than after.
 */
export async function submitEvidence(input: SubmitEvidenceInput): Promise<EvidenceItem & { replayed: boolean }> {
  if (!EVIDENCE_ACCEPTING_STATES.includes(String(input.workerStatus).toUpperCase())) {
    throw new EvidenceError(
      'NOT_ACCEPTING_EVIDENCE',
      'This booking is not accepting evidence.',
      409,
    );
  }

  const requirement = findRequirement(String(input.requirementCode ?? ''));
  if (!requirement) {
    throw new EvidenceError('UNKNOWN_REQUIREMENT', 'Unknown evidence requirement.', 422);
  }

  // Replay FIRST — see the docblock.
  const key = input.clientRequestId?.trim() || null;
  if (key) {
    const already = await findEvidenceByClientRequestId(input.bookingId, input.workerUid, key);
    if (already) return { ...already, replayed: true };
  }

  const existing = await listEvidence(input.bookingId, input.workerUid);
  if (countFor(requirement.code, existing) >= requirement.maxCount) {
    throw new EvidenceError(
      'TOO_MANY_FILES',
      `You can attach at most ${requirement.maxCount} for this requirement. Remove one first.`,
      409,
    );
  }

  const validation = validateDataUri(input.file, {
    allowed: requirement.acceptedMimeTypes as readonly AllowedUploadMime[],
    maxBytes: requirement.maxBytes,
  });
  if (!validation.ok) {
    throw new EvidenceError('EVIDENCE_FILE_INVALID', validation.message, 422);
  }

  const cleaned = stripImageMetadata(validation.buffer, validation.mime);
  const dataUri = `data:${validation.mime};base64,${cleaned.toString('base64')}`;

  const fileUrl = await uploadFileToStorage(
    `booking-evidence/${input.bookingId}`,
    `${input.workerUid}_${requirement.code}_${Date.now()}`,
    dataUri,
  );

  return attachEvidence({
    bookingId: input.bookingId,
    workerUid: input.workerUid,
    requirement,
    fileUrl,
    mimeType: validation.mime,
    bytes: cleaned.length,
    clientRequestId: key,
  });
}
