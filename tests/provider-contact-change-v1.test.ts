/**
 * TAB 04 — the canonical activation writes, and the precondition a migration
 * would have dropped silently.
 *
 * ## The one that matters
 *
 * `requestContactChange` and `confirmContactChange` both call
 * `assertRecentAuth(decoded)`, which reads the Firebase `auth_time` claim and
 * demands a FRESH interactive sign-in — not merely a valid session — before the
 * email or mobile number an account recovers through may be changed.
 *
 * A v1 handler that passed only `uid` would still compile, still route, still
 * answer 200 in every routing suite, and would have removed that requirement
 * from the one operation on the provider surface that decides how an account is
 * recovered. That is privilege escalation arriving as a migration, and it is
 * invisible to any test that asserts a path or a status.
 *
 * So this asserts the ARGUMENT: the decoded token reaches the service.
 */

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));
jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/services/providerContactChangeService', () => ({
  __esModule: true,
  requestContactChange: jest.fn(),
  confirmContactChange: jest.fn(),
}));
jest.mock('../src/services/providerActivationService', () => ({
  __esModule: true,
  acknowledgeProviderPolicy: jest.fn(),
  previewActivationEligibility: jest.fn(),
  getActivationRequirements: jest.fn(),
}));

import { handlers } from '../src/api/v1/domains/account';
import * as contactChanges from '../src/services/providerContactChangeService';
import * as activation from '../src/services/providerActivationService';
import { V1_CONTRACT } from '../src/api/v1/contract';
import { V1_ERROR_STATUS } from '../src/api/v1/errors';

const requestFn = contactChanges.requestContactChange as jest.Mock;
const confirmFn = contactChanges.confirmContactChange as jest.Mock;
const ackFn = activation.acknowledgeProviderPolicy as jest.Mock;

const capture = () => {
  const sent: any = { status: 200, body: undefined, headers: {} };
  const res: any = {
    status(code: number) { sent.status = code; return res; },
    json(body: any) { sent.body = body; return res; },
    set(n: string, v: string) { sent.headers[n] = v; return res; },
    setHeader(n: string, v: string) { sent.headers[n] = v; return res; },
    getHeader(n: string) { return sent.headers[n]; },
    headersSent: false,
  };
  return { res, sent };
};

/** A decoded Firebase token, as `verifyAuth` leaves it on the request. */
const DECODED = { uid: 'prov-1', auth_time: 1_760_000_000, email: 'p@example.com' };

const reqFor = (body: Record<string, unknown> = {}) => ({
  user: DECODED,
  params: {},
  query: {},
  body,
  headers: {},
  get: () => undefined,
}) as any;

beforeEach(() => {
  requestFn.mockReset().mockResolvedValue({ requestId: '1', kind: 'email' });
  confirmFn.mockReset().mockResolvedValue({ kind: 'email', confirmed: true });
  ackFn.mockReset().mockResolvedValue({ acknowledgedAt: '2026-08-21T00:00:00.000Z', policyVersion: null });
});

describe('the recent-auth precondition survives the migration', () => {
  it('passes the DECODED token to the request step, not just the uid', async () => {
    const { res } = capture();
    await handlers['provider.contactChanges.request'](
      reqFor({ kind: 'email', target: 'new@example.com', clientRequestId: 'client-request-id-01' }),
      res,
    );

    expect(requestFn).toHaveBeenCalledTimes(1);
    const [uid, decoded] = requestFn.mock.calls[0];
    expect(uid).toBe('prov-1');
    // The whole point. `assertRecentAuth` reads auth_time off this object; a
    // handler passing undefined here removes the check without failing anything.
    expect(decoded).toBe(DECODED);
    expect(decoded.auth_time).toBe(1_760_000_000);
  });

  it('passes the DECODED token to the confirm step too, rather than trusting step one', async () => {
    const { res } = capture();
    await handlers['provider.contactChanges.confirm'](
      reqFor({ requestId: '1', code: '123456' }),
      res,
    );

    const [uid, decoded] = confirmFn.mock.calls[0];
    expect(uid).toBe('prov-1');
    // The two calls are minutes apart and the window can close between them, so
    // step two re-asserts rather than inheriting step one's verdict.
    expect(decoded).toBe(DECODED);
  });

  it('a stale session answers ACCOUNT_RECENT_AUTH_REQUIRED, never TOKEN_EXPIRED', async () => {
    requestFn.mockRejectedValue(Object.assign(new Error('Sign in again'), {
      statusCode: 401, code: 'RECENT_AUTH_REQUIRED', recovery: 'REAUTHENTICATE',
    }));
    const { res, sent } = capture();
    await handlers['provider.contactChanges.request'](
      reqFor({ kind: 'email', target: 'new@example.com', clientRequestId: 'client-request-id-01' }),
      res,
    );

    // A client reading this as an expired token refreshes, succeeds, retries,
    // and is refused identically — forever. The codes must stay distinguishable.
    expect(sent.status).toBe(401);
    expect(sent.body.error.code).toBe('ACCOUNT_RECENT_AUTH_REQUIRED');
    expect(sent.body.error.code).not.toBe('TOKEN_EXPIRED');
  });

  it('the code is in the published vocabulary, so a client may branch on it', () => {
    expect(V1_ERROR_STATUS.ACCOUNT_RECENT_AUTH_REQUIRED).toBe(401);
    const entry = V1_CONTRACT.find((e) => e.id === 'provider.contactChanges.request');
    expect(entry!.errors).toContain('ACCOUNT_RECENT_AUTH_REQUIRED');
  });
});

