/**
 * The customer projection of the booking timeline, and the guarantee that the
 * provider one did not move.
 *
 * `buildBookingTimeline` is provider-voiced by design — its own header says so.
 * Command 6 exposed the same history to customers, and serving that output
 * verbatim would have been wrong in both directions at once: the customer reads
 * "You marked yourself arrived" about their professional, while the one event
 * that genuinely is theirs is attributed to somebody else.
 *
 * The cross-platform hard rule says a change must not alter any other
 * platform's integration, and that this is PROVEN rather than assumed. The
 * first describe block is that proof.
 */

import {
  buildBookingTimeline,
  projectTimelineForCustomer,
  type TimelineEvent,
} from '../src/controllers/bookingTimeline';

/** A booking that has run the full course, so every stage is present. */
const COMPLETED_ROW = {
  created_at: '2026-08-01T01:00:00.000Z',
  assigned_at: '2026-08-01T02:00:00.000Z',
  accepted_at: '2026-08-01T03:00:00.000Z',
  en_route_at: '2026-08-01T04:00:00.000Z',
  arrived_at: '2026-08-01T05:00:00.000Z',
  started_at: '2026-08-01T06:00:00.000Z',
  completed_at: '2026-08-01T07:00:00.000Z',
  worker_status: 'COMPLETED',
  booking_status: 'COMPLETED',
};

describe('the provider timeline is unchanged (cross-platform rule)', () => {
  const events = buildBookingTimeline(COMPLETED_ROW);

  test('still speaks in the provider voice', () => {
    const labels = events.map((e) => e.label);
    expect(labels).toContain('Assigned to you');
    expect(labels).toContain('You accepted this booking');
    expect(labels).toContain('You marked yourself on the way');
    expect(labels).toContain('You marked yourself arrived');
  });

  test('still uses YOU to mean the provider', () => {
    const accepted = events.find((e) => e.code === 'PROVIDER_ACCEPTED');
    expect(accepted?.actor).toBe('YOU');
  });

  test('projecting for the customer does not mutate the source', () => {
    const before = JSON.parse(JSON.stringify(events));
    projectTimelineForCustomer(events);
    expect(events).toEqual(before);
  });
});

describe('the customer projection', () => {
  const events = projectTimelineForCustomer(buildBookingTimeline(COMPLETED_ROW));
  const byCode = (code: string) => events.find((e) => e.code === code);

  test('never tells the customer they did something the provider did', () => {
    // The defect this exists to prevent, stated as an assertion.
    for (const event of events) {
      if (event.code === 'BOOKING_CREATED') continue;
      expect(event.label).not.toMatch(/^You /);
      expect(event.label).not.toContain('yourself');
    }
  });

  test('attributes the booking to the customer, because it IS theirs', () => {
    // The inversion that a naive rename would miss: provider-seat "CUSTOMER"
    // is the customer's own "YOU".
    const created = byCode('BOOKING_CREATED');
    expect(created?.actor).toBe('YOU');
    expect(created?.label).toBe('You created this booking');
  });

  test('attributes the professional’s actions to the professional', () => {
    for (const code of [
      'PROVIDER_ACCEPTED',
      'PROVIDER_EN_ROUTE',
      'PROVIDER_ARRIVED',
      'JOB_STARTED',
      'JOB_COMPLETED',
    ]) {
      expect(byCode(code)?.actor).toBe('PROVIDER');
    }
  });

  test('reads naturally to a customer', () => {
    expect(byCode('PROVIDER_EN_ROUTE')?.label).toBe('Your professional is on the way');
    expect(byCode('PROVIDER_ARRIVED')?.label).toBe('Your professional arrived');
    expect(byCode('JOB_COMPLETED')?.label).toBe('Work completed');
  });

  test('preserves order, sequence and timestamps exactly', () => {
    const source = buildBookingTimeline(COMPLETED_ROW);
    expect(events.map((e) => e.code)).toEqual(source.map((e) => e.code));
    expect(events.map((e) => e.sequence)).toEqual(source.map((e) => e.sequence));
    expect(events.map((e) => e.at)).toEqual(source.map((e) => e.at));
  });

  test('invents no event the source did not have', () => {
    expect(events).toHaveLength(buildBookingTimeline(COMPLETED_ROW).length);
  });
});

describe('a declined booking', () => {
  const declined = projectTimelineForCustomer(
    buildBookingTimeline({
      created_at: '2026-08-01T01:00:00.000Z',
      assigned_at: '2026-08-01T02:00:00.000Z',
      declined_at: '2026-08-01T03:00:00.000Z',
      worker_status: 'DECLINED',
      booking_status: 'CONFIRMED',
    })
  );

  test('does not tell the customer they were turned down', () => {
    // §14 forbids exposing declined providers, and "your professional declined
    // you" reads as a personal rejection when it usually means unavailability.
    const event = declined.find((e) => e.code === 'PROVIDER_DECLINED');
    expect(event?.label).toBe('Finding you another professional');
    expect(event?.label.toLowerCase()).not.toContain('declined');
    expect(event?.label.toLowerCase()).not.toContain('rejected');
  });

  test('names nobody', () => {
    for (const event of declined) {
      expect(event.actor).toMatch(/^(YOU|PROVIDER|SERVANA)$/);
    }
  });
});

describe('robustness', () => {
  test('a booking with no assignment yet still has a history', () => {
    // Every newly created booking is in this state. An empty timeline here
    // would be the common case, not the edge case.
    const events = projectTimelineForCustomer(
      buildBookingTimeline({
        created_at: '2026-08-01T01:00:00.000Z',
        worker_status: null,
        booking_status: 'PENDING_OTP',
      })
    );
    expect(events).toHaveLength(1);
    expect(events[0].code).toBe('BOOKING_CREATED');
    expect(events[0].actor).toBe('YOU');
  });

  test('an unknown event code keeps its label rather than vanishing', () => {
    // During a rolling deploy a new code can arrive before this map knows it.
    // Reading slightly oddly beats disappearing from someone's history.
    const invented = [
      { code: 'SOMETHING_NEW', label: 'Original label', at: null, actor: 'SERVANA', sequence: 9 },
    ] as unknown as TimelineEvent[];
    const [projected] = projectTimelineForCustomer(invented);
    expect(projected.label).toBe('Original label');
  });

  test('an unknown actor degrades to SERVANA rather than to the customer', () => {
    // Failing closed: attributing an unrecognised actor to "YOU" would tell the
    // customer they did something unknown.
    const odd = [
      { code: 'BOOKING_CREATED', label: 'x', at: null, actor: 'ROBOT', sequence: 0 },
    ] as unknown as TimelineEvent[];
    expect(projectTimelineForCustomer(odd)[0].actor).toBe('SERVANA');
  });

  test('an empty timeline projects to an empty timeline', () => {
    expect(projectTimelineForCustomer([])).toEqual([]);
  });
});
