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

interface Row { id: string; line: number; method: string; path: string; current: string }

/** Every entry in the contract source, with the line its `callers` sits on. */
function readContractRows(source: string): Row[] {
  const lines = source.split('\n');
  const rows: Row[] = [];
  let id = '', method = '', endpointPath = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const idMatch = /^\s{4}id: '([^']+)'/.exec(line);
    if (idMatch) { id = idMatch[1]; method = ''; endpointPath = ''; continue; }
    const methodMatch = /^\s{4}method: '([^']+)'/.exec(line);
    if (methodMatch) { method = methodMatch[1]; continue; }
    const pathMatch = /^\s{4}path: '([^']+)'/.exec(line);
    if (pathMatch) { endpointPath = pathMatch[1]; continue; }
    const callersMatch = /^\s{4}callers: \{.*providerWeb: '([^']+)'.*\},?$/.exec(line);
    if (callersMatch && id) {
      rows.push({ id, line: i, method, path: endpointPath, current: callersMatch[1] });
      id = '';
    }
  }
  return rows;
}

function main(): void {
  const check = process.argv.includes('--check');
  const source = fs.readFileSync(CONTRACT, 'utf8');
  const lines = source.split('\n');
  const rows = readContractRows(source);

  const manifests = loadManifests();
  const providerWeb = manifests.find((m) => m.client === 'providerWeb');
  if (!providerWeb) {
    console.error('no providerWeb manifest under src/api/v1/client-manifests — nothing to derive.');
    process.exit(1);
  }
  const called = calledKeys(providerWeb);

  const changes: { row: Row; next: string }[] = [];
  const matched = new Set<string>();

  for (const row of rows) {
    const k = key(row.method, row.path);
    const isCalled = called.has(k);
    if (isCalled) matched.add(k);
    // Only ever promote TO migrated, or demote a row the client stopped calling.
    // `n/a` means "does not apply to this client" and is a judgement the manifest
    // cannot make, so it is never overwritten.
    if (isCalled && row.current !== 'migrated') changes.push({ row, next: 'migrated' });
    if (!isCalled && row.current === 'migrated') changes.push({ row, next: 'legacy' });
  }

  const orphans = [...called].filter((k) => !matched.has(k));
  if (orphans.length) {
    console.error(
      `${orphans.length} manifest endpoint(s) match no contract entry — the manifest and the ` +
      'contract disagree about what exists, which is a finding, not a formatting problem:',
    );
    for (const o of orphans) console.error('   ', o);
    process.exit(1);
  }

  if (check) {
    if (changes.length === 0) {
      console.log(`client manifests reconciled: ${matched.size} endpoints, contract agrees.`);
      return;
    }
    console.error(`contract disagrees with the client manifests on ${changes.length} entr(ies):`);
    for (const c of changes) console.error(`    ${c.row.id}: ${c.row.current} -> ${c.next}`);
    console.error('run: npm run clients:reconcile');
    process.exit(1);
  }

  for (const { row, next } of changes) {
    lines[row.line] = lines[row.line].replace(/providerWeb: '[^']+'/, `providerWeb: '${next}'`);
  }
  fs.writeFileSync(CONTRACT, lines.join('\n'));
  console.log(`reconciled ${changes.length} entr(ies) from ${matched.size} manifest endpoints.`);
  for (const c of changes) console.log(`    ${c.row.id}: ${c.row.current} -> ${c.next}`);
}

if (require.main === module) main();
