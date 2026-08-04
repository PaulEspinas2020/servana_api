/**
 * Command 6 §28 — state-machine and authorization tests for the canonical
 * account-state endpoint.
 *
 * These assert the properties that matter rather than the shape of the JSON:
 * that access is denied by default, that approval is not activation, that a
 * suspension revokes the right things and keeps the right things, and that an
 * unrecognised status is treated differently from an absent one.
 */

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/services/adminOnboardingService', () => ({
  calculateReadiness: jest.fn(),
}));
// Activation is a unit with its own suite (provider-activation.test.ts). Mocked
// here so these tests exercise COMPOSITION — how the dimensions combine into
// capabilities — rather than re-testing the transition machine through it.
jest.mock('../src/services/providerActivationService', () => ({
  refreshActivationEligibility: jest.fn(),
}));

import dbQuery from '../src/db/dbQuery';
import { calculateReadiness } from '../src/services/adminOnboardingService';
import { refreshActivationEligibility } from '../src/services/providerActivationService';
import { getProviderAccountState } from '../src/services/providerAccountStateService';

const q = dbQuery.query as jest.Mock;
const readiness = calculateReadiness as jest.Mock;
const activationOf = refreshActivationEligibility as jest.Mock;

type Row = Record<string, any>;

/** account row, then onboarding case row (readiness is mocked separately). */
const setup = (
  account: Row | null,
  onboardingStatus?: string,
  ready?: any,
  activation?: string
) => {
  q.mockReset();
  readiness.mockReset();
  activationOf.mockReset();

  // Default mirrors reality: activation only becomes ACTIVE once the
  // application is approved AND somebody has taken the explicit transition.
  activationOf.mockResolvedValue(
    activation ?? (onboardingStatus === 'approved' ? 'ACTIVE' : 'NOT_ELIGIBLE')
  );

  readiness.mockResolvedValue(
    ready ?? {
      blockers: [],
      summary: {
        requirementsUploaded: 2,
        requirementsApproved: 2,
        activeServices: 1,
      },
    }
  );

  const results: any[] = [
    { rows: account ? [account] : [] },
    { rows: onboardingStatus ? [{ onboarding_status: onboardingStatus, id: 'case-1234abcd', submitted_at: null }] : [] },
  ];
  let i = 0;
  q.mockImplementation(() => Promise.resolve(results[i++] ?? { rows: [] }));
};

const ACTIVE_PROVIDER: Row = {
  uid: 'u1',
  role: '2',
  account_status: 'active',
  email: 'a@b.com',
  is_email_verified: true,
  phone_number: '+639171234567',
  is_mobile_verified: true,
};

describe('fail closed', () => {
  it('an unknown uid is denied everything except support', async () => {
    setup(null);
    const s = await getProviderAccountState('nobody');

    expect(s.account.status).toBe('UNKNOWN');
    expect(s.access.canOpenSupportCase).toBe(true);
    expect(s.access.canAcceptJobs).toBe(false);
    expect(s.access.canViewEarnings).toBe(false);
    expect(s.nextStep.blocking).toBe(true);
  });

  it('an UNRECOGNISED status denies — somebody wrote something we do not understand', async () => {
    setup({ ...ACTIVE_PROVIDER, account_status: 'banana' });
    const s = await getProviderAccountState('u1');

    expect(s.account.status).toBe('UNKNOWN');
    expect(s.access.canAcceptJobs).toBe(false);
  });

  it('an ABSENT status is a legacy account and is NOT denied', async () => {
    // Deliberate asymmetry with the case above. Collapsing NULL into "unknown"
    // is what 403'd every pre-column account in a live outage: absence means
    // nothing was ever written, not that somebody blocked them.
    setup({ ...ACTIVE_PROVIDER, account_status: null }, 'approved');
    const s = await getProviderAccountState('u1');

    expect(s.account.status).toBe('ACTIVE');
    expect(s.access.canAcceptJobs).toBe(true);
  });

  it('an empty-string status is treated as absent, not as a value', async () => {
    setup({ ...ACTIVE_PROVIDER, account_status: '   ' }, 'approved');
    const s = await getProviderAccountState('u1');
    expect(s.account.status).toBe('ACTIVE');
  });

  it('a pending provider gets onboarding capability but no operational capability', async () => {
    setup({ ...ACTIVE_PROVIDER, account_status: 'pending' });
    const s = await getProviderAccountState('u1');

    // They must be able to progress — withholding these would make `pending` a
    // trap, which is exactly the position 108 production accounts are in.
    expect(s.access.canEditProfile).toBe(true);
    expect(s.access.canUploadDocuments).toBe(true);
    expect(s.access.canSubmitApplication).toBe(true);

    // And nothing operational, because none of it has been earned yet.
    for (const cap of [
      'canBrowseJobs',
      'canAcceptJobs',
      'canMessageCustomers',
      'canRequestWithdrawal',
      'canGoOnline',
      'canManageAvailability',
      'canViewEarnings',
    ] as const) {
      expect(s.access[cap]).toBe(false);
    }
  });
});