describe('the two steps are published as a pair', () => {
  it('both exist, or neither is usable', () => {
    const ids = ['provider.contactChanges.request', 'provider.contactChanges.confirm'];
    for (const id of ids) {
      const entry = V1_CONTRACT.find((e) => e.id === id);
      expect(entry).toBeDefined();
      expect(entry!.status).toBe('implemented');
      // A canonical request whose confirm is still legacy is ONE flow split
      // across two contracts, and a client that migrates halfway leaves a
      // provider unable to finish changing their recovery address.
      expect(entry!.auth).toBe('provider');
    }
  });

  it('each names its replay mechanism, and they are different mechanisms', () => {
    const request = V1_CONTRACT.find((e) => e.id === 'provider.contactChanges.request')!;
    const confirm = V1_CONTRACT.find((e) => e.id === 'provider.contactChanges.confirm')!;
    // Step one dedupes a repeated START on a caller-supplied id; step two is
    // protected by the code being spent under a row lock. Same flow, genuinely
    // different guards — collapsing them onto one label would be a lie a client
    // gates on.
    expect(request.replayMechanism).toEqual(['client-request-id']);
    expect(confirm.replayMechanism).toEqual(['single-use-token', 'row-lock']);
  });
});

describe('statusCode-only refusals reach the client as themselves', () => {
  it('a 404 from a service that throws no code is a 404, not a 500', async () => {
    // The compliance and contact-change services predate the v1 vocabulary and
    // throw `Object.assign(new Error(msg), { statusCode })`. Before TAB 04 every
    // one of those arrived as INTERNAL 500 — both a lie and unactionable.
    confirmFn.mockRejectedValue(Object.assign(new Error('Contact change request not found'), { statusCode: 404 }));
    const { res, sent } = capture();
    await handlers['provider.contactChanges.confirm'](reqFor({ requestId: '9', code: '123456' }), res);

    expect(sent.status).toBe(404);
    expect(sent.body.error.code).toBe('NOT_FOUND');
  });

  it('a 422 for a malformed number is a validation failure, not a server error', async () => {
    requestFn.mockRejectedValue(Object.assign(new Error('Enter a valid Philippine mobile number'), {
      statusCode: 422, code: 'INVALID_MOBILE',
    }));
    const { res, sent } = capture();
    await handlers['provider.contactChanges.request'](
      reqFor({ kind: 'mobile', target: 'nonsense', clientRequestId: 'client-request-id-01' }), res,
    );

    expect(sent.status).toBe(400);
    expect(sent.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('an unmapped failure still becomes INTERNAL rather than leaking its message', async () => {
    requestFn.mockRejectedValue(new Error('relation "servana.provider_contact_change_requests" does not exist'));
    const { res, sent } = capture();
    await handlers['provider.contactChanges.request'](
      reqFor({ kind: 'email', target: 'x@y.z', clientRequestId: 'client-request-id-01' }), res,
    );

    expect(sent.status).toBe(500);
    // §21 — never a SQL error, a constraint name or a relation on the wire.
    expect(JSON.stringify(sent.body)).not.toContain('relation');
    expect(JSON.stringify(sent.body)).not.toContain('provider_contact_change_requests');
  });
});

describe('the policy acknowledgement records consent without re-deciding it', () => {
  it('records an unknown policyVersion rather than refusing it', async () => {
    const { res, sent } = capture();
    await handlers['provider.activation.acknowledgePolicy'](reqFor({ policyVersion: 'v99-unreleased' }), res);

    // Refusing an unknown version would block acceptance whenever the agreement
    // is revised before the app is — and a provider who cannot accept cannot work.
    expect(ackFn).toHaveBeenCalledWith('prov-1', { version: 'v99-unreleased' });
    expect(sent.status).toBe(200);
  });

  it('accepts an absent body, and passes null rather than the string "undefined"', async () => {
    const { res } = capture();
    await handlers['provider.activation.acknowledgePolicy'](reqFor({}), res);
    expect(ackFn).toHaveBeenCalledWith('prov-1', { version: null });
  });

  it('rejects an over-long version by recording null, not by failing the acceptance', async () => {
    const { res, sent } = capture();
    await handlers['provider.activation.acknowledgePolicy'](reqFor({ policyVersion: 'x'.repeat(65) }), res);
    expect(ackFn).toHaveBeenCalledWith('prov-1', { version: null });
    expect(sent.status).toBe(200);
  });

  it('is declared idempotent, because the upsert COALESCEs the original moment', () => {
    const entry = V1_CONTRACT.find((e) => e.id === 'provider.activation.acknowledgePolicy')!;
    // The instant somebody agreed is a fact. A double tap must not rewrite it,
    // and the contract says so rather than leaving a client to hope.
    expect(entry.idempotent).toBe(true);
    expect(entry.replayMechanism).toBeUndefined();
  });
});
