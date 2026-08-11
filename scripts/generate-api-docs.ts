/**
 * Writes every generated API document from `src/api/v1/contract.ts`.
 *
 *   docs/api/openapi.v1.json
 *   docs/api/API_ENDPOINT_REGISTRY.md
 *   docs/api/LEGACY_ENDPOINT_MIGRATION_MATRIX.md
 *
 * Run: npm run api:docs        (rewrite)
 *      npm run api:docs:check  (fail if the committed files are stale)
 *
 * `tests/v1-contract.test.ts` runs the check, so a contract edit that is not
 * followed by a regenerate fails the gate rather than leaving the registry
 * describing an API that no longer exists.
 *
 * The registry covers ONLY the canonical v1 surface. The full 517-route legacy
 * inventory lives in the migration matrix, which is generated from the same
 * contract plus a static read of the route tree — so every legacy route is
 * accounted for whether or not a v1 successor exists for it yet.
 */

import fs from 'fs';
import path from 'path';
import { V1_CONTRACT, ContractEntry, IMPLEMENTED, PLANNED, fullPath, ClientName } from '../src/api/v1/contract';
import { buildOpenApiDocument, allErrorsFor } from '../src/api/v1/openapi';
import { RETIREMENT_CRITERIA } from '../src/api/v1/legacyTelemetry';
import { buildMountedRoutes, MountedRoute } from './lib/routeTable';

const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'api');

const CLIENTS: ClientName[] = ['customerMobile', 'customerWeb', 'providerMobile', 'providerWeb', 'admin'];
const CLIENT_LABEL: Record<ClientName, string> = {
  customerMobile: 'Cust Mobile',
  customerWeb: 'Cust Web',
  providerMobile: 'Prov Mobile',
  providerWeb: 'Prov Web',
  admin: 'Admin',
};
const CALLER_MARK: Record<string, string> = {
  migrated: '✅',
  legacy: '⏳',
  planned: '·',
  'n/a': '—',
};

const AUTH_LABEL: Record<ContractEntry['auth'], string> = {
  public: 'public',
  authenticated: 'any signed-in',
  provider: 'provider (role 2/4)',
  admin: 'admin (role 1)',
};

const esc = (s: string): string => s.replace(/\|/g, '\\|');

// ─── openapi.v1.json ──────────────────────────────────────────────────────────

const openApiJson = (): string => JSON.stringify(buildOpenApiDocument(), null, 2) + '\n';

// ─── API_ENDPOINT_REGISTRY.md ─────────────────────────────────────────────────

function registryMarkdown(): string {
  const L: string[] = [];
  L.push('# API Endpoint Registry — canonical v1');
  L.push('');
  L.push('> GENERATED from `src/api/v1/contract.ts` by `npm run api:docs`. Do not edit by hand —');
  L.push('> `tests/v1-contract.test.ts` fails if this file and the contract disagree.');
  L.push('');
  L.push(`**${IMPLEMENTED.length} implemented** · **${PLANNED.length} planned** · ${V1_CONTRACT.length} total.`);
  L.push('');
  L.push('A `planned` entry is documented and **not mounted**. It exists so the migration matrix can');
  L.push('name a canonical successor before that successor is built. Calling one returns 404.');
  L.push('');
  L.push('Caller legend: ✅ migrated · ⏳ still on a legacy route · · planned · — not applicable.');
  L.push('');

  const domains = [...new Set(V1_CONTRACT.map((e) => e.domain))];
  for (const domain of domains) {
    const entries = V1_CONTRACT.filter((e) => e.domain === domain);
    L.push(`## ${domain}`);
    L.push('');
    L.push('| Method | Path | Status | Auth | Request | Response | Idem | Owner |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const e of entries) {
      L.push(
        `| \`${e.method.toUpperCase()}\` | \`${fullPath(e)}\` | ${e.status === 'implemented' ? '**live**' : '_planned_'} ` +
          `| ${AUTH_LABEL[e.auth]} | ${e.requestSchema ? `\`${e.requestSchema}\`` : '—'} | \`${e.responseSchema}\` ` +
          `| ${e.idempotent ? 'yes' : 'no'} | ${e.observability} |`,
      );
    }
    L.push('');

    for (const e of entries) {
      L.push(`### \`${e.method.toUpperCase()} ${fullPath(e)}\``);
      L.push('');
      L.push(esc(e.summary));
      L.push('');
      if (e.notes) { L.push(`> ${esc(e.notes)}`); L.push(''); }
      L.push(`- **Domain service** — \`${esc(e.domainService)}\``);
      L.push(`- **Error codes** — ${allErrorsFor(e).map((c) => `\`${c}\``).join(', ')}`);
      if (e.params?.length) {
        L.push(`- **Path params** — ${e.params.map((p) => `\`${p.name}\` (${p.type}) ${esc(p.description)}`).join('; ')}`);
      }
      if (e.query?.length) {
        L.push(`- **Query** — ${e.query.map((q) => `\`${q.name}\` (${q.type}${q.required ? ', required' : ''}) ${esc(q.description)}`).join('; ')}`);
      }
      L.push(`- **Callers** — ${CLIENTS.map((c) => `${CLIENT_LABEL[c]} ${CALLER_MARK[e.callers[c]]}`).join(' · ')}`);
      if (e.legacy.length) {
        L.push('- **Legacy it replaces**');
        for (const l of e.legacy) {
          L.push(`  - \`${l.method.toUpperCase()} ${l.path}\` — **${l.disposition}** — ${esc(l.note)}`);
        }
      } else {
        L.push('- **Legacy it replaces** — none; new capability.');
      }
      L.push('');
    }
  }

  L.push('## Cross-client caller matrix');
  L.push('');
  L.push(`| Endpoint | ${CLIENTS.map((c) => CLIENT_LABEL[c]).join(' | ')} |`);
  L.push(`|---|${CLIENTS.map(() => '---').join('|')}|`);
  for (const e of V1_CONTRACT) {
    L.push(`| \`${e.method.toUpperCase()} ${fullPath(e)}\` | ${CLIENTS.map((c) => CALLER_MARK[e.callers[c]]).join(' | ')} |`);
  }
  L.push('');
  return L.join('\n');
}

