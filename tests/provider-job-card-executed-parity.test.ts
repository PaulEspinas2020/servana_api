/**
 * TAB 02 — the v1 job card and the legacy job card are the SAME card, EXECUTED.
 *
 * ## Why this exists beside `provider-job-response-contract.test.ts`
 *
 * That suite proves the sharing by reading the three controllers' SOURCE and
 * asserting the text returns `formatJobCard(...)` unmodified. That is a good
 * check and it is not this one. Source text is not behaviour: a wrapper added
 * around the call, a field deleted from the envelope on the way out, or a
 * response post-processed by middleware would all leave the asserted substring
 * exactly where it is. Its own docblock draws the right distinction — "they all
 * import it" and "they all return what it produced" are different claims — and
 * then establishes the second one by reading imports.
 *
 * So this suite RUNS them. One seeded row, both handlers invoked, the two
 * emitted payloads compared. A difference here is a real difference on the wire.
 *
 * ## Why TAB 02 needed measuring rather than implementing
 *
 * The Master Command records `/api/worker/job-cards` and its single-card sibling
 * as having "no canonical successor", and asks for a v1 job-card projection
 * carrying `canonicalState` and `availableActions`.
 *
 * Measured at this HEAD, all of that already exists: `provider.jobs.list` and
 * `provider.jobs.get` are mounted, both delegate to the SAME
 * `technicianService` query and the SAME `formatJobCard`, both legacy paths are
 * declared `ALIAS_TEMPORARILY` against them, the generated migration matrix
 * names the successors, and the provider mobile client's own manifest cites the
 * Dart file and line where it calls them.
 *
 * What was missing was not the projection. It was an executed proof that the two
 * surfaces cannot drift, which is what the acceptance criterion actually needs.
 */

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

import dbQuery from '../src/db/dbQuery';
import { handlers as providerJobHandlers } from '../src/api/v1/domains/providerJobs';
import {
  getWorkerJobCards,
  getWorkerJobCard,
} from '../src/controllers/providerController';

const q = dbQuery.query as jest.Mock;

/**
 * One booking row, in the shape `getJobCardsByWorker` returns.
 *
 * ACCEPTED, so disclosure is FULL — the tier where the card carries the most,
 * and therefore the tier at which a divergence between two surfaces would do
 * the most damage.
 */
const ROW = {
  booking_id: 4242,
  worker_uid: 'prov-1',
  status: 'ACCEPTED',
  schedule: '2026-09-01T02:00:00.000Z',
  has_escalation: false,
  payment_method: 'cash',
  payment_status: 'pending',
  customer_id: 'cust-9',
  first_name: 'Maria',
  last_name: 'Santos',
  phone_number: '+639170001234',
  address_one: '12 Rizal St',
  address_two: 'Unit 4',
  post_town: 'Makati',
  zip_code: '1200',
  country: 'PH',
  label: 'Home',
  delivery_instructions: 'Ring twice',
  location_id: 'loc_14.554700_121.024500',
  service_address_lat: 14.5547,
  service_address_lon: 121.0245,
  service_name: 'Electrical Repair',
  service_type: 'repair',
  pricing_breakdown: [{ name: 'Callout', amount: 500 }],
  worker_status: 'ACCEPTED',
  assigned_at: '2026-08-20T01:00:00.000Z',
  started_at: null,
  completed_at: null,
};

const seedRows = (rows: any[]) => {
  q.mockReset();
  q.mockResolvedValue({ rows, rowCount: rows.length });
};

/** A minimal Express double that records what a handler sent. */
const capture = () => {
  const sent: any = { status: 200, body: undefined, headers: {} };
  const res: any = {
    status(code: number) { sent.status = code; return res; },
    json(body: any) { sent.body = body; return res; },
    set(name: string, value: string) { sent.headers[name] = value; return res; },
    setHeader(name: string, value: string) { sent.headers[name] = value; return res; },
    getHeader(name: string) { return sent.headers[name]; },
    headersSent: false,
  };
  return { res, sent };
};

const reqFor = (params: Record<string, string> = {}) => ({
  user: { uid: 'prov-1' },
  params,
  query: {},
  body: {},
  headers: {},
  get: () => undefined,
}) as any;

