import { readFileSync } from 'fs';
import { join } from 'path';

jest.mock('../src/services/providerAccountStateService', () => ({
  getProviderAccountState: jest.fn(),
}));

import requireCapability, {
  __clearCapabilityMemo,
  defaultCapabilityMode,
} from '../src/middleware/requireCapability';
import { getProviderAccountState } from '../src/services/providerAccountStateService';

const mockState = getProviderAccountState as jest.Mock;

/**
 * Capabilities are published; this is the half that enforces them.
 *
 * Masterlist S-02 / access matrix A-02: of the sixteen capabilities the state
 * endpoint reports, three were checked anywhere. Earnings, messaging and
 * availability survived a suspension by accident.
 *
 * The awkward fact these tests exist around: enforcing today would deny every
 * provider on the platform. `provider_activation` is empty and one onboarding
 * case exists, so `canViewEarnings` is false for all 70 provider accounts —
 * including the six who have completed 26 real bookings between them. So it
 * ships in observe mode, and the tests pin BOTH modes, because the whole point
 * is that the flip is a one-word change that must already be known-good.
 */

const state = (access: Record<string, boolean>, nextStepCode = 'OPERATIONAL') => ({
  access,
  nextStep: { code: nextStepCode, route: 'x', blocking: nextStepCode !== 'OPERATIONAL' },
});

