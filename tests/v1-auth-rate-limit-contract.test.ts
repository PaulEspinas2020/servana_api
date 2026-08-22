/**
 * TAB 09 — the auth surface, measured rather than assumed.
 *
 * ## The premise did not hold
 *
 * The Master Command records six legacy auth paths as having no canonical
 * successor: signin, signup, firebase-login, resendverification,
 * resend-email-otp and verify-email-otp. Measured at this HEAD, **all six have a
 * declared successor** in the generated migration matrix, and v1 carries nine
 * auth operations rather than the four the book credits it with.
 *
 * Two of the four mandates were likewise already met: `identifier` is the field
 * name, not `email`, and `/v1/auth/refresh` is declared `public`.
 *
 * ## What was NOT met
 *
 * Mandate 4 — *"State which of these are rate-limited and how, so clients can
 * distinguish a throttle from a refusal"*. The policy existed in
 * `rateLimitPolicy.ts` and rendered into a Markdown table, and reached the
 * machine-readable manifest a client is told to pin: nowhere. Same shape as the
 * request-body gap TAB 03 closed.
 *
 * And a defect underneath it: `routeHealth.ts` defines a well-formed v1 error as
 * one whose `error.code` AND `error.requestId` are both strings. `rateLimitBody`
 * emits no `requestId`, so every 429 on a v1 route violated the envelope that
 * route publishes — the same class of defect `v1AuthEnvelope` was written to fix
 * for 401s, on the one refusal an operator most needs to correlate to a log line.
 */

import { V1_CONTRACT } from '../src/api/v1/contract';
import { V1_RATE_LIMITS, BUCKETS } from '../src/api/v1/rateLimitPolicy';
import { canonicalManifest, rateLimitContractOf } from '../src/api/v1/convergence';
import { SCHEMAS } from '../src/api/v1/openapi';

const manifest = canonicalManifest();
const byId = (id: string) => manifest.find((e) => e.id === id)!;
const entry = (id: string) => V1_CONTRACT.find((e) => e.id === id)!;

describe('the premise: the six legacy auth paths already have successors', () => {
  const SIX = [
    '/api/auth/signin', '/api/auth/signup', '/api/auth/firebase-login',
    '/api/auth/resendverification', '/api/auth/resend-email-otp', '/api/auth/verify-email-otp',
  ];

  it('every one of the six is declared ALIAS_TEMPORARILY against a v1 entry', () => {
    const mapped = new Map<string, string>();
    for (const e of V1_CONTRACT) {
      for (const l of e.legacy) mapped.set(l.path, e.id);
    }
    for (const path of SIX) {
      // The book says these have no canonical successor. They do, and a client
      // planning a migration from the book rather than the matrix would have
      // rebuilt six endpoints that already exist.
      expect(mapped.get(path)).toBeDefined();
    }
  });

  it('v1 carries nine auth operations, not the four the book credits', () => {
    const auth = V1_CONTRACT.filter((e) => e.path.startsWith('/auth/') && e.status === 'implemented');
    expect(auth.length).toBeGreaterThanOrEqual(9);
  });
});

describe('mandate 1: the field is `identifier`, never a channel-specific name', () => {
  it('the recovery and verification endpoints all take `identifier`', () => {
    for (const id of ['auth.forgotPassword', 'auth.resendVerification', 'auth.verifyEmail']) {
      // Naming it `email` would be the client asserting a channel this backend
      // does not fix — the route serves a mobile number too.
      expect(byId(id).requiredBody).toContain('identifier');
      expect(byId(id).requiredBody).not.toContain('email');
    }
  });

  it('login accepts `identifier`, and its emptiness is CONDITIONAL rather than absent', () => {
    const login = byId('auth.login');
    expect(login.allowedBody).toContain('identifier');
    // Either identifier+password OR idToken, so no field is required by every
    // valid call. A client gating on requiredBody alone would pass an empty
    // body, which is why the contract says so out loud.
    expect(login.requiredBody).toEqual([]);
    expect(entry('auth.login').notes).toMatch(/CONDITIONAL/);
    expect((SCHEMAS.LoginRequest as any).properties.identifier.description).toMatch(/mobile/i);
  });
});

describe('mandate 3: refresh is callable WITHOUT a valid access token', () => {
  it('is declared public, and says so on the entry a client reads', () => {
    const refresh = entry('auth.refresh');
    // A caller reaches refresh precisely because the token they would otherwise
    // present has expired. Demanding one would be circular.
    expect(refresh.auth).toBe('public');
    expect(refresh.notes).toMatch(/CALLABLE WITHOUT A VALID ACCESS TOKEN/);
  });

  it('the credential is the refresh token in the BODY', () => {
    expect(byId('auth.refresh').requiredBody).toEqual(['refreshToken']);
  });

  it('records why the provider client deliberately did not migrate it', () => {
    // Its refresh runs on a transport that sends no Authorization header. That
    // is correct against this contract rather than a workaround for it.
    expect(entry('auth.refresh').notes).toMatch(/no Authorization header/);
  });
});

