/**
 * Derive `callers.<client>` from each client's published manifest (TAB 04).
 *
 * ## The problem this replaces
 *
 * `src/api/v1/contract.ts` records, per endpoint, which clients are on the
 * canonical route and which are still on a legacy one. That flag is maintained
 * by hand, in this repository, about code in five others. Measured 2026-08-18:
 * across all 109 entries the value `providerWeb: 'migrated'` appeared **zero
 * times**, while 36 entries name a canonical path the Provider Web portal calls
 * unconditionally, with a file:line for each.
 *
 * The consequence is structural rather than cosmetic. Alias retirement requires
 * every client the matrix lists to read `migrated: true`; with none recorded,
 * none of the 89 `ALIAS_TEMPORARILY` routes can ever be retired. And because
 * `PER_CLIENT_MIGRATION_PLAN.md` is GENERATED from this field, it instructed the
 * Provider Web team to redo capabilities they had already shipped. A derived
 * document that is confidently wrong is worse than no document, because it is
 * generated and therefore trusted.
 *
 * ## The rule
 *
 * The client that changes the call changes the record, in the same commit. Each
 * client publishes the canonical endpoints it calls; this script reads those
 * manifests and writes the derived state into the contract. Nothing here is
 * hand-listed — remove a call from the portal and the next run turns the row
 * back.
 *
 * `--check` fails when the contract disagrees with the manifests, so drift is a
 * red build rather than a discovery six months later.
 *
 * ## Scope
 *
 * Only clients with a manifest are touched. Customer Web, Provider Mobile,
 * Customer Mobile and Admin Web have none yet, and their rows are left exactly
 * as they are — a guess dressed as a derivation would recreate the defect in a
 * new place. TAB 04 mandate 2 asks for those manifests; they are listed as
 * outstanding rather than fabricated here.
 */

import * as fs from 'fs';
import * as path from 'path';

const CONTRACT = path.join(__dirname, '..', 'src', 'api', 'v1', 'contract.ts');
const MANIFEST_DIR = path.join(__dirname, '..', 'src', 'api', 'v1', 'client-manifests');

interface ManifestEndpoint { method: string; path: string; cites: string[] }
interface ClientManifest { client: string; endpoints: ManifestEndpoint[] }

/** Parameter names differ between a call site and the contract; shape does not. */
const shape = (p: string) => p.replace(/:[A-Za-z0-9_]+/g, ':param').replace(/\/+$/, '');
const key = (method: string, p: string) => `${method.toLowerCase()} ${shape(p)}`;

export function loadManifests(): ClientManifest[] {
  if (!fs.existsSync(MANIFEST_DIR)) return [];
  return fs
    .readdirSync(MANIFEST_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(MANIFEST_DIR, f), 'utf8')) as ClientManifest);
}

/** The (method, path) keys a client calls canonically, with the `/v1` prefix removed. */
export function calledKeys(manifest: ClientManifest): Set<string> {
  return new Set(manifest.endpoints.map((e) => key(e.method, e.path.replace(/^\/v1/, ''))));
}

export interface Row {
  id: string;
  method: string;
  path: string;
  /** Line index of `callers: {`. */
  line: number;
  /** Line index of the line carrying the block's closing brace. */
  endLine: number;
  /** Caller state per client, with spreads resolved. */
  states: Record<string, string>;
  /** Clients whose state comes from a spread, so there is no key to rewrite. */
  implied: Set<string>;
}

/**
 * Module-level `const X: Record<ClientName, CallerState> = { ... }` defaults.
 *
 * `callers: { ...ALL_PLANNED, admin: 'migrated' }` states four of its five
 * values through a spread. A parser that reads only literal `client: 'value'`
 * pairs sees one client and silently treats the other four as absent — which is
 * the SAME defect class as an authorization census that cannot read
 * `...adminOnly` and calls the route public.
 *
 * Resolved from the source rather than hardcoded: a second default object added
 * later is picked up without editing this script.
 */
export function readSpreadDefaults(source: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  const re = /const\s+([A-Z][A-Z0-9_]*)\s*:\s*Record<ClientName,\s*CallerState>\s*=\s*\{([\s\S]*?)\};/g;
  for (const m of source.matchAll(re)) {
    const states: Record<string, string> = {};
    for (const pair of m[2].matchAll(/([A-Za-z][A-Za-z0-9_]*)\s*:\s*'([^']+)'/g)) states[pair[1]] = pair[2];
    out.set(m[1], states);
  }
  return out;
}

