/**
 * TAB 08 — three things called "support cases", and the review write surface.
 *
 * ## The trap this suite exists to hold shut
 *
 * The Master Command warns that a shared noun must not drive a migration, and
 * names two near-misses a client's own classifier already made:
 * `support/cases/{id}/messages` matched onto `/v1/conversations/{id}/messages`
 * on the word "messages", and `reputation/summary` matched onto
 * `/v1/provider/earnings/summary` on "summary". Both were rejected as false.
 *
 * Measuring this backend found a THIRD of the same shape, and it is the most
 * dangerous because both sides are already canonical:
 *
 *   - `POST /api/v1/bookings/{id}/support-cases` — the CUSTOMER's post-service
 *     complaint about a booking. `services/reviews/postServiceSupportService`.
 *   - `POST /api/v1/provider/support/cases` — the PROVIDER's case with Servana.
 *     `services/providerSupportCaseService`. Not bound to a booking at all.
 *
 * Filing the second into the first would put a provider's complaint about their
 * payout inside a customer's complaint about a job, under a `bookingId` the
 * provider may not have.
 *
 * It even showed up at the SCHEMA level: `SupportCase` and `SupportCaseList`
 * already existed for the customer resource, so the provider schemas had to be
 * named apart. That collision is asserted below, because it is the clearest
 * evidence that the two are different things wearing one name.
 */

jest.mock('../src/services/providerSupportCaseService', () => ({
  __esModule: true,
  listCategories: jest.fn(), listCases: jest.fn(), getCase: jest.fn(), createCase: jest.fn(),
  addProviderMessage: jest.fn(), withdrawCase: jest.fn(), reopenCase: jest.fn(),
  appealCase: jest.fn(), uploadAttachment: jest.fn(), previewAttachment: jest.fn(),
}));
jest.mock('../src/services/providerReputationService', () => ({
  __esModule: true,
  getProviderReputationSummary: jest.fn(), listOwnedProviderReviews: jest.fn(),
  getOwnedProviderReview: jest.fn(), submitProviderResponse: jest.fn(),
  reportOwnedReview: jest.fn(), appealOwnedReview: jest.fn(),
}));

import { handlers } from '../src/api/v1/domains/providerSupport';
import * as support from '../src/services/providerSupportCaseService';
import * as reputation from '../src/services/providerReputationService';
import { V1_CONTRACT } from '../src/api/v1/contract';
import { SCHEMAS } from '../src/api/v1/openapi';
import { capabilityRegistry } from '../src/api/v1/convergence';

const getCase = support.getCase as jest.Mock;
const addMessage = support.addProviderMessage as jest.Mock;
const respond = reputation.submitProviderResponse as jest.Mock;

const capture = () => {
  const sent: any = { status: 200, body: undefined, headers: {} };
  const res: any = {
    status(c: number) { sent.status = c; return res; },
    json(b: any) { sent.body = b; return res; },
    set(n: string, v: string) { sent.headers[n] = v; return res; },
    setHeader(n: string, v: string) { sent.headers[n] = v; return res; },
    getHeader(n: string) { return sent.headers[n]; },
    headersSent: false,
  };
  return { res, sent };
};

const reqFor = (params: Record<string, string> = {}, body: Record<string, unknown> = {}) => ({
  user: { uid: 'prov-1' }, params, query: {}, body, headers: {}, get: () => undefined,
}) as any;

const entry = (id: string) => V1_CONTRACT.find((e) => e.id === id)!;
const PROVIDER_SUPPORT = V1_CONTRACT.filter((e) => e.domain === 'provider-support');

beforeEach(() => jest.clearAllMocks());

describe('a provider support case is not a customer support case', () => {
  it('the two are separate contract entries backed by separate services', () => {
    const providerCase = entry('provider.support.cases.create');
    const customerCase = V1_CONTRACT.find((e) => e.id === 'bookings.supportCases.create')!;

    expect(providerCase.domainService).toMatch(/providerSupportCaseService/);
    expect(customerCase.domainService).toMatch(/postServiceSupportService/);
    expect(providerCase.domainService).not.toBe(customerCase.domainService);
  });

  it('the provider case is NOT bound to a booking', () => {
    const providerCase = entry('provider.support.cases.create');
    const customerCase = V1_CONTRACT.find((e) => e.id === 'bookings.supportCases.create')!;

    // A provider raising a case about their account, a payout or a policy has
    // no booking to attach it to. Requiring one would make the commonest case
    // unreportable.
    expect(providerCase.path).not.toContain('bookingId');
    expect(customerCase.path).toContain('bookingId');
  });

  it('their response schemas are DIFFERENT objects, not one shared name', () => {
    // The collision was real: SupportCase already existed for the customer
    // resource, so the provider schema had to be named apart. That is the
    // clearest evidence the two are different things wearing one noun.
    expect(SCHEMAS.SupportCase).toBeDefined();
    expect(SCHEMAS.ProviderSupportCase).toBeDefined();
    expect(SCHEMAS.SupportCase).not.toBe(SCHEMAS.ProviderSupportCase);
    expect(entry('provider.support.cases.create').responseSchema).toBe('ProviderSupportCase');
  });

  it('no provider support operation is served by a conversation route', () => {
    // The acceptance criterion, asserted rather than asserted-in-prose.
    for (const e of PROVIDER_SUPPORT) {
      expect(e.path).not.toMatch(/conversations/);
      expect(e.domainService).not.toMatch(/messagingService|conversation/i);
    }
  });

  it('the case thread reaches the SUPPORT service, never the messaging one', async () => {
    addMessage.mockResolvedValue({ messageId: 'm-1' });
    const { res } = capture();
    await handlers['provider.support.cases.reply'](
      reqFor({ caseId: 'case-1' }, { body: 'Any update?', clientRequestId: 'client-request-id-01' }),
      res,
    );
    expect(addMessage).toHaveBeenCalledWith('prov-1', 'case-1', expect.objectContaining({ body: 'Any update?' }));
  });

  it('the capability records WHY the separation exists, so it survives a tidy-up', () => {
    const cap = capabilityRegistry().find((c) => c.key.endsWith(':providerSupportCases'))!;
    expect(cap).toBeDefined();
    expect(cap.domainModule).toMatch(/providerSupportCaseService/);
    // A boundary explained only in a test is one somebody deletes to make the
    // test pass. The reason travels with the declaration.
    expect(cap.roleSplitRationale).toMatch(/conversation/i);
  });
});

