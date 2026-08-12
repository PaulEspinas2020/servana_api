/**
 * The LEGACY_AUTO candidate-delta harness, proven safe before it is ever run.
 *
 * It points at production. Everything about it therefore has to be provable
 * without connecting to anything: that it cannot write, that it will not guess
 * at credentials, that it emits no PII, and that it classifies the same way
 * every time.
 *
 * None of these tests open a connection.
 */

import fs from 'fs';
import path from 'path';

import {
  isReadOnlyStatement,
  resolveMeasureConfig,
  classifyCandidate,
  buildReport,
  hashProvider,
  DELTA_QUERY,
  EXAMPLE_REPORT,
  type CandidateRow,
} from '../scripts/measure-legacy-auto-delta';
import { PROVIDER_ROLES } from '../src/constants/providerRoles';

const SCRIPT = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'measure-legacy-auto-delta.ts'), 'utf8',
);

// ─── It cannot write ──────────────────────────────────────────────────────────

describe('READ-ONLY: mutation is impossible three ways', () => {
  it('the query it sends is a read', () => {
    expect(isReadOnlyStatement(DELTA_QUERY('servana'))).toBe(true);
  });

  it('rejects every mutation keyword', () => {
    for (const sql of [
      'INSERT INTO servana.bookings VALUES (1)',
      'UPDATE servana.bookings SET status = $1',
      'DELETE FROM servana.bookings',
      'DROP TABLE servana.bookings',
      'TRUNCATE servana.bookings',
      'ALTER TABLE servana.bookings ADD COLUMN x INT',
      'GRANT ALL ON servana.bookings TO public',
      'CREATE INDEX ON servana.bookings (id)',
    ]) {
      expect(`${sql.split(' ')[0]}:${isReadOnlyStatement(sql)}`)
        .toBe(`${sql.split(' ')[0]}:false`);
    }
  });

  it('rejects a write smuggled into a data-modifying CTE', () => {
    /**
     * The case an allow-list alone would miss. This is valid PostgreSQL and
     * very much a write, and it STARTS with `WITH`.
     */
    const sneaky = 'WITH gone AS (DELETE FROM servana.bookings RETURNING id) SELECT * FROM gone';
    expect(isReadOnlyStatement(sneaky)).toBe(false);
  });

  it('is not fooled by a keyword hidden in a comment', () => {
    // Comments are stripped before the check, so a legitimate query mentioning
    // a keyword in prose is not refused...
    expect(isReadOnlyStatement('SELECT 1 -- we never DELETE here')).toBe(true);
    expect(isReadOnlyStatement('/* no UPDATE */ SELECT 1')).toBe(true);
    // ...but stripping does not let a real write through.
    expect(isReadOnlyStatement('SELECT 1; DELETE FROM servana.bookings')).toBe(false);
  });

  it('opens the session and the transaction read-only', () => {
    // Belt, braces and a second pair of braces. The server refuses a write even
    // if the in-process check were somehow bypassed.
    expect(SCRIPT).toContain('default_transaction_read_only=on');
    expect(SCRIPT).toContain("client.query('BEGIN READ ONLY')");
    expect(SCRIPT).toContain("client.query('ROLLBACK')");
  });

  it('checks the statement BEFORE sending it', () => {
    const checkAt = SCRIPT.indexOf('if (!isReadOnlyStatement(sql))');
    const sendAt = SCRIPT.indexOf('await client.query(sql)');
    expect(checkAt).toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(sendAt);
  });
});

// ─── It will not guess ────────────────────────────────────────────────────────