/**
 * The index of the line carrying the `}` that closes a block opened on `start`.
 *
 * Brace-balanced rather than "the next line ending in `}`": a `callers` object
 * is shallow today, and a parser that assumes that is one nested object away
 * from silently truncating.
 */
function closingLineOf(lines: string[], start: number): number {
  let depth = 0;
  for (let i = start; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}

/**
 * Every entry in the contract source, with its `callers` block resolved.
 *
 * Reads the block whether it sits on one line or twenty. The previous version
 * required the whole object on a single line — `/^\s{4}callers: \{.*providerWeb:
 * '([^\']+)'.*\},?$/` — so a formatter, a longer line, or a sixth client would
 * have made it return nothing while `--check` printed "contract agrees" and
 * exited 0. It was already returning one row short.
 */
export function readContractRows(source: string): Row[] {
  const lines = source.split('\n');
  const defaults = readSpreadDefaults(source);
  const rows: Row[] = [];
  let id = '', method = '', endpointPath = '';

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const idMatch = /^\s{4}id: '([^']+)'/.exec(line);
    if (idMatch) { id = idMatch[1]; method = ''; endpointPath = ''; continue; }
    const methodMatch = /^\s{4}method: '([^']+)'/.exec(line);
    if (methodMatch) { method = methodMatch[1]; continue; }
    const pathMatch = /^\s{4}path: '([^']+)'/.exec(line);
    if (pathMatch) { endpointPath = pathMatch[1]; continue; }
    if (!/^\s{4}callers: \{/.test(line) || !id) continue;

    const endLine = closingLineOf(lines, i);
    if (endLine === -1) continue; // Unbalanced: the guard will name it.
    const body = lines.slice(i, endLine + 1).join('\n');

    const states: Record<string, string> = {};
    const implied = new Set<string>();
    // Spreads first, explicit keys second — later wins, which is what the
    // TypeScript object literal itself does.
    for (const spread of body.matchAll(/\.\.\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const preset = defaults.get(spread[1]);
      if (!preset) continue;
      for (const [client, state] of Object.entries(preset)) {
        states[client] = state;
        implied.add(client);
      }
    }
    for (const pair of body.matchAll(/([A-Za-z][A-Za-z0-9_]*)\s*:\s*'([^']+)'/g)) {
      if (pair[1] === 'callers') continue;
      states[pair[1]] = pair[2];
      implied.delete(pair[1]);
    }

    rows.push({ id, method, path: endpointPath, line: i, endLine, states, implied });
    id = '';
  }
  return rows;
}

/**
 * Every `id:` in the contract source. The denominator the guard below needs.
 *
 * Deliberately a different, simpler pattern than the one that reads `callers`,
 * so the two cannot fail together: if one regex stops matching, the other still
 * counts, and the disagreement is the alarm.
 */
export function countContractEntries(source: string): string[] {
  return source
    .split('\n')
    .map((l) => /^\s{4}id: '([^']+)'/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]);
}

/**
 * Refuse to reconcile against a contract this parser cannot fully read.
 *
 * ## Why a positive fixture is not enough here
 *
 * The usual form of this guard asserts the parser found MORE THAN ZERO rows.
 * That is the right shape when the failure is total, and it is what several
 * other gates in this repository gained after being caught reporting an
 * honest-looking zero.
 *
 * It would not have caught this one. A formatter does not wrap every line — it
 * wraps the LONG ones. The realistic failure is partial: 111 of 112 entries
 * still parse, `changes` comes back empty for the 112th because it was never
 * examined, and the gate prints "contract agrees" having silently skipped it.
 * A `> 0` guard passes that happily.
 *
 * So the guard is coverage, not existence: every entry the contract declares
 * must yield a `callers` block this parser could read. Anything else is a
 * refusal naming the entries it could not see.
 *
 * This is not hypothetical. On the commit that introduced this guard,
 * `admin.refunds.markFailed` had a `callers` object wrapped across six lines
 * (2d34699, 2026-08-19) and had been invisible to this script ever since — one
 * day before the hand-over that described this defect as "latent, not active".
 * It was active. It just could not be seen by the thing that would have said so.
 */
export function assertParserSawEverything(source: string, rows: Row[]): void {
  const declared = countContractEntries(source);
  const seen = new Set(rows.map((r) => r.id));
  const missed = declared.filter((id) => !seen.has(id));
  if (missed.length === 0) return;
  console.error(
    `the contract declares ${declared.length} entries but this parser could only read ` +
    `${rows.length} of them. It will NOT report agreement on a contract it cannot see:`,
  );
  for (const id of missed) console.error('   ', id);
  console.error('\nA `callers` object this parser cannot read is not a formatting problem.');
  process.exit(1);
}

