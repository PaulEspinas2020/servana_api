/**
 * TAB 07 — proof and money.
 *
 * The job lifecycle was already fully canonical except for the parts that carry
 * PROOF and MONEY. These assert the guarantees that had to be true before those
 * parts could be published.
 *
 * ## The defect this TAB found
 *
 * `attachEvidence` was a plain INSERT with no idempotency key of any kind. A
 * provider on a doorstep whose upload committed and then timed out retried, and
 * the retry filed a SECOND piece of evidence against the same requirement.
 *
 * `requirement.maxCount` bounded the damage without avoiding it: the duplicate
 * either consumed a slot the provider still needed, or — where maxCount is 1 —
 * the retry was refused with TOO_MANY_FILES, which reads as "your upload failed"
 * for an upload that succeeded. Evidence is what a dispute is decided on, so
 * both outcomes are wrong.
 *
 * Migration 043 adds the replay key and a partial unique index; the canonical
 * route REQUIRES the key, and the legacy route accepts one optionally so five
 * shipped clients keep working unchanged.
 */

jest.mock('../src/services/bookingEvidenceService', () => {
  const actual = jest.requireActual('../src/services/bookingEvidenceService');
  return { ...actual, submitEvidence: jest.fn(), listEvidence: jest.fn(), removeEvidence: jest.fn() };
});
jest.mock('../src/services/paymentService', () => ({ __esModule: true, markCashPaid: jest.fn() }));
jest.mock('../src/services/booking/providerBookingOwnership', () => ({
  __esModule: true,
  assertOwnBooking: jest.fn(),
  loadCancellationContext: jest.fn(),
}));
jest.mock('../src/services/bookingAccessService', () => {
  class BookingAccessError extends Error {
    constructor(message: string, readonly statusCode: number, readonly code: string) { super(message); }
  }
  return { BookingAccessError, assertBookingAccess: jest.fn() };
});

import { handlers } from '../src/api/v1/domains/providerEvidence';
import * as evidenceService from '../src/services/bookingEvidenceService';
import * as paymentService from '../src/services/paymentService';
import * as ownership from '../src/services/booking/providerBookingOwnership';
import { assertBookingAccess } from '../src/services/bookingAccessService';
import { V1_CONTRACT } from '../src/api/v1/contract';

const submitEvidence = evidenceService.submitEvidence as jest.Mock;
const removeEvidence = evidenceService.removeEvidence as jest.Mock;
const assertOwn = ownership.assertOwnBooking as jest.Mock;
const cancelCtx = ownership.loadCancellationContext as jest.Mock;
const markCashPaid = paymentService.markCashPaid as jest.Mock;
const bookingAccess = assertBookingAccess as jest.Mock;

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

const reqFor = (params: Record<string, string>, body: Record<string, unknown> = {}) => ({
  user: { uid: 'prov-1' }, params, query: {}, body, headers: {}, get: () => undefined,
}) as any;

const KEY = 'client-request-id-000001';
const entry = (id: string) => V1_CONTRACT.find((e) => e.id === id)!;
const EVIDENCE = {
  id: '7', requirementCode: 'BEFORE_PHOTO', stage: 'BEFORE_SERVICE', state: 'UPLOADED',
  mimeType: 'image/png', bytes: 3, createdAt: '2026-08-21T00:00:00.000Z', reviewNote: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  assertOwn.mockResolvedValue('ACCEPTED');
});

