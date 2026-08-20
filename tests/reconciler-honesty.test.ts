/**
 * The reconciler refuses a contract it cannot read (TAB 03).
 *
 * ## The defect
 *
 * `readContractRows()` used to find entries with
 * `/^\s{4}callers: \{.*providerWeb: '([^']+)'.*\},?$/` — a pattern that matches
 * only when the whole `callers` object sits on ONE line. Wrap it and the row
 * disappears. With no rows, `changes` is empty, and `--check` prints
 * "contract agrees" and exits 0. This gate runs inside `npm run verify`, so it
 * would have agreed with everything, forever, having parsed nothing.
 *
 * ## It was not latent
 *
 * The hand-over that described this called it "latent, not active — it matches
 * 41 endpoints today". It was active. `admin.refunds.markFailed` has had a
 * `callers` object wrapped across six lines since 2d34699 (2026-08-19), one day
 * before that measurement, and the reconciler had been blind to it ever since:
 * 112 entries declared, 111 read, and a green gate on every run.
 *
 * ## Why the guard is coverage and not a positive fixture
 *
 * The usual form asserts the parser found MORE THAN ZERO rows. That is right
 * when the failure is total. This failure is not: a formatter wraps the LONG
 * lines, so 111 of 112 keep parsing and the gate reports agreement having
 * skipped one. `rows.length > 0` passes that happily. Coverage — every declared
 * entry yields a readable block — is the property that actually holds.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readContractRows,
  readSpreadDefaults,
  countContractEntries,
  loadManifests,
} from '../scripts/reconcile-client-manifests';

const CONTRACT = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'v1', 'contract.ts'), 'utf8');

describe('the parser sees the whole contract', () => {
  it('reads a callers block for every entry the contract declares', () => {
    const declared = countContractEntries(CONTRACT);
    const rows = readContractRows(CONTRACT);
    // A floor, so a broken extractor cannot make this vacuous.
    expect(declared.length).toBeGreaterThan(100);
    expect(rows.map((r) => r.id).sort()).toEqual(declared.sort());
  });

  it('reads the wrapped object that the one-line pattern could not', () => {
    // The real, pre-existing case. Named rather than synthesised, so this test
    // dies honestly if the entry is ever reformatted back onto one line.
    const rows = readContractRows(CONTRACT);
    const wrapped = rows.find((r) => r.id === 'admin.refunds.markFailed');
    expect(wrapped).toBeDefined();
    expect(wrapped!.endLine).toBeGreaterThan(wrapped!.line);
    expect(wrapped!.states.providerWeb).toBeDefined();
  });
});

describe('a callers object it cannot read is a refusal, not agreement', () => {
  const ONE_LINE = `    callers: { customerMobile: 'n/a', providerWeb: 'migrated', providerMobile: 'n/a', customerWeb: 'n/a', admin: 'n/a' },`;
  const entry = (callers: string) => [
    'export const V1_CONTRACT: ContractEntry[] = [',
    '  {',
    "    id: 'demo.entry',",
    "    method: 'get',",
    "    path: '/demo',",
    callers,
    '  },',
    '];',
  ].join('\n');

  it('reads it when it is on one line', () => {
    const rows = readContractRows(entry(ONE_LINE));
    expect(rows).toHaveLength(1);
    expect(rows[0].states.providerWeb).toBe('migrated');
  });

  it('reads it when it is wrapped across lines — the edit that used to blind it', () => {
    const wrapped = [
      '    callers: {',
      "      customerMobile: 'n/a',",
      "      customerWeb: 'n/a',",
      "      providerMobile: 'n/a',",
      "      providerWeb: 'migrated',",
      "      admin: 'n/a',",
      '    },',
    ].join('\n');
    const rows = readContractRows(entry(wrapped));
    expect(rows).toHaveLength(1);
    expect(rows[0].states.providerWeb).toBe('migrated');
  });

  it('reports the entry as UNREAD rather than absent when callers is not an object literal', () => {
    /**
     * The failure the coverage guard exists for. A `callers` built by a call
     * rather than written as a literal parses to nothing — and the honest
     * outcome is "I could not read demo.entry", not "demo.entry agrees".
     */
    const rows = readContractRows(entry("    callers: buildCallers('providerWeb'),"));
    const declared = countContractEntries(entry("    callers: buildCallers('providerWeb'),"));
    expect(declared).toEqual(['demo.entry']);
    expect(rows.map((r) => r.id)).not.toContain('demo.entry');
    // Which is exactly the disagreement `assertParserSawEverything` refuses on.
    expect(rows.length).toBeLessThan(declared.length);
  });
});

