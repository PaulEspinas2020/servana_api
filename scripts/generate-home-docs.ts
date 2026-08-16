/**
 * Writes the generated TAB 11 document.
 *
 *   docs/home/HOME_V1_CONTRACT.md
 *
 * Run: npm run home:docs        (rewrite)
 *      npm run home:docs:check  (fail if the committed file is stale)
 *
 * ## Why this is GENERATED
 *
 * A section registry in prose is a list somebody edits when they add a section
 * and forgets when they remove one. The dangerous half is the OWNERSHIP column:
 * a document claiming the catalog owns `featuredServices` while the homepage
 * quietly started deciding it is exactly the drift this tab exists to prevent,
 * and nobody would notice from reading either.
 *
 * So every table is produced by EXECUTING `homePolicy` — the section specs, the
 * cache decision run over real section sets, the payload budget summed from the
 * declarations. If a section changes audience, the caching table changes with
 * it.
 */

import fs from 'fs';
import path from 'path';

import {
  CLIENT_SURFACES,
  COMPOSITION_STRATEGY,
  HOME_CAPABILITIES,
  HOME_DEEP_LINK_TARGETS,
  PAYLOAD_BUDGET,
  PERSONAL_SECTIONS,
  PUBLIC_SECTIONS,
  SECTION_REASONS,
  SECTION_TYPES,
  SECTION_TYPE_NAMES,
  SERVICE_CARD_REFERENCE,
  cacheControlFor,
  type ClientSurface,
} from '../src/services/home/homePolicy';
import { V1_CONTRACT, V1_PREFIX, type ContractEntry } from '../src/api/v1/contract';

const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'home');

const HEADER = `<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-home-docs.ts, derived from
    src/services/home/homePolicy.ts    (sections, caching, budget, failure modes)
    src/services/home/homeService.ts   (the composition)
    src/api/v1/contract.ts             (the canonical endpoints)
  Regenerate: npm run home:docs
-->

# Home v1 Contract
`;

const SURFACE_LABEL: Record<ClientSurface, string> = {
  customerMobile: 'Customer Mobile',
  customerWeb: 'Customer Web',
  providerMobile: 'Provider Mobile',
  providerWeb: 'Provider Web',
  admin: 'Admin Web',
};

// ─── Sections ─────────────────────────────────────────────────────────────────

function sectionSection(): string {
  const rows = SECTION_TYPE_NAMES.map((name) => {
    const spec = SECTION_TYPES[name];
    return `| \`${name}\` | ${spec.audience} | \`${spec.ownedBy}\` | ${
      spec.referenceId ? `\`${spec.referenceId}\`` : '—'
    } | ${spec.ttlSeconds}s | ${spec.maxItems} |`;
  }).join('\n');

  const descriptions = SECTION_TYPE_NAMES.map(
    (name) => `**\`${name}\`** — ${SECTION_TYPES[name].description}`,
  ).join('\n\n');

  return `## 1. The section registry

${SECTION_TYPE_NAMES.length} declared sections. The wire names are **append-only**: a client
shipped against an older registry must keep working, so a section is never renamed and an
unknown one is ignored rather than refused.

| Section | Audience | Owned by | Reference id | TTL | Max items |
| --- | --- | --- | --- | --- | --- |
${rows}

The **Owned by** column is the load-bearing one. The homepage is a READ MODEL: it aggregates
and owns nothing, and every row above names the service that actually decides that data. A
homepage with its own opinion about a price or a booking state is a third source of truth that
disagrees on a Tuesday.

${descriptions}

### Two sections that own nothing because nothing exists yet

\`banners\` has no promotions table in this database, and the command forbids the homepage
owning promotion truth — so inventing one here would be the violation, not the fix. It is
declared and serves \`NOT_CONFIGURED\`, so a client builds the surface once and it fills in the
day a promotion source is built.

\`featuredServices\` reuses the catalog's OWN curation signal, \`display_order\`, which admins
already set. A second featured flag beside it would be a second thing to keep in step.
`;
}

// ─── Canonical references ─────────────────────────────────────────────────────

function referenceSection(): string {
  return `## 2. Canonical references

Every card is a REFERENCE, never a copy.

### Service cards

- id field: \`${SERVICE_CARD_REFERENCE.idField}\` from \`${SERVICE_CARD_REFERENCE.idSource}\`
- hierarchy: ${SERVICE_CARD_REFERENCE.hierarchy.map((h) => `\`${h}\``).join(', ')}
- **never**: ${SERVICE_CARD_REFERENCE.forbidden.map((f) => `\`${f}\``).join(', ')}

${SERVICE_CARD_REFERENCE.note}

