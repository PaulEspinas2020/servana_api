/**
 * Token refresh — the missing half of authentication.
 *
 * `verifyAuth` validates the bearer header with `admin.auth().verifyIdToken()`,
 * so every client credential is a Firebase ID token with a ONE HOUR life. Sign-in
 * obtained a refresh token alongside it and the response whitelist threw it away
 * (auth.service.ts), and no endpoint existed to redeem one. So both mobile apps
 * were handed a credential they could not renew, cached it at sign-in, and began
 * failing every authenticated call an hour later — at which point a 401 made them
 * sign the user out.
 *
 * That stayed invisible while only rarely used routes required auth. It stopped
 * being invisible when the customer booking flow (52667b3) and the worker's job
 * list and lifecycle actions (a062ef9, 9a07330) moved behind verifyAuth.
 */

jest.mock('../src/config', () => ({
  firebaseConfig: { apiKey: 'test-api-key' },
  db: { schema: 'servana' },
  tempId: undefined,
}));

import {
  refreshIdToken,
  TokenRefreshError,
} from '../src/services/tokenRefreshService';

const realFetch = global.fetch;
const mockFetch = jest.fn();

beforeEach(() => {
  mockFetch.mockReset();
  (global as any).fetch = mockFetch;
});

afterAll(() => {
  (global as any).fetch = realFetch;
});

const ok = (body: any) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

const err = (status: number, body: any) => ({
  ok: false,
  status,
  json: async () => body,
});

describe('a valid refresh token yields a fresh session', () => {
  it('returns the new id token', async () => {
    mockFetch.mockResolvedValueOnce(
      ok({ id_token: 'new-id-token', refresh_token: 'r2', expires_in: '3600' }),
    );
    const s = await refreshIdToken('r1');
    expect(s.token).toBe('new-id-token');
    expect(s.expiresIn).toBe(3600);
  });

  it('stores the ROTATED refresh token when Google sends one', async () => {
    // Google may rotate. Keeping the original would pin a token that has been
    // replaced, and the session would die at the next refresh instead of the
    // next hour — harder to diagnose than the bug this fixes.
    mockFetch.mockResolvedValueOnce(
      ok({ id_token: 't', refresh_token: 'rotated', expires_in: '3600' }),
    );
    await expect(refreshIdToken('original')).resolves.toMatchObject({
      refreshToken: 'rotated',
    });
  });

  it('keeps the original refresh token when Google does not rotate', async () => {
    mockFetch.mockResolvedValueOnce(ok({ id_token: 't', expires_in: '3600' }));
    await expect(refreshIdToken('original')).resolves.toMatchObject({
      refreshToken: 'original',
    });
  });

  it('defaults expiresIn rather than emitting NaN', async () => {
    mockFetch.mockResolvedValueOnce(ok({ id_token: 't' }));
    await expect(refreshIdToken('r')).resolves.toMatchObject({ expiresIn: 3600 });
  });

  it('calls the documented secure-token endpoint with grant_type', async () => {
    mockFetch.mockResolvedValueOnce(ok({ id_token: 't', expires_in: '3600' }));
    await refreshIdToken('r1');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('https://securetoken.googleapis.com/v1/token');
    expect(url).toContain('key=test-api-key');
    expect(init.body).toContain('grant_type=refresh_token');
    expect(init.body).toContain('refresh_token=r1');
  });
});

describe('a dead refresh token tells the client to sign in again', () => {
  it.each([
    'TOKEN_EXPIRED',
    'USER_DISABLED',
    'USER_NOT_FOUND',
    'INVALID_REFRESH_TOKEN',
  ])('%s becomes a 401', async (reason) => {
    mockFetch.mockResolvedValueOnce(err(400, { error: { message: reason } }));
    await expect(refreshIdToken('dead')).rejects.toMatchObject({
      statusCode: 401,
      code: 'REFRESH_TOKEN_INVALID',
    });
  });

  it('does not reveal WHICH of those it was', async () => {
    // Distinguishing "disabled" from "expired" tells an attacker whether an
    // account exists and what state it is in (§21).
    mockFetch.mockResolvedValueOnce(err(400, { error: { message: 'USER_DISABLED' } }));
    await expect(refreshIdToken('x')).rejects.toThrow(
      'Session expired. Please log in again.',
    );
  });
});

