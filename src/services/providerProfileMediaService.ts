import { createHash } from 'crypto';
import dbQuery, { pool } from '../db/dbQuery';
import { db } from '../config';
import { validateDataUri, AllowedUploadMime } from '../helpers/fileSignature';
import { assertCleanScan, scanProviderFile } from './providerManagedFileScanner';

const s = db.schema;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'] as const;
const MAX_BYTES = 4 * 1024 * 1024;

export async function submitProfilePhoto(providerUid: string, input: { file: string; clientRequestId: string }) {
  if (!/^[a-zA-Z0-9:_-]{16,128}$/.test(input.clientRequestId)) throw Object.assign(new Error('Invalid client request id'), { statusCode: 400 });
  const prior = await dbQuery.query(
    `SELECT * FROM ${s}.provider_profile_media_submissions WHERE provider_uid = $1 AND client_request_id = $2 LIMIT 1`,
    [providerUid, input.clientRequestId],
  );
  if (prior.rowCount) return present(prior.rows[0]);
  const validation = validateDataUri(input.file, { allowed: ALLOWED as readonly AllowedUploadMime[], maxBytes: MAX_BYTES });
  if (!validation.ok) throw Object.assign(new Error(validation.message), { statusCode: 422, code: validation.code });
  const scan = await scanProviderFile({ buffer: validation.buffer, mimeType: validation.mime, fileName: 'profile-photo' });
  assertCleanScan(scan);
  const bytes = scan.sanitizedBuffer ?? validation.buffer;
  const dataUri = `data:${validation.mime};base64,${bytes.toString('base64')}`;
  const { uploadPrivateFileToStorage } = await import('../helpers/firebaseStorageUploader');
  const stored = await uploadPrivateFileToStorage(`provider-profile-media/${providerUid}`, input.clientRequestId, dataUri);
  try {
    const result = await dbQuery.query(
      `INSERT INTO ${s}.provider_profile_media_submissions
         (provider_uid, private_storage_path, mime_type, byte_size, content_sha256,
          scan_status, scanner_engine, state, client_request_id)
       VALUES ($1,$2,$3,$4,$5,'clean',$6,'under_review',$7)
       ON CONFLICT (provider_uid, client_request_id)
       DO UPDATE SET updated_at = ${s}.provider_profile_media_submissions.updated_at
       RETURNING *`,
      [providerUid, stored.storagePath, stored.mimeType, stored.byteSize,
        createHash('sha256').update(bytes).digest('hex'), scan.engine, input.clientRequestId],
    );
    return present(result.rows[0]);
  } catch (error) {
    const { deletePrivateStoredFile } = await import('../helpers/firebaseStorageUploader');
    await deletePrivateStoredFile(stored.storagePath).catch(() => {});
    throw error;
  }
}

export async function listProfilePhotos(providerUid: string) {
  const result = await dbQuery.query(
    `SELECT * FROM ${s}.provider_profile_media_submissions WHERE provider_uid = $1 ORDER BY created_at DESC LIMIT 20`,
    [providerUid],
  );
  return result.rows.map(present);
}

export async function previewProfilePhoto(providerUid: string, submissionId: string) {
  const result = await dbQuery.query(
    `SELECT id, provider_uid, private_storage_path, mime_type, state
     FROM ${s}.provider_profile_media_submissions
     WHERE id = $1 AND provider_uid = $2 LIMIT 1`,
    [submissionId, providerUid],
  );
  if (!result.rowCount) throw Object.assign(new Error('Profile photo submission not found'), { statusCode: 404 });
  const { createPrivatePreviewUrl } = await import('../helpers/firebaseStorageUploader');
  return { submissionId: String(result.rows[0].id), mimeType: result.rows[0].mime_type, ...(await createPrivatePreviewUrl(result.rows[0].private_storage_path, 300)) };
}

