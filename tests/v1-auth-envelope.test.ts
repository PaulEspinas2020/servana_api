/**
 * A v1 auth failure answers in the v1 envelope (TAB 02).
 *
 * ## What this catches
 *
 * `envelope.ts` declares every v1 failure as
 * `{ error: { code, message, requestId } }`, and `routeHealth.ts` defines a
 * well-formed v1 error as one whose `code` and `requestId` are both strings.
 * The auth chain, however, is built from the LEGACY middlewares — correctly, so
 * that "is this token good" has one answer and not two — and those answer
 * `{ status: 'failed', code: 'UNAUTHENTICATED' }`.
 *
 * Smoked against production on 2026-08-18: 85 of 85 non-public v1 endpoints
 * answered a tokenless request in the legacy shape. Every authenticated route
 * in the router violated the router's own published contract, and no test
 * noticed, because every suite that exercises auth asserts the STATUS CODE.
 *
 * The consequence is a client one. The provider portal classifies failures on
 * `error.code`; with the legacy shape there is no `error` object at all, so a
 * 401 reads as "no v1 code present" — the ambiguous case TAB 03 has to tell
 * apart from a genuinely expired session.
 *
 * So this asserts the SHAPE, not the status. A test that only checked for 401
 * is what let this ship.
 */

jest.mock('../src/middleware/firebaseApp', () => ({ firebaseAdmin: {}, __esModule: true }));

import type { RequestHandler } from 'express';
import { authChain } from '../src/api/v1/register';

/** Drives one chain to its rejection and returns what it wrote. */
const reject = async (auth: 'authenticated' | 'provider' | 'admin') => {
  const chain: RequestHandler[] = authChain({ auth } as never);
  // A faithful bare request: verifyAuth reads `headers.authorization` and
  // `cookies.__session`, so both must exist and be empty for the refusal path
  // to be the one under test rather than a TypeError.
  const req: any = { id: 'req-fixture-1', headers: {}, cookies: {} };
  let status = 0;
  let body: any = null;
  const res: any = {
    statusCode: 0,
    status(code: number) { status = code; this.statusCode = code; return this; },
    set() { return this; },
    json(payload: any) { body = payload; return this; },
  };

  for (const handler of chain) {
    let advanced = false;
    await new Promise<void>((resolve) => {
      const result: any = (handler as any)(req, res, () => { advanced = true; resolve(); });
      if (result && typeof result.then === 'function') result.then(() => resolve(), () => resolve());
      else if (!advanced) resolve();
    });
    if (status >= 400) break;
  }
  return { status, body };
};

describe('a tokenless v1 request is refused in the v1 envelope', () => {
  for (const auth of ['authenticated', 'provider', 'admin'] as const) {
    it(`${auth}: 401 carrying error.code and error.requestId`, async () => {
      const { status, body } = await reject(auth);

      expect(status).toBe(401);

      // The shape, which is the whole point.
      expect(body).toHaveProperty('error');
      expect(typeof body.error.code).toBe('string');
      expect(typeof body.error.requestId).toBe('string');
      expect(body.error.code).toBe('UNAUTHENTICATED');

      // And NOT the legacy shape the middleware natively writes.
      expect(body.status).toBeUndefined();
    });
  }

  it('the request id is the one minted for the request, not a placeholder', async () => {
    const { body } = await reject('provider');
    expect(body.error.requestId).toBe('req-fixture-1');
  });
});