// ─── LEGACY_ENDPOINT_MIGRATION_MATRIX.md ──────────────────────────────────────

interface MatrixRow {
  method: string;
  path: string;
  disposition: string;
  canonical: string;
  note: string;
  file: string;
  line: number;
}

/**
 * Every mounted route, classified.
 *
 * Routes the contract names are classified by the contract. Everything else is
 * KEEP — it is not a duplicate of anything canonical and this command does not
 * touch it. Saying KEEP for 480-odd routes is not padding: the point of the
 * matrix is that no route is UNACCOUNTED FOR, and a route that nobody has
 * looked at is exactly the one that turns out to be a second business truth.
 */
function buildMatrix(routes: MountedRoute[]): MatrixRow[] {
  const claimed = new Map<string, { disposition: string; canonical: string; note: string }>();
  for (const entry of V1_CONTRACT) {
    for (const l of entry.legacy) {
      const key = `${l.method.toUpperCase()} ${l.path}`;
      if (claimed.has(key)) continue;
      claimed.set(key, { disposition: l.disposition, canonical: fullPath(entry), note: l.note });
    }
  }

  const rows: MatrixRow[] = [];
  for (const r of routes) {
    // v1's own routes are the canonical side; they are not legacy.
    if (r.fullPath.startsWith('/api/v1')) continue;
    const key = `${r.verb.toUpperCase()} ${r.fullPath}`;
    const hit = claimed.get(key);
    rows.push({
      method: r.verb.toUpperCase(),
      path: r.fullPath,
      disposition: hit?.disposition ?? 'KEEP',
      canonical: hit?.canonical ?? '—',
      note: hit?.note ?? '',
      file: r.file,
      line: r.line,
    });
  }
  return rows;
}

