/**
 * Writes the generated TAB 13 documents.
 *
 *   docs/api/CLIENT_ENDPOINT_PARITY_MATRIX.md
 *   docs/api/CANONICAL_CALL_MANIFEST.json
 *   docs/api/DEPRECATION_SCHEDULE.md
 *   docs/api/LEGACY_TELEMETRY_SPEC.md
 *   docs/api/PER_CLIENT_MIGRATION_PLAN.md
 *
 * Run: npm run convergence:docs        (rewrite)
 *      npm run convergence:docs:check  (fail if the committed files are stale)
 *
 * ## Why these are GENERATED
 *
 * A parity matrix is the single most dangerous document in this repository to
 * write by hand. It is the artifact five client teams plan releases against,
 * its cells go stale the moment a route moves, and a stale cell reads as
 * permission: "Customer Mobile — migrated" tells a reviewer the alias behind it
 * is safe to delete. Deleting an alias a shipped Flutter build still calls is
 * not a documentation error, it is an outage on a platform whose installed base
 * cannot be corrected for weeks.
 *
 * So no cell here is typed by a human. Every one is `V1_CONTRACT[].callers` run
 * through `parityRow`, and the manifest is the contract filtered to what is
 * actually mounted.
 */

import fs from 'fs';
import path from 'path';

import {
  ARCHITECTURE_REVIEW_RULE,
  CLIENT_SURFACES,
  SERVICE_DELEGATIONS,
  MIGRATION_ORDER,
  SURFACE_CORRECTION_COST,
  SURFACE_LABEL,
  canonicalManifest,
  capabilityRegistry,
  convergenceOf,
  convergenceSummary,
  deprecationPlan,
  dispositionCounts,
  doubleClaimedIds,
  parityRow,
  unclaimedEntries,
  type ClientSurface,
  type ParityState,
} from '../src/api/v1/convergence';
import { RETIREMENT_CRITERIA } from '../src/api/v1/legacyTelemetry';
import { V1_CONTRACT, V1_PREFIX } from '../src/api/v1/contract';

const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'api');

const header = (source: string, title: string) => `<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-convergence-docs.ts, derived from
    src/api/v1/convergence.ts      (the federated capability registry)
    src/api/v1/contract.ts         (the canonical endpoints and their callers)
    src/api/v1/legacyTelemetry.ts  (retirement criteria)
    ${source}
  Regenerate: npm run convergence:docs
-->

# ${title}
`;

const CELL: Record<ParityState, string> = {
  migrated: '**migrated**',
  legacy: 'legacy',
  planned: 'planned',
  'n/a': '—',
  mixed: '⚠ mixed',
};

// ─── 1. The parity matrix ─────────────────────────────────────────────────────

