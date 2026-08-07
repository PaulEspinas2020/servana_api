import axios from 'axios';
import { createHash, randomUUID } from 'crypto';
import dbQuery, { pool } from '../src/db/dbQuery';
import { db } from '../src/config';
import { validateDataUri, AllowedUploadMime } from '../src/helpers/fileSignature';
import { assertCleanScan, scanProviderFile } from '../src/services/providerManagedFileScanner';
import { uploadPrivateFileToStorage } from '../src/helpers/firebaseStorageUploader';

const s = db.schema;
const apply = process.argv.includes('--apply');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = Math.max(1, Math.min(Number(limitArg?.split('=')[1] ?? 100), 1000));
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;

async function main() {
  const result = await dbQuery.query(
    `SELECT id, worker_uid, file_url, file_name, requirement_type
     FROM ${s}.worker_requirements
     WHERE storage_path IS NULL AND file_url LIKE 'https://firebasestorage.googleapis.com/%'
     ORDER BY id LIMIT $1`,
    [limit],
  );
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'plan', candidates: result.rowCount, ids: result.rows.map((r: any) => r.id) }, null, 2));
  if (!apply) return;
  if (!process.env.PROVIDER_DOCUMENT_SCANNER_URL || !process.env.PROVIDER_DOCUMENT_SCANNER_TOKEN) {
    throw new Error('Managed scanner configuration is required for legacy migration.');
  }
  for (const row of result.rows) await migrateOne(row);
}

async function migrateOne(row: any) {
  const response = await axios.get(row.file_url, { responseType: 'arraybuffer', timeout: 20_000, maxContentLength: 10 * 1024 * 1024 });
  const bytes = Buffer.from(response.data);
  const mime = String(response.headers['content-type'] ?? '').split(';')[0].toLowerCase();
  const dataUri = `data:${mime};base64,${bytes.toString('base64')}`;
  const validation = validateDataUri(dataUri, { allowed: ALLOWED as readonly AllowedUploadMime[], maxBytes: 10 * 1024 * 1024 });
  if (!validation.ok) throw new Error(`legacy document ${row.id}: ${validation.code}`);
  const scan = await scanProviderFile({ buffer: validation.buffer, mimeType: validation.mime, fileName: row.file_name });
  assertCleanScan(scan);
  const persist = scan.sanitizedBuffer ?? validation.buffer;
  const requestId = `legacy-${row.id}-${randomUUID()}`;
  const stored = await uploadPrivateFileToStorage(`provider-compliance/${row.worker_uid}`, requestId, `data:${validation.mime};base64,${persist.toString('base64')}`);
  const updated = await dbQuery.query(
    `UPDATE ${s}.worker_requirements SET file_url = $1, storage_path = $2,
       mime_type = $3, byte_size = $4, content_sha256 = $5,
       scanner_engine = $6, scan_status = 'clean', lifecycle_state = 'under_review',
       client_request_id = COALESCE(client_request_id, $7), version = version + 1, updated_at = NOW()
     WHERE id = $8 AND worker_uid = $9 AND storage_path IS NULL RETURNING id`,
    [`private://${stored.storagePath}`, stored.storagePath, stored.mimeType, stored.byteSize,
      createHash('sha256').update(persist).digest('hex'), scan.engine, requestId, row.id, row.worker_uid],
  );
  if (!updated.rowCount) return;
  await revokeLegacyObject(row.file_url);
  console.log(`migrated ${row.id}`);
}

async function revokeLegacyObject(url: string) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/o\/([^/]+)$/);
    if (!match) throw new Error('unrecognized Firebase URL');
    const { firebaseAdmin } = await import('../src/middleware/firebaseApp');
    await firebaseAdmin.storage().bucket().file(decodeURIComponent(match[1])).delete({ ignoreNotFound: true });
  } catch (error) {
    console.error(`WARNING: private copy committed but legacy object revocation needs retry: ${error instanceof Error ? error.message : String(error)}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(() => pool.end());
