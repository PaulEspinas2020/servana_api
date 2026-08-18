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

export async function attachEvidence(params: {
  bookingId: number;
  workerUid: string;
  requirement: EvidenceRequirement;
  fileUrl: string;
  mimeType: string;
  bytes: number;
}): Promise<EvidenceItem> {
  const res = await dbQuery.query(
    `INSERT INTO ${dbSchema}.booking_evidence
       (booking_id, worker_uid, requirement_code, stage, file_url, mime_type, bytes, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'UPLOADED')
     RETURNING id, requirement_code, stage, state, mime_type, bytes, created_at, review_note`,
    [
      params.bookingId,
      params.workerUid,
      params.requirement.code,
      params.requirement.stage,
      params.fileUrl,
      params.mimeType,
      params.bytes,
    ]
  );
  const r = res.rows[0];
  return {
    id: String(r.id),
    requirementCode: r.requirement_code,
    stage: r.stage,
    state: r.state,
    mimeType: r.mime_type,
    bytes: Number(r.bytes),
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    reviewNote: r.review_note ?? null,
  };
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
