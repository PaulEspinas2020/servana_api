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
 *
 * It also rewrites the GENERATED REGIONS inside the two hand-written documents
 *
 *   docs/api/API_V1_CONTRACT.md
 *   docs/api/CROSS_CLIENT_MIGRATION_PLAN.md
 *
 * Those files are prose — decisions, not data — and stay hand-written. But
 * prose that restates a countable fact rots: both files shipped claims
 * ("18 canonical endpoints live", "Six planned entries exist today") that were
 * true when written and false four commands later, with the whole gate green,
 * because nothing derived them. Every countable claim now lives inside a
 * region and is regenerated from the contract; the sentences around it explain
 * why, which is the part a generator cannot write.
 */

import fs from 'fs';
import path from 'path';
import { V1_CONTRACT, ContractEntry, IMPLEMENTED, PLANNED, fullPath, ClientName } from '../src/api/v1/contract';
import { buildOpenApiDocument, allErrorsFor } from '../src/api/v1/openapi';
import { RETIREMENT_CRITERIA } from '../src/api/v1/legacyTelemetry';
import { ACCOUNT_BUCKETS, BUCKETS, V1_RATE_LIMITS } from '../src/api/v1/rateLimitPolicy';
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

// ─── CATALOG_ENDPOINT_REGISTRY.md ─────────────────────────────────────────────

/**
 * The catalog + search slice of the registry, with the identifier semantics
 * spelled out per parameter.
 *
 * Generated rather than written, for the same reason as the main registry — but
 * the extra column is the point of this one. Four different things in this
 * platform are called a "service id", so a registry that lists paths without
 * saying which table each parameter resolves against is the document that
 * causes the confusion rather than the one that ends it.
 */
function catalogRegistryMarkdown(): string {
  const entries = V1_CONTRACT.filter((e) => e.domain === 'catalog' || e.domain === 'search');

  /** Which table each canonical path parameter resolves against. */
  const RESOLVES: Record<string, string> = {
    serviceId: '`services.id` — the canonical Specific Service (95 rows)',
    categoryId: '`catalog_categories.id` (3 rows)',
    subcategoryId: '`catalog_subcategories.id` (12 rows)',
  };

  const L: string[] = [];
  L.push('# Catalog Endpoint Registry');
  L.push('');
  L.push('> GENERATED from `src/api/v1/contract.ts` by `npm run api:docs`. Do not edit by hand.');
  L.push('');
  L.push(`**${entries.length} canonical catalog and search endpoints.** All public, all read-only.`);
  L.push('');
  L.push('Mutation lives on `/api/admin/catalog/*` behind `verifyAuth → verifyRoles([1]) →');
  L.push('requirePermission`. There is no write handler on the public surface and there must not be —');
  L.push('server-side authorization is not satisfiable on an unauthenticated route.');
  L.push('');

  L.push('## Endpoints');
  L.push('');
  L.push('| Method | Path | Response | Errors |');
  L.push('|---|---|---|---|');
  for (const e of entries) {
    L.push(
      `| \`${e.method.toUpperCase()}\` | \`${fullPath(e)}\` | \`${e.responseSchema}\` ` +
        `| ${allErrorsFor(e).map((c) => `\`${c}\``).join(', ') || '—'} |`,
    );
  }
  L.push('');

  L.push('## What every path parameter resolves against');
  L.push('');
  L.push('This is the table that matters. `GET /api/services/:serviceId/level2` resolves its');
  L.push('parameter against `service_families.id`; `GET /api/v1/catalog/services/:serviceId`');
  L.push('resolves the same-named parameter against `services.id`. The integer `3` is meaningful');
  L.push('to both and means different things to each.');
  L.push('');
  L.push('| Endpoint | Parameter | Resolves against |');
  L.push('|---|---|---|');
  for (const e of entries) {
    for (const p of e.params ?? []) {
      L.push(`| \`${fullPath(e)}\` | \`${p.name}\` | ${RESOLVES[p.name] ?? esc(p.description)} |`);
    }
  }
  L.push('');
  L.push('**No canonical endpoint accepts a `service_families.id` or a `service_options.id`.**');
  L.push('`tests/v1-catalog-contract.test.ts` asserts it against the contract, not against prose.');
  L.push('');

  L.push('## Domain services');
  L.push('');
  L.push('| Endpoint | Delegates to |');
  L.push('|---|---|');
  for (const e of entries) {
    L.push(`| \`${e.method.toUpperCase()} ${fullPath(e)}\` | \`${esc(e.domainService)}\` |`);
  }
  L.push('');

  L.push('## Caller matrix');
  L.push('');
  L.push(`| Endpoint | ${CLIENTS.map((c) => CLIENT_LABEL[c]).join(' | ')} |`);
  L.push(`|---|${CLIENTS.map(() => '---').join('|')}|`);
  for (const e of entries) {
    L.push(`| \`${fullPath(e)}\` | ${CLIENTS.map((c) => CALLER_MARK[e.callers[c]]).join(' | ')} |`);
  }
  L.push('');
  L.push('Legend: ✅ migrated · ⏳ still on a legacy route · · planned · — not applicable.');
  L.push('');

  const legacy = entries.flatMap((e) => e.legacy.map((l) => ({ ...l, canonical: fullPath(e) })));
  L.push('## Legacy catalog routes this replaces');
  L.push('');
  L.push('| Method | Legacy path | Disposition | Canonical |');
  L.push('|---|---|---|---|');
  for (const l of legacy) {
    L.push(`| \`${l.method.toUpperCase()}\` | \`${l.path}\` | \`${l.disposition}\` | \`${l.canonical}\` |`);
  }
  L.push('');
  L.push('Full reasoning per route: [`CATALOG_LEGACY_MIGRATION_MAP.md`](CATALOG_LEGACY_MIGRATION_MAP.md).');
  L.push('');
  return L.join('\n');
}

