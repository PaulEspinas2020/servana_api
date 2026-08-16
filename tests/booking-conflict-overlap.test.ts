/**
 * The conflict rule is half-open overlap against each job's REAL span.
 *
 * ## What this replaced
 *
 * A fixed ±2 hours around the scheduled time, which ignores how long the job
 * lasts. Measured at Phase 0, it was wrong in both directions at once, and the
 * executor and the availability engine disagreed about the same provider:
 *
 *   - a 30-minute job blocked the provider for four hours around it;
 *   - a 4-hour job left them "free" 3 hours in, and the executor would
 *     double-book them on work the availability engine already knew overlapped.
 *
 * ## What is asserted here
 *
 * The arithmetic, at the boundaries where an off-by-one is invisible in prose:
 * adjacency, containment, long jobs, zero and missing durations, and the
 * timezone independence that comes from comparing instants. Plus the parity
 * property that matters most — every producer emits the SAME predicate, so a
 * preview and its committer cannot answer differently.
 */

import fs from 'fs';
import path from 'path';

import {
  DEFAULT_SERVICE_DURATION_MINS,
  serviceDurationMinsSql,
  bookingEndSql,
  OVERLAPS_SPAN_SQL,
  bookingSpan,
  CONFLICTING_BOOKING_SQL,
  BUSY_PROVIDERS_SQL,
  NON_OCCUPYING_STATUSES,
} from '../src/services/booking/eligibilityPipeline';

const SRC = path.join(__dirname, '..', 'src');