export async function decideProfilePhoto(input: {
  providerUid: string;
  submissionId: string;
  adminUid: string;
  decision: 'approved' | 'rejected';
  providerReasonCode?: string | null;
  providerReasonDetail?: string | null;
  internalNote?: string | null;
}) {
  const client = await pool.connect();
  let published: { storagePath: string; url: string } | null = null;
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT * FROM ${s}.provider_profile_media_submissions
       WHERE id = $1 AND provider_uid = $2 FOR UPDATE`,
      [input.submissionId, input.providerUid],
    );
    if (!found.rowCount) throw Object.assign(new Error('Profile photo submission not found'), { statusCode: 404 });
    const row = found.rows[0];
    if (row.state === input.decision) {
      await client.query('COMMIT');
      return present(row);
    }
    if (row.state !== 'under_review') throw Object.assign(new Error('Profile photo is no longer reviewable'), { statusCode: 409, code: 'MEDIA_DECISION_CONFLICT' });
    if (input.decision === 'rejected' && !String(input.providerReasonDetail ?? '').trim()) {
      throw Object.assign(new Error('A provider-safe rejection reason is required'), { statusCode: 422, code: 'PROVIDER_REASON_REQUIRED' });
    }
    if (input.decision === 'approved') {
      if (row.scan_status !== 'clean') throw Object.assign(new Error('Only clean media can be published'), { statusCode: 409, code: 'MEDIA_NOT_CLEAN' });
      const { publishApprovedProfileMedia } = await import('../helpers/firebaseStorageUploader');
      published = await publishApprovedProfileMedia(row.private_storage_path, input.providerUid, String(row.id), row.mime_type);
      await client.query(
        `UPDATE ${s}.provider_profile_media_submissions
         SET state = 'replaced', version = version + 1, updated_at = NOW()
         WHERE provider_uid = $1 AND media_kind = 'profile_photo' AND state = 'approved' AND id <> $2`,
        [input.providerUid, input.submissionId],
      );
      await client.query(
        `INSERT INTO ${s}.user_profile(uid, photo_url, updated_at)
         VALUES ($1,$2,NOW())
         ON CONFLICT (uid) DO UPDATE SET photo_url = EXCLUDED.photo_url,
           public_profile_version = ${s}.user_profile.public_profile_version + 1, updated_at = NOW()`,
        [input.providerUid, published.url],
      );
    }
    const updated = await client.query(
      `UPDATE ${s}.provider_profile_media_submissions
       SET state = $1, published_storage_path = $2, published_url = $3,
           provider_reason_code = $4, provider_reason_detail = $5, internal_note = $6,
           reviewed_by = $7, reviewed_at = NOW(), version = version + 1, updated_at = NOW()
       WHERE id = $8 RETURNING *`,
      [input.decision, published?.storagePath ?? null, published?.url ?? null,
        input.providerReasonCode ?? null, String(input.providerReasonDetail ?? '').trim() || null,
        String(input.internalNote ?? '').trim() || null, input.adminUid, input.submissionId],
    );
    await client.query(
      `INSERT INTO ${s}.provider_verification_events
         (provider_uid, domain, source_type, source_id, event_type,
          provider_reason_code, provider_reason_detail, internal_metadata, event_key)
       VALUES ($1,'profile_photo','profile_media',$2,$3,$4,$5,$6::jsonb,$7)
       ON CONFLICT (provider_uid, event_key) DO NOTHING`,
      [input.providerUid, input.submissionId, `profile_photo_${input.decision}`,
        input.providerReasonCode ?? null, input.providerReasonDetail ?? null,
        JSON.stringify({ reviewedBy: input.adminUid, internalNote: input.internalNote ?? null }),
        `profile-photo:${input.submissionId}:${input.decision}`],
    );
    await client.query('COMMIT');
    return present(updated.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (published?.storagePath) {
      const { deletePrivateStoredFile } = await import('../helpers/firebaseStorageUploader');
      await deletePrivateStoredFile(published.storagePath).catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

const present = (row: any) => ({
  submissionId: String(row.id),
  kind: row.media_kind ?? 'profile_photo',
  state: row.state,
  scanState: row.scan_status,
  providerReasonCode: row.provider_reason_code ?? null,
  providerReasonDetail: row.provider_reason_detail ?? null,
  publishedUrl: row.state === 'approved' ? row.published_url ?? null : null,
  submittedAt: row.created_at,
  reviewedAt: row.reviewed_at ?? null,
  version: Number(row.version ?? 1),
});