// ─── Generated regions inside the hand-written documents ──────────────────────

/**
 * The blocks that may appear between region markers, keyed by region name.
 *
 * Each returns the BODY only — the markers themselves stay in the document, so
 * a reader editing the prose can see exactly where the machine writes.
 */
const REGION_BLOCKS: Record<string, () => string[]> = {
  /** §11 of API_V1_CONTRACT.md — which entries are documented and not mounted. */
  'v1-planned': () => {
    const L: string[] = [];
    L.push(
      `**${PLANNED.length} planned ${PLANNED.length === 1 ? 'entry' : 'entries'} today**, ` +
        `against ${IMPLEMENTED.length} implemented.`,
    );
    L.push('');
    L.push('| Path | Domain | Successor to | Why it is not built here |');
    L.push('|---|---|---|---|');
    for (const e of PLANNED) {
      const legacy = e.legacy.map((l) => `\`${l.method.toUpperCase()} ${l.path}\``).join(', ') || '—';
      const why = e.notes ?? e.legacy[0]?.note ?? '';
      L.push(`| \`${fullPath(e)}\` | ${e.domain} | ${legacy} | ${esc(why)} |`);
    }
    return L;
  },

  /** §8 of API_V1_CONTRACT.md — the routes that stay role-specific, and why. */
  'v1-role-specific': () => {
    const rows = V1_CONTRACT.flatMap((e) =>
      e.legacy
        .filter((l) => l.disposition === 'ROLE_SPECIFIC')
        .map((l) => ({ legacy: l, canonical: fullPath(e) })),
    );
    const L: string[] = [];
    L.push(`**${rows.length}** today.`);
    L.push('');
    L.push('| Role-specific route | Nearest canonical | Why it is not the same endpoint |');
    L.push('|---|---|---|');
    for (const r of rows) {
      L.push(
        `| \`${r.legacy.method.toUpperCase()} ${r.legacy.path}\` | \`${r.canonical}\` | ${esc(r.legacy.note)} |`,
      );
    }
    return L;
  },

  /** Phase 0 of CROSS_CLIENT_MIGRATION_PLAN.md — the size of the surface. */
  'v1-surface': () => {
    const aliases = V1_CONTRACT.flatMap((e) => e.legacy.filter((l) => l.disposition === 'ALIAS_TEMPORARILY'));
    const legacyRoutes = buildMountedRoutes().filter((r) => !r.fullPath.startsWith('/api/v1'));
    return [
      `- **${IMPLEMENTED.length} canonical endpoints live**, each driven end to end by \`tests/v1-router.test.ts\`.`,
      `- **${PLANNED.length} planned**, documented and not mounted — see §11 of [\`API_V1_CONTRACT.md\`](API_V1_CONTRACT.md).`,
      `- **${aliases.length} legacy aliases** counted by telemetry, derived from the contract.`,
      `- **${legacyRoutes.length} routes** mounted outside \`/api/v1\`, every one classified in the matrix.`,
    ];
  },

  /**
   * Header of AUTH_ROUTE_MIGRATION_MATRIX.md — how much the generated matrix covers.
   *
   * This one shipped as "covers all 517 routes" while the matrix covered 520:
   * the same rot as §11 and Phase 0, in the third hand-written document, found
   * only because somebody counted. It is derived now.
   */
  'legacy-route-total': () => {
    const routes = buildMountedRoutes();
    const legacy = routes.filter((r) => !r.fullPath.startsWith('/api/v1')).length;
    const v1 = routes.length - legacy;
    return [
      `It classifies the **${legacy} routes** mounted outside \`/api/v1\`, alongside the ` +
        `**${v1} canonical** ones.`,
    ];
  },

  /**
   * "Admin writes — untouched" in CATALOG_LEGACY_MIGRATION_MAP.md.
   *
   * Two route families kept in bulk. Their sizes were hand-counted once
   * (`29` against an actual 28) and are counted from the mounted tree now — a
   * family's size changes every time somebody adds an admin route, which is
   * exactly the kind of number no one revisits a prose document to correct.
   */
  'catalog-admin-route-families': () => {
    const routes = buildMountedRoutes();
    const size = (prefix: string): number =>
      routes.filter((r) => r.fullPath === prefix || r.fullPath.startsWith(`${prefix}/`)).length;
    const families: Array<[string, string]> = [
      ['/api/admin/provider-catalog', '`KEEP`'],
      ['/api/admin/catalog', '`KEEP` — already canonical'],
    ];
    const L: string[] = ['| Family | Routes mounted | Disposition |', '|---|---|---|'];
    for (const [prefix, disposition] of families) {
      L.push(`| \`${prefix}/*\` | ${size(prefix)} | ${disposition} |`);
    }
    return L;
  },

  /**
   * Retirement criterion 4 in CATALOG_LEGACY_MIGRATION_MAP.md.
   *
   * "The canonical successor is `implemented`, not `planned`" is the one
   * criterion the backend can settle by itself, so whether it is met is a fact
   * about the contract rather than a claim to maintain. The document said
   * "all four"; six catalog entries supersede a legacy route.
   */
  'catalog-successor-status': () => {
    const successors = V1_CONTRACT.filter((e) => e.domain === 'catalog' && e.legacy.length > 0);
    const planned = successors.filter((e) => e.status === 'planned');
    if (planned.length) {
      return [
        `**${planned.length} of ${successors.length}** canonical catalog successors are still ` +
          `\`planned\`, so criterion 4 is **not** met for the routes they supersede: ` +
          `${planned.map((e) => `\`${fullPath(e)}\``).join(', ')}.`,
      ];
    }
    return [
      `All **${successors.length}** canonical catalog successors are \`implemented\`, so ` +
        'criterion 4 is already met for every route above.',
    ];
  },

  /**
   * §8 of AUTH_V1_CONTRACT.md — which limiter guards which auth endpoint.
   *
   * This section carried the flattest claim of the three: "Every credential
   * endpoint carries **two** limiters and both must pass." Six of nine do.
   * `refresh` and `verify-mobile` carry the per-IP limiter alone and `logout`
   * carries none — each correctly, each for a reason now declared beside the
   * wiring in `rateLimitPolicy.ts` and rendered below. A security control is the
   * worst place to keep a summary that was true once.
   */
  'auth-rate-limits': () => {
    const window = (ms: number): string => {
      const minutes = ms / 60_000;
      return minutes >= 60 ? `${minutes / 60} h` : `${minutes} min`;
    };

    const L: string[] = [];
    L.push('**Buckets.** One `express-rate-limit` instance each, so endpoints sharing a bucket share a counter.');
    L.push('');
    L.push('| Bucket | Key | Budget | Counts | What it stops |');
    L.push('|---|---|---|---|---|');
    for (const [name, spec] of Object.entries(BUCKETS)) {
      const key = spec.key === 'identifier' ? 'normalised identifier, hashed' : 'normalised IP';
      const counts = spec.skipSuccessfulRequests ? 'failures only' : 'every request';
      L.push(`| \`${name}\` | ${key} | ${spec.max} / ${window(spec.windowMs)} | ${counts} | ${esc(spec.purpose)} |`);
    }

    const ids = Object.keys(V1_RATE_LIMITS);
    const both = ids.filter((id) =>
      V1_RATE_LIMITS[id].buckets.some((b) => ACCOUNT_BUCKETS.includes(b)),
    );
    L.push('');
    L.push(
      `**Per endpoint.** ${both.length} of ${ids.length} carry a per-account bucket *and* the per-IP one; ` +
        'the rest say why they do not.',
    );
    L.push('');
    L.push('| Endpoint | Buckets | Why no per-account bucket |');
    L.push('|---|---|---|');
    for (const id of ids) {
      const policy = V1_RATE_LIMITS[id];
      const buckets = policy.buckets.length
        ? policy.buckets.map((b) => `\`${b}\``).join(' + ')
        : '**none**';
      L.push(`| \`${id}\` | ${buckets} | ${esc(policy.noAccountBucket ?? '—')} |`);
    }
    return L;
  },
};

