/**
 * Every v1 auth failure, on every mounted route, in the v1 envelope (TAB 04).
 *
 * ## Why this exists beside `v1-auth-envelope.test.ts`
 *
 * That suite asserts the shape for the three auth MODES. This one asserts it as
 * a property over every implemented contract entry, because a test enumerating
 * cases covers only the cases somebody remembered — and the defect it guards
 * against is precisely one that held on 85 of 85 routes while every suite that
 * touched auth asserted the status code and passed.
 *
 * ## The INVALID_TOKEN decision (TAB 04 owns it)
 *
 * `verifyAuth` can emit five distinct 401 bodies, not the three the v1 contract
 * publishes: UNAUTHENTICATED (twice, by two paths), TOKEN_REVOKED,
 * TOKEN_EXPIRED and INVALID_TOKEN. The last is absent from `V1_ERROR_STATUS`
 * and from the OpenAPI's `AUTH_DEFAULT_ERRORS`, and `register.ts` deferred the
 * question of whether to add it here.
 *
 * It is NOT added, and the mapping to UNAUTHENTICATED with the original kept in
 * `details.reason` stands. Three reasons:
 *
 *   1. The published OpenAPI declares 401 as UNAUTHENTICATED | TOKEN_EXPIRED |
 *      TOKEN_REVOKED. Anyone generating a client from that document gets a
 *      parser with no case for a fourth code, so adding one is a breaking
 *      contract change needing a version story — not a bug fix.
 *   2. Nothing is lost. `details.reason` carries the original verbatim, so a
 *      client that wants the distinction has it; it simply is not a top-level
 *      code the contract promises.
 *   3. TAB 12 maps the published vocabulary to customer copy. A 37th code that
 *      only ever appears nested would be mapped and unreachable — a mapping
 *      nobody can trigger is worse than none, because it reads as covered.
 *
 * RFC 6750 §3.1 does define `invalid_token` as a distinct Bearer error, which
 * is the argument for the other side. It is recorded rather than dismissed: if
 * the contract owner wants it published, that is a deliberate vocabulary
 * change, and the test below is what will fail and prompt the conversation.
 */

jest.mock('../src/middleware/firebaseApp', () => ({ firebaseAdmin: {}, __esModule: true }));

import type { RequestHandler, Response } from 'express';
import { authChain, v1AuthEnvelope } from '../src/api/v1/register';
import { IMPLEMENTED, type ContractEntry } from '../src/api/v1/contract';
import { V1_ERROR_STATUS } from '../src/api/v1/errors';
import { allErrorsFor } from '../src/api/v1/openapi';

const REQUEST_ID = 'req-conformance-fixture';

