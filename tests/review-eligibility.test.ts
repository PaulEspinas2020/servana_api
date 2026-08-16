/**
 * Review eligibility, duplicate prevention, and the Catalog V2 correction.
 *
 * ## What this suite is for
 *
 * Three release gates:
 *
 *   - "Review always references an eligible booking"
 *   - "One booking cannot create duplicate active reviews"
 *   - "Provider rating summary is backend-derived"
 *
 * The eligibility DECISION is now a pure function, so the first is checkable by
 * calling it rather than by driving six tables from migration 012. The duplicate
 * rule and the provider-from-assignment rule are properties of the WRITE PATH, so
 * they are asserted structurally against the real source — the guards are an
 * advisory lock and a transactional check, and a fake faithful enough to prove
 * them would be a reimplementation of Postgres.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));

import fs from 'fs';
import path from 'path';
import {
  CANONICAL_DIMENSIONS,
  CANONICAL_SERVICE_RESOLUTION,
  DIMENSION_KEYS,
  EDIT_WINDOW_HOURS,
  ELIGIBILITY_REFUSALS,
  ELIGIBILITY_REFUSAL_CODES,
  MIN_DIMENSION_SAMPLE,
  MODERATION_STATES,
  MODERATION_STATE_NAMES,
  RATING_BOUNDS,
  REVIEW_EVENTS,
  REVIEW_WINDOW_DAYS,
  countsTowardRating,
  evaluateEligibility,
  publiclyVisible,
} from '../src/services/reviews/reviewPolicy';

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const COMPLETED_AT = '2026-08-01T00:00:00.000Z';
const eligible = {
  isOwner: true,
  isActiveCustomer: true,
  hasCompletedProvider: true,
  bookingCompleted: true,
  completedAt: COMPLETED_AT,
  hasExistingReview: false,
  now: '2026-08-02T00:00:00.000Z',
};

// ─── Eligibility ──────────────────────────────────────────────────────────────

describe('a review always references an eligible booking', () => {
  it('accepts a completed booking inside the window', () => {
    const verdict = evaluateEligibility(eligible);
    expect(verdict.eligible).toBe(true);
    expect(verdict.window).toEqual({
      opensAt: COMPLETED_AT,
      closesAt: '2026-08-15T00:00:00.000Z',
    });
  });

  it('refuses a booking that is not the caller\'s', () => {
    const verdict = evaluateEligibility({ ...eligible, isOwner: false });
    expect(verdict.refusal).toBe('BOOKING_NOT_OWNED');
    expect(verdict.status).toBe(403);
  });

  it('checks ownership FIRST, so nothing else leaks about another booking', () => {
    // A caller who could tell "not yours" from "not completed" could probe the
    // state of somebody else's booking. Ownership is the first gate, so every
    // other fact is unreachable without it.
    const verdict = evaluateEligibility({
      isOwner: false,
      isActiveCustomer: false,
      hasCompletedProvider: false,
      bookingCompleted: false,
      completedAt: null,
      hasExistingReview: true,
    });
    expect(verdict.refusal).toBe('BOOKING_NOT_OWNED');
    // No window, so not even the completion time is disclosed.
    expect(verdict.window).toBeNull();
  });

  it('refuses when no provider completed the booking', () => {
    // There is nobody to review. §122 in its negative form: the provider comes
    // from the assignment, so no assignment means no review.
    const verdict = evaluateEligibility({ ...eligible, hasCompletedProvider: false });
    expect(verdict.refusal).toBe('NO_ASSIGNED_PROVIDER');
  });

  it('refuses a booking that has not been completed', () => {
    const verdict = evaluateEligibility({ ...eligible, bookingCompleted: false });
    expect(verdict.refusal).toBe('BOOKING_NOT_COMPLETED');
    // NOT terminal: the customer should wait, not give up.
    expect(ELIGIBILITY_REFUSALS.BOOKING_NOT_COMPLETED.terminal).toBe(false);
  });

  it('distinguishes "not finished yet" from "too late"', () => {
    // Opposite situations. A client showing the wrong one tells the customer to
    // give up when they should wait, or to wait for a window that has closed.
    const early = evaluateEligibility({ ...eligible, bookingCompleted: false });
    const late = evaluateEligibility({ ...eligible, now: '2026-09-01T00:00:00.000Z' });

    expect(early.refusal).toBe('BOOKING_NOT_COMPLETED');
    expect(late.refusal).toBe('REVIEW_WINDOW_CLOSED');
    expect(ELIGIBILITY_REFUSALS.REVIEW_WINDOW_CLOSED.terminal).toBe(true);
  });

  it('refuses a completion with no timestamp rather than guessing a window', () => {
    const verdict = evaluateEligibility({ ...eligible, completedAt: null });
    expect(verdict.refusal).toBe('COMPLETION_NOT_FINALIZED');
    expect(verdict.window).toBeNull();
  });

  it('refuses an unparseable completion timestamp the same way', () => {
    const verdict = evaluateEligibility({ ...eligible, completedAt: 'not-a-date' });
    expect(verdict.refusal).toBe('COMPLETION_NOT_FINALIZED');
  });

  it('refuses a second review, and still reports when the window closed', () => {
    const verdict = evaluateEligibility({ ...eligible, hasExistingReview: true });
    expect(verdict.refusal).toBe('REVIEW_ALREADY_EXISTS');
    expect(verdict.status).toBe(409);
    // The window is still reported: a caller who already reviewed should learn
    // when their edit window relates to, not only that they are refused.
    expect(verdict.window).not.toBeNull();
  });

  it('refuses an inactive account', () => {
    const verdict = evaluateEligibility({ ...eligible, isActiveCustomer: false });
    expect(verdict.refusal).toBe('ACCOUNT_NOT_ELIGIBLE');
  });

  it('every declared refusal carries a reason and a status', () => {
    for (const code of ELIGIBILITY_REFUSAL_CODES) {
      const spec = ELIGIBILITY_REFUSALS[code];
      expect(spec.reason.length).toBeGreaterThan(20);
      expect([403, 409, 422]).toContain(spec.status);
    }
  });

  it('the window is exactly the declared number of days', () => {
    const verdict = evaluateEligibility(eligible);
    const opens = new Date(verdict.window!.opensAt).getTime();
    const closes = new Date(verdict.window!.closesAt).getTime();
    expect((closes - opens) / (24 * 60 * 60 * 1000)).toBe(REVIEW_WINDOW_DAYS);
  });
});

// ─── The write path's guarantees ──────────────────────────────────────────────

describe('one booking cannot create duplicate active reviews', () => {
  const source = read('src/services/customerReviewService.ts');

  it('takes an advisory lock keyed on the customer AND the booking', () => {
    // Two devices submitting at once serialise on this. Without it, both pass
    // the existing-review check and both insert.
    expect(source).toMatch(/pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
    expect(source).toMatch(/`review:\$\{customerUid\}:\$\{bookingId\}`/);
  });

  it('checks for an existing review INSIDE the transaction', () => {
    const create = source.slice(source.indexOf('export async function createReview'));
    const beginAt = create.indexOf("client.query('BEGIN')");
    const lockAt = create.indexOf('pg_advisory_xact_lock');
    const checkAt = create.indexOf('getExistingReview');
    const insertAt = create.indexOf('INSERT INTO');

    // The order is what makes it a guard rather than a race: open the
    // transaction, take the lock, THEN read, then write. A check taken before
    // the lock is a check two concurrent submissions both pass.
    expect(beginAt).toBeGreaterThan(0);
    expect(lockAt).toBeGreaterThan(beginAt);
    expect(checkAt).toBeGreaterThan(lockAt);
    expect(insertAt).toBeGreaterThan(checkAt);

    // ...and the check runs on the TRANSACTION's connection, not a fresh one
    // from the pool, which would read outside the lock's scope.
    expect(create).toMatch(/getExistingReview\(bookingId, customerUid, run\)/);

    // Committing after the check is what the write needs; there is an earlier
    // COMMIT in this function, and it is the replay path closing a transaction
    // that wrote nothing.
    expect(create.indexOf("client.query('COMMIT')", checkAt)).toBeGreaterThan(insertAt);
  });

  it('replays a clientRequestId rather than writing a second review', () => {
    expect(source).toMatch(/client_request_id = \$2/);
    expect(source).toMatch(/if \(replay\.rows\.length\)/);
  });

  it('refuses with a distinguishable code when one already exists', () => {
    expect(source).toMatch(/REVIEW_ALREADY_EXISTS/);
    expect(source).toMatch(/REVIEW_DUPLICATE_REQUEST/);
  });
});

describe('the provider comes from the booking, never from the caller', () => {
  const source = read('src/services/customerReviewService.ts');
  const handler = read('src/api/v1/domains/reviews.ts');

  it('resolves the provider from the COMPLETED assignment', () => {
    expect(source).toMatch(/bw\.worker_uid\s+AS provider_uid/);
    expect(source).toMatch(/AND bw\.status = 'COMPLETED'/);
  });

  it('the create payload has NO provider field to accept', () => {
    // §122 holds by construction: there is nothing to validate, because there is
    // nothing to send.
    const payload = source.slice(
      source.indexOf('export interface CreateReviewPayload'),
      source.indexOf('// ─── Helpers'),
    );
    expect(payload).not.toMatch(/providerUid|providerId/);
  });

  it('the v1 handler passes no provider through', () => {
    const create = handler.slice(handler.indexOf("'bookings.review.create'"));
    expect(create).not.toMatch(/providerUid|providerId/);
  });

  it('refuses a booking whose provider is the reviewer themselves', () => {
    expect(source).toMatch(/booking\.provider_uid === customerUid/);
  });
});

// ─── The Catalog V2 correction ────────────────────────────────────────────────

describe('the review service resolves the CANONICAL service id', () => {
  const source = read('src/services/customerReviewService.ts');

  it('uses bookingCanonicalServiceSql, not service_options.service_id', () => {
    /**
     * The defect this fixed. `service_options.service_id` is a foreign key to
     * `service_families` — legacy coarse provenance — while
     * `service_review_dimensions.service_id` REFERENCES `services(id)`, the
     * Catalog V2 canonical identity. Two id spaces, so service-specific
     * dimensions silently never matched.
     */
    expect(source).toMatch(/bookingCanonicalServiceSql\(dbSchema, 'b'\)/);
    expect(stripComments(source)).not.toMatch(/so\.service_id/);
  });

  it('no longer joins service_options at all in the review lookup', () => {
    const lookup = source.slice(
      source.indexOf('async function getBookingForReview'),
      source.indexOf('async function getExistingReview'),
    );
    expect(stripComments(lookup)).not.toMatch(/service_options/);
  });

  it('the policy names the forbidden resolution explicitly', () => {
    expect(CANONICAL_SERVICE_RESOLUTION.resolvesTo).toBe('services.id');
    expect(CANONICAL_SERVICE_RESOLUTION.forbidden).toContain('service_families');
  });

  it('dimensions are looked up with that canonical id', () => {
    expect(source).toMatch(/service_review_dimensions[\s\S]{0,120}service_id::text = \$1/);
  });
});