describe('the list: v1 and legacy emit the identical card', () => {
  it('returns byte-identical cards from both surfaces', async () => {
    seedRows([ROW]);
    const legacy = capture();
    await getWorkerJobCards(reqFor(), legacy.res);

    seedRows([ROW]);
    const v1 = capture();
    await providerJobHandlers['provider.jobs.list'](reqFor(), v1.res);

    const legacyCards = legacy.sent.body;
    const v1Cards = v1.sent.body?.data?.jobs;

    expect(Array.isArray(legacyCards)).toBe(true);
    expect(Array.isArray(v1Cards)).toBe(true);
    expect(v1Cards).toHaveLength(1);
    // The ENVELOPE differs by design — a bare array versus { data: { jobs } }.
    // The CARD must not.
    expect(JSON.stringify(v1Cards[0])).toBe(JSON.stringify(legacyCards[0]));
  });

  it('carries canonicalState and availableActions on the executed v1 response', async () => {
    seedRows([ROW]);
    const v1 = capture();
    await providerJobHandlers['provider.jobs.list'](reqFor(), v1.res);

    const card = v1.sent.body.data.jobs[0];
    // The TAB 02 acceptance criterion, asserted against what the handler
    // actually sent rather than against the schema that describes it.
    expect(card.canonicalState).toBe('ACCEPTED');
    expect(Array.isArray(card.availableActions)).toBe(true);
    expect(card.availableActions.length).toBeGreaterThan(0);
  });

  it('still carries the deprecated pair the shipped clients read', async () => {
    seedRows([ROW]);
    const v1 = capture();
    await providerJobHandlers['provider.jobs.list'](reqFor(), v1.res);

    const card = v1.sent.body.data.jobs[0];
    // Additive, not replacing. Removing these breaks live apps.
    expect(card.status).toBe('ACCEPTED');
    expect(card.workerStatus).toBe('ACCEPTED');
  });

  it('publishes the page meta a client needs to detect truncation', async () => {
    seedRows([ROW]);
    const v1 = capture();
    await providerJobHandlers['provider.jobs.list'](reqFor(), v1.res);

    // The one behavioural difference from legacy: legacy returns every readable
    // card uncapped, v1 windows at 50 by default. `total` is what lets a client
    // tell a complete list from a first page — without it, a provider with more
    // than fifty jobs would silently lose the furthest-future ones, because the
    // query orders by schedule ASC.
    expect(v1.sent.body.meta?.page).toBeDefined();
    expect(v1.sent.body.meta.page.total).toBe(1);
  });
});

describe('the single card: v1 and legacy emit the identical card', () => {
  it('returns byte-identical cards from both surfaces', async () => {
    seedRows([ROW]);
    const legacy = capture();
    await getWorkerJobCard(reqFor({ bookingId: '4242' }), legacy.res);

    seedRows([ROW]);
    const v1 = capture();
    await providerJobHandlers['provider.jobs.get'](reqFor({ bookingId: '4242' }), v1.res);

    expect(JSON.stringify(v1.sent.body.data)).toBe(JSON.stringify(legacy.sent.body));
  });

  it('is NOT redundant with the list: it answers 404 for a booking the list omits', async () => {
    // Mandate 4 asked whether the single-card route is still needed once the
    // list carries the projection. It is: the list is windowed, so "not on the
    // page I fetched" and "not mine" are indistinguishable from the list alone.
    // This route answers that question directly, and scopes by uid in SQL.
    seedRows([]);
    const v1 = capture();
    await providerJobHandlers['provider.jobs.get'](reqFor({ bookingId: '999999' }), v1.res);

    expect(v1.sent.status).toBe(404);
  });

  it('refuses a non-numeric bookingId rather than passing it to the query', async () => {
    seedRows([ROW]);
    const v1 = capture();
    await providerJobHandlers['provider.jobs.get'](reqFor({ bookingId: 'abc' }), v1.res);

    expect(v1.sent.status).toBe(400);
    expect(q).not.toHaveBeenCalled();
  });
});

describe('the identity a card is scoped to comes from the token', () => {
  it('takes the provider uid from the token, never from a parameter', async () => {
    seedRows([ROW]);
    const v1 = capture();
    // A path parameter naming another provider must not reach the query as the
    // scope. This is the BOLA shape v1 exists to remove.
    await providerJobHandlers['provider.jobs.list'](
      { ...reqFor({ workerId: 'someone-else' }), params: { workerId: 'someone-else' } } as any,
      v1.res,
    );

    const params = q.mock.calls[0][1];
    expect(params[0]).toBe('prov-1');
    expect(JSON.stringify(params)).not.toContain('someone-else');
  });
});