function parityMatrixDoc(): string {
  const registry = capabilityRegistry().sort((a, b) => a.key.localeCompare(b.key));
  const summary = convergenceSummary();

  const head = `| Capability | Verdict | ${CLIENT_SURFACES.map((s) => SURFACE_LABEL[s]).join(' | ')} |`;
  const divider = `| --- | --- | ${CLIENT_SURFACES.map(() => '---').join(' | ')} |`;
  const rows = registry
    .map((cap) => {
      const row = parityRow(cap);
      const cells = CLIENT_SURFACES.map((s) => CELL[row.surfaces[s]]);
      return `| ${cap.title} | ${row.verdict} | ${cells.join(' | ')} |`;
    })
    .join('\n');

  const detail = registry
    .map((cap) => {
      const row = parityRow(cap);
      const report = convergenceOf(cap);
      const canonical = row.canonicalPaths.map((p) => `  - \`${p}\``).join('\n');
      const legacy = row.legacyPaths.length
        ? row.legacyPaths.map((p) => `  - \`${p}\``).join('\n')
        : '  - none';
      return `### ${cap.title}

- key: \`${cap.key}\` · declared in \`${cap.source}\`
- verdict: **${row.verdict}** · domain service: \`${report.sharedService ?? report.services.join(', ')}\`
- route families: ${report.routeFamilies.map((f) => `\`${f}\``).join(', ')}

Canonical:
${canonical}

Legacy still aliased for this capability:
${legacy}

${cap.roleSplitRationale}`;
    })
    .join('\n\n');

  const delegations = SERVICE_DELEGATIONS.map(
    (d) =>
      `**\`${d.from}\` → \`${d.to}\`** (evidence: \`${d.evidenceFile}\`, \`${d.evidenceImport}\`)\n\n${d.why}`,
  ).join('\n\n');

  return `${header('the seven domain policy registries', 'Client endpoint parity matrix')}
> Every cell is computed from \`V1_CONTRACT[].callers\`. Nothing here is typed by
> hand, because a stale "migrated" cell reads as permission to delete the alias
> behind it — and on mobile that is an outage nobody can correct for weeks.

## 1. Summary

| | |
| --- | --- |
| Capabilities | ${summary.capabilities} |
| Canonical endpoints mounted | ${summary.implementedEndpoints} |
| Canonical endpoints planned | ${summary.plannedEndpoints} |
| Legacy mappings tracked | ${summary.legacyMappings} |
| Converged (one route family) | ${summary.byVerdict.SHARED} |
| Role-split over ONE service | ${summary.byVerdict.ROLE_SPLIT_SHARED_SERVICE} |
| Single-surface | ${summary.byVerdict.SINGLE_SURFACE} |
| **Divergent (forked truth)** | **${summary.byVerdict.DIVERGENT}** |
| Broken (names a missing endpoint) | ${summary.byVerdict.BROKEN} |
| Surface × capability cells on canonical | ${summary.migratedCallerCells} |
| Surface × capability cells still legacy | ${summary.legacyCallerCells} |

**${summary.byVerdict.DIVERGENT} divergent capabilities.** Every capability whose
endpoints span more than one route family names exactly one domain service — the
role split is a permission boundary, never a second implementation.

**${summary.migratedCallerCells} cells on canonical.** ${summary.migratedCallerCells === 0
  ? 'No client has migrated. The v1 namespace is mounted, tested and documented, and it is '
    + 'unpushed — nothing can migrate against a contract that is not serving. That is a '
    + 'deployment gap, not a design gap, and the matrix says so rather than showing '
    + 'optimistic cells.'
  : 'Each one is derived from that client\'s published manifest — the endpoints it calls, '
    + 'generated from its own source with a file:line per call site — and never asserted '
    + 'here by hand. A client with no manifest reads legacy, planned or n/a regardless of '
    + 'what it may already have shipped, because nothing in this repository has verified '
    + 'it; see src/api/v1/client-manifests/.'}

## 2. Legend

| Cell | Meaning |
| --- | --- |
| **migrated** | This client calls the canonical v1 route today |
| legacy | This client calls a legacy route the canonical entry supersedes |
| planned | This client will migrate; it calls no equivalent today |
| ⚠ mixed | This client has migrated SOME endpoints of this capability and not others |
| — | The capability does not apply to this client |

\`⚠ mixed\` exists because a client halfway through a capability is neither
migrated nor legacy, and rounding it to either would make the matrix lie in the
direction of whoever wrote it.

| Verdict | Meaning |
| --- | --- |
| \`SHARED\` | One route family; every surface that performs it calls the same endpoints |
| \`ROLE_SPLIT_SHARED_SERVICE\` | Several route families by role, proven over ONE domain service |
| \`SINGLE_SURFACE\` | Only one surface performs this operation at all |
| \`DIVERGENT\` | Role-split families naming different services — a forked business truth |
| \`BROKEN\` | The capability names a contract id that does not exist |

## 3. The matrix

${head}
${divider}
${rows}

## 4. Correction cost, which is the migration order

Migrate in reverse order of correction cost. A web client is a git push from
being fixed; a mobile client keeps calling whatever the installed build knows
for as long as the customer leaves the app installed.

| Client | Correction cost | Deploy shape | Zero-traffic window before an alias may go |
| --- | --- | --- | --- |
${MIGRATION_ORDER.map((s) => {
    const c = SURFACE_CORRECTION_COST[s];
    return `| ${c.order}. ${SURFACE_LABEL[s]} | ${c.cost} | ${c.deploys} | ${c.retirementDays} days |`;
  }).join('\n')}

## 5. Verified delegations

A capability may name two service modules without being a fork when one is a
decision layer over the other. Each delegation below names the file and the
import that make it true, and \`tests/cross-platform-convergence.test.ts\` reads
those files — an exemption that stops being true stops being granted.

${delegations}

## 6. Every capability

${detail}
`;
}

