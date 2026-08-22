/**
 * TAB 01 — the canonical provider activation projection.
 *
 * These assert the PROPERTIES that made this a sibling resource rather than
 * more fields on the profile, and the ones a client migration depends on:
 *
 *   1. The complete activation checklist is renderable from this one read.
 *   2. A denial yields NULL, never a zeroed summary.
 *   3. Each concern is loaded ONCE — the summaries count the very rows the
 *      compliance verdict was computed from, so they cannot disagree.
 *   4. `availableActions` is DERIVED from the capability object, so it grows
 *      when `Capabilities` grows instead of silently omitting the new one.
 *   5. Nothing here discloses document content, a storage path, or an
 *      unmasked identifier.
 *
 * ## Why the database fake THROWS on an unrecognised query
 *
 * A double that matches raw SQL on a substring and returns `{ rows: [] }` for
 * anything else fails OPEN: a query whose text drifts stops being matched, the
 * fake answers "no rows", and the test goes on passing while asserting nothing
 * about the code that actually runs. This repository has already been bitten by
 * exactly that — `tests/support/accountDbFake.ts` matched a provider-profile
 * SELECT on its list prefix and seeded a column the schema has never had, so a
 * query that raised 42703 in production had a green suite behind it.
 *
 * So this fake refuses. An unrecognised query is a thrown error naming the SQL,
 * which turns a drifted query into a red test rather than a silent empty result.
 */

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/services/adminOnboardingService', () => ({
  calculateReadiness: jest.fn(),
}));
jest.mock('../src/services/providerActivationService', () => ({
  previewActivationEligibility: jest.fn(),
  getActivationRequirements: jest.fn(),
}));

import dbQuery from '../src/db/dbQuery';
import { calculateReadiness } from '../src/services/adminOnboardingService';
import {
  previewActivationEligibility,
  getActivationRequirements,
} from '../src/services/providerActivationService';
import {
  actionCodeFor,
  availableActionsFor,
  getProviderActivation,
} from '../src/services/account/providerActivationProjection';
import { DOCUMENT_TYPE_CATALOG } from '../src/services/providerProfileComplianceService';

const q = dbQuery.query as jest.Mock;
const readiness = calculateReadiness as jest.Mock;
const activationOf = previewActivationEligibility as jest.Mock;
const activationReqs = getActivationRequirements as jest.Mock;

type Row = Record<string, any>;

interface Seed {
  /** `user_credentials` as the state machine reads it. Null means no such account. */
  account: Row | null;
  /** `user_credentials` as the compliance loader reads it (role 2/4 only). */
  providerAccount?: Row | null;
  documents?: Row[];
  certifications?: Row[];
  onboardingStatus?: string;
  activation?: string;
}

/** Which query is this? Keyed on a fragment unique to each, and total. */
const classify = (sql: string): string => {
  if (sql.includes('provider_onboarding_cases')) return 'onboardingCase';
  if (sql.includes('worker_requirements')) return 'documents';
  if (sql.includes('provider_certifications')) return 'certifications';
  if (sql.includes('user_credentials') && sql.includes('role::int IN (2,4)')) return 'providerCred';
  if (sql.includes('user_credentials')) return 'stateCred';
  throw new Error(`activation fake: unrecognised query, refusing to answer it:\n${sql}`);
};

const counts: Record<string, number> = {};

