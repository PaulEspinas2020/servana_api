/**
 * The v1 document writes carry the side effect their legacy siblings carry.
 *
 * ## Why this suite exists
 *
 * `provider.documents.list` was canonical while submit, preview and withdraw
 * were still legacy — a provider could read their onboarding state over v1 and
 * not act on it. Closing that is mostly URLs, and the part that is not is this:
 *
 * The legacy upload and delete handlers each end with
 * `autoOnlineEngine.evaluateProvider(uid, 'system', uid).catch(() => {})`.
 * It reads like logging and it is not. Submitting the last outstanding
 * requirement is what makes a provider ELIGIBLE TO GO ONLINE, and withdrawing
 * one can make them ineligible again. An endpoint that stores the document and
 * skips the re-evaluation leaves a provider blocked with nothing left to do —
 * or online against a requirement they have just removed.
 *
 * A migration that reproduces the payload and drops this passes every contract
 * check, every schema check and every route test. So the assertion here is
 * behavioural: the engine is CALLED, with the caller's own uid, after the write
 * succeeds.
 *
 * ## And it must not be able to fail the request
 *
 * The legacy `.catch(() => {})` is deliberate. A re-evaluation that throws must
 * not turn a stored document into a 500 the client retries, which would submit
 * it twice. That swallow is asserted too — an unswallowed rejection is the
 * easier mistake to make when copying the line.
 */

import express from 'express';

import { startTestServer, request, type TestServer } from './support/httpTestServer';

import * as compliance from '../src/services/providerProfileComplianceService';
import * as autoOnlineEngine from '../src/services/providerAutoOnlineEngine';
import { handlers } from '../src/api/v1/domains/account';

jest.mock('../src/services/providerProfileComplianceService', () => {
  const actual = jest.requireActual('../src/services/providerProfileComplianceService');
  return {
    ...actual,
    uploadDocument: jest.fn(),
    deleteDocument: jest.fn(),
    getDocumentPreview: jest.fn(),
  };
});

jest.mock('../src/services/providerAutoOnlineEngine', () => ({
  evaluateProvider: jest.fn(),
}));

const svc = compliance as jest.Mocked<typeof compliance>;
const engine = autoOnlineEngine as jest.Mocked<typeof autoOnlineEngine>;

const UID = 'worker-under-test';

/** A minimal app carrying just the handlers under test and a fixed identity. */
const buildApp = () => {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as any).user = { uid: UID };
    next();
  });
  a.post('/documents', handlers['provider.documents.create'] as any);
  a.delete('/documents/:documentId', handlers['provider.documents.delete'] as any);
  a.get('/documents/:documentId/preview', handlers['provider.documents.preview'] as any);
  return a;
};

let server: TestServer;
const post = (path: string, body: unknown) => request(server.base, 'POST', path, { body });
const del = (path: string) => request(server.base, 'DELETE', path);
const get = (path: string) => request(server.base, 'GET', path);

beforeAll(async () => {
  server = await startTestServer(buildApp());
});

afterAll(async () => {
  await server.close();
});

const validBody = {
  documentTypeId: 'gov_id',
  fileName: 'id.png',
  file: 'data:image/png;base64,iVBORw0KGgo=',
  clientRequestId: 'req-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  (svc.uploadDocument as jest.Mock).mockResolvedValue({
    requirementId: '5', documentType: 'gov_id', status: 'submitted',
    submittedAt: null, expiresAt: null, reviewNote: null,
  });
  (svc.deleteDocument as jest.Mock).mockResolvedValue(undefined);
  (svc.getDocumentPreview as jest.Mock).mockResolvedValue({
    url: 'https://example.test/signed', expiresAt: null, mimeType: 'image/png',
  });
  (engine.evaluateProvider as jest.Mock).mockResolvedValue(undefined);
});

