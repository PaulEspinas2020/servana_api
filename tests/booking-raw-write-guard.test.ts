/**
 * RAW STATUS MUTATION OUTSIDE THE EXECUTOR — an enforced migration, not a
 * cleanup promise.
 *
 * `transitionBooking` is meant to be the only writer of `bookings.status` and
 * `booking_workers.status`. It is not yet: 21 legacy sites still write
 * directly, across three services. Converting them all in one commit would
 * combine new transition infrastructure, behaviour changes on live paths and
 * every caller's migration into a single blast radius.
 *
 * So the count is a tracked gate instead. Every site is listed below with the
 * business operation it belongs to and the phase that will convert it. The
 * guard fails when:
 *
 *   - a 22nd raw mutation appears anywhere;
 *   - a file that was migrated starts writing directly again;
 *   - the count for an allow-listed file changes without the list changing.
 *
 * When the count reaches zero the allow-list is deleted and the rule becomes
 * simply: no raw status writes outside the executor.
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

function findRawWrites(): RawWrite[] {
  const hits: RawWrite[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;

      const rel = path.relative(SRC, full).split(path.sep).join('/');
      const lines = codeOf(full).split('\n');

      lines.forEach((line, i) => {
        const m = /UPDATE\s+\$\{[^}]+\}\.(bookings|booking_workers)\b/i.exec(line);
        if (!m) return;
        // SQL here spans template literals; look ahead for the SET … status.
        const window = lines.slice(i, i + 8).join('\n');
        if (!/\bSET\b/i.test(window)) return;
        if (!/\bstatus\s*=/i.test(window)) return;
        hits.push({ file: rel, table: m[1].toLowerCase() as RawWrite['table'], line: i + 1 });
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
    count: 10,
    phase: 'EXECUTOR',
    reason:
      'THE executor. The one place permitted to write lifecycle state. The tenth '
      + 'write is the atomic PROVIDER_START, which carries the worker-code '
      + 'predicate in the same statement rather than checking it separately.',
  },
  'services/bookingService.ts': {
    count: 3,
    phase: 'B — customer cancellation / OTP confirm',
    reason: 'Customer cancel and confirm-OTP still write directly.',
  },
  'services/technicianService.ts': {
    count: 10,
    phase: 'C — provider accept / decline / start / complete',
    reason:
      'The provider lifecycle writer. Ten sites covering accept, decline, arrival ' +
      'stages, start and complete. Highest-traffic family, migrated after the ' +
      'executor is proven under race and retry.',
  },
  'services/adminBookingService.ts': {
    count: 8,
    phase: 'D — admin assign / reassign / cancel / complete',
    reason: 'Admin operational actions, including the reassignment write.',
  },
};

describe('raw status writes are inventoried and shrinking', () => {
  const found = findRawWrites();

  const byFile = found.reduce<Record<string, number>>((acc, hit) => {
    acc[hit.file] = (acc[hit.file] ?? 0) + 1;
    return acc;
  }, {});

  it('no file writes lifecycle status unless it is on the ledger', () => {
    // The 22nd-mutation check. A new direct write anywhere fails here, which is
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

  it('the detector ignores SQL quoted inside a comment (negative fixture)', () => {
    // `bookingResponseConflict.ts` documents the racing UPDATE in a docblock.
    // Counting that would inflate the ledger with prose.
    const conflict = path.join(SRC, 'services/bookingResponseConflict.ts');
    const raw = fs.readFileSync(conflict, 'utf8');
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
    const insert = executor.indexOf('INSERT INTO ${s}.booking_transitions');
    const commit = executor.indexOf("client.query('COMMIT')");
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
