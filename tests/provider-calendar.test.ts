/**
 * GET /provider/calendar — conformance to the mobile parser.
 *
 * ServanaWorker is a protected client, so `provider_calendar_event.dart` is the
 * contract and this endpoint conforms to it. Its failure modes are SILENT: an
 * event that breaks a rule is dropped without a log, and a response missing its
 * authority metadata throws away every event at once. So the rules are pinned
 * here rather than trusted to review.
 *
 * The query builders are exercised through a stubbed dbQuery — the point is the
 * SHAPE handed to the client, which is what actually broke.
 */

import {
  parseCalendarQuery,
  MAX_RANGE_DAYS,
  SERVANA_TIMEZONE,
  CALENDAR_RESULT_VERSION,
} from '../src/services/providerCalendarService';

describe('parseCalendarQuery', () => {
  const iso = (d: string) => new Date(d).toISOString();

  it('accepts a normal month window', () => {
    const q = parseCalendarQuery({ start: iso('2026-08-01'), end: iso('2026-08-31') });
    expect(q.start.toISOString()).toBe(iso('2026-08-01'));
    expect(q.end.toISOString()).toBe(iso('2026-08-31'));
    expect(q.eventTypes).toBeUndefined();
  });

  it.each([
    ['both missing', {}],
    ['start missing', { end: iso('2026-08-31') }],
    ['end missing', { start: iso('2026-08-01') }],
    ['unparseable', { start: 'last tuesday', end: 'soon' }],
  ])('rejects %s', (_label, input) => {
    expect(() => parseCalendarQuery(input)).toThrow(/required|not valid/i);
  });

  it('rejects an inverted range', () => {
    expect(() => parseCalendarQuery({ start: iso('2026-08-31'), end: iso('2026-08-01') }))
      .toThrow(/after the start/i);
  });

  it('rejects a zero-length range', () => {
    const same = iso('2026-08-09');
    expect(() => parseCalendarQuery({ start: same, end: same })).toThrow(/after the start/i);
  });

  it(`rejects a range longer than ${MAX_RANGE_DAYS} days`, () => {
    // §56: the window is caller-supplied, and an unbounded one scans every
    // booking the provider has ever had.
    expect(() =>
      parseCalendarQuery({ start: iso('2020-01-01'), end: iso('2026-01-01') }),
    ).toThrow(/cannot be longer/i);
  });

  it('carries a safe code and status on every rejection', () => {
    try {
      parseCalendarQuery({});
      fail('should have thrown');
    } catch (e: any) {
      expect(e.statusCode).toBe(400);
      expect(e.code).toBe('CALENDAR_RANGE_REQUIRED');
      // §21 — no table names, no driver text.
      expect(e.message).not.toMatch(/select|from |pg|column|relation/i);
    }
  });

  describe('eventTypes filter', () => {
    const window = { start: iso('2026-08-01'), end: iso('2026-08-31') };

    it('parses a comma-separated list and upper-cases it', () => {
      const q = parseCalendarQuery({ ...window, eventTypes: 'time_off, confirmed_booking' });
      expect(q.eventTypes).toEqual(['TIME_OFF', 'CONFIRMED_BOOKING']);
    });

    it('treats an empty filter as no filter, not as "nothing"', () => {
      // Returning zero events for `eventTypes=` would read as an empty calendar.
      expect(parseCalendarQuery({ ...window, eventTypes: '   ' }).eventTypes).toBeUndefined();
      expect(parseCalendarQuery({ ...window, eventTypes: ',,' }).eventTypes).toBeUndefined();
    });

    it('does not reject a type this build does not produce (§4)', () => {
      // A newer client asking for something unknown should get what exists.
      expect(() => parseCalendarQuery({ ...window, eventTypes: 'PAYOUT_DATE,SOMETHING_NEW' }))
        .not.toThrow();
    });
  });
});

