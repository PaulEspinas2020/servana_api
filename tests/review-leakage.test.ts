/**
 * Review privacy: what each seat may read, and what nothing may read.
 *
 * ## Why this is written as a leak test rather than a shape test
 *
 * A review is a public statement about a named worker written by a customer who
 * is not public. The failure mode is not "the wrong field is missing" — it is
 * "one extra column reached a stranger". So every projection here is fed a row
 * carrying EVERY private column the tables hold, and the assertion is on the
 * serialized output: if a field is added to a SELECT later and forgotten in the
 * mapper, these fail.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));

const query = jest.fn();
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => query(...args) },
  pool: { connect: jest.fn() },
}));

import fs from 'fs';
import path from 'path';
import {
  FIELD_VISIBILITY,
  NEVER_PROJECTED,
  REVIEW_SEATS,
  mayReadField,
} from '../src/services/reviews/reviewPolicy';
import {
  getReviewByBooking,
  listProviderReviews,
} from '../src/services/customerReviewService';
import { getPublicRatingSummary } from '../src/services/ratingAggregationService';

/** Everything private the review tables actually hold, plus the author's identity. */
const PRIVATE = {
  customer_uid: 'cust-secret-uid',
  customer_email: 'dana@example.com',
  customer_phone: '+639170000000',
  address_one: '14 Mabini Street',
  private_feedback: 'He smelled of cigarettes and I did not want to say so publicly.',
  internal_notes: 'Escalated by agent K.',
  moderation_notes: 'Borderline, left up.',
  reviewer_notes: 'Watch this account.',
  password_hash: '$2b$10$whatever',
  fcm_token: 'tok-123',
};

const PUBLIC_ROW = {
  review_id: 'rev-1',
  booking_id: '77',
  provider_uid: 'prov-1',
  service_id: '42',
  overall_rating: 5,
  public_comment: 'Excellent work, arrived on time.',
  visibility: 'PUBLIC',
  moderation_status: 'APPROVED',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  edited_at: null,
  deleted_at: null,
  dimensions: [{ dimensionKey: 'punctuality', score: 5 }],
  response_id: null,
};

const leaky = { ...PUBLIC_ROW, ...PRIVATE };

const serialize = (value: unknown): string => JSON.stringify(value);

beforeEach(() => query.mockReset());

// ─── The public list ──────────────────────────────────────────────────────────

describe('a stranger reading a provider\'s reviews', () => {
  const listWith = async (row: Record<string, unknown>) => {
    query
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ total: 1 }], rowCount: 1 });
    return listProviderReviews('prov-1', 20, 0);
  };

  it('sees the rating, the comment and nothing about the author', async () => {
    const { reviews } = await listWith(leaky);
    const body = serialize(reviews);

    expect(reviews[0].overallRating).toBe(5);
    expect(reviews[0].publicComment).toBe(PUBLIC_ROW.public_comment);

    for (const [field, secret] of Object.entries(PRIVATE)) {
      expect(body).not.toContain(String(secret));
      expect(body).not.toContain(field);
    }
  });

  it('never carries the private feedback, which is the whole point of it being private', async () => {
    const { reviews } = await listWith(leaky);
    expect(reviews[0]).not.toHaveProperty('privateFeedback');
    expect(serialize(reviews)).not.toContain('cigarettes');
  });

  it('never carries the booking id, which links a stranger to a visit', async () => {
    // A booking id plus a provider plus a date is enough to work out who was at
    // which address on which day.
    const { reviews } = await listWith(leaky);
    expect(reviews[0]).not.toHaveProperty('bookingId');
  });

  it('never carries the author\'s uid', async () => {
    const { reviews } = await listWith(leaky);
    expect(serialize(reviews)).not.toContain('cust-secret-uid');
  });

  it('filters unpublished and moderated-away reviews in SQL, not after the read', async () => {
    await listWith(leaky);
    const sql = String(query.mock.calls[0][0]);
    // Filtering in the mapper would still have loaded them, and a LIMIT applied
    // before a filter returns short pages that look like the end of the list.
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(sql).toMatch(/visibility IN \('PUBLIC','ANONYMOUS_PUBLIC'\)/);
    expect(sql).toMatch(/publication_state IN/);
    expect(sql).toMatch(/moderation_status IN/);
  });

  it('counts with the SAME filters it lists with', async () => {
    await listWith(leaky);
    const list = String(query.mock.calls[0][0]);
    const count = String(query.mock.calls[1][0]);
    for (const clause of [
      'deleted_at IS NULL',
      "visibility IN ('PUBLIC','ANONYMOUS_PUBLIC')",
      "publication_state IN ('PUBLISHED','EDITED','REDACTED')",
    ]) {
      expect(list).toContain(clause);
      // A total counted under looser filters is a paginator that promises pages
      // that do not exist.
      expect(count).toContain(clause);
    }
  });
});

// ─── The author's own read ────────────────────────────────────────────────────

