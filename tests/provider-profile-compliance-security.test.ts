jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
  pool: { connect: jest.fn() },
}));
jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));

import dbQuery from '../src/db/dbQuery';
import { baselineDocumentScan } from '../src/services/providerDocumentSecurity';
import {
  DOCUMENT_TYPE_CATALOG,
  PROFILE_FIELD_REGISTRY,
  listDocuments,
  uploadDocument,
} from '../src/services/providerProfileComplianceService';
import { previewProfilePhoto } from '../src/services/providerProfileMediaService';

const query = dbQuery.query as jest.Mock;

describe('Command 24 provider profile and document security', () => {
  beforeEach(() => query.mockReset());

  it('uses the same three required document IDs as the shipped provider portal', () => {
    expect(DOCUMENT_TYPE_CATALOG.filter(d => d.required).map(d => d.id)).toEqual([
      'valid_id',
      'nbi_clearance',
      'service_record',
    ]);
    expect(DOCUMENT_TYPE_CATALOG.find(d => d.id === 'valid_id')?.aliases).toContain('government_id');
    expect(DOCUMENT_TYPE_CATALOG.find(d => d.id === 'service_record')?.aliases).toContain('cv');
  });

  it('classifies verified identifiers as private and re-verification controlled', () => {
    for (const id of ['legalName', 'email', 'mobile', 'legalAddress']) {
      const field = PROFILE_FIELD_REGISTRY.find(f => f.id === id);
      expect(field).toEqual(expect.objectContaining({
        classification: 'private',
        customerVisible: false,
      }));
      expect(['reverification', 'admin']).toContain(field?.editable);
    }
  });

  it('never returns a storage path, permanent URL, or internal reviewer note', async () => {
    query.mockResolvedValue({
      rowCount: 1,
      rows: [{
        id: 41,
        worker_uid: 'provider-a',
        file_name: 'id.pdf',
        file_url: 'https://permanent.example/secret',
        storage_path: 'provider-documents/provider-a/secret.pdf',
        internal_rationale: 'risk score 99',
        uploaded_at: '2026-08-07T00:00:00.000Z',
        requirement_type: 'valid_id',
        mime_type: 'application/pdf',
        byte_size: 123,
        lifecycle_state: 'under_review',
        scan_status: 'clean',
        review_state: 'approved',
        reason_code: null,
        provider_message: null,
        version: 1,
      }],
    });

    const result = await listDocuments('provider-a');
    expect(query.mock.calls[0][1]).toEqual(['provider-a']);
    expect(result[0].state).toBe('verified');
    expect(JSON.stringify(result)).not.toContain('storage_path');
    expect(JSON.stringify(result)).not.toContain('permanent.example');
    expect(JSON.stringify(result)).not.toContain('risk score');
  });

  it('does not treat an approved review as verified until scanning is clean', async () => {
    query.mockResolvedValue({
      rowCount: 1,
      rows: [{
        id: 42,
        file_name: 'id.pdf',
        uploaded_at: '2026-08-07T00:00:00.000Z',
        requirement_type: 'valid_id',
        lifecycle_state: 'under_review',
        scan_status: 'pending',
        review_state: 'approved',
        version: 1,
      }],
    });
    expect((await listDocuments('provider-a'))[0].state).toBe('processing');
  });

  it('rejects the standard antivirus test marker and active PDF content', () => {
    const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
    expect(baselineDocumentScan(eicar, 'application/pdf').safe).toBe(false);
    expect(baselineDocumentScan(Buffer.from('%PDF-1.7 /JavaScript'), 'application/pdf').safe).toBe(false);
  });

  it('always scopes profile-media previews to the provider in the route', async () => {
    query.mockResolvedValue({ rowCount: 0, rows: [] });

    await expect(previewProfilePhoto('provider-a', 'submission-b')).rejects.toMatchObject({ statusCode: 404 });
    expect(query.mock.calls[0][1]).toEqual(['submission-b', 'provider-a']);
    expect(query.mock.calls[0][0]).toContain('AND provider_uid = $2');
  });

  it('rejects malformed document dates before scanning, storage, or a transaction', async () => {
    query.mockResolvedValue({ rowCount: 0, rows: [] });

    await expect(uploadDocument('provider-a', {
      documentTypeId: 'valid_id',
      fileName: 'id.pdf',
      file: 'data:application/pdf;base64,JVBERi0xLjQ=',
      clientRequestId: 'document-request-1234',
      issueDate: 'not-a-date',
    })).rejects.toMatchObject({ statusCode: 422, code: 'INVALID_ISSUE_DATE' });
  });

  it('requires a current expiration date for NBI submissions', async () => {
    query.mockResolvedValue({ rowCount: 0, rows: [] });

    await expect(uploadDocument('provider-a', {
      documentTypeId: 'nbi_clearance',
      fileName: 'nbi.pdf',
      file: 'data:application/pdf;base64,JVBERi0xLjQ=',
      clientRequestId: 'document-request-5678',
    })).rejects.toMatchObject({ statusCode: 422, code: 'EXPIRATION_REQUIRED' });
  });

  it('does not accept underscore or punctuation in a masked identifier suffix', async () => {
    query.mockResolvedValue({ rowCount: 0, rows: [] });

    await expect(uploadDocument('provider-a', {
      documentTypeId: 'valid_id',
      fileName: 'id.pdf',
      file: 'data:application/pdf;base64,JVBERi0xLjQ=',
      clientRequestId: 'document-request-9012',
      identifierLast4: '__',
    })).rejects.toMatchObject({ statusCode: 422, code: 'INVALID_IDENTIFIER_SUFFIX' });
  });
});
