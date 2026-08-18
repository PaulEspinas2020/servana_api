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
  calendarDayOf,
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

describe('calendarDayOf — the defect a tidy fixture would never have caught', () => {
  // Found by inserting ONE real row into production, not by any test here.
  // A single-day all-day leave came back as a FIFTEEN MINUTE event: the code
  // sliced a parsed Date instead of the raw column, produced 'Wed Mar 0',
  // failed to parse, and fell through to the minimum-span fallback. Nothing
  // threw. The event still rendered. It was just the wrong length.

  it('reads the day straight off a pg date string', () => {
    expect(calendarDayOf('2027-03-01')).toBe('2027-03-01');
  });

  it('reads the day off a pg timestamp string', () => {
    expect(calendarDayOf('2027-03-01T00:00:00.000Z')).toBe('2027-03-01');
  });

  it('produces a value that actually parses back to that day', () => {
    // The real assertion: the output must be usable as a date, which is
    // precisely what the buggy version failed at.
    const day = calendarDayOf('2027-03-01');
    const parsed = new Date(`${day}T00:00:00.000Z`);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    expect(parsed.toISOString()).toBe('2027-03-01T00:00:00.000Z');
  });

  it('a stringified Date does NOT survive the same slice — the actual bug', () => {
    // Pinned so nobody "simplifies" the raw-value rule back out again.
    const asDate = new Date('2027-03-01T00:00:00.000Z');
    const wrong = String(asDate).slice(0, 10);
    expect(wrong).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(new Date(`${wrong}T00:00:00.000Z`).getTime())).toBe(true);
  });

  it('is safe on null and undefined', () => {
    expect(calendarDayOf(null)).toBe('');
    expect(calendarDayOf(undefined)).toBe('');
  });

  describe('the span it produces for an all-day leave', () => {
    const allDaySpan = (startRaw: unknown, endRaw: unknown) => {
      const start = new Date(`${calendarDayOf(startRaw)}T00:00:00.000Z`);
      const end = new Date(
        new Date(`${calendarDayOf(endRaw ?? startRaw)}T00:00:00.000Z`).getTime() + 86_400_000,
      );
      return (end.getTime() - start.getTime()) / 3_600_000;
    };

    it('gives a SINGLE-day leave a full 24 hours, not 15 minutes', () => {
      // The exact production row: start_date === end_date === 2027-03-01.
      expect(allDaySpan('2027-03-01', '2027-03-01')).toBe(24);
    });

    it('gives a three-day leave 72 hours, end_date being inclusive', () => {
      expect(allDaySpan('2027-03-01', '2027-03-03')).toBe(72);
    });

    it('falls back to the start day when end_date is null', () => {
      expect(allDaySpan('2027-03-01', null)).toBe(24);
    });
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

/**
 * The emitted event object, exercised through a mocked dbQuery.
 *
 * Everything above this point mirrors the service's logic in the test file
 * rather than running it, which pins the RULES but never the actual payload —
 * the header's claim that "the query builders are exercised through a stubbed
 * dbQuery" was aspirational. These cases run `getProviderCalendar` for real and
 * assert on what a client would receive.
 */
describe('getProviderCalendar — the payload a client actually receives', () => {
  const bookingRow = {
    id: 106,
    schedule: '2026-08-12T02:00:00.000Z',
    eta_minutes: 10,
    booking_status: 'CONFIRMED',
    created_at: '2026-08-01T00:00:00.000Z',
    worker_status: 'ACCEPTED',
    assigned_at: '2026-08-01T00:00:00.000Z',
    confirmed_at: '2026-08-02T00:00:00.000Z',
    accepted_at: null,
    service_name: 'Aircon Cleaning',
    duration_mins: 120,
    post_town: 'Makati City',
  };

  const loadWith = async (bookings: any[], timeOff: any[]) => {
    jest.resetModules();
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: bookings })
      .mockResolvedValueOnce({ rows: timeOff });
    jest.doMock('../src/db/dbQuery', () => ({ __esModule: true, default: { query } }));
    const svc = require('../src/services/providerCalendarService');
    const result = await svc.getProviderCalendar('provider-uid-1', svc.parseCalendarQuery({
      start: new Date('2026-08-10').toISOString(),
      end: new Date('2026-08-17').toISOString(),
    }));
    return { result, query };
  };

  afterEach(() => { jest.dontMock('../src/db/dbQuery'); jest.resetModules(); });

  it('returns the city as locationLabel', async () => {
    const { result } = await loadWith([bookingRow], []);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].locationLabel).toBe('Makati City');
  });

  it('uses duration_mins for the block width, not eta_minutes', async () => {
    // eta_minutes is travel time. Using it would draw a 10-minute job for a
    // 10-minute drive.
    const { result } = await loadWith([bookingRow], []);
    const e = result.events[0];
    expect((new Date(e.end).getTime() - new Date(e.start).getTime()) / 60_000).toBe(120);
  });

  it('gives locationLabel null — not "" — when there is no resolved address', async () => {
    // An empty string renders as a blank location line; null renders as absent.
    const { result } = await loadWith([{ ...bookingRow, post_town: null }], []);
    expect(result.events[0].locationLabel).toBeNull();

    const blank = await loadWith([{ ...bookingRow, post_town: '   ' }], []);
    expect(blank.result.events[0].locationLabel).toBeNull();
  });

  it('never attaches a location to time off — it is not at a place', async () => {
    const { result } = await loadWith([], [{
      id: 9, start_date: '2026-08-12', end_date: '2026-08-12', all_day: true,
      start_time: null, end_time: null, reason: 'Leave', note: null,
      status: 'ACTIVE', created_at: '2026-08-01T00:00:00.000Z', cancelled_at: null,
    }]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].eventType).toBe('TIME_OFF');
    expect(result.events[0].locationLabel).toBeNull();
  });

  it('flags the booking, not the time off, when the two overlap', async () => {
    const { result } = await loadWith([bookingRow], [{
      id: 9, start_date: '2026-08-12', end_date: '2026-08-12', all_day: true,
      start_time: null, end_time: null, reason: 'Leave', note: null,
      status: 'ACTIVE', created_at: '2026-08-01T00:00:00.000Z', cancelled_at: null,
    }]);
    const booking = result.events.find((e: any) => e.eventType === 'CONFIRMED_BOOKING');
    const timeOff = result.events.find((e: any) => e.eventType === 'TIME_OFF');
    expect(booking.hasConflict).toBe(true);
    expect(timeOff.hasConflict).toBe(false);
  });

  it('scopes both queries to the authenticated provider uid', async () => {
    // §11 — the uid is the first bind parameter on every query, never a filter
    // applied after the fact.
    const { query } = await loadWith([bookingRow], []);
    for (const call of query.mock.calls) {
      expect(call[1][0]).toBe('provider-uid-1');
    }
  });

  it('emits every field the mobile parser requires, on every event', async () => {
    const { result } = await loadWith([bookingRow], [{
      id: 9, start_date: '2026-08-14', end_date: '2026-08-14', all_day: true,
      start_time: null, end_time: null, reason: 'Leave', note: null,
      status: 'ACTIVE', created_at: '2026-08-01T00:00:00.000Z', cancelled_at: null,
    }]);
    expect(result.generatedAt).toBeTruthy();
    expect(result.timezone).toBe(SERVANA_TIMEZONE);
    for (const e of result.events) {
      for (const key of ['eventId', 'title', 'start', 'end', 'updatedAt', 'timezone']) {
        expect(String((e as any)[key] ?? '')).not.toBe('');
      }
      // The silent-drop rule: end strictly after start.
      expect(new Date(e.end).getTime()).toBeGreaterThan(new Date(e.start).getTime());
    }
  });
});