// ─── 2. The canonical call manifest ───────────────────────────────────────────

function manifestJson(): string {
  const manifest = canonicalManifest();
  return `${JSON.stringify(
    {
      $comment:
        'GENERATED by scripts/generate-convergence-docs.ts. The machine-readable list of every ' +
        'canonical call a client may make. Diff your own call sites against this. Only MOUNTED ' +
        'endpoints appear: a planned entry is documentation, and generating a typed client from ' +
        'one would ship calls to a 404.',
      prefix: V1_PREFIX,
      generatedFrom: 'src/api/v1/contract.ts + src/api/v1/convergence.ts',
      endpointCount: manifest.length,
      surfaces: CLIENT_SURFACES,
      endpoints: manifest,
    },
    null,
    2,
  )}\n`;
}

// ─── 3. The deprecation schedule ──────────────────────────────────────────────

function deprecationScheduleDoc(): string {
  const plan = deprecationPlan();
  const counts = dispositionCounts();
  const retirable = plan.filter((r) => r.retirable);
  const blocked = plan.filter((r) => !r.retirable);

  const rows = plan
    .map(
      (r) =>
        `| \`${r.legacy.method.toUpperCase()} ${r.legacy.path}\` | ${r.legacy.disposition} | \`${r.canonical.id}\` | ${
          r.retirable ? '**retirable**' : r.blockedBy.join('; ')
        } | ${r.earliestWindowDays}d |`,
    )
    .join('\n');

  const named = ['/api/services/full', '/api/services/level2', '/api/level2'];
  const namedRows = plan
    .filter((r) => named.some((n) => r.legacy.path.startsWith(n)))
    .map(
      (r) =>
        `**\`${r.legacy.method.toUpperCase()} ${r.legacy.path}\`** → \`${r.canonical.id}\`\n\n${r.legacy.note}`,
    )
    .join('\n\n');

  return `${header('src/api/v1/legacyTelemetry.ts (RETIREMENT_CRITERIA)', 'Deprecation schedule')}
> No date in this document is a calendar date. Every one is a CONDITION, because
> "we think nobody calls it" is how a path a shipped build depends on gets
> deleted.

## 1. The gate

An alias may be deleted only when all four are true:

1. the canonical successor is \`status: 'implemented'\` — ${RETIREMENT_CRITERIA.requireCanonicalImplemented ? 'required' : 'not required'};
2. every client the matrix lists reads \`migrated\` — ${RETIREMENT_CRITERIA.requireAllCallersMigrated ? 'required' : 'not required'};
3. \`[legacy-contract]\` telemetry has recorded **zero** hits for
   ${RETIREMENT_CRITERIA.webZeroTrafficDays} consecutive days (web-only alias) or
   ${RETIREMENT_CRITERIA.mobileZeroTrafficDays} consecutive days (any mobile caller);
4. the deletion is a separate change from the migration that made it possible, so
   it can be reverted on its own.

Condition 3 is measured in days of observed silence rather than in releases
because an unupdated app keeps calling the old path for as long as it stays
installed.

## 2. Where things stand

| | |
| --- | --- |
| Legacy mappings tracked | ${plan.length + counts.KEEP + counts.ROLE_SPECIFIC} |
| In the retirement plan | ${plan.length} |
| \`KEEP\` (not a duplicate of anything) | ${counts.KEEP} |
| \`ROLE_SPECIFIC\` (different auth/action, same service) | ${counts.ROLE_SPECIFIC} |
| \`ALIAS_TEMPORARILY\` | ${counts.ALIAS_TEMPORARILY} |
| \`CANONICALIZE\` | ${counts.CANONICALIZE} |
| \`RETIRE\` | ${counts.RETIRE} |
| **Retirable today** | **${retirable.length}** |
| Blocked | ${blocked.length} |

${
  retirable.length === 0
    ? 'Nothing is retirable today, and the reason is the same for all of them: no client has migrated, because the v1 namespace is not deployed. The schedule is the order things become retirable, not a queue of pending deletions.'
    : `${retirable.length} alias(es) meet every condition except the observed-traffic window, which still has to run.`
}

## 3. Every alias

| Legacy route | Disposition | Canonical successor | Blocked by | Window |
| --- | --- | --- | --- | --- |
${rows}

## 4. The paths the command names

${namedRows || '_None of `/services/full`, `/level2` appear in the contract\'s legacy mappings._'}

## 5. The next safe step

Deploy the v1 namespace, then migrate Admin Web first — it is the cheapest to
correct and the only surface whose entire capability set is already
role-specific, so a mistake there cannot reach a customer. Provider Web second,
for the same deploy shape and a live installed base that a revert reaches
immediately.

Neither retires anything. Retirement waits on the telemetry window, and the
window cannot start until traffic exists to be counted.
`;
}

