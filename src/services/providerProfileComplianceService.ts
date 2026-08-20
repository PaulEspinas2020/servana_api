import { createHash } from 'crypto';
import dbQuery, { pool } from '../db/dbQuery';
import { db } from '../config';
import { validateDataUri, AllowedUploadMime } from '../helpers/fileSignature';
import { stripImageMetadata } from '../helpers/stripImageMetadata';
import { assertCleanScan, scanProviderFile } from './providerManagedFileScanner';
import { getPublicRatingSummary } from './ratingAggregationService';

const s = db.schema;
const ALLOWED_DOCUMENT_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export type DataClassification = 'public' | 'private' | 'operational' | 'internal';

export interface ProfileFieldDefinition {
  id: string;
  label: string;
  classification: DataClassification;
  editable: 'direct' | 'review' | 'reverification' | 'admin';
  customerVisible: boolean;
  masked: boolean;
  recentAuthRequired: boolean;
}

export const PROFILE_FIELD_REGISTRY: readonly ProfileFieldDefinition[] = [
  { id: 'legalName', label: 'Legal name', classification: 'private', editable: 'reverification', customerVisible: false, masked: false, recentAuthRequired: true },
  { id: 'birthDate', label: 'Birth date', classification: 'private', editable: 'reverification', customerVisible: false, masked: true, recentAuthRequired: true },
  { id: 'email', label: 'Email', classification: 'private', editable: 'reverification', customerVisible: false, masked: true, recentAuthRequired: true },
  { id: 'mobile', label: 'Mobile number', classification: 'private', editable: 'reverification', customerVisible: false, masked: true, recentAuthRequired: true },
  { id: 'legalAddress', label: 'Residential address', classification: 'private', editable: 'reverification', customerVisible: false, masked: true, recentAuthRequired: true },
  { id: 'displayName', label: 'Display name', classification: 'public', editable: 'review', customerVisible: true, masked: false, recentAuthRequired: false },
  { id: 'photo', label: 'Profile photo', classification: 'public', editable: 'review', customerVisible: true, masked: false, recentAuthRequired: false },
  { id: 'biography', label: 'Biography', classification: 'public', editable: 'review', customerVisible: true, masked: false, recentAuthRequired: false },
  { id: 'skills', label: 'Skills', classification: 'public', editable: 'review', customerVisible: true, masked: false, recentAuthRequired: false },
  { id: 'languages', label: 'Languages', classification: 'public', editable: 'review', customerVisible: true, masked: false, recentAuthRequired: false },
  { id: 'experienceSummary', label: 'Experience summary', classification: 'public', editable: 'review', customerVisible: true, masked: false, recentAuthRequired: false },
  { id: 'branch', label: 'Branch', classification: 'operational', editable: 'admin', customerVisible: false, masked: false, recentAuthRequired: false },
  { id: 'serviceArea', label: 'Service area', classification: 'operational', editable: 'admin', customerVisible: true, masked: false, recentAuthRequired: false },
  { id: 'providerType', label: 'Provider type', classification: 'operational', editable: 'admin', customerVisible: false, masked: false, recentAuthRequired: false },
  { id: 'reviewerNotes', label: 'Reviewer notes', classification: 'internal', editable: 'admin', customerVisible: false, masked: true, recentAuthRequired: false },
] as const;

export interface DocumentTypeDefinition {
  id: string;
  name: string;
  category: string;
  required: boolean;
  maximumFiles: number;
  expiry: 'none' | 'required' | 'optional';
  reviewRequired: boolean;
  acceptedMimeTypes: readonly string[];
  version: number;
  aliases?: readonly string[];
}

export const DOCUMENT_TYPE_CATALOG: readonly DocumentTypeDefinition[] = [
  { id: 'valid_id', name: 'Valid Government ID', category: 'identity', required: true, maximumFiles: 2, expiry: 'optional', reviewRequired: true, acceptedMimeTypes: ALLOWED_DOCUMENT_MIMES, version: 1, aliases: ['government_id', 'national_id', 'passport', 'drivers_license', 'philsys'] },
  { id: 'nbi_clearance', name: 'NBI Clearance', category: 'compliance', required: true, maximumFiles: 2, expiry: 'required', reviewRequired: true, acceptedMimeTypes: ALLOWED_DOCUMENT_MIMES, version: 1 },
  { id: 'service_record', name: 'CV or Service Record', category: 'experience', required: true, maximumFiles: 3, expiry: 'none', reviewRequired: true, acceptedMimeTypes: ALLOWED_DOCUMENT_MIMES, version: 1, aliases: ['cv', 'resume', 'work_record', 'certificate', 'tor', 'diploma'] },
  { id: 'proof_of_address', name: 'Proof of Address', category: 'address', required: false, maximumFiles: 2, expiry: 'none', reviewRequired: true, acceptedMimeTypes: ALLOWED_DOCUMENT_MIMES, version: 1 },
  { id: 'professional_license', name: 'Professional License', category: 'qualification', required: false, maximumFiles: 3, expiry: 'required', reviewRequired: true, acceptedMimeTypes: ALLOWED_DOCUMENT_MIMES, version: 1 },
  { id: 'trade_certificate', name: 'Trade Certificate', category: 'qualification', required: false, maximumFiles: 5, expiry: 'optional', reviewRequired: true, acceptedMimeTypes: ALLOWED_DOCUMENT_MIMES, version: 1 },
  { id: 'training_certificate', name: 'Training Certificate', category: 'qualification', required: false, maximumFiles: 5, expiry: 'optional', reviewRequired: true, acceptedMimeTypes: ALLOWED_DOCUMENT_MIMES, version: 1 },
  { id: 'branch_authorization', name: 'Branch Authorization', category: 'organization', required: false, maximumFiles: 2, expiry: 'optional', reviewRequired: true, acceptedMimeTypes: ALLOWED_DOCUMENT_MIMES, version: 1 },
  { id: 'payout_verification', name: 'Payout Verification Document', category: 'finance', required: false, maximumFiles: 2, expiry: 'optional', reviewRequired: true, acceptedMimeTypes: ALLOWED_DOCUMENT_MIMES, version: 1 },
] as const;