describe('FAIL CLOSED: no credentials are inferred', () => {
  it('refuses without the explicit opt-in', () => {
    const r = resolveMeasureConfig({
      PG_MEASURE_HOST: 'h', PG_MEASURE_DATABASE: 'd',
      PG_MEASURE_USER: 'u', PG_MEASURE_PASSWORD: 'p',
    } as NodeJS.ProcessEnv);
    expect(r.usable).toBe(false);
    expect((r as { reason: string }).reason).toContain('ALLOW_PRODUCTION_MEASUREMENT');
  });

  it('refuses when any dedicated variable is missing', () => {
    const base = {
      ALLOW_PRODUCTION_MEASUREMENT: 'true',
      PG_MEASURE_HOST: 'h', PG_MEASURE_DATABASE: 'd',
      PG_MEASURE_USER: 'u', PG_MEASURE_PASSWORD: 'p',
    };
    for (const drop of ['PG_MEASURE_HOST', 'PG_MEASURE_DATABASE', 'PG_MEASURE_USER', 'PG_MEASURE_PASSWORD']) {
      const env = { ...base } as Record<string, string>;
      delete env[drop];
      const r = resolveMeasureConfig(env as NodeJS.ProcessEnv);
      expect(`${drop}:${r.usable}`).toBe(`${drop}:false`);
    }
  });

  it('NEVER falls back to the application DB_* variables', () => {
    /**
     * The property that matters most. A fallback is how a script written for
     * staging ends up reading production because somebody had a `.env` loaded.
     */
    const r = resolveMeasureConfig({
      ALLOW_PRODUCTION_MEASUREMENT: 'true',
      DB_HOST: 'prod', DB_DATABASE: 'servana', DB_USER: 'admin', DB_PASSWORD: 'secret',
    } as NodeJS.ProcessEnv);
    expect(r.usable).toBe(false);
    expect(SCRIPT).not.toContain('DB_HOST');
    expect(SCRIPT).not.toContain('process.env.DB_');
  });

  it('accepts only a complete, explicit configuration', () => {
    const r = resolveMeasureConfig({
      ALLOW_PRODUCTION_MEASUREMENT: 'true',
      PG_MEASURE_HOST: 'h', PG_MEASURE_PORT: '6543', PG_MEASURE_DATABASE: 'd',
      PG_MEASURE_USER: 'u', PG_MEASURE_PASSWORD: 'p', PG_MEASURE_SCHEMA: 'other',
    } as NodeJS.ProcessEnv);
    expect(r.usable).toBe(true);
    expect((r as { config: { port: number; schema: string } }).config.port).toBe(6543);
    expect((r as { config: { port: number; schema: string } }).config.schema).toBe('other');
  });
});

// ─── It emits no PII ──────────────────────────────────────────────────────────

describe('NO PII leaves the harness', () => {
  const rows: CandidateRow[] = [
    { providerUid: 'real-provider-uid-1', role: 3, isArchived: false, hasCapability: true },
    { providerUid: 'real-provider-uid-2', role: 2, isArchived: true, hasCapability: false },
  ];

  it('provider identifiers are hashed, not passed through', () => {
    const report = buildReport(rows, '2026-08-12T00:00:00.000Z');
    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain('real-provider-uid-1');
    expect(serialised).not.toContain('real-provider-uid-2');
    for (const p of report.providers) expect(p.provider).toMatch(/^p_[0-9a-f]{12}$/);
  });

  it('the hash is stable and non-reversible in shape', () => {
    expect(hashProvider('abc')).toBe(hashProvider('abc'));
    expect(hashProvider('abc')).not.toBe(hashProvider('abd'));
    expect(hashProvider('abc')).not.toContain('abc');
  });

  it('the query selects no names, emails, phones or addresses', () => {
    const sql = DELTA_QUERY('servana');
    for (const column of ['first_name', 'last_name', 'email', 'phone', 'address', 'service_address']) {
      expect(`${column}:${sql.includes(column)}`).toBe(`${column}:false`);
    }
  });

  it('the failure path prints no credentials or driver internals', () => {
    expect(SCRIPT).toContain("err?.message ?? 'unknown error'");
  });
});

// ─── Classification is deterministic ──────────────────────────────────────────

