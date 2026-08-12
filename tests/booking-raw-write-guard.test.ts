/**
 * RAW STATUS MUTATION OUTSIDE THE EXECUTOR — an enforced migration, not a
 * cleanup promise.
 *
 * `transitionBooking` is meant to be the only writer of `bookings.status` and
 * `booking_workers.status`. It is not yet: legacy sites still write directly,
 * across three services — 21 of them when this guard was added. Converting them
 * all in one commit would combine new transition infrastructure, behaviour
 * changes on live paths and every caller's migration into a single blast
 * radius.
 *
 * So the count is a tracked gate instead. Every site is listed below with the
 * business operation it belongs to and the phase that will convert it. The
 * guard fails when:
 *
 *   - a raw mutation appears in a file the ledger does not list;
 *   - a file that was migrated starts writing directly again;
 *   - the count for an allow-listed file changes without the list changing.
 *
 * When the count reaches zero the allow-list is deleted and the rule becomes
 * simply: no raw status writes outside the executor.
 *
 * A file that reaches zero is REMOVED from the ledger rather than left with a
 * zero entry, so the list always reads as outstanding work. `bookingService`
 * went first, in Phase C; `adminBookingService` followed at the end of Phase
 * D. One legacy writer remains.
 *
 * ## What counts as a raw write
 *
 * An `UPDATE` against either table whose `SET` touches `status`. Reads are
 * unaffected — repositories and projections may read status freely. The
 * boundary being enforced is *mutation*.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '..', 'src');

/** Source with comments stripped — SQL quoted in a docblock is not a write. */
const codeOf = (abs: string): string =>
  fs
    .readFileSync(abs, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

interface RawWrite {
  file: string;
  table: 'bookings' | 'booking_workers';
  line: number;
}

/**
 * Does the statement STARTING at `lines[i]` mutate a lifecycle status?
 *
 * Extracted so the boundary rule can be tested against a fixture rather than
 * against whichever production line happens to have the right shape today.
 * The previous negative fixture named a real statement and stopped being a
 * counter-example the moment that statement legitimately started setting
 * status — a test only keeps proving something if what it proves does not
 * depend on unrelated code staying still.
 *
 * SQL spans template literals here, so the SET may be lines below the UPDATE.
 * The scan stops at the literal's closing backtick: a fixed line window bled
 * across statement boundaries and attributed the NEXT query's `SET status` to
 * a preceding pointer update.
 */
export function statusWriteAt(lines: string[], i: number): RawWrite['table'] | null {
  const m = /UPDATE\s+\$\{[^}]+\}\.(bookings|booking_workers)\b/i.exec(lines[i]);
  if (!m) return null;
  const ahead = lines.slice(i, i + 12).join('\n');
  const from = ahead.indexOf(m[0]);
  const end = ahead.indexOf('`', from);
  const stmt = end === -1 ? ahead : ahead.slice(from, end);
  if (!/\bSET\b/i.test(stmt)) return null;
  if (!/\bstatus\s*=/i.test(stmt)) return null;
  return m[1].toLowerCase() as RawWrite['table'];
}

function findRawWrites(): RawWrite[] {
  const hits: RawWrite[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;

      const rel = path.relative(SRC, full).split(path.sep).join('/');
      const lines = codeOf(full).split('\n');

      lines.forEach((_line, i) => {
        const table = statusWriteAt(lines, i);
        if (!table) return;
        hits.push({ file: rel, table, line: i + 1 });
      });
    }
  };
  walk(SRC);
  return hits;
}

/**
 * The migration ledger.
 *
 * `count` is how many raw writes that file may still contain. Each conversion
 * lowers a number here in the same commit that changes the code, so the diff
 * shows the progress and the guard proves it.
 */