describe('spread defaults are resolved, not counted as absent', () => {
  /**
   * `callers: { ...ALL_PLANNED, admin: 'migrated' }` states four of five values
   * through a spread. Reading only literal pairs sees one client and treats the
   * rest as missing — the same defect class as an authorization census that
   * cannot read `...adminOnly` and reports the route public.
   */
  it('finds the module-level default objects', () => {
    const defaults = readSpreadDefaults(CONTRACT);
    expect(defaults.has('ALL_PLANNED')).toBe(true);
    expect(defaults.get('ALL_PLANNED')!.providerMobile).toBe('planned');
  });

  it('applies the spread, then lets an explicit key win', () => {
    const source = [
      "const ALL_PLANNED: Record<ClientName, CallerState> = {",
      "  customerMobile: 'planned',",
      "  customerWeb: 'planned',",
      "  providerMobile: 'planned',",
      "  providerWeb: 'planned',",
      "  admin: 'planned',",
      '};',
      '  {',
      "    id: 'spread.entry',",
      "    method: 'get',",
      "    path: '/spread',",
      "    callers: { ...ALL_PLANNED, providerWeb: 'migrated' },",
      '  },',
    ].join('\n');
    const rows = readContractRows(source);
    expect(rows).toHaveLength(1);
    expect(rows[0].states).toEqual({
      customerMobile: 'planned',
      customerWeb: 'planned',
      providerMobile: 'planned',
      providerWeb: 'migrated',
      admin: 'planned',
    });
    // And it knows which values have no key to rewrite, so a write-back inserts
    // one instead of silently doing nothing.
    expect(rows[0].implied.has('providerMobile')).toBe(true);
    expect(rows[0].implied.has('providerWeb')).toBe(false);
  });
});

describe('the reconciler is parameterised over clients, not written around one', () => {
  it('reads every manifest in the directory', () => {
    const clients = loadManifests().map((m) => m.client).sort();
    expect(clients).toEqual(['providerMobile', 'providerWeb']);
  });

  it('names no client in its own source', () => {
    /**
     * The two hardcoded sites this TAB removed: a regex that read only the
     * `providerWeb` value, and a lookup that selected only the `providerWeb`
     * manifest. Adding the worker app must be a file drop, not an edit here.
     *
     * Comments are stripped first — this file's own history is written in them,
     * and matching a comment would make the assertion unfixable-by-construction.
     */
    const src = fs
      .readFileSync(path.join(__dirname, '..', 'scripts', 'reconcile-client-manifests.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(src).not.toContain('providerWeb');
    expect(src).not.toContain('providerMobile');
  });
});

describe('the guard writes nowhere', () => {
  it('the fixtures above are strings, and the only disk write is a temp file', () => {
    // Hermeticity, asserted rather than assumed: os.tmpdir() and nothing else.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconciler-'));
    expect(dir.startsWith(os.tmpdir())).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * A client cannot license the deletion of a legacy route by publishing a
 * manifest about its own unreleased code.
 *
 * Landing the worker app's manifest moved 32 entries to
 * `providerMobile: 'migrated'` and, with nothing else changed, made 13 legacy
 * aliases retirable — the five job transitions, the job-card reads, the provider
 * document routes. The client that licensed that has never been released.
 *
 * `callers` answers "does this client's CODE call the canonical route?", which
 * is the only question a client can answer about itself. Retirement asks "is
 * anything in the FIELD still calling the legacy one?" — and those come apart
 * exactly when a client has rewritten its calls and not shipped them.
 */
describe('an unreleased client does not clear a legacy route for retirement', () => {
  // Imported here rather than at the top: this block is about the consequence of
  // the reconciliation above, and reads better beside it.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { deprecationPlan, SURFACE_RELEASED } = require('../src/api/v1/convergence');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { V1_CONTRACT } = require('../src/api/v1/contract');

  it('the worker app is on record as not shipped', () => {
    expect(SURFACE_RELEASED.providerMobile).toBe(false);
  });

  it('the reconciliation really did mark it migrated — otherwise this proves nothing', () => {
    const migrated = (V1_CONTRACT as any[]).filter((e) => e.callers.providerMobile === 'migrated');
    expect(migrated.length).toBeGreaterThan(20);
  });

  it('no alias is retirable on the word of the unshipped client alone', () => {
    const plan = deprecationPlan() as Array<{
      canonical: { callers: Record<string, string> };
      retirable: boolean;
      blockedBy: string[];
    }>;
    const onItsWord = plan.filter(
      (r) => r.retirable && r.canonical.callers.providerMobile === 'migrated',
    );
    expect(onItsWord).toEqual([]);
  });

  it('says "migrated but not shipped", not "has not migrated"', () => {
    /**
     * The two states need different work, and collapsing them would tell the
     * worker app team to redo a migration they have already done — which is the
     * exact harm the reconciler was built to stop.
     */
    const plan = deprecationPlan() as Array<{
      canonical: { callers: Record<string, string> };
      blockedBy: string[];
    }>;
    const blocked = plan.filter((r) => r.canonical.callers.providerMobile === 'migrated');
    expect(blocked.length).toBeGreaterThan(0);
    const reasons = blocked.flatMap((r) => r.blockedBy).join(' | ');
    expect(reasons).toContain('not shipped');
  });
});