describe('mandate 4: what throttles an operation is published', () => {
  it('every rate-limited endpoint publishes its buckets, resolved to budgets', () => {
    for (const id of Object.keys(V1_RATE_LIMITS)) {
      const published = byId(id).rateLimit;
      expect(published).not.toBeNull();
      for (const limit of published!.limits) {
        // Naming the bucket alone would tell a client which counters exist and
        // nothing about what they permit. A client backing off needs the window
        // and the budget.
        expect(typeof limit.windowMs).toBe('number');
        expect(typeof limit.max).toBe('number');
        expect(typeof limit.skipSuccessfulRequests).toBe('boolean');
        expect(limit.purpose.length).toBeGreaterThan(0);
      }
    }
  });

  it('login publishes that only FAILED attempts count against the account bucket', () => {
    const login = byId('auth.login').rateLimit!;
    const account = login.limits.find((l) => l.bucket === 'perAccountLogin')!;
    // A client must not treat a successful sign-in as having spent budget.
    expect(account.skipSuccessfulRequests).toBe(true);
    expect(account.key).toBe('identifier');
  });

  it('an endpoint with NO account bucket publishes the reason, not just the absence', () => {
    const refresh = byId('auth.refresh').rateLimit!;
    expect(refresh.limits.every((l) => l.key === 'ip')).toBe(true);
    // An absent bucket and a considered exemption look identical from outside.
    // This is what tells them apart.
    expect(refresh.noAccountBucket).toMatch(/nothing to key an account bucket on/);
  });

  it('logout publishes an empty limit set WITH its reason, rather than null', () => {
    const logout = byId('auth.logout').rateLimit!;
    expect(logout.limits).toEqual([]);
    expect(logout.noAccountBucket).toMatch(/nothing to enumerate/);
  });

  it('an unlimited endpoint publishes null, so absence is unambiguous', () => {
    // Anything with no policy at all. null and { limits: [] } mean different
    // things: no policy versus a policy of none.
    const unlimited = manifest.find((e) => !V1_RATE_LIMITS[e.id])!;
    expect(unlimited.rateLimit).toBeNull();
  });

  it('refuses to publish a budget it could not resolve', () => {
    const original = (BUCKETS as any).__probe;
    (V1_RATE_LIMITS as any).__probeEntry = { buckets: ['__probe'] };
    try {
      // Publishing an unresolved bucket would put a name in the artifact with no
      // budget behind it, which reads as "limited" while saying nothing.
      expect(() => rateLimitContractOf('__probeEntry')).toThrow(/not in BUCKETS/);
    } finally {
      delete (V1_RATE_LIMITS as any).__probeEntry;
      if (original === undefined) delete (BUCKETS as any).__probe;
    }
  });
});

describe('a 429 on a v1 route satisfies the envelope that route publishes', () => {
  it('the limiter body carries a branchable code and a retryable flag', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { rateLimitBody } = require('../src/helpers/rateLimitBody');
    const body = rateLimitBody('slow down');
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.retryable).toBe(true);
    // The flat message stays for clients already installed — removing it is a
    // later step of the error migration, not this one.
    expect(body.message).toBe('slow down');
  });

  it('the v1 wrapper stamps the requestId the envelope promises', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { v1RateLimitEnvelope } = require('../src/api/v1/register');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { rateLimitBody } = require('../src/helpers/rateLimitBody');

    const sent: any = {};
    const res: any = {
      statusCode: 429,
      json: (b: any) => { sent.body = b; return res; },
      set: () => res, setHeader: () => res, getHeader: () => undefined,
    };
    const req: any = { headers: {}, get: () => undefined };

    const inner = (_q: any, r: any) => { r.json(rateLimitBody('slow down')); };
    v1RateLimitEnvelope(inner)(req, res, () => {});

    // routeHealth defines a well-formed v1 error as code AND requestId both
    // strings. Without this, every 429 on a v1 route failed that definition.
    expect(typeof sent.body.error.requestId).toBe('string');
    expect(sent.body.error.requestId.length).toBeGreaterThan(0);
    expect(sent.body.error.code).toBe('RATE_LIMITED');
    // ADDITIVE: nothing the previous body carried was removed.
    expect(sent.body.message).toBe('slow down');
    expect(sent.body.error.retryable).toBe(true);
  });

  it('leaves a body that already carries a requestId alone', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { v1RateLimitEnvelope } = require('../src/api/v1/register');
    const sent: any = {};
    const res: any = {
      statusCode: 429,
      json: (b: any) => { sent.body = b; return res; },
      set: () => res, setHeader: () => res, getHeader: () => undefined,
    };
    const req: any = { headers: {}, get: () => undefined };
    const inner = (_q: any, r: any) => {
      r.json({ error: { code: 'RATE_LIMITED', requestId: 'already-here' } });
    };
    v1RateLimitEnvelope(inner)(req, res, () => {});
    expect(sent.body.error.requestId).toBe('already-here');
  });

  it('does not touch a non-429 response', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { v1RateLimitEnvelope } = require('../src/api/v1/register');
    const sent: any = {};
    const res: any = {
      statusCode: 200,
      json: (b: any) => { sent.body = b; return res; },
      set: () => res, setHeader: () => res, getHeader: () => undefined,
    };
    const req: any = { headers: {}, get: () => undefined };
    const inner = (_q: any, r: any) => { r.json({ data: { ok: true } }); };
    v1RateLimitEnvelope(inner)(req, res, () => {});
    expect(sent.body).toEqual({ data: { ok: true } });
  });
});