// ─── Rating summary ───────────────────────────────────────────────────────────

describe('the rating summary is backend-derived', () => {
  it('no moderation state both hides a review and counts it', () => {
    // A hidden review that still moved the average is a provider's displayed
    // rating disagreeing with the reviews shown beneath it.
    for (const state of MODERATION_STATE_NAMES) {
      const spec = MODERATION_STATES[state];
      if (!spec.publiclyVisible) expect(spec.countsToward).toBe(false);
    }
  });

  it('a rejected review stops counting and a restored one starts again', () => {
    expect(countsTowardRating('REJECTED')).toBe(false);
    expect(publiclyVisible('REJECTED')).toBe(false);
    expect(countsTowardRating('RESTORED')).toBe(true);
    expect(publiclyVisible('RESTORED')).toBe(true);
  });

  it('a reported review stays visible until somebody decides', () => {
    // Hiding on report would make a report a censorship button.
    expect(publiclyVisible('REPORTED')).toBe(true);
    expect(countsTowardRating('REPORTED')).toBe(true);
  });

  it('a pending review is neither visible nor counted', () => {
    expect(publiclyVisible('PENDING_REVIEW')).toBe(false);
    expect(countsTowardRating('PENDING_REVIEW')).toBe(false);
  });

  it('an unknown state counts for nothing — fails closed', () => {
    expect(countsTowardRating('SOMETHING_NEW')).toBe(false);
    expect(publiclyVisible('SOMETHING_NEW')).toBe(false);
  });

  it('no endpoint accepts a rating for a provider', () => {
    // A rating a caller can set is a rating a caller can inflate.
    const handler = read('src/api/v1/domains/reviews.ts');
    expect(handler).not.toMatch(/averageRating\s*[:=]/);
    expect(handler).not.toMatch(/setRating|updateRating/);
  });

  it('withholds a dimension average below the sample floor', () => {
    // Three reviews is not a measurement, and on a small provider publishing one
    // identifies who wrote it.
    expect(MIN_DIMENSION_SAMPLE).toBeGreaterThanOrEqual(5);
    const aggregation = read('src/services/ratingAggregationService.ts');
    expect(aggregation).toMatch(/MIN_DIMENSION_SAMPLE/);
  });
});