// ─── 4. The telemetry spec ────────────────────────────────────────────────────

function telemetrySpecDoc(): string {
  const plan = deprecationPlan();
  const watched = new Set(plan.map((r) => `${r.legacy.method.toUpperCase()} ${r.legacy.path}`));

  return `${header('src/api/v1/legacyTelemetry.ts', 'Legacy telemetry specification')}
> The measurement that turns "temporarily" into a date somebody can defend.

## 1. What is counted

\`legacyContractTelemetry\` derives its watch list FROM \`V1_CONTRACT[].legacy\`,
so a route can only be DOCUMENTED as superseded if it is also being COUNTED.
There is no second list to keep in step: add a legacy mapping to the contract
and it starts reporting on the next boot.

**${watched.size} distinct legacy routes** are on the watch list today.

Per route, per one-hour window:

| Field | Meaning |
| --- | --- |
| \`hits\` | Requests matched to this legacy path |
| \`bearer\` | How many carried an Authorization header |
| \`clients\` | Counts per coarse client label |

## 2. What is deliberately NOT counted

No uid. No path parameter value. No query string. No body. No raw User-Agent.

A telemetry log that names who called is a log that has to be protected like the
data it describes, and this one exists to answer a single question — is anyone
still calling this? — which needs none of that.

The client label is the explicit \`X-Servana-Client\` header when a client sends
one, optionally with \`X-Servana-Client-Version\`. Otherwise it degrades to a
User-Agent FAMILY (\`ua:dart\`, \`ua:browser\`, \`ua:tool\`, \`ua:other\`) and never
the User-Agent itself, which on mobile carries the device model and OS build.

## 3. Where it goes

One \`console.info\` line per route per window:

\`\`\`
[legacy-contract] GET /api/services/full hits=412 bearer=impl window=60m clients=[customer-mobile@1.4.2=380 ua:dart=32]
\`\`\`

A log line rather than a metrics endpoint, deliberately. The API runs under PM2
on a single box, so \`pm2 logs servana-prod | grep legacy-contract\` is a tool
the team already has. A \`/admin/telemetry\` route would need a contract entry, a
permission and a portal screen before it told anybody anything.

\`snapshot()\` returns the current window as an object for tests and for ops.

## 4. Reading it for a retirement decision

1. \`grep legacy-contract\` for the route over the window its callers require
   (${RETIREMENT_CRITERIA.webZeroTrafficDays} days web, ${RETIREMENT_CRITERIA.mobileZeroTrafficDays} days if any mobile client is listed).
2. Zero hits across every window, **and** every caller cell reads \`migrated\`,
   **and** the canonical successor is mounted.
3. Delete the alias as its own change.

A non-zero count from \`ua:dart\` with no version header is the case that most
often stops a retirement: it is a Flutter build old enough to predate the header
being sent, which is exactly the installed base the window exists to protect.

## 5. What this cannot tell you

It counts requests that ARRIVE. A client that has migrated but still ships the
old call behind a feature flag registers zero and is not migrated. That is why
condition 2 of the retirement gate is the caller matrix and not the traffic
count — the two answer different questions, and only the pair is sufficient.

## 6. Never blocks

Every path through the middleware is wrapped. A bug in telemetry is a missing
log line, not an outage on five live clients.
`;
}