describe('a retried evidence upload returns the original, not a second photo', () => {
  it('answers 200 with replayed:true rather than filing again', async () => {
    submitEvidence.mockResolvedValue({ ...EVIDENCE, replayed: true });
    const { res, sent } = capture();
    await handlers['provider.jobs.evidence.create'](
      reqFor({ bookingId: '4242' }, { requirementCode: 'BEFORE_PHOTO', file: 'data:image/png;base64,AAAA', clientRequestId: KEY }),
      res,
    );

    expect(sent.status).toBe(200);
    expect(sent.body.data.replayed).toBe(true);
    expect(sent.body.data.id).toBe('7');
    expect(sent.body.error).toBeUndefined();
  });

  it('answers 201 for a first upload, so a client can still tell them apart', async () => {
    submitEvidence.mockResolvedValue({ ...EVIDENCE, replayed: false });
    const { res, sent } = capture();
    await handlers['provider.jobs.evidence.create'](
      reqFor({ bookingId: '4242' }, { requirementCode: 'BEFORE_PHOTO', file: 'data:image/png;base64,AAAA', clientRequestId: KEY }),
      res,
    );
    expect(sent.status).toBe(201);
    expect(sent.body.data.replayed).toBe(false);
  });

  it('REQUIRES the replay key, and refuses before touching storage', async () => {
    const { res, sent } = capture();
    await handlers['provider.jobs.evidence.create'](
      reqFor({ bookingId: '4242' }, { requirementCode: 'BEFORE_PHOTO', file: 'data:image/png;base64,AAAA' }),
      res,
    );

    expect(sent.status).toBe(400);
    // A write that cannot be retried safely is not one to publish canonically,
    // and the refusal must land before an upload is attempted.
    expect(submitEvidence).not.toHaveBeenCalled();
  });

  it('always states approved:false — attached is not accepted', async () => {
    submitEvidence.mockResolvedValue({ ...EVIDENCE, replayed: false });
    const { res, sent } = capture();
    await handlers['provider.jobs.evidence.create'](
      reqFor({ bookingId: '4242' }, { requirementCode: 'BEFORE_PHOTO', file: 'data:image/png;base64,AAAA', clientRequestId: KEY }),
      res,
    );
    // §19 — a client must not read a 201 as a review decision.
    expect(sent.body.data.approved).toBe(false);
  });

  it('declares client-request-id AND unique-constraint', () => {
    expect(entry('provider.jobs.evidence.create').replayMechanism)
      .toEqual(['client-request-id', 'unique-constraint']);
  });

  it('a booking that is not the caller\'s is a 404, not a 403', async () => {
    assertOwn.mockResolvedValue(null);
    const { res, sent } = capture();
    await handlers['provider.jobs.evidence.list'](reqFor({ bookingId: '9999' }), res);

    // 403 would confirm the booking exists. 404 does not distinguish "not
    // yours" from "not there", which is the point.
    expect(sent.status).toBe(404);
  });
});

describe('the replay key is scoped so it cannot drop another provider\'s evidence', () => {
  it('the migration scopes the unique index by worker as well as booking', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const sql = fs.readFileSync('scripts/migrations/043-booking-evidence-client-request-id.sql', 'utf8');
    // (booking_id, client_request_id) alone would let one provider's key collide
    // with another's on a reassigned booking — and a collision here does not
    // deduplicate, it DROPS the second provider's evidence.
    expect(sql).toMatch(/\(booking_id,\s*worker_uid,\s*client_request_id\)/);
    // Partial, so legacy rows carrying no key are not retroactively governed.
    expect(sql).toMatch(/WHERE client_request_id IS NOT NULL/);
  });

  it('the migration is additive: a nullable column the previous build ignores', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const sql = fs.readFileSync('scripts/migrations/043-booking-evidence-client-request-id.sql', 'utf8');
    // The COLUMN definition specifically — a bare /NOT NULL/ over the whole file
    // matches the partial index's own `WHERE client_request_id IS NOT NULL`
    // predicate, which is a different statement about a different thing.
    const alter = /ALTER TABLE servana\.booking_evidence\s+ADD COLUMN IF NOT EXISTS client_request_id TEXT;/;
    expect(sql).toMatch(alter);
    expect(sql.match(alter)![0]).not.toMatch(/NOT NULL/);
    // Nothing is dropped or rewritten, so a rollback to the previous dist needs
    // no database change.
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|ALTER COLUMN|UPDATE /);
  });
});