A booking created before Catalog V2 carries a legacy option id and no
\`catalog_service_id\`. The composition resolves it through
\`bookingCanonicalServiceSql\` — the same helper the eligibility pipeline uses — so such a
booking still ranks the right service rather than silently dropping out of the ranking.

### Booking cards

\`bookingId\` is \`bookings.id\`, and the state is the CANONICAL state with its customer
projection: the same \`deriveCanonicalState\` and \`toCustomerProjection\` every other customer
surface uses.

The homepage declares no status vocabulary of its own. A four-value homepage enum over an
eleven-state machine is a card that says "in progress" for three different situations.

The active-booking list is additionally filtered on the DERIVED answer rather than the raw
status column, because the derivation is the authority and the two can disagree — that
disagreement is the whole reason the derivation exists.

### Deep links

Reused, not redeclared: ${HOME_DEEP_LINK_TARGETS.map((t) => `\`${t}\``).join(', ')} come from
\`services/events/domainEvents.DEEP_LINK_TARGETS\`, which already declares one target per
destination keyed on a canonical id with a projection per client. A second deep-link
vocabulary for the homepage is precisely the duplication this tab avoids.
`;
}

// ─── Caching ──────────────────────────────────────────────────────────────────

function cachingSection(): string {
  // EVIDENCE: run the real decision over the sets that matter.
  const publicOnly = cacheControlFor([...PUBLIC_SECTIONS]);
  const mixed = cacheControlFor(['categories', 'activeBooking']);
  const personalOnly = cacheControlFor([...PERSONAL_SECTIONS]);
  const shortest = cacheControlFor(['categories', 'popularServices']);

  return `## 3. Caching

The header is derived from the SECTIONS PRESENT, not from the route. Produced by running
\`cacheControlFor\`:

| Requested | Cache-Control |
| --- | --- |
| every public section | \`${publicOnly}\` |
| \`categories\` + \`popularServices\` | \`${shortest}\` |
| \`categories\` + \`activeBooking\` | \`${mixed}\` |
| every personal section | \`${personalOnly}\` |

Two rules produce that table.

**Any personal section makes the whole response \`private, no-store\`**, whatever the individual
TTLs say. A shared cache holding one customer's active booking and serving it to the next
request is the leak §115 forbids, and it is one the server cannot observe once a proxy is in
front of it. \`Vary: Authorization\` is set alongside as belt and braces.

**The shortest TTL wins.** A response is only as fresh as its stalest part; taking the maximum
would serve a 15-minute popularity ranking under a 5-minute promise.

So \`?sections=categories,featuredServices\` is genuinely cacheable and the default set is not,
and neither is a property of the URL.

### One request, not a dozen

${COMPOSITION_STRATEGY.note}
`;
}

// ─── Partial failure ──────────────────────────────────────────────────────────

function failureSection(): string {
  const reasons = Object.entries(SECTION_REASONS)
    .map(([code, meaning]) => `| \`${code}\` | ${meaning} |`)
    .join('\n');

  const optional = SECTION_TYPE_NAMES.filter(
    (n) => SECTION_TYPES[n].failureMode === 'optional',
  );

  return `## 4. Partial failure

Every section is \`optional\` (${optional.length} of ${SECTION_TYPE_NAMES.length}), which is the
correct default: every section on this page is additive to a page that is still usable without
it. One failed section must not blank the homepage.

A failed section arrives as \`status: "unavailable"\` with an empty \`items\` array and a reason
CODE. \`items\` is never absent, so a client renders a gap rather than crashing on a missing
key, and the exception goes to the log rather than to the caller.

| Reason | Meaning |
| --- | --- |
${reasons}

\`EMPTY\` and \`UNAVAILABLE\` are deliberately different. An empty recents list is a new
customer; an unavailable one is a backend that failed. Collapsing them shows "no recent
services" to somebody who has ten.

\`meta.unavailable\` names every section that failed, so a client can tell a partial page from a
complete one without inspecting each envelope.
`;
}

// ─── Budget ───────────────────────────────────────────────────────────────────

function budgetSection(): string {
  return `## 5. Payload budget

| Bound | Value |
| --- | --- |
| Total items across every section | ${PAYLOAD_BUDGET.maxTotalItems} |
| Serialized bytes | ${PAYLOAD_BUDGET.maxBytes / 1024} KiB |
| Queries per request | ${PAYLOAD_BUDGET.maxQueriesPerRequest} |

${PAYLOAD_BUDGET.note}

Every number is asserted against a COMPOSED response in
\`tests/home-parity-performance.test.ts\`, over a deliberately oversized catalog — 40 services
and 30 categories — so the ceilings are what is being tested rather than the fixture happening
to be small. The byte ceiling is the backstop that catches a section whose ITEMS grew rather
than whose count did.
`;
}

// ─── Endpoints and callers ────────────────────────────────────────────────────