describe('reputation summary is not an earnings summary', () => {
  it('they are different entries with different services', () => {
    const reputationSummary = entry('provider.reputation.summary');
    const earnings = V1_CONTRACT.find((e) => e.path === '/provider/earnings/summary');

    expect(reputationSummary.domainService).toMatch(/providerReputationService/);
    if (earnings) {
      // One is a rating aggregate, the other is money. They share a noun and
      // nothing else — a client classifier already matched them and was wrong.
      expect(earnings.domainService).not.toMatch(/providerReputationService/);
      expect(reputationSummary.path).not.toBe(earnings.path);
    }
  });
});

describe('the review WRITE surface v1 was missing', () => {
  it('a provider can now respond, report and appeal canonically', () => {
    for (const id of ['provider.reviews.respond', 'provider.reviews.report', 'provider.reviews.appeal']) {
      expect(entry(id).status).toBe('implemented');
      expect(entry(id).method).toBe('post');
    }
  });

  it('the response delegates, so the moderation pass applies on day one', async () => {
    respond.mockResolvedValue({ responseId: 'r-1', state: 'pending_moderation' });
    const { res, sent } = capture();
    await handlers['provider.reviews.respond'](
      reqFor({ reviewId: 'rev-1' }, { body: 'Thanks for the feedback.', clientRequestId: 'client-request-id-01' }),
      res,
    );

    // A response is PUBLIC-FACING TEXT. Reimplementing the write here would
    // have shipped a canonical route without the moderation the legacy one has.
    expect(respond).toHaveBeenCalledWith('prov-1', 'rev-1', expect.objectContaining({ body: 'Thanks for the feedback.' }));
    expect(sent.status).toBe(201);
    expect(entry('provider.reviews.respond').domainService).toMatch(/submitProviderResponse/);
  });

  it('EDIT and WITHDRAW are documented as absent, with the reason', () => {
    // The mandate asks whether a response can be edited or withdrawn. It cannot,
    // and saying so is the deliverable — a client team plans for one shot rather
    // than discovering it.
    const ids = V1_CONTRACT.map((e) => e.id);
    expect(ids).not.toContain('provider.reviews.response.update');
    expect(ids).not.toContain('provider.reviews.response.delete');
    expect(entry('provider.reviews.respond').notes).toMatch(/EDIT AND WITHDRAW/);
    expect(SCHEMAS.ProviderReviewResponse).toBeDefined();
    expect((SCHEMAS.ProviderReviewResponse as any).description).toMatch(/no edit and no withdraw/i);
  });

  it('the appeal is keyed on the moderation CASE, not the review', () => {
    const appeal = entry('provider.reviews.appeal');
    // The thing appealed is a DECISION, and one review can carry more than one
    // over time. Keying on the review would make the second appeal ambiguous.
    expect(appeal.path).toContain(':caseId');
    expect(appeal.path).not.toContain(':reviewId');
  });

  it('every write in this domain declares a replay mechanism', () => {
    const writes = PROVIDER_SUPPORT.filter((e) => !e.idempotent);
    expect(writes.length).toBeGreaterThanOrEqual(8);
    for (const w of writes) {
      expect(Array.isArray(w.replayMechanism)).toBe(true);
      expect(w.replayMechanism!.length).toBeGreaterThan(0);
    }
  });
});

describe('every resource id is a resource, never an identity', () => {
  it('a malformed caseId is NOT_FOUND and never reaches the query', async () => {
    const { res, sent } = capture();
    await handlers['provider.support.cases.get'](reqFor({ caseId: "' OR 1=1--" }), res);

    expect(sent.status).toBe(404);
    expect(getCase).not.toHaveBeenCalled();
  });

  it('the caller uid travels with every case read, so scoping happens in SQL', async () => {
    getCase.mockResolvedValue({ caseId: 'case-1' });
    const { res } = capture();
    await handlers['provider.support.cases.get'](reqFor({ caseId: 'case-1' }), res);
    expect(getCase).toHaveBeenCalledWith('prov-1', 'case-1');
  });

  it('no route in this domain accepts a provider uid as a parameter', () => {
    for (const e of PROVIDER_SUPPORT) {
      expect(e.path).not.toMatch(/:providerUid|:workerId|:uid/);
    }
  });
});