describe('role', () => {
  it('a customer holding a valid token is not a provider', async () => {
    setup({ ...ACTIVE_PROVIDER, role: '3' });
    const s = await getProviderAccountState('u1');

    expect(s.nextStep.code).toBe('ROLE_NOT_PERMITTED');
    expect(s.access.canAcceptJobs).toBe(false);
  });

  it('role 4 is ALSO a provider — a check written as role=2 is wrong', async () => {
    setup({ ...ACTIVE_PROVIDER, role: '4' }, 'approved');
    const s = await getProviderAccountState('u1');

    expect(s.nextStep.code).not.toBe('ROLE_NOT_PERMITTED');
    expect(s.access.canAcceptJobs).toBe(true);
  });

  it('the undefined role 6 is denied', async () => {
    setup({ ...ACTIVE_PROVIDER, role: '6' });
    const s = await getProviderAccountState('u1');
    expect(s.nextStep.code).toBe('ROLE_NOT_PERMITTED');
  });
});

describe('approval is not activation (§8)', () => {
  it('an approved provider with no active service cannot accept jobs', async () => {
    setup(
      { ...ACTIVE_PROVIDER, account_status: 'pending' },
      'approved',
      {
        blockers: [],
        summary: { requirementsUploaded: 2, requirementsApproved: 2, activeServices: 0 },
      },
      // Approved, but an activation requirement is outstanding — so the
      // explicit transition into ACTIVE has not been taken.
      'PENDING_REQUIREMENTS'
    );
    const s = await getProviderAccountState('u1');

    expect(s.application.status).toBe('APPROVED');
    expect(s.activation.status).toBe('PENDING_REQUIREMENTS');
    expect(s.access.canAcceptJobs).toBe(false);
    expect(s.nextStep.code).toBe('ACTIVATION_PENDING');
  });

  it('activation ACTIVE requires the operational account to be active too', async () => {
    setup({ ...ACTIVE_PROVIDER, account_status: 'active' }, 'approved');
    const s = await getProviderAccountState('u1');

    expect(s.activation.status).toBe('ACTIVE');
    expect(s.access.canAcceptJobs).toBe(true);
    expect(s.access.canGoOnline).toBe(true);
  });

  it('an unapproved application is never eligible for activation', async () => {
    setup({ ...ACTIVE_PROVIDER, account_status: 'pending' }, 'in_review');
    const s = await getProviderAccountState('u1');

    expect(s.activation.status).toBe('NOT_ELIGIBLE');
    expect(s.access.canAcceptJobs).toBe(false);
  });
});