function matrixMarkdown(): string {
  const routes = buildMountedRoutes();
  const rows = buildMatrix(routes);
  const byDisposition = (d: string) => rows.filter((r) => r.disposition === d);

  const L: string[] = [];
  L.push('# Legacy Endpoint Migration Matrix');
  L.push('');
  L.push('> GENERATED by `npm run api:docs` from `src/api/v1/contract.ts` plus a static read of the');
  L.push('> mounted route tree. Do not edit by hand.');
  L.push('');
  L.push(`Every route the app mounts outside \`/api/v1\`: **${rows.length}**.`);
  L.push('');
  L.push('| Disposition | Count | Meaning |');
  L.push('|---|---:|---|');
  L.push(`| \`ALIAS_TEMPORARILY\` | ${byDisposition('ALIAS_TEMPORARILY').length} | A canonical v1 successor exists. Kept until every caller migrates; traffic is counted. |`);
  L.push(`| \`CANONICALIZE\` | ${byDisposition('CANONICALIZE').length} | Should become canonical. No v1 successor built yet — owned by a later domain command. |`);
  L.push(`| \`ROLE_SPECIFIC\` | ${byDisposition('ROLE_SPECIFIC').length} | Legitimately separate: different auth, action or payload — same domain service. |`);
  L.push(`| \`RETIRE\` | ${byDisposition('RETIRE').length} | No caller and no successor. Delete once telemetry confirms zero traffic. |`);
  L.push(`| \`KEEP\` | ${byDisposition('KEEP').length} | Not a duplicate of anything canonical. Untouched by this command. |`);
  L.push('');

  L.push('## Retirement criteria');
  L.push('');
  L.push('An alias is deleted only when **all** of these hold. Written down because "we think');
  L.push('nobody calls it" is how `/api/services/:id/options-with-addons` came to 404 in production');
  L.push('for months — a path can look dead from the server and still be the only thing a shipped');
  L.push('build knows how to call.');
  L.push('');
  L.push(`- Web-only alias: **${RETIREMENT_CRITERIA.webZeroTrafficDays} consecutive days** of zero recorded hits.`);
  L.push(`- Mobile alias: **${RETIREMENT_CRITERIA.mobileZeroTrafficDays} consecutive days** of zero recorded hits — the installed base has to move, not just the current build.`);
  L.push(`- Every client the matrix lists for the route reads \`migrated\`: **${RETIREMENT_CRITERIA.requireAllCallersMigrated}**.`);
  L.push(`- The canonical successor is \`implemented\`, not \`planned\`: **${RETIREMENT_CRITERIA.requireCanonicalImplemented}**.`);
  L.push('');
  L.push('Measure with: `pm2 logs servana-prod | grep legacy-contract`.');
  L.push('');

  for (const d of ['ALIAS_TEMPORARILY', 'CANONICALIZE', 'ROLE_SPECIFIC', 'RETIRE'] as const) {
    const list = byDisposition(d);
    if (!list.length) continue;
    L.push(`## ${d} (${list.length})`);
    L.push('');
    L.push('| Method | Legacy path | Canonical successor | Why it is still here |');
    L.push('|---|---|---|---|');
    for (const r of list) {
      L.push(`| \`${r.method}\` | \`${r.path}\` | \`${r.canonical}\` | ${esc(r.note)} |`);
    }
    L.push('');
  }

  L.push(`## KEEP (${byDisposition('KEEP').length})`);
  L.push('');
  L.push('Mounted, not superseded, not a duplicate. Listed so the inventory is complete and so a');
  L.push('later domain command starts from a route list rather than from a grep.');
  L.push('');
  L.push('| Method | Path | Source |');
  L.push('|---|---|---|');
  for (const r of byDisposition('KEEP')) {
    L.push(`| \`${r.method}\` | \`${r.path}\` | \`${r.file}:${r.line}\` |`);
  }
  L.push('');
  return L.join('\n');
}

// ─── Runner ───────────────────────────────────────────────────────────────────

export interface GeneratedFile {
  relPath: string;
  content: string;
}

export function generateAll(): GeneratedFile[] {
  return [
    { relPath: 'docs/api/openapi.v1.json', content: openApiJson() },
    { relPath: 'docs/api/API_ENDPOINT_REGISTRY.md', content: registryMarkdown() },
    { relPath: 'docs/api/LEGACY_ENDPOINT_MIGRATION_MATRIX.md', content: matrixMarkdown() },
  ];
}

/** Compares generated content with what is on disk. Newline-normalised for Windows checkouts. */
export function staleFiles(): string[] {
  const repoRoot = path.resolve(__dirname, '..');
  const stale: string[] = [];
  for (const file of generateAll()) {
    const abs = path.join(repoRoot, file.relPath);
    if (!fs.existsSync(abs)) { stale.push(file.relPath); continue; }
    const onDisk = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
    if (onDisk !== file.content.replace(/\r\n/g, '\n')) stale.push(file.relPath);
  }
  return stale;
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  if (check) {
    const stale = staleFiles();
    if (stale.length) {
      console.error(`API docs are stale — run "npm run api:docs":\n  ${stale.join('\n  ')}`);
      process.exitCode = 1;
    } else {
      console.log('API docs are up to date.');
    }
  } else {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const file of generateAll()) {
      const abs = path.resolve(__dirname, '..', file.relPath);
      fs.writeFileSync(abs, file.content, 'utf8');
      console.log(`wrote ${file.relPath}`);
    }
  }
}