const RAW_WRITE_ALLOWLIST: Record<string, { count: number; phase: string; reason: string }> = {
  'services/booking/transitionExecutor.ts': {
    count: 15,
    phase: 'EXECUTOR',
    reason:
      'THE executor. The one place permitted to write lifecycle state. One write '
      + 'is the atomic PROVIDER_START, which carries the worker-code predicate in '
      + 'the same statement rather than checking it separately. One is the '
      + 'LEGACY_STATUS_PROJECTION for EN_ROUTE / ARRIVED — a measured ServanaClient '
      + 'compatibility obligation with a retirement condition, not canonical '
      + 'state. One is the decline/cancel release, which returns the booking to '
      + 'the pool and clears worker_code in the same transaction as the '
      + 'transition. None of them moves the outstanding count, which counts '
      + 'writers OUTSIDE the executor.',
  },
  'services/technicianService.ts': {
    count: 2,
    phase: 'E2 — auto-assignment write ownership',
    reason:
      'THE LAST LEGACY WRITER. Every provider and admin action goes through '
      + 'the executor; PROVIDER_CANCEL (E1) took the 48-hour policy with it, so '
      + 'no controller evaluates that rule any more. Two sites remain, both in '
      + 'assignWorker — auto-assignment. Its SELECTION logic belongs to '
      + 'TAB 05; its WRITE does not, and E2 moves it. The gate stays 0: an '
      + 'assignment engine may choose a provider, never mutate lifecycle '
      + 'state.',
  },
};