const maskEmail = (email: unknown): string | null => {
  const value = String(email ?? '').trim();
  const at = value.indexOf('@');
  if (at <= 0) return value ? '***' : null;
  return `${value.slice(0, Math.min(2, at))}***${value.slice(at)}`;
};

const maskPhone = (phone: unknown): string | null => {
  const value = String(phone ?? '').trim();
  if (!value) return null;
  return `${'*'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
};

const safeList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String).map((v) => v.trim()).filter(Boolean).slice(0, 20) : [];

const latestDecisionSql = `
  LEFT JOIN LATERAL (
    SELECT decision, reason_code, provider_message, decided_at
    FROM ${s}.provider_requirement_decisions
    WHERE worker_requirement_id = wr.id AND NOT is_superseded
    ORDER BY decided_at DESC LIMIT 1
  ) ld ON true`;

export const listDocuments = async (providerUid: string) => {
  const result = await dbQuery.query(
    `SELECT wr.id, wr.file_name, wr.uploaded_at, wr.requirement_type,
            wr.mime_type, wr.byte_size, wr.lifecycle_state, wr.scan_status,
            wr.issue_date, wr.expires_at, wr.identifier_mask,
            wr.replacement_for_id, wr.replaced_by_id, wr.version,
            COALESCE(ld.decision, 'pending_review') AS review_state,
            ld.reason_code, ld.provider_message, ld.decided_at
     FROM ${s}.worker_requirements wr
     ${latestDecisionSql}
     WHERE wr.worker_uid = $1
     ORDER BY wr.uploaded_at DESC`,
    [providerUid],
  );
  const now = Date.now();
  return result.rows.map((r: any) => {
    const expired = r.expires_at && new Date(r.expires_at).getTime() <= now;
    const state = r.lifecycle_state === 'replaced' || r.lifecycle_state === 'revoked'
      ? r.lifecycle_state
      : expired ? 'expired'
      : r.review_state === 'approved' && r.scan_status === 'clean' ? 'verified'
      : r.review_state === 'rejected' ? 'rejected'
      : r.review_state === 'needs_resubmission' ? 'action_required'
      : r.scan_status === 'pending' ? 'processing'
      : 'under_review';
    return {
      id: String(r.id),
      documentTypeId: r.requirement_type ?? 'unknown',
      displayName: r.file_name,
      mimeType: r.mime_type ?? null,
      byteSize: r.byte_size == null ? null : Number(r.byte_size),
      state,
      reviewState: r.review_state,
      scanState: r.scan_status,
      issueDate: r.issue_date ?? null,
      expiresAt: r.expires_at ?? null,
      identifierMask: r.identifier_mask ?? null,
      replacementForId: r.replacement_for_id == null ? null : String(r.replacement_for_id),
      replacedById: r.replaced_by_id == null ? null : String(r.replaced_by_id),
      providerReasonCode: r.reason_code ?? null,
      providerReasonDetail: r.provider_message ?? null,
      uploadedAt: r.uploaded_at,
      reviewedAt: r.decided_at ?? null,
      version: Number(r.version ?? 1),
      availableActions: state === 'verified' ? ['preview', 'replace']
        : ['rejected', 'expired', 'action_required'].includes(state) ? ['preview', 'replace']
        : ['preview'],
    };
  });
};

export const getDocumentPreview = async (providerUid: string, documentId: number) => {
  const result = await dbQuery.query(
    `SELECT id, storage_path, file_name, mime_type
     FROM ${s}.worker_requirements WHERE id = $1 AND worker_uid = $2 LIMIT 1`,
    [documentId, providerUid],
  );
  if (!result.rowCount) throw Object.assign(new Error('Document not found'), { statusCode: 404 });
  const row = result.rows[0];
  if (!row.storage_path) {
    throw Object.assign(new Error('This legacy document must be re-uploaded before private preview is available'), {
      statusCode: 409,
      code: 'LEGACY_DOCUMENT_REUPLOAD_REQUIRED',
    });
  }
  const { createPrivatePreviewUrl } = await import('../helpers/firebaseStorageUploader');
  const preview = await createPrivatePreviewUrl(row.storage_path, 300);
  return { documentId: String(row.id), displayName: row.file_name, mimeType: row.mime_type, ...preview };
};

export const deleteDocument = async (providerUid: string, documentId: number) => {
  const result = await dbQuery.query(
    `SELECT wr.id, wr.storage_path, wr.lifecycle_state,
            COALESCE(ld.decision, 'pending_review') AS review_state
     FROM ${s}.worker_requirements wr
     ${latestDecisionSql}
     WHERE wr.id = $1 AND wr.worker_uid = $2 LIMIT 1`,
    [documentId, providerUid],
  );
  if (!result.rowCount) {
    throw Object.assign(new Error('Document not found'), { statusCode: 404, code: 'DOCUMENT_NOT_FOUND' });
  }
  const row = result.rows[0];
  if (row.lifecycle_state === 'verified' || row.review_state === 'approved') {
    throw Object.assign(new Error('Approved documents cannot be deleted. Submit a replacement instead.'), {
      statusCode: 409,
      code: 'APPROVED_DOCUMENT_LOCKED',
    });
  }

  // Remove the private object first. If the following row delete fails, the
  // provider can retry and no sensitive blob is left behind; the temporary
  // stale metadata is safer than an untracked private object.
  if (row.storage_path) {
    const { deletePrivateStoredFile } = await import('../helpers/firebaseStorageUploader');
    await deletePrivateStoredFile(row.storage_path);
  }
  const deleted = await dbQuery.query(
    `DELETE FROM ${s}.worker_requirements
     WHERE id = $1 AND worker_uid = $2
       AND lifecycle_state <> 'verified'
     RETURNING storage_path`,
    [documentId, providerUid],
  );
  if (!deleted.rowCount) {
    throw Object.assign(new Error('Document could not be deleted'), { statusCode: 409, code: 'DOCUMENT_STATE_CHANGED' });
  }
};

interface UploadDocumentInput {
  documentTypeId: string;
  fileName: string;
  file: string;
  clientRequestId: string;
  issueDate?: string | null;
  expiresAt?: string | null;
  identifierLast4?: string | null;
  replacementForId?: number | null;
}

export const uploadDocument = async (providerUid: string, input: UploadDocumentInput) => {
  const definition = DOCUMENT_TYPE_CATALOG.find((d) => d.id === input.documentTypeId || d.aliases?.includes(input.documentTypeId));
  if (!definition) throw Object.assign(new Error('Unknown document type'), { statusCode: 422, code: 'UNKNOWN_DOCUMENT_TYPE' });
  if (!/^[a-zA-Z0-9:_-]{16,128}$/.test(input.clientRequestId)) {
    throw Object.assign(new Error('clientRequestId must be 16-128 safe characters'), { statusCode: 400 });
  }
  // Fast replay path: a confirmed retry must not depend on the scanner or
  // storage being available again. The transaction repeats this check under
  // the provider/type lock to close the concurrent-request race.
  const replay = await dbQuery.query(
    `SELECT id, requirement_type FROM ${s}.worker_requirements WHERE worker_uid = $1 AND client_request_id = $2 LIMIT 1`,
    [providerUid, input.clientRequestId],
  );
  if (replay.rowCount) {
    const replayDefinition = DOCUMENT_TYPE_CATALOG.find((d) =>
      d.id === replay.rows[0].requirement_type || d.aliases?.includes(replay.rows[0].requirement_type));
    if (replayDefinition?.id !== definition.id) {
      throw Object.assign(new Error('Idempotency key was already used for another document type'), {
        statusCode: 409,
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    }
    const all = await listDocuments(providerUid);
    return all.find((d: any) => d.id === String(replay.rows[0].id));
  }
  if (definition.expiry === 'required' && !input.expiresAt) {
    throw Object.assign(new Error('Expiration date is required for this document type'), { statusCode: 422, code: 'EXPIRATION_REQUIRED' });
  }
  const issueTime = input.issueDate ? Date.parse(input.issueDate) : null;
  const expiryTime = input.expiresAt ? Date.parse(input.expiresAt) : null;
  if (input.issueDate && (issueTime == null || Number.isNaN(issueTime))) {
    throw Object.assign(new Error('Issue date is invalid'), { statusCode: 422, code: 'INVALID_ISSUE_DATE' });
  }
  if (input.expiresAt && (expiryTime == null || Number.isNaN(expiryTime))) {
    throw Object.assign(new Error('Expiration date is invalid'), { statusCode: 422, code: 'INVALID_EXPIRATION_DATE' });
  }
  if (expiryTime != null && expiryTime <= Date.now()) {
    throw Object.assign(new Error('An expired document cannot be submitted as current'), { statusCode: 422, code: 'DOCUMENT_ALREADY_EXPIRED' });
  }
  if (issueTime != null && issueTime > Date.now()) {
    throw Object.assign(new Error('Issue date cannot be in the future'), { statusCode: 422, code: 'ISSUE_DATE_IN_FUTURE' });
  }
  if (issueTime != null && expiryTime != null && expiryTime <= issueTime) {
    throw Object.assign(new Error('Expiration date must be after the issue date'), { statusCode: 422, code: 'INVALID_DOCUMENT_DATE_RANGE' });
  }
  if (input.identifierLast4 && !/^[a-zA-Z0-9]{2,4}$/.test(input.identifierLast4)) {
    throw Object.assign(new Error('Identifier suffix must contain 2-4 letters or numbers'), { statusCode: 422, code: 'INVALID_IDENTIFIER_SUFFIX' });
  }
  const validation = validateDataUri(input.file, {
    allowed: definition.acceptedMimeTypes as readonly AllowedUploadMime[],
    maxBytes: MAX_DOCUMENT_BYTES,
  });
  if (!validation.ok) throw Object.assign(new Error(validation.message), { statusCode: 422, code: validation.code });
  const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || `${definition.id}.${validation.mime.split('/').pop()}`;
  const scan = await scanProviderFile({ buffer: validation.buffer, mimeType: validation.mime, fileName: safeName });
  assertCleanScan(scan);
  // §58. A phone embeds EXIF GPS in a photo by default, and a provider
  // photographs their ID or NBI clearance at home — so the file carries their
  // home coordinates into storage and into every admin preview. The
  // booking-evidence path has stripped this since Command 19 for exactly this
  // reason; identity documents are strictly more sensitive and were missed.
  //
  // Stripped AFTER the malware scan so the scanner still sees the original
  // bytes, and BEFORE the hash so the digest describes what is actually
  // stored. `stripImageMetadata` is total — unknown types and malformed input
  // return the buffer unchanged, so this cannot fail an upload.
  const persistenceBuffer = stripImageMetadata(scan.sanitizedBuffer ?? validation.buffer, validation.mime);
  const persistenceDataUri = `data:${validation.mime};base64,${persistenceBuffer.toString('base64')}`;
  const contentSha256 = createHash('sha256').update(persistenceBuffer).digest('hex');
  const identifierMask = input.identifierLast4 ? `****${input.identifierLast4}` : null;
  const client = await pool.connect();
  let stored: { storagePath: string; mimeType: string; byteSize: number } | null = null;
  let commitAttempted = false;
  let id!: number;
  try {
    await client.query('BEGIN');
    // One provider/type lock makes idempotency, logical file limits, and
    // replacement-chain checks atomic across concurrent mobile/web retries.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [providerUid, definition.id]);
    const prior = await client.query(
      `SELECT id, requirement_type FROM ${s}.worker_requirements WHERE worker_uid = $1 AND client_request_id = $2 LIMIT 1`,
      [providerUid, input.clientRequestId],
    );
    if (prior.rowCount) {
      const priorDefinition = DOCUMENT_TYPE_CATALOG.find((d) =>
        d.id === prior.rows[0].requirement_type || d.aliases?.includes(prior.rows[0].requirement_type));
      if (priorDefinition?.id !== definition.id) {
        throw Object.assign(new Error('Idempotency key was already used for another document type'), {
          statusCode: 409,
          code: 'IDEMPOTENCY_KEY_REUSED',
        });
      }
      id = Number(prior.rows[0].id);
      commitAttempted = true;
      await client.query('COMMIT');
    } else {
      if (input.replacementForId) {
        const owned = await client.query(
          `SELECT id, requirement_type FROM ${s}.worker_requirements
           WHERE id = $1 AND worker_uid = $2 FOR UPDATE`,
          [input.replacementForId, providerUid],
        );
        if (!owned.rowCount) throw Object.assign(new Error('Replacement document not found'), { statusCode: 404 });
        const existingDefinition = DOCUMENT_TYPE_CATALOG.find((d) => d.id === owned.rows[0].requirement_type || d.aliases?.includes(owned.rows[0].requirement_type));
        if (existingDefinition?.id !== definition.id) {
          throw Object.assign(new Error('Replacement must use the same document type'), { statusCode: 409, code: 'REPLACEMENT_TYPE_MISMATCH' });
        }
        const pendingChild = await client.query(
          `SELECT id FROM ${s}.worker_requirements
           WHERE worker_uid = $1 AND replacement_for_id = $2
             AND lifecycle_state NOT IN ('replaced', 'revoked') LIMIT 1`,
          [providerUid, input.replacementForId],
        );
        if (pendingChild.rowCount) {
          throw Object.assign(new Error('A replacement is already active for this document'), { statusCode: 409, code: 'REPLACEMENT_ALREADY_SUBMITTED' });
        }
      } else {
        const slots = await client.query(
          `SELECT COUNT(*)::int AS count FROM ${s}.worker_requirements
           WHERE worker_uid = $1 AND requirement_type = $2
             AND replacement_for_id IS NULL AND lifecycle_state <> 'revoked'`,
          [providerUid, definition.id],
        );
        if (Number(slots.rows[0]?.count ?? 0) >= definition.maximumFiles) {
          throw Object.assign(new Error(`A maximum of ${definition.maximumFiles} files is allowed for this document type`), {
            statusCode: 409,
            code: 'DOCUMENT_FILE_LIMIT_REACHED',
          });
        }
      }
      const storage = await import('../helpers/firebaseStorageUploader');
      stored = await storage.uploadPrivateFileToStorage(
        `provider-compliance/${providerUid}`,
        input.clientRequestId,
        persistenceDataUri,
      );
      const result = await client.query(
        `INSERT INTO ${s}.worker_requirements
           (worker_uid, file_url, file_name, requirement_type, storage_path,
            mime_type, byte_size, content_sha256, scanner_engine, client_request_id,
            lifecycle_state, scan_status, issue_date, expires_at, identifier_mask,
            replacement_for_id, version, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 'under_review', 'clean', $11, $12, $13, $14, 1, NOW())
         RETURNING id`,
        [providerUid, `private://${stored.storagePath}`, safeName, definition.id,
          stored.storagePath, stored.mimeType, stored.byteSize, contentSha256, scan.engine,
          input.clientRequestId, input.issueDate ?? null, input.expiresAt ?? null,
          identifierMask, input.replacementForId ?? null],
      );
      id = Number(result.rows[0].id);
      await client.query(
        `INSERT INTO ${s}.provider_verification_events
           (provider_uid, domain, source_type, source_id, event_type, event_key)
         VALUES ($1, 'document', 'worker_requirement', $2, 'document_submitted', $3)
         ON CONFLICT (provider_uid, event_key) DO NOTHING`,
        [providerUid, String(id), `document-submitted:${id}:v1`],
      );
      commitAttempted = true;
      await client.query('COMMIT');
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (!commitAttempted) {
      if (stored?.storagePath) {
        const { deletePrivateStoredFile } = await import('../helpers/firebaseStorageUploader');
        await deletePrivateStoredFile(stored.storagePath).catch(() => {});
      }
    }
    throw error;
  } finally {
    client.release();
  }
  const all = await listDocuments(providerUid);
  return all.find((d: any) => d.id === String(id));
};