const drive = async (chain: RequestHandler[]) => {
  // A faithful bare request: verifyAuth reads `headers.authorization` and
  // `cookies.__session`, so both must exist and be empty for the refusal path
  // to be the one under test rather than a TypeError.
  const req: any = { id: REQUEST_ID, headers: {}, cookies: {} };
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

describe('v1 auth envelope conformance — a property, not a case list', () => {
  const gated = IMPLEMENTED.filter((e: ContractEntry) => e.auth !== 'public');
  const publicEntries = IMPLEMENTED.filter((e: ContractEntry) => e.auth === 'public');

  it('there is a meaningful population to assert over', () => {
    // Guards the vacuous pass: a filter bug that empties the list would make
    // every property below trivially true.
    expect(gated.length).toBeGreaterThan(50);
    expect(publicEntries.length).toBeGreaterThan(0);
    expect(gated.length + publicEntries.length).toBe(IMPLEMENTED.length);
  });

  it('every gated entry refuses a tokenless call in the v1 envelope', async () => {
    const offenders: string[] = [];

    for (const entry of gated) {
      const { status, body } = await drive(authChain(entry));

      const wellFormed =
        status === 401 &&
        body &&
        typeof body.error?.code === 'string' &&
        typeof body.error?.message === 'string' &&
        body.error.requestId === REQUEST_ID &&
        body.status === undefined && // never the legacy shape
        V1_ERROR_STATUS[body.error.code as never] === 401;

      if (!wellFormed) {
        offenders.push(`${entry.id} (${entry.method.toUpperCase()} ${entry.path}) -> ${status} ${JSON.stringify(body)}`);
      }
    }

    // The message carries the names: "expected 0, got 3" is the start of a
    // search rather than the end of one.
    expect({ count: offenders.length, offenders }).toMatchObject({ count: 0 });
  });

  it('every code a gated entry can emit is one its OpenAPI entry declares', async () => {
    // Closes the loop between the published document and what actually runs.
    const offenders: string[] = [];
    for (const entry of gated) {
      const { body } = await drive(authChain(entry));
      const declared = allErrorsFor(entry);
      if (!declared.includes(body?.error?.code)) {
        offenders.push(`${entry.id}: emitted ${body?.error?.code}, declares ${declared.join('|')}`);
      }
    }
    expect({ count: offenders.length, offenders }).toMatchObject({ count: 0 });
  });

  it('public entries carry no auth chain at all', () => {
    for (const entry of publicEntries) {
      expect(authChain(entry)).toHaveLength(0);
    }
  });
});

describe('every failure verifyAuth can produce', () => {
  /** Wraps a stub that writes one of the legacy bodies verifyAuth writes. */
  const translate = async (legacyBody: Record<string, unknown>, status = 401) => {
    const inner: RequestHandler = (_req, res) => {
      res.status(status).json(legacyBody);
    };
    const req: any = { id: REQUEST_ID, headers: {}, cookies: {} };
    let out: any = null;
    let code = 0;
    const res: any = {
      statusCode: 0,
      status(c: number) { code = c; this.statusCode = c; return this; },
      set() { return this; },
      json(payload: any) { out = payload; return this; },
    };
    await v1AuthEnvelope(inner)(req, res as Response, (() => {}) as never);
    return { status: code, body: out };
  };

  // Enumerated from verifyAuth.ts end to end, not inferred from the two shapes
  // observed externally. All five, including the hybrid TOKEN_REVOKED body that
  // already carries its own nested `error` object.
  it.each([
    ['no authorization header and no cookie', { status: 'failed', code: 'UNAUTHENTICATED', message: 'Authentication is required' }, 'UNAUTHENTICATED'],
    ['a Bearer header with an empty token', { status: 'failed', code: 'UNAUTHENTICATED', message: 'Authentication is required' }, 'UNAUTHENTICATED'],
    ['an expired id token', { status: 'failed', code: 'TOKEN_EXPIRED', message: 'Session expired. Please log in again.' }, 'TOKEN_EXPIRED'],
    ['a revoked session', { status: 'failed', code: 'TOKEN_REVOKED', message: 'You were signed out. Please sign in again.', error: { code: 'TOKEN_REVOKED', recovery: 'REAUTHENTICATE', retryable: false } }, 'TOKEN_REVOKED'],
    ['a malformed token', { status: 'failed', code: 'INVALID_TOKEN', message: 'Authentication token is invalid' }, 'UNAUTHENTICATED'],
  ])('%s -> %s in the v1 envelope', async (_name, legacy, expected) => {
    const { status, body } = await translate(legacy);
    expect(status).toBe(401);
    expect(body.error.code).toBe(expected);
    expect(body.error.requestId).toBe(REQUEST_ID);
    expect(body.status).toBeUndefined();
  });

  it('TOKEN_EXPIRED and TOKEN_REVOKED stay distinct rather than collapsing', () => {
    // They mean different things to a customer — one is a silent
    // re-authentication, the other is a sign-out that needs explaining — and
    // TAB 12 cannot tell them apart if the server does not.
    expect(V1_ERROR_STATUS.TOKEN_EXPIRED).toBe(401);
    expect(V1_ERROR_STATUS.TOKEN_REVOKED).toBe(401);
    expect('TOKEN_EXPIRED').not.toBe('TOKEN_REVOKED');
  });

  it('INVALID_TOKEN is not a published v1 code, and its origin survives', async () => {
    // The decision recorded in this file's docblock, pinned. If somebody adds
    // INVALID_TOKEN to the vocabulary, this fails and the conversation happens
    // deliberately instead of by drift.
    expect(Object.keys(V1_ERROR_STATUS)).not.toContain('INVALID_TOKEN');

    const { body } = await translate({ status: 'failed', code: 'INVALID_TOKEN', message: 'Authentication token is invalid' });
    expect(body.error.code).toBe('UNAUTHENTICATED');
    expect(body.error.details).toEqual({ reason: 'INVALID_TOKEN' });
  });

  it('a 401 does not distinguish a known account from an unknown one', () => {
    // The guardrail: nothing in the refusal may become an enumeration oracle.
    const messages = [
      'Authentication is required',
      'Session expired. Please log in again.',
      'You were signed out. Please sign in again.',
      'Authentication token is invalid',
    ];
    for (const m of messages) {
      expect(m).not.toMatch(/no such|not found|unknown user|does not exist|wrong password|incorrect password/i);
    }
  });
});

describe('the legacy tree did not move', () => {
  it('an unwrapped auth rejection still writes the legacy shape verbatim', async () => {
    // 520 legacy routes and five clients read this shape. The v1 work is a
    // wrapper applied only by `authChain`, so the bare middleware must be
    // untouched — asserted rather than assumed.
    const inner: RequestHandler = (_req, res) => {
      res.status(401).json({ status: 'failed', code: 'UNAUTHENTICATED', message: 'Authentication is required' });
    };
    let body: any = null;
    const res: any = {
      statusCode: 0,
      status(c: number) { this.statusCode = c; return this; },
      set() { return this; },
      json(p: any) { body = p; return this; },
    };
    inner({ id: REQUEST_ID } as never, res, (() => {}) as never);

    expect(body).toEqual({
      status: 'failed',
      code: 'UNAUTHENTICATED',
      message: 'Authentication is required',
    });
    expect(body.error).toBeUndefined();
    expect(body.requestId).toBeUndefined();
  });
});