describe('submitting a document re-evaluates online eligibility', () => {
  it('calls the engine with the caller\'s own uid, after the write', async () => {
    const res = await post('/documents', validBody);

    expect(res.status).toBe(201);
    expect(svc.uploadDocument).toHaveBeenCalledTimes(1);
    expect(engine.evaluateProvider).toHaveBeenCalledWith(UID, 'system', UID);
  });

  it('does not re-evaluate when the write was refused', async () => {
    // Nothing changed, so there is nothing to re-evaluate — and calling the
    // engine anyway would let a rejected upload flip a provider's online state.
    (svc.uploadDocument as jest.Mock).mockRejectedValue(new Error('nope'));

    await post('/documents', validBody);

    expect(engine.evaluateProvider).not.toHaveBeenCalled();
  });

  it('an engine failure does not fail the upload', async () => {
    // A stored document reported as a 500 is a document the client submits
    // again. The legacy handler swallows for this reason and so must this one.
    (engine.evaluateProvider as jest.Mock).mockRejectedValue(new Error('engine down'));

    const res = await post('/documents', validBody);

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('data');
  });

  it('refuses a malformed replacementForId before writing anything', async () => {
    const res = await post('/documents', { ...validBody, replacementForId: 'not-a-number' });

    expect(res.status).toBe(400);
    expect(svc.uploadDocument).not.toHaveBeenCalled();
    expect(engine.evaluateProvider).not.toHaveBeenCalled();
  });
});

describe('withdrawing a document re-evaluates too', () => {
  it('calls the engine after the delete', async () => {
    // The direction that is easy to forget: removing a requirement can make a
    // provider ineligible, and skipping this leaves them online against a
    // document that is gone.
    const res = await del('/documents/5');

    expect(res.status).toBe(200);
    expect(svc.deleteDocument).toHaveBeenCalledWith(UID, 5);
    expect(engine.evaluateProvider).toHaveBeenCalledWith(UID, 'system', UID);
  });

  it('does not re-evaluate when the delete was refused', async () => {
    (svc.deleteDocument as jest.Mock).mockRejectedValue(new Error('nope'));

    await del('/documents/5');

    expect(engine.evaluateProvider).not.toHaveBeenCalled();
  });
});

describe('a document id is never enumerable', () => {
  it('a malformed id answers 404, the same as one that is not yours', async () => {
    // A 422 for a malformed id and a 404 for someone else's would let a caller
    // separate "no such document" from "not yours", which is the whole
    // enumeration.
    for (const id of ['abc', '0', '-1', '1.5']) {
      const res = await get(`/documents/${id}/preview`);
      expect(res.status).toBe(404);
    }
    expect(svc.getDocumentPreview).not.toHaveBeenCalled();
  });

  it('and the delete path answers the same way', async () => {
    const res = await del('/documents/abc');
    expect(res.status).toBe(404);
    expect(svc.deleteDocument).not.toHaveBeenCalled();
  });
});

describe('the preview response cannot be cached', () => {
  it('carries no-store, because the payload is a private URL', async () => {
    // A short-lived grant retained by a browser or an intermediary is a durable
    // one. The headers are set by the HANDLER rather than the route, so they
    // travel with the only v1 response that contains a storage URL.
    const res = await get('/documents/5/preview');

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(res.headers.get('pragma')).toBe('no-cache');
    expect(res.body.data.url).toBe('https://example.test/signed');
  });

  it('and the LIST still projects no url at all', async () => {
    // The separation this whole capability rests on: review state is readable,
    // content requires a second, re-authorized operation with its own audit
    // trail. A url appearing in the list would make the preview endpoint
    // decorative.
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '../src/api/v1/domains/account.ts'),
      'utf8',
    );
    const listHandler = source.slice(
      source.indexOf("'provider.documents.list'"),
      source.indexOf("'provider.documentTypes.list'"),
    );
    expect(listHandler).not.toContain('url');
    expect(listHandler).not.toContain('storagePath');
  });
});
