/**
 * Authorization decisions are recorded, and carry no secret or PII (TAB 04).
 *
 * The tests that matter here are the negative ones. This module emits a line
 * about a caller at the exact moment they were refused — which is when someone
 * is most tempted to log "everything, to debug it" — so the assertions are
 * mostly about what must NOT appear.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));

import {
  decisionFor,
  recordAuthzDecision,
  shortActor,
  __authzDecisions,
  __resetAuthzAudit,
} from '../src/observability/authzAudit';

const reqWith = (over: Record<string, unknown> = {}): any => {
  const req: any = {
    headers: {},
    path: '/api/v1/provider/earnings/summary',
    ...over,
  };
  // `clientLabelOf` reads a header through Express's accessor, so the double
  // needs it. Reading from the same `headers` bag keeps the two consistent.
  req.get = (name: string) => req.headers[String(name).toLowerCase()];
  return req;
};

beforeEach(() => {
  __resetAuthzAudit();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('the actor is identifiable but not impersonable', () => {
  it('truncates a uid to six characters', () => {
    expect(shortActor('9l2KpHqRsTuVwXyZ')).toBe('9l2KpH…');
  });

  it('says anonymous rather than inventing an actor', () => {
    expect(shortActor(undefined)).toBe('anonymous');
    expect(shortActor('')).toBe('anonymous');
    expect(shortActor(null)).toBe('anonymous');
  });

  it('never carries the whole uid', () => {
    const uid = 'provider-uid-that-is-quite-long-000';
    const decision = decisionFor(reqWith({ user: { uid } }), {
      outcome: 'deny', rule: 'role', routeId: 'provider.earnings.summary',
      reason: 'PROVIDER_ROLE_REQUIRED',
    });
    expect(JSON.stringify(decision)).not.toContain(uid);
  });
});

describe('the shape is fixed, so nothing can be smuggled in', () => {
  it('builds every field here rather than passing the request through', () => {
    const decision = decisionFor(
      reqWith({
        user: { uid: 'abc123def', email: 'someone@example.com', token: 'secret-token' },
        body: { password: 'hunter2' },
        headers: { authorization: 'Bearer eyJhbGciOi' },
      }),
      {
        outcome: 'deny', rule: 'ownership', routeId: 'bookings.get',
        reason: 'BOOKING_NOT_OWNED', objectType: 'booking',
      },
    );

    const serialised = JSON.stringify(decision);
    for (const secret of ['someone@example.com', 'secret-token', 'hunter2', 'eyJhbGciOi']) {
      expect(serialised).not.toContain(secret);
    }
    // And the keys are exactly the declared ones.
    expect(Object.keys(decision).sort()).toEqual(
      ['actor', 'actorRole', 'client', 'objectType', 'outcome', 'reason', 'routeId', 'rule'].sort(),
    );
  });

  it('records the object KIND, never its identifier', () => {
    // `booking` is useful in a log; `booking 4471` is a customer's appointment.
    const decision = decisionFor(reqWith({ user: { uid: 'u' }, params: { bookingId: '4471' } }), {
      outcome: 'deny', rule: 'ownership', routeId: 'bookings.get',
      reason: 'BOOKING_NOT_OWNED', objectType: 'booking',
    });
    expect(decision.objectType).toBe('booking');
    expect(JSON.stringify(decision)).not.toContain('4471');
  });
});

describe('what gets emitted', () => {
  it('writes a line for a DENY', () => {
    recordAuthzDecision(decisionFor(reqWith({ user: { uid: 'abc123' } }), {
      outcome: 'deny', rule: 'capability', routeId: 'provider.earnings.summary',
      reason: 'APPLICATION_NOT_SUBMITTED',
    }));
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect((console.warn as jest.Mock).mock.calls[0][0]).toContain('[authz] DENY rule=capability');
  });

  it('stays silent for an ALLOW', () => {
    /**
     * One line per allowed request would drown the signal and duplicate what
     * requestLog already records. The decision is still retained in memory for
     * a test to assert on.
     */
    recordAuthzDecision(decisionFor(reqWith({ user: { uid: 'abc123' } }), {
      outcome: 'allow', rule: 'role', routeId: 'provider.jobs.list', reason: 'OK',
    }));
    expect(console.warn).not.toHaveBeenCalled();
    expect(__authzDecisions()).toHaveLength(1);
  });

  it('bounds what it retains, so a deny storm cannot grow without limit', () => {
    for (let i = 0; i < 150; i++) {
      recordAuthzDecision(decisionFor(reqWith({ user: { uid: 'abc123' } }), {
        outcome: 'allow', rule: 'role', routeId: 'r', reason: 'OK',
      }));
    }
    expect(__authzDecisions().length).toBeLessThanOrEqual(100);
  });
});

describe('the audit can never break the decision it observes', () => {
  /**
   * The regression this pins, found by a negative fixture rather than by
   * design.
   *
   * Wiring the audit into `verifyRoles` made `clientLabelOf` throw on a request
   * double that had no `req.get`. The throw did not lose a log line — it
   * aborted the middleware BEFORE it sent its 403, and the authz matrix test
   * `admin mode denies role 4` started reporting ALLOWED.
   *
   * An observability bug must be a missing line, never a changed decision, and
   * that matters most in the code whose job is to say no.
   */
  it('survives a request with no accessors at all', () => {
    const hostile: any = {};
    expect(() =>
      recordAuthzDecision(
        decisionFor(hostile, {
          outcome: 'deny', rule: 'role', routeId: 'x', reason: 'FORBIDDEN_ROLE',
        }),
      ),
    ).not.toThrow();
  });

  it('survives a request whose accessors throw', () => {
    const hostile: any = {
      get: () => { throw new Error('header access exploded'); },
      get user() { throw new Error('user access exploded'); },
    };
    expect(() =>
      recordAuthzDecision(
        decisionFor(hostile, {
          outcome: 'deny', rule: 'ownership', routeId: 'x', reason: 'NOT_OWNED',
        }),
      ),
    ).not.toThrow();
  });

  it('still records something useful when it falls back', () => {
    // Degraded, not silent: the RULE and REASON are supplied by the caller and
    // survive whatever the request does.
    __resetAuthzAudit();
    recordAuthzDecision(
      decisionFor({} as any, {
        outcome: 'deny', rule: 'capability', routeId: 'provider.earnings', reason: 'NOT_ACTIVE',
      }),
    );
    const [recorded] = __authzDecisions();
    expect(recorded.rule).toBe('capability');
    expect(recorded.reason).toBe('NOT_ACTIVE');
    expect(recorded.client).toBe('unknown');
  });
});