// ─── 5. The per-client migration plan ─────────────────────────────────────────

/**
 * One section per client, listing exactly what that client moves.
 *
 * The existing `CROSS_CLIENT_MIGRATION_PLAN.md` argues the ORDER and is
 * hand-written, correctly — it is an argument, and an argument is not derivable.
 * This is the WORK LIST behind that argument, and it is derived, because a
 * hand-maintained list of 95 endpoints against five clients is stale the day
 * after it is written.
 */
function perClientPlanDoc(): string {
  const registry = capabilityRegistry();

  const sections = MIGRATION_ORDER
    .map((surface, index) => {
      const relevant = registry
        .map((cap) => ({ cap, row: parityRow(cap) }))
        .filter(({ row }) => row.surfaces[surface] !== 'n/a')
        .sort((a, b) => a.cap.title.localeCompare(b.cap.title));

      const counts = { migrated: 0, legacy: 0, planned: 0, mixed: 0 };
      for (const { row } of relevant) {
        const state = row.surfaces[surface];
        if (state in counts) counts[state as keyof typeof counts] += 1;
      }

      const work = relevant
        .filter(({ row }) => row.surfaces[surface] !== 'migrated')
        .map(({ cap, row }) => {
          const from = row.legacyPaths.length
            ? row.legacyPaths.map((p) => `\`${p}\``).join(', ')
            : '_no legacy equivalent — this is new_';
          const to = row.canonicalPaths.map((p) => `\`${p}\``).join(', ');
          return `| ${cap.title} | ${CELL[row.surfaces[surface]]} | ${from} | ${to} |`;
        })
        .join('\n');

      const cost = SURFACE_CORRECTION_COST[surface];

      return `## ${index + 1}. ${SURFACE_LABEL[surface]}

Correction cost: **${cost.cost}** — ${cost.deploys}.
An alias this client blocks needs **${cost.retirementDays} days** of observed silence before it may go.

| | |
| --- | --- |
| Capabilities that apply | ${relevant.length} |
| Already on canonical | ${counts.migrated} |
| Still on a legacy route | ${counts.legacy} |
| Partially migrated | ${counts.mixed} |
| No equivalent called today | ${counts.planned} |

| Capability | Today | Calls now | Move to |
| --- | --- | --- | --- |
${work || '| _nothing outstanding_ | | | |'}`;
    })
    .join('\n\n');

  return `${header('the federated capability registry', 'Per-client migration plan')}
> The WORK LIST, derived. The ORDER and the argument for it live in
> [\`CROSS_CLIENT_MIGRATION_PLAN.md\`](CROSS_CLIENT_MIGRATION_PLAN.md), which is
> hand-written because an argument is not derivable. This is what each client
> actually has to change, and it is generated because a hand-maintained list of
> ${V1_CONTRACT.filter((e) => e.status === 'implemented').length} endpoints across five clients is stale the day after it is written.

## How to read this

Clients appear in migration order: cheapest to correct first. A client migrates
one capability at a time, and the legacy route it was calling stays mounted
throughout — that is what "additive" means here, and it is why no step in this
plan can break a client that has not taken it yet.

A row says: this capability, this client, calling this today, should call this
instead. Nothing in the "Move to" column is planned work — every path listed is
mounted and tested now.

${sections}

## What none of this authorizes

Migrating a client does not retire anything. The alias stays until the observed
traffic window in [\`DEPRECATION_SCHEDULE.md\`](DEPRECATION_SCHEDULE.md) has run,
because a client that has migrated in source may still have an installed base
that has not.
`;
}

