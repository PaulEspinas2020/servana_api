jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
  pool: { connect: jest.fn() },
}));
jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/services/providerManagedFileScanner', () => ({
  scanProviderFile: jest.fn(),
  assertCleanScan: jest.fn(),
}));
jest.mock('../src/helpers/firebaseStorageUploader', () => ({
  uploadPrivateFileToStorage: jest.fn(),
  deletePrivateStoredFile: jest.fn(),
  createPrivatePreviewUrl: jest.fn(),
}));

import dbQuery, { pool } from '../src/db/dbQuery';
import * as scanner from '../src/services/providerManagedFileScanner';
import * as storage from '../src/helpers/firebaseStorageUploader';
import { uploadDocument } from '../src/services/providerProfileComplianceService';

const query = dbQuery.query as jest.Mock;
const connect = pool.connect as jest.Mock;
const scan = scanner.scanProviderFile as jest.Mock;
const uploadPrivate = storage.uploadPrivateFileToStorage as jest.Mock;
const deletePrivate = storage.deletePrivateStoredFile as jest.Mock;
const pdf = 'data:application/pdf;base64,JVBERi0xLjQ=';

const listed = (id: number, type: string, expiresAt: string | null = null) => ({
  id,
  file_name: `${type}.pdf`,
  uploaded_at: '2026-08-07T01:00:00.000Z',
  requirement_type: type,
  mime_type: 'application/pdf',
  byte_size: 8,
  lifecycle_state: 'under_review',
  scan_status: 'clean',
  issue_date: null,
  expires_at: expiresAt,
  identifier_mask: null,
  replacement_for_id: null,
  replaced_by_id: null,
  version: 1,
  review_state: 'pending_review',
  reason_code: null,
  provider_message: null,
  decided_at: null,
});

describe('required provider document submission integration boundary', () => {
  let clientQuery: jest.Mock;
  let release: jest.Mock;
  let nextInsertId: number;

  beforeEach(() => {
    jest.clearAllMocks();
    nextInsertId = 100;
    release = jest.fn();
    clientQuery = jest.fn(async (sql: string) => {
      if (sql.includes('COUNT(*)::int')) return { rowCount: 1, rows: [{ count: 0 }] };
      if (sql.includes('INSERT INTO servana.worker_requirements')) {
        return { rowCount: 1, rows: [{ id: ++nextInsertId }] };
      }
      return { rowCount: 0, rows: [] };
    });
    connect.mockResolvedValue({ query: clientQuery, release });
    scan.mockResolvedValue({
      verdict: 'clean',
      engine: 'test-managed-scanner',
      sha256: 'original-hash',
    });
    uploadPrivate.mockImplementation(async (folder: string, requestId: string) => ({
      storagePath: `${folder}/${requestId}.pdf`,
      mimeType: 'application/pdf',
      byteSize: 8,
    }));
    deletePrivate.mockResolvedValue(undefined);
  });

  it.each([
    ['valid_id', null],
    ['nbi_clearance', '2030-08-07T23:59:59.999Z'],
    ['service_record', null],
  ])('submits %s through scan, private storage, transaction, and timeline', async (type, expiresAt) => {
    const expectedId = nextInsertId + 1;
    query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [listed(expectedId, type, expiresAt)] });

    const result = await uploadDocument('provider-required-docs', {
      documentTypeId: type,
      fileName: `${type}.pdf`,
      file: pdf,
      clientRequestId: `required-${type}-request-0001`,
      expiresAt,
    });

    expect(result).toEqual(expect.objectContaining({
      id: String(expectedId),
      documentTypeId: type,
      state: 'under_review',
      scanState: 'clean',
    }));
    expect(scan).toHaveBeenCalledTimes(1);
    expect(uploadPrivate).toHaveBeenCalledWith(
      'provider-compliance/provider-required-docs',
      `required-${type}-request-0001`,
      expect.stringMatching(/^data:application\/pdf;base64,/),
    );
    expect(clientQuery.mock.calls.some(([sql]) => sql === 'BEGIN')).toBe(true);
    expect(clientQuery.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(true);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('provider_verification_events'))).toBe(true);
    expect(deletePrivate).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('storagePath');
    expect(JSON.stringify(result)).not.toContain('private://');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('replays a confirmed request without rescanning, reuploading, or opening a transaction', async () => {
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 77 }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [listed(77, 'valid_id')] });

    const result = await uploadDocument('provider-required-docs', {
      documentTypeId: 'valid_id',
      fileName: 'valid_id.pdf',
      file: pdf,
      clientRequestId: 'required-valid-id-replay-0001',
    });

    expect(result?.id).toBe('77');
    expect(scan).not.toHaveBeenCalled();
    expect(uploadPrivate).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects a new logical file at the catalog limit before private storage', async () => {
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*)::int')) return { rowCount: 1, rows: [{ count: 2 }] };
      return { rowCount: 0, rows: [] };
    });

    await expect(uploadDocument('provider-required-docs', {
      documentTypeId: 'valid_id',
      fileName: 'third-id.pdf',
      file: pdf,
      clientRequestId: 'required-valid-id-limit-0001',
    })).rejects.toMatchObject({ statusCode: 409, code: 'DOCUMENT_FILE_LIMIT_REACHED' });

    expect(uploadPrivate).not.toHaveBeenCalled();
    expect(clientQuery.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('deletes the newly stored private object when database persistence fails', async () => {
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*)::int')) return { rowCount: 1, rows: [{ count: 0 }] };
      if (sql.includes('INSERT INTO servana.worker_requirements')) throw new Error('database unavailable');
      return { rowCount: 0, rows: [] };
    });

    await expect(uploadDocument('provider-required-docs', {
      documentTypeId: 'service_record',
      fileName: 'cv.pdf',
      file: pdf,
      clientRequestId: 'required-service-record-fail-0001',
    })).rejects.toThrow('database unavailable');

    expect(deletePrivate).toHaveBeenCalledWith(
      'provider-compliance/provider-required-docs/required-service-record-fail-0001.pdf',
    );
    expect(clientQuery.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