/**
 * Per-client move table: what this client can migrate today, from the contract.
 *
 * Two things this table is careful NOT to claim.
 *
 * The contract records caller state **per capability**, not per legacy path —
 * `auth.login` is one entry with four legacy forms, and no client calls all
 * four. So the right-hand column is every legacy route the capability
 * supersedes, of which this client calls one or more. Rendering it as "this
 * client calls all of these" would send a provider-web team to migrate
 * `/api/auth/customer-firebase-login`.
 *
 * And `ROLE_SPECIFIC` routes are excluded outright. They are the ones the
 * matrix says must NOT be collapsed; listing them as a move would contradict
 * the classification in the document next door.
 */
const clientMovesBlock = (client: ClientName): string[] => {
  const movable = V1_CONTRACT.filter((e) => e.status === 'implemented' && e.callers[client] === 'legacy');
  const L: string[] = [];
  if (!movable.length) {
    L.push(
      '**Nothing yet.** No canonical endpoint this client calls on a legacy route is implemented, ' +
        'so there is no move to make — the successors it needs are still `planned`.',
    );
    return L;
  }
  L.push(
    `**${movable.length}** canonical ${movable.length === 1 ? 'capability is' : 'capabilities are'} live ` +
      'that this client still reaches by a legacy route.',
  );
  L.push('');
  L.push('| Move to (canonical) | Legacy routes it supersedes |');
  L.push('|---|---|');
  for (const e of movable) {
    const supersedes = e.legacy.filter((l) => l.disposition === 'ALIAS_TEMPORARILY' || l.disposition === 'CANONICALIZE');
    const from = supersedes.length
      ? supersedes.map((l) => `\`${l.method.toUpperCase()} ${l.path}\``).join('<br>')
      : '— (new capability)';
    L.push(`| \`${e.method.toUpperCase()} ${fullPath(e)}\` | ${from} |`);
  }
  L.push('');
  L.push(
    'Caller state is recorded **per capability**, not per legacy path: this client calls one or ' +
      'more of the routes on the right, not all of them. `ROLE_SPECIFIC` routes are excluded — ' +
      'those are the ones that must not be collapsed.',
  );
  return L;
};