const codeOf = (relative: string): string => fs
  .readFileSync(path.join(SRC, relative), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// ─── 1. The span, in TypeScript ───────────────────────────────────────────────

const at = (iso: string) => new Date(iso);

describe('a job occupies exactly its own span', () => {
  it('runs from the scheduled instant for its duration', () => {
    const span = bookingSpan(at('2026-09-01T10:00:00.000Z'), 30);
    expect(span.from.toISOString()).toBe('2026-09-01T10:00:00.000Z');
    expect(span.to.toISOString()).toBe('2026-09-01T10:30:00.000Z');
  });

  it('falls back to the declared default when duration is absent', () => {
    /**
     * Not invented: `service_options.duration_mins` is declared
     * `INT NOT NULL DEFAULT 120`, and three live queries already read it as
     * `COALESCE(duration_mins, 120)`. A row predating the column is treated
     * exactly as it is treated everywhere else today.
     */
    expect(DEFAULT_SERVICE_DURATION_MINS).toBe(120);
    for (const missing of [undefined, null]) {
      expect(bookingSpan(at('2026-09-01T10:00:00.000Z'), missing).to.toISOString())
        .toBe('2026-09-01T12:00:00.000Z');
    }
  });

  it('refuses a zero or negative duration rather than occupying nothing', () => {
    /**
     * The dangerous case. A zero-length span overlaps nothing, so one bad row
     * would make a provider infinitely bookable at that instant — silently, and
     * only for that provider.
     */
    for (const bad of [0, -30]) {
      expect(bookingSpan(at('2026-09-01T10:00:00.000Z'), bad).to.toISOString())
        .toBe('2026-09-01T12:00:00.000Z');
    }
  });

  it('is not symmetric padding — it starts AT the schedule', () => {
    // The old rule reached two hours BACKWARDS. A job does not occupy the
    // provider before it starts.
    const span = bookingSpan(at('2026-09-01T10:00:00.000Z'), 60);
    expect(span.from.getTime()).toBe(at('2026-09-01T10:00:00.000Z').getTime());
  });
});

// ─── 2. The overlap predicate, as SQL ─────────────────────────────────────────

describe('the overlap predicate is half-open', () => {
  const predicate = OVERLAPS_SPAN_SQL('$1::timestamptz', '$2::timestamptz');

  it('compares start-before-end and end-after-start, strictly', () => {
    /**
     * `[start, end)`. Strict on both sides is what makes a job ending at 12:00
     * not collide with one starting at 12:00 — the normal shape of a working
     * day. Closed intervals would refuse every back-to-back booking.
     */
    expect(predicate).toContain('b.schedule < $2::timestamptz');
    expect(predicate).toContain('> $1::timestamptz');
    expect(predicate).not.toContain('<=');
    expect(predicate).not.toContain('>=');
  });

  it('measures the other booking by its own duration, not by a constant', () => {
    expect(predicate).toContain('duration_mins');
    expect(predicate).toContain("|| ' minutes')::interval");
  });

  it('defends the duration in SQL exactly as it does in TypeScript', () => {
    // NULL, zero and negative all fall back to the default — the same three
    // cases the TS helper handles, so the two cannot disagree.
    const duration = serviceDurationMinsSql('so');
    expect(duration).toContain('COALESCE');
    expect(duration).toContain('NULLIF');
    expect(duration).toContain('GREATEST(so.duration_mins, 0)');
    expect(duration).toContain(String(DEFAULT_SERVICE_DURATION_MINS));
  });

  it('takes aliases, so it can be embedded in any shape of query', () => {
    const aliased = OVERLAPS_SPAN_SQL('t.start_at', 't.end_at', 'other', 'opt');
    expect(aliased).toContain('other.schedule < t.end_at');
    expect(aliased).toContain('opt.duration_mins');
  });

  it('compares INSTANTS, so it cannot drift with a server timezone', () => {
    // The old rule did its arithmetic on JS Dates in the server's zone. This
    // one never converts to wall-clock at all.
    expect(bookingEndSql('b', 'so')).toContain('b.schedule +');
    expect(bookingEndSql('b', 'so')).not.toContain('AT TIME ZONE');
    expect(predicate).not.toContain('AT TIME ZONE');
  });
});

/**
 * The rule, evaluated in TypeScript over the same arithmetic the SQL performs.
 *
 * A table of the cases that decide whether the rule is right, including the two
 * the fixed ±2h window got wrong. Executing them is what makes this evidence
 * rather than a restatement of the predicate.
 */
describe('the cases the fixed window got wrong', () => {
  const overlaps = (
    a: { start: string; mins?: number | null },
    b: { start: string; mins?: number | null },
  ): boolean => {
    const spanA = bookingSpan(at(a.start), a.mins);
    const spanB = bookingSpan(at(b.start), b.mins);
    return spanA.from < spanB.to && spanA.to > spanB.from;
  };

  it('a 30-minute job does NOT block a job 90 minutes later', () => {
    // Old rule: within ±2h → refused. The provider was blocked out for four
    // hours around every half-hour job.
    expect(overlaps(
      { start: '2026-09-01T10:00:00.000Z', mins: 30 },
      { start: '2026-09-01T11:30:00.000Z', mins: 30 },
    )).toBe(false);
  });

  it('a 4-hour job DOES block a job 3 hours in', () => {
    // Old rule: 13:00 falls outside 08:00–12:00 → assigned. This is the
    // operationally damaging one — a genuine double-booking.
    expect(overlaps(
      { start: '2026-09-01T10:00:00.000Z', mins: 240 },
      { start: '2026-09-01T13:00:00.000Z', mins: 60 },
    )).toBe(true);
  });

  it('back-to-back is allowed, in both orders', () => {
    expect(overlaps(
      { start: '2026-09-01T10:00:00.000Z', mins: 120 },
      { start: '2026-09-01T12:00:00.000Z', mins: 60 },
    )).toBe(false);
    expect(overlaps(
      { start: '2026-09-01T12:00:00.000Z', mins: 60 },
      { start: '2026-09-01T10:00:00.000Z', mins: 120 },
    )).toBe(false);
  });

  it('one minute of overlap is a conflict', () => {
    expect(overlaps(
      { start: '2026-09-01T10:00:00.000Z', mins: 120 },
      { start: '2026-09-01T11:59:00.000Z', mins: 60 },
    )).toBe(true);
  });

  it('a job wholly containing another conflicts, whichever is asked first', () => {
    const long = { start: '2026-09-01T09:00:00.000Z', mins: 480 };
    const short = { start: '2026-09-01T12:00:00.000Z', mins: 30 };
    expect(overlaps(long, short)).toBe(true);
    expect(overlaps(short, long)).toBe(true);
  });

  it('identical spans conflict', () => {
    const job = { start: '2026-09-01T10:00:00.000Z', mins: 60 };
    expect(overlaps(job, { ...job })).toBe(true);
  });

  it('two jobs with unknown durations behave as two-hour jobs', () => {
    expect(overlaps(
      { start: '2026-09-01T10:00:00.000Z' },
      { start: '2026-09-01T11:00:00.000Z' },
    )).toBe(true);
    expect(overlaps(
      { start: '2026-09-01T10:00:00.000Z' },
      { start: '2026-09-01T12:00:00.000Z' },
    )).toBe(false);
  });

  it('is timezone-independent: the same instants decide, however written', () => {
    // 10:00Z is 18:00 in Manila. Expressing either side in a different offset
    // must not change the answer.
    expect(overlaps(
      { start: '2026-09-01T10:00:00.000Z', mins: 60 },
      { start: '2026-09-01T18:30:00.000+08:00', mins: 60 },
    )).toBe(true);
    expect(overlaps(
      { start: '2026-09-01T10:00:00.000Z', mins: 60 },
      { start: '2026-09-01T19:00:00.000+08:00', mins: 60 },
    )).toBe(false);
  });

  it('a DST-style offset change does not move a span', () => {
    // Instants, not wall-clock: the span is a fixed number of milliseconds.
    const span = bookingSpan(at('2026-11-01T05:30:00.000Z'), 90);
    expect(span.to.getTime() - span.from.getTime()).toBe(90 * 60 * 1000);
  });
});

// ─── 3. Parity: one predicate, every producer ─────────────────────────────────

describe('every occupancy question is asked the same way', () => {
  it('the row probe resolves BOTH spans from the database', () => {
    /**
     * The caller supplies a provider and a booking id — never a duration. A
     * caller-supplied span is exactly how the preview and the committer came to
     * disagree about how long a job lasts.
     */
    const sql = CONFLICTING_BOOKING_SQL('servana');
    expect(sql).toContain('WITH target AS');
    expect(sql).toContain('LEFT JOIN servana.service_options');
    expect(sql).toContain('b.worker_uid = $1');
    expect(sql).toContain('b.id <> $2');
    expect(sql).not.toContain('$3');
    expect(sql).not.toContain('$4');
  });

  it('the set-shaped form takes a span and an exclusion', () => {
    const sql = BUSY_PROVIDERS_SQL('servana');
    expect(sql).toContain('$1::timestamptz');
    expect(sql).toContain('$2::timestamptz');
    // NULL exclusion for a slot preview that has no booking of its own yet.
    expect(sql).toContain('($3::int IS NULL OR b.id <> $3)');
  });

  it('both forms exclude the same non-occupying statuses', () => {
    for (const status of NON_OCCUPYING_STATUSES) {
      expect(CONFLICTING_BOOKING_SQL('servana')).toContain(`'${status}'`);
      expect(BUSY_PROVIDERS_SQL('servana')).toContain(`'${status}'`);
    }
  });

  const PRODUCERS = [
    'services/booking/transitionExecutor.ts',   // commit-time revalidation
    'services/technicianService.ts',            // auto-assignment selection
    'services/adminBookingService.ts',          // admin candidate preview
    'services/providerAvailabilityEngine.ts',   // the Admin availability answer
  ];

  it.each(PRODUCERS)('%s no longer carries a fixed window', (file) => {
    const code = codeOf(file);
    expect(code).not.toContain('conflictWindowFor');
    expect(code).not.toContain('CONFLICT_WINDOW_HOURS');
    expect(code).not.toContain('2 * 60 * 60 * 1000');
    expect(code).not.toContain("INTERVAL '2 hours'");
  });

  it.each(PRODUCERS)('%s uses a shared span builder', (file) => {
    expect(codeOf(file)).toMatch(
      /CONFLICTING_BOOKING_SQL|BUSY_PROVIDERS_SQL|OVERLAPS_SPAN_SQL|bookingEndSql|bookingSpan/,
    );
  });

  it('no producer writes its own duration fallback', () => {
    // `COALESCE(so.duration_mins, 120)` appeared in three files with the
    // constant retyped each time. One declaration now, or the next edit moves
    // one copy and leaves the others behind.
    for (const file of [...PRODUCERS, 'services/providerEligibilityEngine.ts']) {
      expect(codeOf(file)).not.toMatch(/COALESCE\(\s*so\.duration_mins\s*,\s*120\s*\)/);
    }
  });

  it('the executor no longer promises "within 2 hours" in its refusal', () => {
    // The message was the legacy one, and it stopped being true.
    const executor = codeOf('services/booking/transitionExecutor.ts');
    expect(executor).not.toContain('conflicting booking within 2 hours');
    expect(executor).toContain('conflicting booking during this job');
  });
});