// ─── Composition ──────────────────────────────────────────────────────────────

export function generateAll(): Array<{ relPath: string; content: string }> {
  return [
    { relPath: 'docs/api/CLIENT_ENDPOINT_PARITY_MATRIX.md', content: parityMatrixDoc() },
    { relPath: 'docs/api/CANONICAL_CALL_MANIFEST.json', content: manifestJson() },
    { relPath: 'docs/api/DEPRECATION_SCHEDULE.md', content: deprecationScheduleDoc() },
    { relPath: 'docs/api/LEGACY_TELEMETRY_SPEC.md', content: telemetrySpecDoc() },
    { relPath: 'docs/api/PER_CLIENT_MIGRATION_PLAN.md', content: perClientPlanDoc() },
  ];
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

/**
 * §138: the manifest must describe exactly what the router mounts.
 *
 * Returned as data rather than thrown, so the test can report every difference
 * at once instead of the first one.
 */
export function manifestDrift(): string[] {
  const problems: string[] = [];
  const manifest = canonicalManifest();
  const mounted = V1_CONTRACT.filter((e) => e.status === 'implemented');

  if (manifest.length !== mounted.length) {
    problems.push(`manifest has ${manifest.length} endpoints, contract mounts ${mounted.length}`);
  }
  for (const entry of mounted) {
    const row = manifest.find((m) => m.id === entry.id);
    if (!row) {
      problems.push(`mounted endpoint ${entry.id} is missing from the manifest`);
      continue;
    }
    if (row.path !== `${V1_PREFIX}${entry.path}`) {
      problems.push(`${entry.id}: manifest path ${row.path} ≠ contract ${V1_PREFIX}${entry.path}`);
    }
    if (!row.capability) {
      problems.push(`${entry.id}: no capability claims this endpoint (§137)`);
    }
  }
  for (const row of manifest) {
    if (!mounted.some((e) => e.id === row.id)) {
      problems.push(`manifest lists ${row.id}, which the contract does not mount`);
    }
  }
  for (const entry of unclaimedEntries()) {
    problems.push(`contract entry ${entry.id} is claimed by no capability (§137)`);
  }
  for (const { id, capabilities } of doubleClaimedIds()) {
    problems.push(`contract entry ${id} is claimed by ${capabilities.length} capabilities: ${capabilities.join(', ')}`);
  }
  return problems;
}

if (require.main === module) {
  if (process.argv.includes('--check')) {
    const drift = manifestDrift();
    const stale = staleFiles();
    if (drift.length) {
      console.error(`Canonical manifest does not describe the router:\n  ${drift.join('\n  ')}`);
    }
    if (stale.length) {
      console.error(
        `Convergence docs are stale — run "npm run convergence:docs":\n  ${stale.join('\n  ')}`,
      );
    }
    if (drift.length || stale.length) process.exitCode = 1;
    else console.log(`Convergence docs are up to date. ${ARCHITECTURE_REVIEW_RULE.checks.length} §137 checks pass.`);
  } else {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const file of generateAll()) {
      const abs = path.resolve(__dirname, '..', file.relPath);
      fs.writeFileSync(abs, file.content, 'utf8');
      console.log(`wrote ${file.relPath}`);
    }
  }
}