describe('DETERMINISTIC classification', () => {
  it('an eligible provider produces no reasons', () => {
    const role = Number([...PROVIDER_ROLES][0]);
    expect(classifyCandidate({ providerUid: 'x', role, isArchived: false, hasCapability: true }))
      .toEqual([]);
  });

  it('every canonical provider role passes the role check', () => {
    // Role 4 is a provider too. Asking `role === 2` is the bug this measurement
    // must not reproduce while measuring.
    for (const role of PROVIDER_ROLES) {
      expect(classifyCandidate({
        providerUid: 'x', role: Number(role), isArchived: false, hasCapability: true,
      })).toEqual([]);
    }
  });

  it('returns EVERY reason, not the first', () => {
    // "How many ways is this provider ineligible" is the more useful question
    // when deciding whether the correction is safe to enable.
    expect(classifyCandidate({
      providerUid: 'x', role: 99, isArchived: true, hasCapability: false,
    })).toEqual(['ROLE_NOT_PROVIDER', 'ARCHIVED', 'NO_CAPABILITY']);
  });

  it('treats a missing role as not-a-provider', () => {
    expect(classifyCandidate({ providerUid: 'x', role: null, isArchived: false, hasCapability: true }))
      .toEqual(['ROLE_NOT_PROVIDER']);
  });

  it('is order-independent and repeatable', () => {
    const row: CandidateRow = { providerUid: 'x', role: 99, isArchived: true, hasCapability: false };
    const first = classifyCandidate(row);
    for (let i = 0; i < 20; i += 1) expect(classifyCandidate(row)).toEqual(first);
  });

  it('does NOT test the schedule conflict', () => {
    /**
     * LEGACY_AUTO already enforces it, so it cannot contribute to the delta.
     * Including it would overstate the displacement and make the correction
     * look more dangerous than it is.
     */
    expect(SCRIPT).not.toContain('CONFLICTING_BOOKING_SQL');
    expect(DELTA_QUERY('servana')).not.toContain('schedule BETWEEN');
  });
});

describe('the report is deterministic and complete', () => {
  const rows: CandidateRow[] = [
    { providerUid: 'a', role: 2, isArchived: false, hasCapability: true },
    { providerUid: 'b', role: 2, isArchived: false, hasCapability: false },
    { providerUid: 'b', role: 2, isArchived: false, hasCapability: false },
    { providerUid: 'c', role: 9, isArchived: true, hasCapability: false },
  ];

  it('counts totals and the percentage', () => {
    const r = buildReport(rows, 'T');
    expect(r.totals.autoAssignments).toBe(4);
    expect(r.totals.wouldBeRefused).toBe(3);
    expect(r.totals.refusedPercent).toBe(75);
  });

  it('counts each failure reason independently', () => {
    const r = buildReport(rows, 'T');
    expect(r.byFailure.NO_CAPABILITY).toBe(3);
    expect(r.byFailure.ARCHIVED).toBe(1);
    expect(r.byFailure.ROLE_NOT_PROVIDER).toBe(1);
  });

  it('orders providers stably, so two runs diff cleanly', () => {
    const a = JSON.stringify(buildReport(rows, 'T'));
    const b = JSON.stringify(buildReport([...rows].reverse(), 'T'));
    expect(a).toBe(b);
  });

  it('an empty dataset does not divide by zero', () => {
    const r = buildReport([], 'T');
    expect(r.totals.refusedPercent).toBe(0);
    expect(r.providers).toEqual([]);
  });

  it('the documented example matches the real report shape', () => {
    // The operator reads EXAMPLE_REPORT to know what to expect. If the shape
    // drifts from it, the documentation is lying.
    const real = buildReport(rows, 'T');
    expect(Object.keys(real).sort()).toEqual(Object.keys(EXAMPLE_REPORT).sort());
    expect(Object.keys(real.totals).sort()).toEqual(Object.keys(EXAMPLE_REPORT.totals).sort());
    expect(Object.keys(real.byFailure).sort()).toEqual(Object.keys(EXAMPLE_REPORT.byFailure).sort());
  });
});

// ─── It changes nothing ───────────────────────────────────────────────────────

describe('the harness changes no assignment behaviour', () => {
  it('is a script, not wired into the application', () => {
    const src = path.join(__dirname, '..', 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        if (fs.readFileSync(full, 'utf8').includes('measure-legacy-auto-delta')) {
          offenders.push(path.relative(src, full));
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });

  it('AUTO_ASSIGN still uses LEGACY_AUTO — measuring is not correcting', () => {
    const executor = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'booking', 'transitionExecutor.ts'), 'utf8',
    );
    expect(executor).toContain("targetValidation: 'LEGACY_AUTO'");
  });
});