export const listCertifications = async (providerUid: string) => {
  const result = await dbQuery.query(
    `SELECT id, certification_type, issuing_authority, credential_mask,
            issue_date, expires_at, related_document_id, state,
            renewal_of_id, provider_reason_code, provider_reason_detail,
            version, created_at, updated_at
     FROM ${s}.provider_certifications WHERE provider_uid = $1
     ORDER BY created_at DESC`,
    [providerUid],
  );
  const now = Date.now();
  return result.rows.map((r: any) => ({
    id: r.id,
    certificationType: r.certification_type,
    issuingAuthority: r.issuing_authority,
    credentialMask: r.credential_mask,
    issueDate: r.issue_date,
    expiresAt: r.expires_at,
    state: r.expires_at && new Date(r.expires_at).getTime() <= now && r.state === 'verified' ? 'expired' : r.state,
    relatedDocumentId: r.related_document_id == null ? null : String(r.related_document_id),
    renewalOfId: r.renewal_of_id,
    providerReasonCode: r.provider_reason_code,
    providerReasonDetail: r.provider_reason_detail,
    version: Number(r.version),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
};

export const submitCertification = async (providerUid: string, input: {
  certificationType: string;
  issuingAuthority: string;
  credentialLast4?: string | null;
  issueDate?: string | null;
  expiresAt?: string | null;
  relatedDocumentId: number;
  renewalOfId?: string | null;
  clientRequestId: string;
}) => {
  if (!/^[a-zA-Z0-9:_-]{16,128}$/.test(input.clientRequestId)) throw Object.assign(new Error('Invalid client request id'), { statusCode: 400 });
  const ownedDoc = await dbQuery.query(
    `SELECT id FROM ${s}.worker_requirements WHERE id = $1 AND worker_uid = $2 LIMIT 1`,
    [input.relatedDocumentId, providerUid],
  );
  if (!ownedDoc.rowCount) throw Object.assign(new Error('Related document not found'), { statusCode: 404 });
  if (input.renewalOfId) {
    const ownedCert = await dbQuery.query(
      `SELECT id FROM ${s}.provider_certifications WHERE id = $1 AND provider_uid = $2 LIMIT 1`,
      [input.renewalOfId, providerUid],
    );
    if (!ownedCert.rowCount) throw Object.assign(new Error('Certification to renew not found'), { statusCode: 404 });
  }
  const result = await dbQuery.query(
    `INSERT INTO ${s}.provider_certifications
       (provider_uid, certification_type, issuing_authority, credential_mask,
        issue_date, expires_at, related_document_id, state, renewal_of_id,
        client_request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'under_review', $8, $9)
     ON CONFLICT (provider_uid, client_request_id)
     DO UPDATE SET updated_at = ${s}.provider_certifications.updated_at
     RETURNING id`,
    [providerUid, input.certificationType.trim().slice(0, 80), input.issuingAuthority.trim().slice(0, 160),
      input.credentialLast4 ? `****${input.credentialLast4.slice(-4)}` : null,
      input.issueDate ?? null, input.expiresAt ?? null, input.relatedDocumentId,
      input.renewalOfId ?? null, input.clientRequestId],
  );
  const all = await listCertifications(providerUid);
  return all.find((c: any) => c.id === result.rows[0].id);
};

/**
 * Everything `computeCompliance` reasons about, loaded ONCE.
 *
 * Split out because three readers need these same three lists — the compliance
 * verdict, the activation projection's document and certification summaries, and
 * its completion checklist. Before the split, the canonical activation read
 * would have issued `listDocuments` three times for one screen: once inside
 * `calculateCompliance`, once inside the account-state machine that also calls
 * it, and once for the summary. §56 names duplicate queries on a hot read as the
 * defect; this makes the single load structural rather than remembered.
 *
 * `first_name` and `last_name` are selected here and NOT used by
 * `computeCompliance`. They are the legal-name half of the activation checklist,
 * and taking them from this row rather than from a second query is what stops
 * the checklist disagreeing with the compliance verdict about the same account.
 */
export interface ComplianceInputs {
  /** The provider credential row, or null when the uid names no provider. */
  account: any | null;
  documents: any[];
  certifications: any[];
}

export const loadComplianceInputs = async (providerUid: string): Promise<ComplianceInputs> => {
  const [cred, documents, certifications] = await Promise.all([
    dbQuery.query(
      `SELECT account_status, is_archive, COALESCE(is_email_verified,false) AS email_verified,
              COALESCE(is_mobile_verified,false) AS mobile_verified,
              COALESCE(is_email_verified,false) AS is_email_verified,
              COALESCE(is_mobile_verified,false) AS is_mobile_verified,
              first_name, last_name
       FROM ${s}.user_credentials WHERE uid = $1 AND role::int IN (2,4) LIMIT 1`,
      [providerUid],
    ),
    listDocuments(providerUid),
    listCertifications(providerUid),
  ]);
  return {
    account: cred.rowCount ? cred.rows[0] : null,
    documents,
    certifications,
  };
};

/**
 * The compliance verdict over already-loaded inputs. Pure, so the activation
 * projection and the account-state machine cannot reach different verdicts from
 * the same rows.
 */
export const computeCompliance = ({ account, documents, certifications }: ComplianceInputs) => {
  if (!account) return { state: 'restricted', version: 1, blockingRequirements: [{ code: 'PROVIDER_NOT_FOUND', severity: 'blocking', action: 'contact-support' }], warnings: [], affectedCapabilities: ['jobs', 'services', 'payouts'] };
  const blockingRequirements: any[] = [];
  const warnings: any[] = [];
  if (account.account_status !== 'active' || account.is_archive) blockingRequirements.push({ code: 'ACCOUNT_NOT_ACTIVE', severity: 'blocking', action: 'contact-support' });
  if (!account.email_verified && !account.mobile_verified) blockingRequirements.push({ code: 'VERIFIED_CONTACT_REQUIRED', severity: 'blocking', action: 'verify-contact' });
  for (const definition of DOCUMENT_TYPE_CATALOG.filter((d) => d.required)) {
    const matching = documents.filter((d: any) => d.documentTypeId === definition.id || definition.aliases?.includes(d.documentTypeId));
    if (!matching.some((d: any) => d.state === 'verified')) {
      const actionRequired = matching.some((d: any) => ['rejected', 'expired', 'action_required'].includes(d.state));
      blockingRequirements.push({
        code: actionRequired ? 'DOCUMENT_ACTION_REQUIRED' : 'REQUIRED_DOCUMENT_NOT_VERIFIED',
        documentTypeId: definition.id,
        label: definition.name,
        severity: 'blocking',
        action: actionRequired ? 'replace-document' : 'upload-document',
      });
    }
  }
  const warningWindow = Date.now() + 30 * 24 * 60 * 60 * 1000;
  for (const document of documents) {
    if (document.state === 'verified' && document.expiresAt && new Date(document.expiresAt).getTime() <= warningWindow) {
      warnings.push({ code: 'DOCUMENT_EXPIRING_SOON', documentId: document.id, severity: 'warning', action: 'replace-document' });
    }
  }
  for (const certification of certifications) {
    if (certification.state === 'expired' || certification.state === 'revoked') {
      warnings.push({ code: 'CERTIFICATION_NOT_CURRENT', certificationId: certification.id, severity: 'warning', action: 'renew-certification' });
    }
  }
  return {
    state: blockingRequirements.length ? 'action_required' : warnings.length ? 'expiring_soon' : 'compliant',
    blockingRequirements,
    warnings,
    affectedCapabilities: blockingRequirements.length ? ['jobs', 'new-service-readiness', 'payout-changes'] : [],
    affectedServices: [],
    effectiveAt: new Date().toISOString(),
    version: 1,
  };
};

/**
 * The compliance verdict for one provider. Unchanged on the wire: load, then
 * compute, exactly as this function did inline before the split.
 */
export const calculateCompliance = async (providerUid: string) =>
  computeCompliance(await loadComplianceInputs(providerUid));

export const getPublicProfile = async (providerUid: string) => {
  const result = await dbQuery.query(
    `SELECT uc.uid, uc.first_name, uc.last_name,
            up.public_display_name, up.public_bio, up.public_skills,
            up.public_languages, up.public_experience_summary,
            up.photo_url, up.public_profile_version
     FROM ${s}.user_credentials uc
     LEFT JOIN ${s}.user_profile up ON up.uid = uc.uid
     WHERE uc.uid = $1 AND uc.role::int IN (2,4) LIMIT 1`,
    [providerUid],
  );
  if (!result.rowCount) throw Object.assign(new Error('Provider not found'), { statusCode: 404 });
  const r = result.rows[0];
  const [pending, publicRating] = await Promise.all([dbQuery.query(
    `SELECT id, submitted_fields, state, provider_reason_code, provider_reason_detail, submitted_at, version
     FROM ${s}.provider_profile_revisions
     WHERE provider_uid = $1 AND state IN ('pending_review','action_required')
     ORDER BY submitted_at DESC LIMIT 1`,
    [providerUid],
  ), getPublicRatingSummary(providerUid)]);
  return {
    providerProfileId: providerUid,
    displayName: r.public_display_name ?? `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
    photoUrl: r.photo_url ?? null,
    biography: r.public_bio ?? null,
    skills: safeList(r.public_skills),
    languages: safeList(r.public_languages),
    experienceSummary: r.public_experience_summary ?? null,
    publicRating,
    version: Number(r.public_profile_version ?? 1),
    pendingRevision: pending.rows[0] ? {
      id: pending.rows[0].id,
      fields: pending.rows[0].submitted_fields,
      state: pending.rows[0].state,
      providerReasonCode: pending.rows[0].provider_reason_code,
      providerReasonDetail: pending.rows[0].provider_reason_detail,
      submittedAt: pending.rows[0].submitted_at,
      version: Number(pending.rows[0].version),
    } : null,
  };
};

/**
 * The fields the PUBLIC-PROFILE REVISION channel actually carries.
 *
 * ## The disagreement this replaces
 *
 * There were two allow-lists for one write and they did not match.
 * `PROVIDER_SELF_EDITABLE_FIELDS` is DERIVED from the field registry — every
 * field marked `editable: 'review'` — and returns SIX ids. This function's
 * allow-list was a hand-written Set of FIVE. The missing one is `photo`.
 *
 * The consequence was a route that contradicted itself within two statements.
 * `patchProviderProfile` asks `providerMayEdit('photo')`, which consults the
 * registry and says yes, and its refusal message for everything else prints
 * `PROVIDER_SELF_EDITABLE_FIELDS` — so it advertises `photo` to the provider as
 * reviewable. The request then reached here and was refused with a DIFFERENT
 * code, `FIELD_NOT_EDITABLE`, which is not in the set `provider.profile.patch`
 * declares it can return. A client gating on the published contract, as TAB 03
 * requires, could not have handled it.
 *
 * ## Why the registry is not the thing that was wrong
 *
 * `photo` genuinely IS provider-editable under review. It simply is not editable
 * THROUGH THIS CHANNEL: a photo is a file, and it has its own submission
 * pipeline with the MIME, magic-byte and size validation §44 demands. Widening
 * this allow-list to accept it would create a second, weaker path to change a
 * customer-visible image — a jsonb string where a validated upload belongs.
 *
 * So the registry keeps saying `photo` is reviewable, and this constant says
 * which channel carries it. `REVIEW_FIELD_CHANNELS` names the exception, and
 * `tests/provider-profile-patch-channels.test.ts` fails the build when the two
 * stop covering the registry between them — so a seventh review field cannot be
 * added without somebody stating where it is submitted.
 */
export const PUBLIC_PROFILE_REVISION_FIELDS: readonly string[] = Object.freeze([
  'displayName', 'biography', 'skills', 'languages', 'experienceSummary',
]);

/**
 * Review-editable fields this channel does NOT carry, and where each goes
 * instead. A refusal that names the alternative is an instruction; one that does
 * not is a dead end.
 */
export const REVIEW_FIELD_CHANNELS: Readonly<Record<string, string>> = Object.freeze({
  photo: 'POST /api/provider/profile-photo-submissions',
});

export const submitPublicProfileRevision = async (providerUid: string, input: {
  fields: Record<string, unknown>;
  clientRequestId: string;
}) => {
  if (!/^[a-zA-Z0-9:_-]{16,128}$/.test(input.clientRequestId)) throw Object.assign(new Error('Invalid client request id'), { statusCode: 400 });
  const allowed = new Set(PUBLIC_PROFILE_REVISION_FIELDS);
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.fields ?? {})) {
    if (!allowed.has(key)) throw Object.assign(new Error(`Field ${key} is not editable through public profile`), { statusCode: 422, code: 'FIELD_NOT_EDITABLE' });
    if (key === 'skills' || key === 'languages') fields[key] = safeList(value);
    else fields[key] = String(value ?? '').trim().slice(0, key === 'biography' ? 1200 : 300);
  }
  if (!Object.keys(fields).length) throw Object.assign(new Error('At least one public field is required'), { statusCode: 400 });
  const result = await dbQuery.query(
    `INSERT INTO ${s}.provider_profile_revisions
       (provider_uid, client_request_id, submitted_fields, state)
     VALUES ($1, $2, $3::jsonb, 'pending_review')
     ON CONFLICT (provider_uid, client_request_id)
     DO UPDATE SET client_request_id = EXCLUDED.client_request_id
     RETURNING id, submitted_fields, state, submitted_at, version`,
    [providerUid, input.clientRequestId, JSON.stringify(fields)],
  );
  return result.rows[0];
};

export const getVerificationTimeline = async (providerUid: string, limit = 50) => {
  const result = await dbQuery.query(
    `SELECT id, domain, source_type, source_id, event_type,
            provider_reason_code, provider_reason_detail, created_at
     FROM ${s}.provider_verification_events WHERE provider_uid = $1
     ORDER BY created_at DESC LIMIT $2`,
    [providerUid, Math.max(1, Math.min(limit, 100))],
  );
  return result.rows.map((r: any) => ({
    id: r.id,
    domain: r.domain,
    sourceType: r.source_type,
    sourceId: r.source_id,
    eventType: r.event_type,
    providerReasonCode: r.provider_reason_code,
    providerReasonDetail: r.provider_reason_detail,
    createdAt: r.created_at,
  }));
};

/**
 * The activation summarisers, extracted so ONE derivation serves both readers.
 *
 * `getProfileCenter` computed these three inline. The canonical activation
 * projection (`provider.activation.get`) needs the same three numbers, and a
 * second inline copy is how [[feedback_one_rule_three_statements]] happens — one
 * rule stated in three places, disagreeing in all three. These are pure
 * functions over lists the caller already loaded, so neither reader issues a
 * query the other has already issued, and neither can drift from the other
 * without a compile error.
 *
 * Pure on purpose: `documentSummary` and `certificationSummary` are counts over
 * the SAME arrays `calculateCompliance` reasons about, so a caller that has
 * those arrays must never re-fetch them to count them (§56).
 */
export interface DocumentSummary {
  total: number;
  verified: number;
  actionRequired: number;
}

export const summariseDocuments = (documents: readonly any[]): DocumentSummary => ({
  total: documents.length,
  verified: documents.filter((d: any) => d.state === 'verified').length,
  actionRequired: documents.filter((d: any) =>
    ['rejected', 'expired', 'action_required'].includes(d.state)).length,
});

export interface CertificationSummary {
  total: number;
  current: number;
}

export const summariseCertifications = (certifications: readonly any[]): CertificationSummary => ({
  total: certifications.length,
  current: certifications.filter((c: any) => c.state === 'verified').length,
});

export interface CompletionRequirement {
  id: string;
  label: string;
  state: 'completed' | 'pending' | 'blocked';
  blocking: boolean;
  route: string;
}

/**
 * The provider-facing activation checklist.
 *
 * Driven by `DOCUMENT_TYPE_CATALOG`, not by the rows: a required document that
 * has NEVER been submitted must appear as `blocked`, and a list built from rows
 * alone shows an empty checklist to the provider who has everything left to do.
 * Same reasoning `listDocuments`' caller in the v1 document list already applies.
 *
 * `account` is the already-loaded credential row rather than a uid, so this
 * cannot issue a query and cannot therefore disagree with the row its caller
 * reasoned about.
 */
export const buildCompletionRequirements = (
  account: any,
  documents: readonly any[],
): CompletionRequirement[] => [
  {
    id: 'verified_contact',
    label: 'Verify an email or mobile number',
    state: account.is_email_verified || account.is_mobile_verified ? 'completed' : 'blocked',
    blocking: true,
    route: 'SecurityView',
  },
  {
    id: 'legal_name',
    label: 'Provide your legal name',
    state: account.first_name && account.last_name ? 'completed' : 'blocked',
    blocking: true,
    route: 'ProfileView',
  },
  ...DOCUMENT_TYPE_CATALOG.filter((d) => d.required).map((definition) => ({
    id: `document:${definition.id}`,
    label: definition.name,
    state: (documents.some((d: any) => (d.documentTypeId === definition.id || definition.aliases?.includes(d.documentTypeId)) && d.state === 'verified')
      ? 'completed'
      : documents.some((d: any) => d.documentTypeId === definition.id || definition.aliases?.includes(d.documentTypeId))
        ? 'pending'
        : 'blocked') as CompletionRequirement['state'],
    blocking: true,
    route: 'ProviderDocumentsView',
  })),
];

/** `complete` only when every requirement is. Anything else is `incomplete`. */
export const completionStateOf = (
  requirements: readonly CompletionRequirement[],
): 'complete' | 'incomplete' =>
  requirements.every((r) => r.state === 'completed') ? 'complete' : 'incomplete';

export const getProfileCenter = async (providerUid: string) => {
  const [account, publicProfile, documents, certifications, compliance, timeline, services] = await Promise.all([
    dbQuery.query(
      `SELECT uc.uid, uc.first_name, uc.last_name, uc.email, uc.phone_number,
              uc.is_email_verified, uc.is_mobile_verified, uc.account_status,
              uc.role, uc.is_archive, up.birthdate, up.gender, up.profile_version,
              pa.activation_status
       FROM ${s}.user_credentials uc
       LEFT JOIN ${s}.user_profile up ON up.uid = uc.uid
       LEFT JOIN ${s}.provider_activation pa ON pa.provider_uid = uc.uid
       WHERE uc.uid = $1 AND uc.role::int IN (2,4) LIMIT 1`,
      [providerUid],
    ),
    getPublicProfile(providerUid),
    listDocuments(providerUid),
    listCertifications(providerUid),
    calculateCompliance(providerUid),
    getVerificationTimeline(providerUid, 20),
    dbQuery.query(
      `SELECT es.service_id, s.name, COALESCE(es.status,'active') AS status
       FROM ${s}.employee_services es LEFT JOIN ${s}.services s ON s.id = es.service_id
       WHERE es.employee_uid = $1 ORDER BY s.name`,
      [providerUid],
    ),
  ]);
  if (!account.rowCount) throw Object.assign(new Error('Provider not found'), { statusCode: 404 });
  const a = account.rows[0];
  const completionRequirements = buildCompletionRequirements(a, documents);
  return {
    providerProfileId: providerUid,
    accountId: providerUid,
    privateAccount: {
      legalName: [a.first_name, a.last_name].filter(Boolean).join(' '),
      birthDate: a.birthdate ?? null,
      gender: a.gender ?? null,
      emailMasked: maskEmail(a.email),
      mobileMasked: maskPhone(a.phone_number),
      emailVerification: a.is_email_verified ? 'verified' : a.email ? 'pending' : 'not_started',
      mobileVerification: a.is_mobile_verified ? 'verified' : a.phone_number ? 'pending' : 'not_started',
    },
    publicProfile,
    operational: {
      providerType: Number(a.role) === 4 ? 'organization_provider' : 'individual_provider',
      accountState: a.account_status ?? 'unknown',
      approvalState: a.account_status === 'active' ? 'approved' : a.account_status ?? 'unknown',
      activationState: a.activation_status ?? 'not_started',
      branch: null,
      serviceArea: null,
      services: services.rows.map((r: any) => ({ serviceId: String(r.service_id), name: r.name, operationalState: r.status })),
    },
    completion: {
      state: completionStateOf(completionRequirements),
      requirements: completionRequirements,
    },
    compliance,
    documentSummary: summariseDocuments(documents),
    certificationSummary: summariseCertifications(certifications),
    timeline,
    fieldRegistryVersion: 1,
    documentCatalogVersion: 1,
    version: Number(a.profile_version ?? 1),
  };
};

export const applyDocumentDecisionEffects = async (
  requirementId: number,
  decision: 'approved' | 'rejected' | 'needs_resubmission' | 'escalated',
) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT id, worker_uid, replacement_for_id, version
       FROM ${s}.worker_requirements WHERE id = $1 FOR UPDATE`,
      [requirementId],
    );
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return;
    }
    const row = result.rows[0];
    const lifecycle = decision === 'approved' ? 'verified'
      : decision === 'rejected' ? 'rejected'
      : decision === 'needs_resubmission' ? 'action_required'
      : 'under_review';
    await client.query(
      `UPDATE ${s}.worker_requirements
       SET lifecycle_state = $1, version = version + 1, updated_at = NOW()
       WHERE id = $2`,
      [lifecycle, requirementId],
    );
    if (decision === 'approved' && row.replacement_for_id) {
      await client.query(
        `UPDATE ${s}.worker_requirements
         SET lifecycle_state = 'replaced', replaced_by_id = $1,
             version = version + 1, updated_at = NOW()
         WHERE id = $2 AND worker_uid = $3`,
        [requirementId, row.replacement_for_id, row.worker_uid],
      );
    }
    await client.query(
      `INSERT INTO ${s}.provider_verification_events
         (provider_uid, domain, source_type, source_id, event_type, event_key)
       VALUES ($1, 'document', 'worker_requirement', $2, $3, $4)
       ON CONFLICT (provider_uid, event_key) DO NOTHING`,
      [row.worker_uid, String(requirementId), `document_${decision}`, `document-${requirementId}-${decision}-v${Number(row.version) + 1}`],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
