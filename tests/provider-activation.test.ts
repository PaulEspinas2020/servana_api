/**
 * Command 6 §8, §28 — the activation dimension.
 *
 * The property under test throughout: operational access is GRANTED BY AN
 * EXPLICIT TRANSITION and by nothing else. A checklist reaching 100% must not
 * activate anybody, and neither must a recompute.
 */

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));

import dbQuery from '../src/db/dbQuery';
import {
  VALID_ACTIVATION_TRANSITIONS,
  transitionActivation,
  refreshActivationEligibility,
  ActivationTransitionError,
  type ActivationStatus,
} from '../src/services/providerActivationService';

const q = dbQuery.query as jest.Mock;

/**
 * Routes each query by its SQL text rather than by call order, so a change in
 * the number of schema statements does not silently shift the fixtures onto the
 * wrong queries — which would make these tests assert nothing.
 */
const mockDb = (opts: {
  status: ActivationStatus;
  version?: number;
  approvedServices?: number;
  availability?: number;
  policy?: number;
  updateReturns?: boolean;
}) => {
  const {
    status,
    version = 1,
    approvedServices = 1,
    availability = 1,
    policy = 1,
    updateReturns = true,
  } = opts;

  q.mockReset();
  q.mockImplementation((sql: string) => {
    const t = String(sql);
    if (/CREATE TABLE|CREATE INDEX/i.test(t)) return Promise.resolve({ rows: [] });
    if (/INSERT INTO servana\.provider_activation \(provider_uid\)/i.test(t)) {
      return Promise.resolve({
        rows: [{ activation_status: status, version, activated_at: null }],
      });
    }
    if (/worker_service_applications/i.test(t)) {
      return Promise.resolve({ rows: [{ n: approvedServices }] });
    }
    if (/worker_availability/i.test(t)) {
      return Promise.resolve({ rows: [{ n: availability }] });
    }
    if (/policy_acknowledged_at IS NOT NULL/i.test(t)) {
      return Promise.resolve({ rows: [{ n: policy }] });
    }
    if (/UPDATE servana\.provider_activation/i.test(t)) {
      return Promise.resolve({
        rows: updateReturns ? [{ activation_status: 'PLACEHOLDER', version: version + 1 }] : [],
      });
    }
    if (/INSERT INTO servana\.provider_activation_events/i.test(t)) {
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
};

describe('the transition table', () => {
  it('has no edge that skips READY_FOR_ACTIVATION', () => {
    // If PENDING_REQUIREMENTS could reach ACTIVE directly, the requirement
    // re-check that guards activation could be bypassed entirely.
    expect(VALID_ACTIVATION_TRANSITIONS.PENDING_REQUIREMENTS).not.toContain('ACTIVE');
    expect(VALID_ACTIVATION_TRANSITIONS.NOT_ELIGIBLE).not.toContain('ACTIVE');
  });

  it('only READY_FOR_ACTIVATION and TEMPORARILY_RESTRICTED may reach ACTIVE', () => {
    const canReachActive = (Object.keys(VALID_ACTIVATION_TRANSITIONS) as ActivationStatus[])
      .filter((from) => VALID_ACTIVATION_TRANSITIONS[from].includes('ACTIVE'))
      .sort();
    expect(canReachActive).toEqual(['READY_FOR_ACTIVATION', 'TEMPORARILY_RESTRICTED']);
  });

  it('every state can be revoked to NOT_ELIGIBLE', () => {
    for (const from of Object.keys(VALID_ACTIVATION_TRANSITIONS) as ActivationStatus[]) {
      if (from === 'NOT_ELIGIBLE') continue;
      expect(VALID_ACTIVATION_TRANSITIONS[from]).toContain('NOT_ELIGIBLE');
    }
  });
});

describe('activation requires an explicit, guarded transition', () => {
  it('activates when every blocking requirement is satisfied', async () => {
    mockDb({ status: 'READY_FOR_ACTIVATION' });
    const r = await transitionActivation({
      providerUid: 'u1',
      to: 'ACTIVE',
      expectedVersion: 1,
      actorType: 'admin',
      actorUid: 'admin-1',
    });
    expect(r.version).toBe(2);
  });

  it('refuses when a requirement is outstanding, and names how many', async () => {
    mockDb({ status: 'READY_FOR_ACTIVATION', availability: 0, policy: 0 });
    await expect(
      transitionActivation({
        providerUid: 'u1',
        to: 'ACTIVE',
        expectedVersion: 1,
        actorType: 'admin',
      })
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('re-checks at commit — a caller cannot assert readiness', async () => {
    // The caller says activate; the data says a requirement is missing. The
    // data wins, because the check happens inside the transition.
    mockDb({ status: 'READY_FOR_ACTIVATION', approvedServices: 0 });
    await expect(
      transitionActivation({
        providerUid: 'u1',
        to: 'ACTIVE',
        expectedVersion: 1,
        actorType: 'admin',
      })
    ).rejects.toBeInstanceOf(ActivationTransitionError);
  });

  it('a provider cannot activate their own account', async () => {
    mockDb({ status: 'READY_FOR_ACTIVATION' });
    await expect(
      transitionActivation({
        providerUid: 'u1',
        to: 'ACTIVE',
        expectedVersion: 1,
        actorType: 'provider',
        actorUid: 'u1',
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('an invalid edge is rejected with 422', async () => {
    mockDb({ status: 'NOT_ELIGIBLE' });
    await expect(
      transitionActivation({
        providerUid: 'u1',
        to: 'ACTIVE',
        expectedVersion: 1,
        actorType: 'admin',
      })
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('a stale version is a 409, not a silent overwrite', async () => {
    mockDb({ status: 'READY_FOR_ACTIVATION', version: 7 });
    await expect(
      transitionActivation({
        providerUid: 'u1',
        to: 'ACTIVE',
        expectedVersion: 3,
        actorType: 'admin',
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('losing the write race is also a 409', async () => {
    // Version matched on read, then another writer got there first.
    mockDb({ status: 'READY_FOR_ACTIVATION', updateReturns: false });
    await expect(
      transitionActivation({
        providerUid: 'u1',
        to: 'ACTIVE',
        expectedVersion: 1,
        actorType: 'admin',
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('recomputing eligibility never grants access', () => {
  it('promotes only as far as READY_FOR_ACTIVATION', async () => {
    mockDb({ status: 'PENDING_REQUIREMENTS' });
    const r = await refreshActivationEligibility('u1', true);
    expect(r).not.toBe('ACTIVE');
  });

  it('leaves an already-active provider alone', async () => {
    mockDb({ status: 'ACTIVE' });
    expect(await refreshActivationEligibility('u1', true)).toBe('ACTIVE');
  });

  it('does not quietly un-restrict a restricted provider', async () => {
    // Lifting a restriction is a decision (§14), not a recompute.
    mockDb({ status: 'TEMPORARILY_RESTRICTED' });
    expect(await refreshActivationEligibility('u1', true)).toBe('TEMPORARILY_RESTRICTED');
  });
});

describe('requirements fail closed', () => {
  it('a requirement that cannot be verified is not satisfied', async () => {
    q.mockReset();
    q.mockImplementation((sql: string) => {
      const t = String(sql);
      if (/CREATE TABLE|CREATE INDEX/i.test(t)) return Promise.resolve({ rows: [] });
      if (/INSERT INTO servana\.provider_activation \(provider_uid\)/i.test(t)) {
        return Promise.resolve({
          rows: [{ activation_status: 'READY_FOR_ACTIVATION', version: 1, activated_at: null }],
        });
      }
      // Every requirement lookup blows up — a missing table, say.
      if (/count\(\*\)/i.test(t)) return Promise.reject(new Error('relation does not exist'));
      return Promise.resolve({ rows: [] });
    });

    await expect(
      transitionActivation({
        providerUid: 'u1',
        to: 'ACTIVE',
        expectedVersion: 1,
        actorType: 'admin',
      })
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});