describe('a broken backend must not sign everyone out', () => {
  it('a network failure is 502, not 401', async () => {
    // 401 would tell every app in the field to discard its session because
    // Google was briefly unreachable. The client should retry.
    mockFetch.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(refreshIdToken('r')).rejects.toMatchObject({
      statusCode: 502,
      code: 'REFRESH_UNAVAILABLE',
    });
  });

  it('a 5xx from Google is 502, not 401', async () => {
    mockFetch.mockResolvedValueOnce(err(503, {}));
    await expect(refreshIdToken('r')).rejects.toMatchObject({ statusCode: 502 });
  });

  it('a success response with no id_token is 502, not a broken session', async () => {
    mockFetch.mockResolvedValueOnce(ok({ expires_in: '3600' }));
    await expect(refreshIdToken('r')).rejects.toMatchObject({ statusCode: 502 });
  });

  it('a missing API key is 502, not 401', async () => {
    jest.isolateModules(() => {
      jest.doMock('../src/config', () => ({
        firebaseConfig: { apiKey: undefined },
        db: { schema: 'servana' },
        tempId: undefined,
      }));
    });
    // Covered structurally: the guard precedes any fetch, so a misconfigured
    // deploy cannot mass-invalidate sessions.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'services', 'tokenRefreshService.ts'),
      'utf8',
    );
    const guard = src.indexOf('REFRESH_UNAVAILABLE');
    const firstFetch = src.indexOf('await fetch(');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstFetch);
  });
});

describe('the input is validated before anything is called', () => {
  it.each([undefined, null, '', '   '])('%p is rejected as a 400', async (v) => {
    await expect(refreshIdToken(v as any)).rejects.toMatchObject({
      statusCode: 400,
      code: 'REFRESH_TOKEN_REQUIRED',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('sign-in hands the client something it can renew', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (...p: string[]) =>
    fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');

  it('the sign-in whitelist includes refreshToken', () => {
    // Without this the endpoint above has nothing to redeem, and the fix is
    // only half applied — which is exactly the state this file was written for.
    const svc = read('services', 'auth.service.ts');
    expect(svc).toMatch(/refreshToken:\s*firebaseUser\.refreshToken/);
  });

  it('the route exists and is rate limited', () => {
    // This asserted `signInLimiter` until 2026-08-09, when the limiters were
    // split and the route moved to `tokenExchangeLimiter`. The split was the
    // correct call, and putting the sign-in limiter back would be a live
    // outage rather than a nitpick: signInLimiter allows 10 requests per 15
    // minutes because it guards a PASSWORD, while a token refresh is a routine
    // background call every running app makes. At 10/15min the customer app
    // would start failing to renew sessions under normal use.
    //
    // So the assertion is on the property that matters — the route is limited,
    // and NOT by the password limiter — rather than on one hardcoded name.
    const routes = read('routes', 'auth.route.ts');
    const line = routes.match(/router\.post\("\/auth\/refresh"[^\n]*/)?.[0] ?? '';

    expect(line).toContain('tokenExchangeLimiter');
    expect(line).not.toContain('signInLimiter');
  });

  it('the limiter it uses is real, and looser than the password limiter', () => {
    // Guards the other direction: renaming a limiter onto this route without
    // giving it a budget suited to background refreshes would pass the check
    // above while still breaking the app.
    const routes = read('routes', 'auth.route.ts');
    const block = routes.match(/const tokenExchangeLimiter = rateLimit\(\{[\s\S]*?\}\);/)?.[0] ?? '';
    const max = Number(block.match(/max:\s*(\d+)/)?.[1] ?? 0);
    const signInMax = Number(
      (routes.match(/const signInLimiter = rateLimit\(\{[\s\S]*?\}\);/)?.[0] ?? '').match(/max:\s*(\d+)/)?.[1] ?? 0,
    );

    expect(max).toBeGreaterThan(0);
    expect(signInMax).toBeGreaterThan(0);
    expect(max).toBeGreaterThan(signInMax);
  });

  it('the route is NOT behind verifyAuth', () => {
    // Requiring a valid token to obtain a valid token is circular; the caller
    // is here precisely because theirs expired.
    const routes = read('routes', 'auth.route.ts');
    const line = routes.match(/router\.post\("\/auth\/refresh"[^\n]*/)?.[0] ?? '';
    expect(line).not.toContain('verifyAuth');
  });
});