function main(): void {
  const check = process.argv.includes('--check');
  const source = fs.readFileSync(CONTRACT, 'utf8');
  const lines = source.split('\n');
  const rows = readContractRows(source);

  // BEFORE anything is believed about `rows`. A reconciliation result is worth
  // exactly what the parse behind it is worth.
  assertParserSawEverything(source, rows);

  const manifests = loadManifests();
  if (manifests.length === 0) {
    console.error(`no client manifests under ${MANIFEST_DIR} — nothing to derive.`);
    process.exit(1);
  }

  /**
   * Every manifest found, not the one this script used to name.
   *
   * `loadManifests()` already reads every `.json` in the directory; the old
   * version then discarded all but `providerWeb`, and wrote back through a
   * regex with `providerWeb` baked into it. Two hardcoded sites meant adding a
   * second client was an edit to this script rather than a file drop — and, per
   * the reconciler's own docblock, the clients without a manifest had their rows
   * left alone, which is right, but silently and forever.
   */
  const changes: { row: Row; client: string; from: string; next: string }[] = [];
  const perClientMatched = new Map<string, number>();

  for (const manifest of manifests) {
    const client = manifest.client;
    const called = calledKeys(manifest);
    const matched = new Set<string>();

    for (const row of rows) {
      const k = key(row.method, row.path);
      const isCalled = called.has(k);
      if (isCalled) matched.add(k);
      const current = row.states[client];
      if (current === undefined) {
        console.error(
          `contract entry ${row.id} states no caller value for '${client}', and a manifest ` +
          'for that client exists. The contract and the client list disagree about who exists.',
        );
        process.exit(1);
      }
      // Only ever promote TO migrated, or demote a row the client stopped
      // calling. `n/a` means "does not apply to this client" and is a judgement
      // the manifest cannot make, so it is never overwritten.
      if (isCalled && current !== 'migrated') changes.push({ row, client, from: current, next: 'migrated' });
      if (!isCalled && current === 'migrated') changes.push({ row, client, from: current, next: 'legacy' });
    }

    const orphans = [...called].filter((k) => !matched.has(k));
    if (orphans.length) {
      console.error(
        `${orphans.length} endpoint(s) in the ${client} manifest match no contract entry — the ` +
        'manifest and the contract disagree about what exists, which is a finding, not a ' +
        'formatting problem:',
      );
      for (const o of orphans) console.error('   ', o);
      process.exit(1);
    }
    perClientMatched.set(client, matched.size);
  }

  const summary = [...perClientMatched.entries()].map(([c, n]) => `${c} ${n}`).join(', ');

  if (check) {
    if (changes.length === 0) {
      console.log(`client manifests reconciled: ${summary}; contract agrees.`);
      return;
    }
    console.error(`contract disagrees with the client manifests on ${changes.length} entr(ies):`);
    for (const c of changes) console.error(`    ${c.row.id} [${c.client}]: ${c.from} -> ${c.next}`);
    console.error('run: npm run clients:reconcile');
    process.exit(1);
  }

  /**
   * Write back into the block, not into one remembered line.
   *
   * Two cases. An explicit `client: 'value'` is replaced where it sits, which
   * may be any line of a wrapped object. A value that came from a SPREAD has no
   * key to replace, so an explicit override is inserted immediately after the
   * opening brace — the object's own precedence rule, since a later key beats a
   * spread.
   *
   * Applied bottom-up so an insertion never shifts a line index still to be
   * used.
   */
  for (const { row, client, next } of [...changes].sort((a, b) => b.row.line - a.row.line)) {
    if (row.implied.has(client)) {
      const indent = (/^(\s*)/.exec(lines[row.line]) as RegExpExecArray)[1] + '  ';
      lines.splice(row.line + 1, 0, `${indent}${client}: '${next}',`);
      continue;
    }
    const pattern = new RegExp(`${client}: '[^']+'`);
    for (let i = row.line; i <= row.endLine; i += 1) {
      if (pattern.test(lines[i])) { lines[i] = lines[i].replace(pattern, `${client}: '${next}'`); break; }
    }
  }
  fs.writeFileSync(CONTRACT, lines.join('\n'));
  console.log(`reconciled ${changes.length} entr(ies) across ${manifests.length} manifest(s): ${summary}.`);
  for (const c of changes) console.log(`    ${c.row.id} [${c.client}]: ${c.from} -> ${c.next}`);
}

if (require.main === module) main();