// null means no authenticated user. Passing `undefined` would select the
// default parameter instead - which is how this test first passed a uid while
// claiming to test the absence of one.
function ctx(uid: string | null = 'provider-1') {
  const req: any = {
    user: uid ? { uid } : undefined,
    method: 'GET',
    baseUrl: '/api',
    path: '/provider/earnings',
  };
  const res: any = {
    statusCode: 0,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  const next = jest.fn();
  return { req, res, next };
}

describe('requireCapability', () => {
  beforeEach(() => {
    __clearCapabilityMemo();
    mockState.mockReset();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  describe('enforce mode', () => {
    const mw = (cap: string) =>
      requireCapability(cap as any, { mode: 'enforce' });

    it('lets a granted capability through', async () => {
      mockState.mockResolvedValue(state({ canViewEarnings: true }));
      const { req, res, next } = ctx();
      await mw('canViewEarnings')(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('refuses one the server did not grant', async () => {
      mockState.mockResolvedValue(state({ canViewEarnings: false }, 'ACTIVATION_PENDING'));
      const { req, res, next } = ctx();
      await mw('canViewEarnings')(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.body.error.code).toBe('PROVIDER_NOT_APPROVED');
    });

    it('treats an absent capability as denied, not as permission', async () => {
      // Absence is never permission — the same rule the client parser holds.
      mockState.mockResolvedValue(state({}, 'ACTIVATION_PENDING'));
      const { req, res, next } = ctx();
      await mw('canViewEarnings')(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });

    it('rejects a non-boolean true-ish value', async () => {
      mockState.mockResolvedValue(state({ canViewEarnings: 'true' as any }));
      const { req, res, next } = ctx();
      await mw('canViewEarnings')(req, res, next);
      expect(next).not.toHaveBeenCalled();
    });

    it.each([
      ['ACCOUNT_SUSPENDED', 'PROVIDER_SUSPENDED'],
      ['APPLICATION_REJECTED', 'PROVIDER_REJECTED'],
      ['ACCOUNT_DISABLED', 'PROVIDER_DISABLED'],
      ['ROLE_NOT_PERMITTED', 'ROLE_NOT_PERMITTED'],
      ['DOCUMENTS_ACTION_REQUIRED', 'PROVIDER_NOT_APPROVED'],
    ])('a %s denial answers %s', async (nextStep, expected) => {
      // The denial is chosen from the STATE, not from the capability: a
      // suspended provider and an unapproved one both fail canViewEarnings and
      // need different screens. One code for both is how a client ends up
      // showing "session expired" to someone whose account is on hold.
      mockState.mockResolvedValue(state({ canViewEarnings: false }, nextStep));
      const { req, res, next } = ctx();
      await mw('canViewEarnings')(req, res, next);
      expect(res.body.error.code).toBe(expected);
    });

    it('answers RETRY when the lookup itself fails', async () => {
      mockState.mockRejectedValue(new Error('db down'));
      const { req, res, next } = ctx();
      await mw('canViewEarnings')(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.body.error.code).toBe('ACCOUNT_STATUS_UNAVAILABLE');
      expect(res.body.error.retryable).toBe(true);
    });

    it('refuses an unauthenticated caller before asking anything', async () => {
      const { req, res, next } = ctx(null);
      await mw('canViewEarnings')(req, res, next);
      expect(res.statusCode).toBe(401);
      expect(mockState).not.toHaveBeenCalled();
    });
  });

  describe('observe mode', () => {
    const mw = (cap: string) =>
      requireCapability(cap as any, { mode: 'observe' });

    it('lets a would-be denial through, and says so', async () => {
      mockState.mockResolvedValue(state({ canViewEarnings: false }, 'ACTIVATION_PENDING'));
      const { req, res, next } = ctx();
      await mw('canViewEarnings')(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('WOULD DENY canViewEarnings')
      );
    });

    it('logs a truncated uid, not a user record', async () => {
      mockState.mockResolvedValue(state({ canViewEarnings: false }));
      const { req, res, next } = ctx('firebase-uid-abcdef123456');
      await mw('canViewEarnings')(req, res, next);
      const line = (console.warn as jest.Mock).mock.calls[0][0] as string;
      expect(line).toContain('fireba…');
      expect(line).not.toContain('abcdef123456');
    });

    it('does not break the route when the lookup fails', async () => {
      // A route we are only WATCHING must never be broken by the watching.
      mockState.mockRejectedValue(new Error('db down'));
      const { req, res, next } = ctx();
      await mw('canViewEarnings')(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.statusCode).toBe(0);
    });

    it('stays silent when the capability is granted', async () => {
      mockState.mockResolvedValue(state({ canViewEarnings: true }));
      const { req, res, next } = ctx();
      await mw('canViewEarnings')(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
    });
  });

  describe('the memo', () => {
    it('collapses the five parallel earnings calls into one lookup', async () => {
      // The worker's earnings screen fires five summary requests at once
      // (all-time, this week, last week, this month, last month). Without the
      // memo, one screen costs five full state computations.
      mockState.mockResolvedValue(state({ canViewEarnings: true }));
      const mw = requireCapability('canViewEarnings' as any, { mode: 'enforce' });
      await Promise.all(
        Array.from({ length: 5 }, async () => {
          const { req, res, next } = ctx();
          await mw(req, res, next);
        })
      );
      expect(mockState).toHaveBeenCalledTimes(1);
    });

    it('does not share one provider answer with another', async () => {
      mockState.mockImplementation(async (uid: string) =>
        state({ canViewEarnings: uid === 'allowed' })
      );
      const mw = requireCapability('canViewEarnings' as any, { mode: 'enforce' });

      const a = ctx('allowed');
      await mw(a.req, a.res, a.next);
      expect(a.next).toHaveBeenCalled();

      const b = ctx('denied');
      await mw(b.req, b.res, b.next);
      expect(b.next).not.toHaveBeenCalled();
    });
  });

  describe('the default mode', () => {
    const original = process.env.CAPABILITY_ENFORCEMENT;
    afterEach(() => {
      if (original === undefined) delete process.env.CAPABILITY_ENFORCEMENT;
      else process.env.CAPABILITY_ENFORCEMENT = original;
    });

    it('is observe unless deliberately switched', () => {
      // The wrong default here locks every provider out of their own money.
      delete process.env.CAPABILITY_ENFORCEMENT;
      expect(defaultCapabilityMode()).toBe('observe');
      process.env.CAPABILITY_ENFORCEMENT = 'true';
      expect(defaultCapabilityMode()).toBe('observe');
      process.env.CAPABILITY_ENFORCEMENT = 'yes';
      expect(defaultCapabilityMode()).toBe('observe');
    });

    it('enforces only on the exact word', () => {
      process.env.CAPABILITY_ENFORCEMENT = 'enforce';
      expect(defaultCapabilityMode()).toBe('enforce');
    });
  });
});

describe('the read path stays a read path', () => {
  it('account-state resolves activation without persisting', () => {
    // This middleware calls getProviderAccountState on ordinary GETs. That
    // function used to upsert a provider_activation row, bump its version and
    // append an audit event (fixed in bd6ba25). If it is ever reverted, every
    // earnings request becomes a write that manufactures activation history for
    // a provider nobody reviewed.
    const service = readFileSync(
      join(__dirname, '..', 'src', 'services', 'providerAccountStateService.ts'),
      'utf8'
    );
    expect(service).toContain('previewActivationEligibility(');
    // The word still appears in the comment explaining why it is gone; what
    // must not come back is a CALL to it.
    expect(service).not.toMatch(/refreshActivationEligibility\s*\(/);
  });
});

describe('wiring', () => {
  const routes = readFileSync(
    join(__dirname, '..', 'src', 'routes', 'provider.routes.ts'),
    'utf8'
  );

  it('gates every money read, and nothing else yet', () => {
    // The access matrix's ordered remediation says money reads first. Anything
    // wider would have to wait on S-06 anyway, since it would deny everyone.
    const gated = routes
      .split('\n')
      .filter((l) => l.includes('requireCapability('))
      .map((l) => l.match(/router\.\w+\("([^"]+)"/)?.[1]);
    expect(new Set(gated)).toEqual(
      new Set([
        '/provider/earnings',
        '/provider/earnings/summary',
        '/provider/earnings/:id',
        '/provider/ledger',
        '/provider/payouts',
        '/provider/payout/summary',
      ])
    );
  });

  it('runs after the role guard, which runs after auth', () => {
    for (const line of routes.split('\n')) {
      if (!line.includes('requireCapability(')) continue;
      expect(line.indexOf('verifyAuth')).toBeLessThan(
        line.indexOf('requireProviderRole')
      );
      expect(line.indexOf('requireProviderRole')).toBeLessThan(
        line.indexOf('requireCapability')
      );
    }
  });
});