for (const client of CLIENTS) {
  REGION_BLOCKS[`v1-moves:${client}`] = () => clientMovesBlock(client);
}

const BEGIN = (name: string) => `<!-- BEGIN GENERATED: ${name} -->`;
const END = (name: string) => `<!-- END GENERATED: ${name} -->`;

/** Documents that are hand-written prose with machine-written regions inside. */
const REGION_FILES = [
  'docs/api/API_V1_CONTRACT.md',
  'docs/api/CROSS_CLIENT_MIGRATION_PLAN.md',
  'docs/api/AUTH_ROUTE_MIGRATION_MATRIX.md',
  'docs/api/CATALOG_LEGACY_MIGRATION_MAP.md',
  'docs/api/AUTH_V1_CONTRACT.md',
];

/**
 * Rewrites every generated region in one hand-written document.
 *
 * An unknown region name and an unclosed region are both throws. A marker that
 * silently produced nothing would be worse than no marker at all: the document
 * would read as machine-checked and not be.
 */
export function renderRegions(relPath: string): string {
  const abs = path.resolve(__dirname, '..', relPath);
  const source = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  const out: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('<!-- BEGIN GENERATED:')) { out.push(lines[i]); continue; }

    // A marker that does not parse is a throw, not a pass-through. Silently
    // copying it is how `v1-moves:providerWeb` sat in this document with an
    // empty body and the check green — the region LOOKED machine-written.
    const open = /^<!-- BEGIN GENERATED: ([A-Za-z0-9:_-]+) -->$/.exec(trimmed);
    if (!open) {
      throw new Error(`${relPath}:${i + 1}: malformed region marker — ${trimmed}`);
    }

    const name = open[1];
    const block = REGION_BLOCKS[name];
    if (!block) {
      throw new Error(`${relPath}: unknown generated region "${name}" — no block generator exists for it.`);
    }
    const close = lines.indexOf(END(name), i);
    if (close === -1) {
      throw new Error(`${relPath}: region "${name}" opens at line ${i + 1} and is never closed.`);
    }

    out.push(BEGIN(name), ...block(), END(name));
    i = close;
  }

  return out.join('\n');
}