describe('raw status writes are inventoried and shrinking', () => {
  const found = findRawWrites();

  const byFile = found.reduce<Record<string, number>>((acc, hit) => {
    acc[hit.file] = (acc[hit.file] ?? 0) + 1;
    return acc;
  }, {});

  it('no file writes lifecycle status unless it is on the ledger', () => {
    // The unlisted-writer check. A new direct write anywhere fails here, which is
    // the whole point of adding the guard before the migration rather than after.
    const unlisted = Object.keys(byFile).filter((f) => !(f in RAW_WRITE_ALLOWLIST));
    expect(unlisted).toEqual([]);
  });

  it.each(Object.entries(RAW_WRITE_ALLOWLIST))(
    '%s holds exactly the number of raw writes the ledger records',
    (file, entry) => {
      // Catches BOTH directions: a migrated file quietly writing again, and a
      // ledger entry left stale after a conversion.
      expect(byFile[file] ?? 0).toBe(entry.count);
    },
  );

  it('every ledger entry names a real file', () => {
    for (const file of Object.keys(RAW_WRITE_ALLOWLIST)) {
      expect(fs.existsSync(path.join(SRC, file))).toBe(true);
    }
  });

  it('every ledger entry states a phase and a reason', () => {
    for (const [, entry] of Object.entries(RAW_WRITE_ALLOWLIST)) {
      expect(entry.phase.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  /**
   * The ratchet.
   *
   * A migration that is only ever measured at the end is a migration that
   * quietly goes backwards in the middle. This is the baseline: no phase may
   * raise it, every phase may lower it, and lowering it means editing this
   * number in the same commit that changes the code.
   *
   * TAB 04 does not certify until it reads 0.
   */
  const APPROVED_BASELINE = 21;

  it('the outstanding count has not increased — no phase may add a raw write', () => {
    const outstanding = Object.entries(RAW_WRITE_ALLOWLIST)
      .filter(([file]) => file !== 'services/booking/transitionExecutor.ts')
      .reduce((n, [, e]) => n + e.count, 0);

    expect(outstanding).toBeLessThanOrEqual(APPROVED_BASELINE);
  });

  it('the ledger and the code agree on the outstanding count', () => {
    // Belt and braces against the ledger being lowered without the code
    // changing: the ledger's per-file numbers are already checked against the
    // scan above, so this catches an arithmetic slip in the baseline itself.
    const fromLedger = Object.entries(RAW_WRITE_ALLOWLIST)
      .filter(([file]) => file !== 'services/booking/transitionExecutor.ts')
      .reduce((n, [, e]) => n + e.count, 0);
    const fromScan = Object.entries(byFile)
      .filter(([file]) => file !== 'services/booking/transitionExecutor.ts')
      .reduce((n, [, count]) => n + count, 0);
    expect(fromLedger).toBe(fromScan);
  });

  it('the detector finds writes at all (positive fixture)', () => {
    // A guard that reports zero because its regex is broken looks identical to
    // a clean codebase. The executor itself is the fixture: it must be found.
    expect(byFile['services/booking/transitionExecutor.ts']).toBeGreaterThan(0);
  });

  it('a SET that does not touch status is not a lifecycle write (negative fixture)', () => {
    // ADMIN_REASSIGN writes `SET worker_uid` and, a few lines later, a separate
    // statement writes `SET status`. A fixed line window joined the two and
    // counted the reassignment pointer update as a status mutation. Changing
    // ownership is not changing lifecycle state, and a guard that cannot tell
    // them apart will mis-report the migration it exists to measure.
    // A SYNTHETIC fixture, deliberately. This used to name a real statement in
    // the executor and stopped being a counter-example the moment that
    // statement legitimately started setting status too.
    const fixture = [
      '      await client.query(',
      '        `UPDATE ${s}.bookings SET worker_uid = $2 WHERE id = $1`,',
      '        [loaded.id, nextProvider],',
      '      );',
      '      await client.query(',
      "        `UPDATE ${s}.bookings SET status = 'CONFIRMED' WHERE id = $1`,",
      '        [loaded.id],',
      '      );',
    ];
    expect(statusWriteAt(fixture, 1)).toBeNull();
    // Positive half: the statement that DOES set status is still found.
    expect(statusWriteAt(fixture, 5)).toBe('bookings');
  });

  it('a multi-line statement is still detected (boundary control)', () => {
    // The boundary rule must not degrade into "only single-line statements
    // count" — most of the executor's SQL spans several lines.
    const fixture = [
      '        `UPDATE ${s}.booking_workers',
      '            SET status = $3,',
      '                accepted_at = NOW()',
      '          WHERE booking_id = $1`,',
    ];
    expect(statusWriteAt(fixture, 0)).toBe('booking_workers');
  });

  it('the detector ignores SQL quoted inside a comment (negative fixture)', () => {
    // `bookingResponseConflict.ts` documents the racing UPDATE in a docblock.
    // Counting that would inflate the ledger with prose.
    const conflict = path.join(SRC, 'services/bookingResponseConflict.ts');
    const raw = fs.readFileSync(conflict, 'utf8').replace(/\r\n/g, '\n');
    expect(raw).toContain('UPDATE booking_workers SET status');
    expect(byFile['services/bookingResponseConflict.ts'] ?? 0).toBe(0);
  });
});

describe('the executor is the intended sole writer', () => {
  const executor = codeOf(path.join(SRC, 'services/booking/transitionExecutor.ts'));

  it('writes inside a transaction it owns', () => {
    expect(executor).toContain("client.query('BEGIN')");
    expect(executor).toContain("client.query('COMMIT')");
    expect(executor).toContain("client.query('ROLLBACK')");
  });

  it('locks the booking row before deciding anything', () => {
    // Optimistic checking alone would let two providers both read ASSIGNED and
    // both proceed. The lock is what makes the second one wait and then lose.
    expect(executor).toContain('FOR UPDATE');
  });

  it('appends the timeline in the SAME transaction as the status write', () => {
    // lastIndexOf for the COMMIT: the same-target no-op and the event-only
    // branch each commit earlier in the FILE, and indexOf would compare
    // against one of those rather than the transition path's.
    const insert = executor.indexOf('INSERT INTO ${s}.booking_transitions');
    const commit = executor.lastIndexOf("client.query('COMMIT')");
    expect(insert).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(insert);
  });

  it('takes an ACTION, never a destination state', () => {
    // A caller naming a destination can pick any state the machine happens to
    // allow and bypass the rule that was supposed to get it there.
    expect(executor).toContain('action: BookingAction');
    expect(executor).not.toMatch(/toState\s*:\s*BookingState;\s*\n\s*actorUid/);
  });

  it('derives the current state from the LOCKED rows, not from the request', () => {
    const load = executor.indexOf('loadForUpdate(client');
    const derive = executor.indexOf('deriveCanonicalState({');
    expect(load).toBeGreaterThan(-1);
    expect(derive).toBeGreaterThan(load);
  });

  it('authorizes from loaded rows, never from a client-supplied id', () => {
    expect(executor).toContain('loaded.customerUid === actorUid');
    expect(executor).toContain('loaded.workerUid === actorUid');
    // No reading of an actor identity out of the payload.
    expect(executor).not.toMatch(/metadata\??\.\s*(customerUid|userId|workerUid)\b/);
  });

  it('writes only the canonical cancelled spelling', () => {
    expect(executor).toContain('CANONICAL_CANCELLED');
    expect(executor).not.toMatch(/=\s*['"]CANCELED['"]/);
  });

  it('never writes DISPUTED into bookings.status', () => {
    // A dispute is an exception ON TOP of the service outcome. Writing it into
    // the status column would erase whether the booking completed or was
    // cancelled — and those have different financial consequences.
    expect(executor).not.toMatch(/SET status = 'DISPUTED'/);
    expect(executor).toContain('priorTerminalState');
  });

  it('redacts secrets before they reach the timeline', () => {
    expect(executor).toContain('redactMetadata');
    expect(executor).toContain("'workerCode'");
  });
});