const seed = (s: Seed) => {
  q.mockReset();
  readiness.mockReset();
  activationOf.mockReset();
  activationReqs.mockReset();
  for (const k of Object.keys(counts)) delete counts[k];

  readiness.mockResolvedValue({ blockers: [], summary: {} });
  activationReqs.mockResolvedValue([]);
  activationOf.mockResolvedValue(s.activation ?? 'NOT_ELIGIBLE');

  q.mockImplementation(async (sql: string) => {
    const kind = classify(sql);
    counts[kind] = (counts[kind] ?? 0) + 1;
    switch (kind) {
      case 'stateCred':
        return { rows: s.account ? [s.account] : [], rowCount: s.account ? 1 : 0 };
      case 'providerCred': {
        const row = s.providerAccount === undefined ? s.account : s.providerAccount;
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      case 'onboardingCase':
        return s.onboardingStatus
          ? { rows: [{ onboarding_status: s.onboardingStatus, submitted_at: null, id: 'case-1' }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      case 'documents':
        return { rows: s.documents ?? [], rowCount: (s.documents ?? []).length };
      case 'certifications':
        return { rows: s.certifications ?? [], rowCount: (s.certifications ?? []).length };
      default:
        throw new Error(`unhandled kind ${kind}`);
    }
  });
};

const PROVIDER: Row = {
  uid: 'prov-1',
  role: 2,
  account_status: 'active',
  email: 'p@example.com',
  phone_number: '+639170000000',
  is_email_verified: true,
  is_mobile_verified: false,
  email_verified: true,
  mobile_verified: false,
  is_archive: false,
  first_name: 'Ana',
  last_name: 'Reyes',
};

/** A `worker_requirements` row shaped as `listDocuments` reads it. */
const documentRow = (over: Row = {}): Row => ({
  id: 11,
  file_name: 'nbi.pdf',
  uploaded_at: '2026-01-01T00:00:00.000Z',
  requirement_type: DOCUMENT_TYPE_CATALOG[0].id,
  mime_type: 'application/pdf',
  byte_size: 1024,
  lifecycle_state: 'submitted',
  scan_status: 'clean',
  issue_date: null,
  expires_at: null,
  identifier_mask: '****1234',
  replacement_for_id: null,
  replaced_by_id: null,
  version: 1,
  decision: 'approved',
  review_state: 'approved',
  reason_code: null,
  provider_message: null,
  decided_at: '2026-01-02T00:00:00.000Z',
  ...over,
});

describe('the activation checklist is renderable from this one read', () => {
  it('carries every member the profile surface previously needed a legacy route for', async () => {
    seed({ account: PROVIDER, documents: [documentRow()], onboardingStatus: 'approved' });

    const result = await getProviderActivation('prov-1');

    // The six the mobile client named, plus the routing the checklist needs.
    expect(result.compliance).not.toBeNull();
    expect(result.documentSummary).not.toBeNull();
    expect(result.certificationSummary).not.toBeNull();
    expect(result.completion).not.toBeNull();
    expect(Array.isArray(result.availableActions)).toBe(true);
    expect(Array.isArray(result.checklist)).toBe(true);
    expect((result.compliance as any).blockingRequirements).toBeDefined();
    expect(result.nextStep.code).toBeTruthy();
    expect(result.nextStep.route).toBeTruthy();
  });

  it('drives completion from the document CATALOG, so a never-submitted requirement is blocked', async () => {
    seed({ account: PROVIDER, documents: [] });

    const result = await getProviderActivation('prov-1');
    const requiredTypes = DOCUMENT_TYPE_CATALOG.filter((d) => d.required);

    // A checklist built from ROWS would be two items long and claim completeness.
    expect(result.completion!.requirements.length).toBe(2 + requiredTypes.length);
    for (const definition of requiredTypes) {
      const item = result.completion!.requirements.find((r) => r.id === `document:${definition.id}`);
      expect(item).toBeDefined();
      expect(item!.state).toBe('blocked');
    }
    expect(result.completion!.state).toBe('incomplete');
  });

  it('reports complete only when every requirement is satisfied', async () => {
    const verified = DOCUMENT_TYPE_CATALOG.filter((d) => d.required).map((d, i) =>
      documentRow({ id: 100 + i, requirement_type: d.id }));
    seed({ account: PROVIDER, documents: verified });

    const result = await getProviderActivation('prov-1');

    expect(result.completion!.requirements.every((r) => r.state === 'completed')).toBe(true);
    expect(result.completion!.state).toBe('complete');
  });
});

describe('a denial yields null, never a zeroed summary', () => {
  it('withholds every summary for an account this uid does not name', async () => {
    seed({ account: null });

    const result = await getProviderActivation('ghost');

    expect(result.compliance).toBeNull();
    expect(result.documentSummary).toBeNull();
    expect(result.certificationSummary).toBeNull();
    expect(result.completion).toBeNull();
  });

  it('still says WHY, rather than refusing silently', async () => {
    seed({ account: null });

    const result = await getProviderActivation('ghost');

    // The property the legacy discovery route exists to provide: a refused
    // caller can find out what refused them.
    expect(result.nextStep.code).toBe('ROLE_NOT_PERMITTED');
    expect(result.nextStep.route).toBeTruthy();
    expect(result.nextStep.blocking).toBe(true);
    expect(result.access.canOpenSupportCase).toBe(true);
  });

  it('denies a non-provider role without inventing a compliance verdict for them', async () => {
    seed({ account: { ...PROVIDER, role: 3 } });

    const result = await getProviderActivation('customer-1');

    expect(result.nextStep.code).toBe('ROLE_NOT_PERMITTED');
    expect(result.compliance).toBeNull();
    expect(result.documentSummary).toBeNull();
    expect(result.access.canAcceptJobs).toBe(false);
    expect(result.access.canBrowseJobs).toBe(false);
    expect(result.access.canViewEarnings).toBe(false);
  });

  it('loads nothing at all for a denied account', async () => {
    seed({ account: null });
    await getProviderActivation('ghost');

    // A denial that still queried documents would be paying for data it must
    // not use, and would be one refactor away from returning it.
    expect(counts.documents ?? 0).toBe(0);
    expect(counts.certifications ?? 0).toBe(0);
    expect(counts.providerCred ?? 0).toBe(0);
  });
});

describe('one load per concern', () => {
  it('loads the documents and certifications exactly once for a full projection', async () => {
    seed({ account: PROVIDER, documents: [documentRow()], onboardingStatus: 'approved' });

    await getProviderActivation('prov-1');

    // Before the split, the state machine called calculateCompliance and the
    // projection called it again — six queries to answer three questions, and
    // two answers able to disagree between them.
    expect(counts.documents).toBe(1);
    expect(counts.certifications).toBe(1);
    expect(counts.providerCred).toBe(1);
  });

  it('summarises the SAME array the compliance verdict was computed from', async () => {
    const documents = [
      documentRow({ id: 1, requirement_type: DOCUMENT_TYPE_CATALOG[0].id }),
      documentRow({ id: 2, requirement_type: 'other', review_state: 'rejected', decision: 'rejected' }),
    ];
    seed({ account: PROVIDER, documents });

    const result = await getProviderActivation('prov-1');

    expect(result.documentSummary).toEqual({ total: 2, verified: 1, actionRequired: 1 });
    // The verdict reasoned over those same two rows: the first required type is
    // verified, so it must NOT appear as an outstanding requirement.
    const outstanding = (result.compliance as any).blockingRequirements
      .filter((b: any) => b.documentTypeId === DOCUMENT_TYPE_CATALOG[0].id);
    expect(outstanding).toHaveLength(0);
  });
});

describe('availableActions is derived, not mapped', () => {
  it('renders a capability key as an action code', () => {
    expect(actionCodeFor('canViewDashboard')).toBe('VIEW_DASHBOARD');
    expect(actionCodeFor('canGoOnline')).toBe('GO_ONLINE');
    expect(actionCodeFor('canRequestWithdrawal')).toBe('REQUEST_WITHDRAWAL');
  });

  it('includes every true capability and no false one', () => {
    const access: any = { canViewDashboard: true, canAcceptJobs: false, canGoOffline: true };
    expect(availableActionsFor(access)).toEqual(['GO_OFFLINE', 'VIEW_DASHBOARD']);
  });

  it('grows when the capability object grows — the property a hand-written map lacks', () => {
    const access: any = { canViewDashboard: true, canRequestPayoutMethod: true };
    // No edit to the projection was needed for this to appear.
    expect(availableActionsFor(access)).toContain('REQUEST_PAYOUT_METHOD');
  });

  it('agrees with `access` on a real projection, in both directions', async () => {
    seed({ account: PROVIDER, documents: [documentRow()], onboardingStatus: 'approved', activation: 'ACTIVE' });

    const result = await getProviderActivation('prov-1');

    for (const [capability, granted] of Object.entries(result.access)) {
      const code = actionCodeFor(capability);
      expect(result.availableActions.includes(code)).toBe(granted === true);
    }
  });

  it('is sorted, so a captured-response diff does not churn', async () => {
    seed({ account: PROVIDER, documents: [documentRow()], onboardingStatus: 'approved' });

    const result = await getProviderActivation('prov-1');

    expect(result.availableActions).toEqual([...result.availableActions].sort());
  });
});

describe('the projection discloses state, never content', () => {
  it('carries no storage path, no URL and no raw identifier anywhere in the response', async () => {
    seed({
      account: PROVIDER,
      documents: [documentRow({ identifier_mask: '****9999' })],
      onboardingStatus: 'approved',
    });

    const serialized = JSON.stringify(await getProviderActivation('prov-1'));

    expect(serialized).not.toMatch(/storage_path|storagePath/);
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(serialized).not.toMatch(/signedUrl|downloadUrl/);
  });

  it('names no other account: the uid it answers for is the uid it was asked for', async () => {
    seed({ account: PROVIDER, documents: [], onboardingStatus: 'approved' });

    const result = await getProviderActivation('prov-1');

    expect(result.uid).toBe('prov-1');
  });
});

describe('the two document counts have two sources, and that is recorded not hidden', () => {
  it('pins the divergence: `documents` is row-driven, `documentSummary` is catalog-driven', async () => {
    // `state.documents.approved` comes from calculateReadiness' summary;
    // `documentSummary.verified` counts listDocuments' catalog-driven states.
    // They are DIFFERENT sources and can disagree — a pre-existing condition
    // this projection surfaces rather than creates. Reconciling them is a
    // question about which legacy route owns the answer, which is TAB 04.
    //
    // Pinned here so the disagreement is a documented fact rather than a
    // surprise found in production, and so a future reconciliation has to
    // delete this test deliberately instead of drifting past it.
    seed({
      account: PROVIDER,
      documents: [documentRow({ id: 1, requirement_type: DOCUMENT_TYPE_CATALOG[0].id })],
    });

    const result = await getProviderActivation('prov-1');

    expect(result.documentSummary!.verified).toBe(1);   // catalog-driven
    expect(result.documents.approved).toBe(0);          // readiness-driven, seeded empty
  });
});