export function generateAll(): GeneratedFile[] {
  return [
    { relPath: 'docs/api/openapi.v1.json', content: openApiJson() },
    { relPath: 'docs/api/API_ENDPOINT_REGISTRY.md', content: registryMarkdown() },
    { relPath: 'docs/api/LEGACY_ENDPOINT_MIGRATION_MATRIX.md', content: matrixMarkdown() },
    { relPath: 'docs/api/CATALOG_ENDPOINT_REGISTRY.md', content: catalogRegistryMarkdown() },
    ...REGION_FILES.map((relPath) => ({ relPath, content: renderRegions(relPath) })),
  ];
}

/** Region names a document must contain, for the drift test to assert against. */
export const EXPECTED_REGIONS: Record<string, string[]> = {
  'docs/api/API_V1_CONTRACT.md': ['v1-role-specific', 'v1-planned'],
  'docs/api/CROSS_CLIENT_MIGRATION_PLAN.md': [
    'v1-surface',
    ...CLIENTS.map((c) => `v1-moves:${c}`),
  ],
  'docs/api/AUTH_ROUTE_MIGRATION_MATRIX.md': ['legacy-route-total'],
  'docs/api/AUTH_V1_CONTRACT.md': ['auth-rate-limits'],
  'docs/api/CATALOG_LEGACY_MIGRATION_MAP.md': [
    'catalog-admin-route-families',
    'catalog-successor-status',
  ],
};

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