describe('the author reading their own review', () => {
  it('does see their private feedback', async () => {
    query.mockResolvedValueOnce({ rows: [leaky], rowCount: 1 });
    const review = await getReviewByBooking('77', 'cust-secret-uid');
    expect(review).not.toBeNull();
    expect(review!.privateFeedback).toContain('cigarettes');
  });

  it('is scoped by the author uid IN THE QUERY', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await getReviewByBooking('77', 'someone-else');
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toMatch(/WHERE r\.booking_id = \$1 AND r\.customer_uid = \$2/);
    expect(params).toEqual(['77', 'someone-else']);
  });

  it('returns null rather than another customer\'s review', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await getReviewByBooking('77', 'someone-else')).toBeNull();
  });

  it('still never carries contact details or credentials', async () => {
    query.mockResolvedValueOnce({ rows: [leaky], rowCount: 1 });
    const review = await getReviewByBooking('77', 'cust-secret-uid');
    const body = serialize(review);
    for (const field of NEVER_PROJECTED) {
      expect(body).not.toContain(field);
    }
    expect(body).not.toContain('dana@example.com');
    expect(body).not.toContain('Mabini');
    expect(body).not.toContain('$2b$10$');
  });

  it('never carries a moderator\'s notes about the author', async () => {
    // An author reading "Watch this account" learns they are flagged, which is
    // both a privacy leak about an internal process and a warning to whoever is
    // being watched.
    query.mockResolvedValueOnce({ rows: [leaky], rowCount: 1 });
    const body = serialize(await getReviewByBooking('77', 'cust-secret-uid'));
    expect(body).not.toContain('Escalated by agent');
    expect(body).not.toContain('Watch this account');
  });
});

// ─── The rating summary ───────────────────────────────────────────────────────

describe('the public rating summary', () => {
  it('is derived from the aggregate table, and exposes no individual review', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        average_rating: 4.6, review_count: 12,
        rating_1_count: 0, rating_2_count: 1, rating_3_count: 1,
        rating_4_count: 2, rating_5_count: 8,
        aggregation_policy_version: 1, aggregate_version: 9,
        calculated_at: '2026-08-10T00:00:00.000Z',
        ...PRIVATE,
      }],
      rowCount: 1,
    });
    const summary = await getPublicRatingSummary('prov-1');
    expect(summary.averageRating).toBe(4.6);
    expect(summary.reviewCount).toBe(12);
    for (const secret of Object.values(PRIVATE)) {
      expect(serialize(summary)).not.toContain(String(secret));
    }
  });

  it('says so plainly when a provider has no reviews, instead of showing a zero', async () => {
    // A displayed 0.0 reads as "rated badly". A new provider has not been rated.
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const summary = await getPublicRatingSummary('prov-new');
    expect(summary.averageRating).toBeNull();
    expect(summary.reviewCount).toBe(0);
    expect(summary.explanation).toMatch(/No verified customer reviews yet/);
  });

  it('marks a small sample as low volume rather than hiding it', async () => {
    query.mockResolvedValueOnce({
      rows: [{ average_rating: 5, review_count: 2 }],
      rowCount: 1,
    });
    const summary = await getPublicRatingSummary('prov-small');
    expect(summary.lowVolume).toBe(true);
    // The number is still shown; the client is told it rests on two reviews.
    expect(summary.averageRating).toBe(5);
  });
});

// ─── The declaration itself ───────────────────────────────────────────────────

describe('the field visibility declaration', () => {
  it('gives no seat a field that is never projected', async () => {
    // Two mechanisms that disagree is how a leak survives a review: one file
    // says "never" and another says "admin may".
    for (const field of NEVER_PROJECTED) {
      for (const seat of REVIEW_SEATS) {
        expect(mayReadField(field, seat)).toBe(false);
      }
    }
  });

  it('grants an unknown field to nobody — fails closed', () => {
    for (const seat of REVIEW_SEATS) {
      expect(mayReadField('some_new_column', seat)).toBe(false);
    }
  });

  it('gives the public no field the author alone should hold', () => {
    for (const field of ['privateFeedback', 'authorName', 'authorUid', 'bookingId']) {
      expect(mayReadField(field, 'public')).toBe(false);
      expect(mayReadField(field, 'provider')).toBe(false);
    }
  });

  it('gives the REVIEWED provider no more than the public, except nothing', () => {
    // A provider seeing more than the public sees is a provider who can work out
    // which customer wrote which review — and then contact them.
    for (const [field, seats] of Object.entries(FIELD_VISIBILITY)) {
      if (seats.includes('provider')) {
        expect(seats).toContain('public');
      }
    }
  });

  it('keeps the moderation state to admins', () => {
    // Showing a provider that a review is REPORTED tells them somebody complained
    // before anybody has decided whether the complaint is right.
    expect(mayReadField('moderationState', 'provider')).toBe(false);
    expect(mayReadField('moderationState', 'public')).toBe(false);
    expect(mayReadField('moderationState', 'admin')).toBe(true);
  });

  it('the v1 handlers project no field the declaration withholds from everyone', () => {
    const handler = fs.readFileSync(
      path.join(__dirname, '..', 'src/api/v1/domains/reviews.ts'),
      'utf8',
    );
    for (const field of NEVER_PROJECTED) {
      expect(handler).not.toContain(field);
    }
  });
});