function endpointSection(): string {
  const entries = V1_CONTRACT.filter((e) => e.domain === 'home');
  const rows = entries
    .map(
      (e: ContractEntry) =>
        `| \`${e.method.toUpperCase()} ${V1_PREFIX}${e.path}\` | ${e.auth} | \`${e.domainService}\` |`,
    )
    .join('\n');

  const legacy = entries
    .flatMap((e) => e.legacy.map((l) => ({ entry: e, legacy: l })))
    .map(
      ({ entry, legacy: l }) =>
        `| \`${l.method.toUpperCase()} ${l.path}\` | ${l.disposition} | \`${entry.id}\` | ${l.note} |`,
    )
    .join('\n');

  return `## 6. Canonical endpoints

| Endpoint | Auth | Domain service |
| --- | --- | --- |
${rows}

\`GET ${V1_PREFIX}/home/refresh\` was named as optional in the command and is NOT built. There
is nothing to refresh: the composition holds no server-side cached copy, so every request is
already current, and an endpoint whose only behaviour is to return what the previous one
returned is a route that exists to be called by mistake. Per-section TTLs and the
\`?sections=\` selector cover the case a client actually has — re-fetching part of the page.

### Related routes, deliberately KEPT

Neither is superseded. Home REFERENCES them rather than replacing them, and a client that
needs only one of them should not fetch a whole page to get it.

| Route | Disposition | Related entry | Why |
| --- | --- | --- | --- |
${legacy}
`;
}

function callerMatrixSection(): string {
  const head = `| Capability | ${CLIENT_SURFACES.map((s) => SURFACE_LABEL[s]).join(' | ')} |`;
  const divider = `| --- | ${CLIENT_SURFACES.map(() => '---').join(' | ')} |`;

  const rows = HOME_CAPABILITIES.map((capability) => {
    const cells = CLIENT_SURFACES.map((surface) => {
      if (!capability.surfaces.includes(surface)) return '—';
      const states = capability.contractIds
        .map((id) => V1_CONTRACT.find((e) => e.id === id)?.callers[surface])
        .filter(Boolean);
      if (!states.length) return '·';
      if (states.every((s) => s === 'migrated')) return 'migrated';
      if (states.some((s) => s === 'legacy')) return 'legacy';
      if (states.every((s) => s === 'n/a')) return '—';
      return 'planned';
    });
    return `| ${capability.title} | ${cells.join(' | ')} |`;
  }).join('\n');

  const rationale = HOME_CAPABILITIES.map(
    (c) => `**${c.title}** (\`${c.domainModule}\`)\n\n${c.roleSplitRationale}`,
  ).join('\n\n');

  return `## 7. Cross-platform caller matrix

\`migrated\` — this client calls the canonical v1 route today.
\`legacy\` — this client calls a legacy route the canonical entry supersedes.
\`planned\` — this client will migrate; it calls no equivalent today.
\`—\` — the capability does not apply to this client.

${head}
${divider}
${rows}

Home is **new**, so no cell reads \`legacy\`: there is no legacy homepage endpoint to alias.
The customer app assembles the page on the device from three or four separate calls, and those
calls are KEPT — they are canonical reads in their own right, and home references them rather
than replacing them.

Providers are \`—\` throughout. Provider Web and Provider Mobile have a dashboard with
genuinely different content and their own endpoint; folding both into one surface would give
the response a role branch and two meanings.

### Why each capability is or is not role-split

${rationale}
`;
}

// ─── Composition ──────────────────────────────────────────────────────────────

export function homeContractDoc(): string {
  return [
    HEADER,
    '> A COMPOSITION endpoint. It aggregates and owns nothing: every card is a',
    '> reference to a canonical id, and the section registry names which service',
    '> owns each part. The caching and budget tables are produced by RUNNING the',
    '> real decision functions, so they are evidence rather than description.',
    '',
    sectionSection(),
    referenceSection(),
    cachingSection(),
    failureSection(),
    budgetSection(),
    endpointSection(),
    callerMatrixSection(),
  ].join('\n');
}

export function generateAll(): Array<{ relPath: string; content: string }> {
  return [{ relPath: 'docs/home/HOME_V1_CONTRACT.md', content: homeContractDoc() }];
}

/** Compares generated content with what is on disk. Newline-normalised for Windows checkouts. */
export function staleFiles(): string[] {
  const repoRoot = path.resolve(__dirname, '..');
  const stale: string[] = [];
  for (const file of generateAll()) {
    const abs = path.join(repoRoot, file.relPath);
    if (!fs.existsSync(abs)) {
      stale.push(file.relPath);
      continue;
    }
    const onDisk = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
    if (onDisk !== file.content.replace(/\r\n/g, '\n')) stale.push(file.relPath);
  }
  return stale;
}

if (require.main === module) {
  if (process.argv.includes('--check')) {
    const stale = staleFiles();
    if (stale.length) {
      console.error(`Home docs are stale — run "npm run home:docs":\n  ${stale.join('\n  ')}`);
      process.exitCode = 1;
    } else {
      console.log('Home docs are up to date.');
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