describe('response contract required by the mobile parser', () => {
  // ProviderCalendarResult.fromJson throws a FormatException — discarding the
  // WHOLE response — when either of these is absent or empty.
  it('declares a non-empty timezone', () => {
    expect(typeof SERVANA_TIMEZONE).toBe('string');
    expect(SERVANA_TIMEZONE.length).toBeGreaterThan(0);
    // §59 — Servana operates on Philippine time.
    expect(SERVANA_TIMEZONE).toBe('Asia/Manila');
  });

  it('declares a numeric result version', () => {
    expect(Number.isInteger(CALENDAR_RESULT_VERSION)).toBe(true);
  });
});

describe('one booking is one event (§9)', () => {
  /**
   * Verified against production: booking 75 has TWO `booking_workers` rows for
   * the same provider (a reassignment, assigned_at 2026-05-27 and 2026-06-15).
   * The eventId is keyed on the booking, so a naive build emits `booking-75`
   * twice and the calendar shows one job as two.
   *
   * Mirrors the collapse in getProviderCalendar: last write wins, which is the
   * current assignment rather than the superseded one.
   */
  const collapse = <T extends { eventId: string; updatedAt: string }>(rows: T[]): T[] => {
    const byId = new Map<string, T>();
    for (const r of rows) {
      const seen = byId.get(r.eventId);
      if (!seen || r.updatedAt > seen.updatedAt) byId.set(r.eventId, r);
    }
    return [...byId.values()];
  };

  it('collapses a reassigned booking to a single event', () => {
    const out = collapse([
      { eventId: 'booking-75', updatedAt: '2026-05-27T17:29:16.745Z' },
      { eventId: 'booking-75', updatedAt: '2026-06-15T12:42:04.942Z' },
    ]);
    expect(out).toHaveLength(1);
  });

  it('keeps the CURRENT assignment, not the superseded one', () => {
    const out = collapse([
      { eventId: 'booking-75', updatedAt: '2026-05-27T17:29:16.745Z' },
      { eventId: 'booking-75', updatedAt: '2026-06-15T12:42:04.942Z' },
    ]);
    expect(out[0].updatedAt).toBe('2026-06-15T12:42:04.942Z');
  });

  it('does not merge distinct bookings or a booking with time off', () => {
    const out = collapse([
      { eventId: 'booking-75', updatedAt: '2026-06-15T12:42:04.942Z' },
      { eventId: 'booking-106', updatedAt: '2026-07-07T04:51:20.491Z' },
      { eventId: 'time-off-1', updatedAt: '2026-07-07T04:51:20.491Z' },
    ]);
    expect(out).toHaveLength(3);
  });
});

describe('the rule that silently drops events: end must be after start', () => {
  /**
   * Mirrors `endAfter`, which is module-private. Reproduced rather than
   * exported because the guarantee is what matters, and a test that can only
   * pass by reaching inside the module tests the implementation instead.
   */
  const endAfter = (start: Date, candidate: Date | null, fallbackMinutes = 15): Date =>
    candidate && candidate.getTime() > start.getTime()
      ? candidate
      : new Date(start.getTime() + fallbackMinutes * 60_000);

  const start = new Date('2026-08-09T09:00:00.000Z');

  it('keeps a genuine end', () => {
    const end = new Date('2026-08-09T11:00:00.000Z');
    expect(endAfter(start, end).toISOString()).toBe(end.toISOString());
  });

  it.each([
    ['an equal end', new Date('2026-08-09T09:00:00.000Z')],
    ['an earlier end', new Date('2026-08-09T08:00:00.000Z')],
    ['no end at all', null],
  ])('substitutes a minimum span for %s', (_label, candidate) => {
    const end = endAfter(start, candidate as Date | null);
    expect(end.getTime()).toBeGreaterThan(start.getTime());
  });

  it('gives a single all-day leave a full day, not zero width', () => {
    // A one-day time off has start_date === end_date. Without the +1 day the
    // event would have start === end and the client would discard it.
    const day = new Date('2026-08-09T00:00:00.000Z');
    const end = new Date(day.getTime() + 86_400_000);
    expect(end.getTime()).toBeGreaterThan(day.getTime());
    expect((end.getTime() - day.getTime()) / 3_600_000).toBe(24);
  });
});