// ─── Dimensions and events ────────────────────────────────────────────────────

describe('the declared vocabulary', () => {
  it('has six canonical dimensions, each with a description', () => {
    expect(DIMENSION_KEYS).toHaveLength(6);
    for (const key of DIMENSION_KEYS) {
      expect(CANONICAL_DIMENSIONS[key].length).toBeGreaterThan(15);
    }
  });

  it('the service enforces the same rating bounds the policy declares', () => {
    const source = read('src/services/customerReviewService.ts');
    expect(RATING_BOUNDS).toEqual({ min: 1, max: 5 });
    expect(source).toMatch(/const MIN_RATING\s+= 1/);
    expect(source).toMatch(/const MAX_RATING\s+= 5/);
  });

  it('the edit window is short, because an edit changes a published statement', () => {
    expect(EDIT_WINDOW_HOURS).toBe(48);
  });

  it('publishes ReviewCreated, and the event is declared in the TAB 09 registry', () => {
    const { DOMAIN_EVENT_NAMES } = require('../src/services/events/domainEvents');
    for (const event of REVIEW_EVENTS) {
      expect(DOMAIN_EVENT_NAMES).toContain(event);
    }
    const source = read('src/services/customerReviewService.ts');
    expect(source).toMatch(/name: 'ReviewCreated'/);
  });

  it('does NOT publish an event the registry would project to nothing', () => {
    // `ReviewUpdated` is deliberately unpublished, and the policy says why.
    const { DOMAIN_EVENT_NAMES } = require('../src/services/events/domainEvents');
    expect(DOMAIN_EVENT_NAMES).not.toContain('ReviewUpdated');
    const { UNPUBLISHED_EVENTS } = require('../src/services/reviews/reviewPolicy');
    expect(UNPUBLISHED_EVENTS.ReviewUpdated.length).toBeGreaterThan(40);
  });
});