describe('cash collection: authorized per booking, and refuses the customer', () => {
  it('refuses a CUSTOMER settling their own cash payment', async () => {
    bookingAccess.mockResolvedValue('customer');
    const { res, sent } = capture();
    await handlers['bookings.payments.cashCollected'](reqFor({ bookingId: '4242' }), res);

    // A customer declaring their own cash payment is not evidence of anything.
    expect(sent.status).toBe(403);
    expect(sent.body.error.code).toBe('BOOKING_ACCESS_DENIED');
    expect(markCashPaid).not.toHaveBeenCalled();
  });

  it('admits the assigned PROVIDER', async () => {
    bookingAccess.mockResolvedValue('provider');
    markCashPaid.mockResolvedValue({ status: 'PAID', method: 'CASH', paid_at: '2026-08-21T00:00:00.000Z' });
    const { res, sent } = capture();
    await handlers['bookings.payments.cashCollected'](reqFor({ bookingId: '4242' }), res);

    expect(sent.status).toBe(200);
    expect(sent.body.data.status).toBe('PAID');
  });

  it('admits ADMIN, because support-assisted recovery needs this path', async () => {
    bookingAccess.mockResolvedValue('admin');
    markCashPaid.mockResolvedValue({ status: 'PAID', method: 'CASH', paid_at: null });
    const { res, sent } = capture();
    await handlers['bookings.payments.cashCollected'](reqFor({ bookingId: '4242' }), res);

    // Declaring auth: 'provider' would have looked stricter and locked admin out.
    expect(sent.status).toBe(200);
  });

  it('is declared idempotent, because COALESCE(paid_at, NOW()) makes it so', () => {
    const e = entry('bookings.payments.cashCollected');
    expect(e.idempotent).toBe(true);
    expect(e.replayMechanism).toBeUndefined();
  });

  it('sits with its payment siblings rather than directly under /api', () => {
    // The legacy path is /api/:bookingId/mark-cash-paid — directly under /api,
    // where a wildcard added at that level would shadow it.
    expect(entry('bookings.payments.cashCollected').path).toBe('/bookings/:bookingId/cash-collected');
  });
});

describe('cancellation eligibility explains a refusal instead of bare-erroring', () => {
  it('uses the SAME policy function the transition calls', async () => {
    cancelCtx.mockResolvedValue({ worker_status: 'ACCEPTED', schedule: '2026-09-01T02:00:00.000Z' });
    const { res, sent } = capture();
    await handlers['provider.jobs.cancellationEligibility'](reqFor({ bookingId: '4242' }), res);

    expect(sent.status).toBe(200);
    expect(sent.body.data.bookingId).toBe(4242);
    // evaluateCancellation is what the cancel transition consults, so the button
    // and the POST behind it cannot disagree about the window.
    expect(entry('provider.jobs.cancellationEligibility').domainService)
      .toMatch(/evaluateCancellation/);
  });

  it('404s a booking that is not the caller\'s without saying which', async () => {
    cancelCtx.mockResolvedValue(null);
    const { res, sent } = capture();
    await handlers['provider.jobs.cancellationEligibility'](reqFor({ bookingId: '9999' }), res);
    expect(sent.status).toBe(404);
  });

  it('refuses a non-numeric bookingId before any query', async () => {
    const { res, sent } = capture();
    await handlers['provider.jobs.cancellationEligibility'](reqFor({ bookingId: 'abc' }), res);
    expect(sent.status).toBe(400);
    expect(cancelCtx).not.toHaveBeenCalled();
  });
});

describe('evidence removal is soft and scoped', () => {
  it('reports NOT_FOUND when nothing was removed, rather than claiming success', async () => {
    removeEvidence.mockResolvedValue(false);
    const { res, sent } = capture();
    await handlers['provider.jobs.evidence.delete'](reqFor({ bookingId: '4242', evidenceId: '7' }), res);
    expect(sent.status).toBe(404);
  });

  it('passes the caller uid so the scope is in the UPDATE itself', async () => {
    removeEvidence.mockResolvedValue(true);
    const { res } = capture();
    await handlers['provider.jobs.evidence.delete'](reqFor({ bookingId: '4242', evidenceId: '7' }), res);
    expect(removeEvidence).toHaveBeenCalledWith(4242, 'prov-1', 7);
  });
});