describe('suspension (§13)', () => {
  it('revokes operational capability immediately', async () => {
    setup({ ...ACTIVE_PROVIDER, account_status: 'suspended' }, 'approved');
    const s = await getProviderAccountState('u1');

    expect(s.account.status).toBe('SUSPENDED');
    expect(s.access.canAcceptJobs).toBe(false);
    expect(s.access.canBrowseJobs).toBe(false);
    expect(s.access.canGoOnline).toBe(false);
    expect(s.access.canRequestWithdrawal).toBe(false);
    expect(s.access.canMessageCustomers).toBe(false);
    expect(s.nextStep.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('keeps what withholding would only punish', async () => {
    setup({ ...ACTIVE_PROVIDER, account_status: 'suspended' }, 'approved');
    const s = await getProviderAccountState('u1');

    // Someone suspended still needs to see what they are owed, still needs
    // support, and must never be trapped online.
    expect(s.access.canViewEarnings).toBe(true);
    expect(s.access.canViewBookings).toBe(true);
    expect(s.access.canOpenSupportCase).toBe(true);
    expect(s.access.canGoOffline).toBe(true);
  });

  it('suspension outranks unverified identifiers (§6 precedence)', async () => {
    setup(
      { ...ACTIVE_PROVIDER, account_status: 'suspended', is_email_verified: false, is_mobile_verified: false },
      'approved'
    );
    const s = await getProviderAccountState('u1');

    // Not "verify your email" — the suspension is what matters.
    expect(s.nextStep.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('verification (§3)', () => {
  it('missing verification data is not verification', async () => {
    setup({
      ...ACTIVE_PROVIDER,
      account_status: 'pending',
      is_email_verified: false,
      is_mobile_verified: false,
    });
    const s = await getProviderAccountState('u1');

    expect(s.verification.email).toBe('PENDING');
    expect(s.verification.mobile).toBe('PENDING');
    expect(s.verification.minimumRequirementMet).toBe(false);
    expect(s.nextStep.code).toBe('IDENTIFIER_VERIFICATION_REQUIRED');
  });

  it('a mobile-only account with a verified number meets the minimum', async () => {
    // 29 production accounts hold no email at all.
    setup({
      ...ACTIVE_PROVIDER,
      account_status: 'pending',
      email: null,
      is_email_verified: false,
      is_mobile_verified: true,
    });
    const s = await getProviderAccountState('u1');

    expect(s.verification.email).toBe('MISSING');
    expect(s.verification.mobile).toBe('VERIFIED');
    expect(s.verification.minimumRequirementMet).toBe(true);
    expect(s.nextStep.code).not.toBe('IDENTIFIER_VERIFICATION_REQUIRED');
  });
});

describe("Servana's backlog is never the provider's problem", () => {
  it('a pending internal review does not become a provider next-step', async () => {
    setup({ ...ACTIVE_PROVIDER, account_status: 'pending' }, 'in_review', {
      blockers: [
        { code: 'requirement_pending_review', severity: 'blocking', label: '2 documents pending review' },
        { code: 'service_application_pending', severity: 'blocking', label: '1 application pending' },
      ],
      summary: { requirementsUploaded: 2, requirementsApproved: 0, activeServices: 0 },
    });
    const s = await getProviderAccountState('u1');

    // Those blockers are Servana's queue. The provider is simply waiting.
    expect(s.profile.missingFields).toEqual([]);
    expect(s.nextStep.code).toBe('APPLICATION_UNDER_REVIEW');
    expect(s.profile.completionPercent).toBe(100);
  });
});

describe('resilience', () => {
  it('a readiness failure does not grant access', async () => {
    q.mockReset();
    readiness.mockReset();
    readiness.mockRejectedValue(new Error('boom'));
    const results = [
      { rows: [{ ...ACTIVE_PROVIDER, account_status: 'pending' }] },
      { rows: [] },
    ];
    let i = 0;
    q.mockImplementation(() => Promise.resolve(results[i++] ?? { rows: [] }));

    const s = await getProviderAccountState('u1');
    expect(s.access.canAcceptJobs).toBe(false);
  });

  it('the review reference is safe, not the internal case id', async () => {
    setup(ACTIVE_PROVIDER, 'in_review');
    const s = await getProviderAccountState('u1');

    expect(s.application.reviewReference).toBe('SR-CASE-123');
    expect(s.application.reviewReference).not.toContain('case-1234abcd');
  });
});
