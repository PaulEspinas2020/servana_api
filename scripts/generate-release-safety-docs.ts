/**
 * Writes the generated TAB 14 documents.
 *
 *   docs/api/OBSERVABILITY_STANDARD.md
 *   docs/api/SECURITY_AUTHZ_MATRIX.md
 *   docs/api/API_CONTRACT_CI.md
 *   docs/api/RELEASE_GATE_CHECKLIST.md
 *
 * Run: npm run safety:docs        (rewrite)
 *      npm run safety:docs:check  (fail if the committed files are stale)
 *
 * ## Why these are GENERATED
 *
 * The authorization matrix is the dangerous one. It is the document a reviewer
 * consults to answer "is this endpoint protected?", and a stale row answers
 * confidently and wrongly. Every cell here is `ROLE_ACCESS[entry.auth]` — the
 * same table the router's auth chain is asserted against — so a route whose
 * auth mode changes rewrites its own row.
 *
 * The release checklist has the same property for a different reason: every
 * line names an npm script, and `tests/release-gate.test.ts` asserts the script
 * exists. A gate whose command was renamed is a gate that silently stopped
 * being checked.
 */

import fs from 'fs';
import path from 'path';

import {
  ALERTS,
  CORRELATION,
  FORBIDDEN_KEY_FRAGMENTS,
  LATENCY_BUCKETS_MS,
  LOG_FIELDS,
  METRICS,
  P0_ALERTS,
  SAFE_ENTITY_KEYS,
  redact,
  routeTemplate,
} from '../src/observability/observabilityPolicy';
import { BLOCKING_GATES, RELEASE_GATES, RELEASE_PROHIBITIONS } from '../src/observability/releaseGate';
import {
  OWNERSHIP_RULES,
  PROVIDER_MODE_EXCLUDES_ADMIN,
  ROLES,
  ROLE_ACCESS,
  authorizationMatrix,
  matrixSummary,
} from '../src/api/v1/authzMatrix';
import { CREDENTIAL_RULES, SMOKE_ACCOUNTS, smokeSummary } from '../src/api/v1/routeHealth';
import { NO_REMOVAL_RULE, __notices } from '../src/api/v1/deprecation';
import { RETIREMENT_CRITERIA } from '../src/api/v1/legacyTelemetry';
import { V1_CONTRACT } from '../src/api/v1/contract';
import { APPROVED_OWNER_ROLES, OWNERSHIP_REQUIRED_FROM } from './lib/migrationSafety';

const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'api');

const header = (title: string, sources: string) => `<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-release-safety-docs.ts, derived from
${sources}
  Regenerate: npm run safety:docs
-->

# ${title}
`;

// ─── 1. Observability standard ────────────────────────────────────────────────

function observabilityDoc(): string {
  const fields = LOG_FIELDS.map(
    (f) => `| \`${f.field}\` | ${f.presence} | ${f.description} |`,
  ).join('\n');

  const metrics = METRICS.map(
    (m) => `### \`${m.name}\` (${m.kind})

${m.description}

- labels: ${m.labels.map((l) => `\`${l}\``).join(', ')}
- **why:** ${m.why}`,
  ).join('\n\n');

  const alerts = ALERTS.map(
    (a) => `| ${a.severity} | \`${a.name}\` | \`${a.metric}\` | ${a.condition} | ${a.firstAction} |`,
  ).join('\n');

  // EVIDENCE: run the real redactor over a real-shaped payload.
  const example = redact({
    bookingId: 84213,
    serviceId: 180,
    customerEmail: 'dana@example.com',
    addressOne: '14 Mabini Street',
    otp: '482913',
    accessToken: 'eyJhbGciOiJIUzI1NiJ9.abc',
  });

  return `${header('Observability standard', `    src/observability/observabilityPolicy.ts  (schema, redaction, metrics, alerts)
    src/observability/requestLog.ts           (the middleware)
    src/observability/metrics.ts              (the registry)`)}
> One log schema, one correlation id, one metric vocabulary. The redaction
> example below is produced by RUNNING the real redactor, so it is evidence
> rather than description.

## 1. Correlation (§140)

One id, end to end.

| | |
| --- | --- |
| Returned as | \`${CORRELATION.header}\` on every response |
| Accepted from | ${CORRELATION.inboundHeaders.map((h) => `\`${h}\``).join(', ')} |
| Client identity | \`${CORRELATION.clientHeader}\`, \`${CORRELATION.clientVersionHeader}\` |

Propagated to:

${CORRELATION.propagatedTo.map((p) => `- ${p}`).join('\n')}

${CORRELATION.note}

An inbound id must match \`[A-Za-z0-9._:-]{8,128}\`. That is not fussiness: a
caller-controlled value that reaches a line-delimited log can inject an entire
forged entry, and the same value ends up in the error envelope the client
displays.

## 2. The log line (§141)

One JSON object per request, emitted on \`res.finish\` so the status and latency
are the real ones.

| Field | Presence | Meaning |
| --- | --- | --- |
${fields}

### What is never logged

The middleware does not read request bodies, response bodies, query strings or
headers beyond the client label. Not "reads them and redacts" — does not read
them.

Entity ids come from route parameters through a **deny-by-default allow-list**:

- kept: ${SAFE_ENTITY_KEYS.map((k) => `\`${k}\``).join(', ')}
- everything else is dropped
- these fragments are additionally replaced wherever they appear:
  ${FORBIDDEN_KEY_FRAGMENTS.slice(0, 12).map((f) => `\`${f}\``).join(', ')}, …

An allow-list is the only design where a NEW sensitive field is safe by default.
Under a deny-list, the next developer who adds \`taxIdNumber\` to a payload has
to remember it is sensitive, and the failure is silent, permanent, and already
in the aggregator by the time anybody notices.

### The redactor, run

Input:

\`\`\`json
{
  "bookingId": 84213, "serviceId": 180,
  "customerEmail": "dana@example.com", "addressOne": "14 Mabini Street",
  "otp": "482913", "accessToken": "eyJhbGciOiJIUzI1NiJ9.abc"
}
\`\`\`

Output:

\`\`\`json
${JSON.stringify(example, null, 2)}
\`\`\`

### A ROLE, never a person

\`actorRole\` is one of \`admin\`, \`provider\`, \`customer\`, \`anonymous\`. There is no
uid field and one cannot be added by accident.

"A provider failed to accept a job" is an operational fact. "Provider FbX9… failed
to accept job 84213" is a record of a named person's working day, and a log that
accumulates those has to be protected like the database it describes.

## 3. Cardinality

Every route label is a TEMPLATE. \`${routeTemplate('/api/v1/bookings/84213/timeline')}\`,
never the concrete path.

A metric keyed on a real booking id is one series per booking, which is how a
monitoring bill and an outage arrive on the same afternoon. It is also a record
of which bookings exist, held somewhere with weaker access control than the
database.

## 4. Metrics (§142)

Latency buckets (ms): ${LATENCY_BUCKETS_MS.join(', ')}.

Quantiles are reported as bucket UPPER BOUNDS. A histogram cannot tell you the
true 95th percentile; pretending otherwise gives an incident a number that is
precise and wrong.

${metrics}

## 5. Alerts (§151)

${P0_ALERTS.length} P0 signals. A P0 wakes somebody; the rest wait for the morning.

| Severity | Alert | Metric | Condition | First action |
| --- | --- | --- | --- | --- |
${alerts}

Each alert names a FIRST ACTION, because an alert that says only "error rate is
high" makes an incident longer than no alert at all.

## 6. Where it goes

\`console.info\` with a JSON payload, and \`[servana-metrics]\` lines on a window.

Deliberately log lines rather than a metrics endpoint. The API runs under PM2 on
a single box, so \`pm2 logs servana-prod\` is the tool the team already has. A
\`/admin/telemetry\` route would need a contract entry, a permission and a portal
screen before it told anybody anything.

\`snapshot()\` returns the registry as data — that is what the tests read, and
what a future exporter would serialize. Swapping the transport touches one file.
`;
}

// ─── 2. Security / authz matrix ───────────────────────────────────────────────

function authzDoc(): string {
  const summary = matrixSummary();

  const roleTable = (Object.keys(ROLE_ACCESS) as Array<keyof typeof ROLE_ACCESS>)
    .map((mode) => {
      const cells = ROLES.map((r) => (ROLE_ACCESS[mode][r] === 'allow' ? 'allow' : '—'));
      return `| \`${mode}\` | ${cells.join(' | ')} |`;
    })
    .join('\n');

  const rows = authorizationMatrix()
    .map(
      (row) =>
        `| \`${row.id}\` | ${row.method} ${row.path} | \`${row.authMode}\` | ${
          ROLES.map((r) => (row.access[r] === 'allow' ? '●' : '·')).join(' ')
        } | ${row.objectScoped ? (row.ownership ? '✔ ' + row.ownership.parameter : '**MISSING**') : '—'} |`,
    )
    .join('\n');

  const ownership = OWNERSHIP_RULES.map(
    (rule) => `### \`${rule.domain}\` — \`:${rule.parameter}\`

- predicate: ${rule.predicate}
- enforced by: \`${rule.enforcedBy}\`
- proven by: \`${rule.provenBy}\`
- a non-owner receives: ${rule.refusal}
- distinguishes absent from forbidden: **${rule.distinguishesAbsentFromForbidden ? 'YES — this is a defect' : 'no'}**`,
  ).join('\n\n');

  const accounts = SMOKE_ACCOUNTS.map(
    (a) => `### \`${a.key}\`

- auth mode: \`${a.authMode}\` · credential: \`$${a.credentialEnv}\` · rotate every ${a.rotationDays} days
- privilege: ${a.privilege}

${a.constraints.map((c) => `- ${c}`).join('\n')}`,
  ).join('\n\n');

  return `${header('Security and authorization matrix', `    src/api/v1/authzMatrix.ts   (roles, object ownership)
    src/api/v1/routeHealth.ts   (proof strength, smoke accounts)
    src/api/v1/contract.ts      (the declared auth mode per endpoint)`)}
> Two questions, and only one of them is about roles.

## 1. Summary

| | |
| --- | --- |
| Mounted endpoints | ${summary.endpoints} |
| \`public\` | ${summary.public} |
| \`authenticated\` | ${summary.authenticated} |
| \`provider\` | ${summary.provider} |
| \`admin\` | ${summary.admin} |
| Object-scoped | ${summary.objectScoped} |
| Object-scoped WITH an ownership rule | ${summary.objectScopedWithRule} |
| **Unguarded** | **${summary.unguarded}** |

## 2. Role access, by declared mode

| Mode | ${ROLES.join(' | ')} |
| --- | ${ROLES.map(() => '---').join(' | ')} |
${roleTable}

Derived from the auth chain in \`register.ts\` and asserted against it, so a mode
whose chain changes without this table changing fails the build.

**\`provider\` denies admin, deliberately.** ${PROVIDER_MODE_EXCLUDES_ADMIN}

## 3. Object-level authorization is the one that matters

A role check is necessary and not sufficient. Every customer holds the customer
role; the whole point is that one customer must not read another's booking.

A booking carries an address and a time when somebody will be at home. A leak of
it is not a data-protection abstraction — it is telling a stranger where a person
lives and when they will be there. OWASP puts this first in the API top ten.

${ownership}

### Why almost every refusal is a 404

Answering 403 for an object that exists and 404 for one that does not is an
enumeration oracle, and booking ids are small integers. Every rule above is
asserted NOT to distinguish the two cases.

## 4. The matrix

Columns are ${ROLES.join(', ')}. \`●\` = the auth chain admits that role.

| Endpoint | Route | Mode | ${ROLES.map((r) => r[0].toUpperCase()).join(' ')} | Object rule |
| --- | --- | --- | --- | --- |
${rows}

## 5. What counts as proof that a route is protected (§143)

> A 401 from global auth middleware must never be considered route proof.

\`GET /api/catalog\` shipped unreachable. It was shadowed by \`GET /api/:id\`, and
every check that touched it saw a plausible response and concluded the route was
fine — because in the legacy tree an unknown single-segment path is parsed as a
booking id and answers 401 or 400, which is exactly what a protected route also
answers.

\`classifyProbe\` therefore returns a proof STRENGTH:

| Verdict | Meaning |
| --- | --- |
| \`HANDLER_REACHED\` | The handler produced the response. The only positive proof. |
| \`ROUTE_ABSENT\` | The v1 router's own terminal 404. Definitive absence. |
| \`INCONCLUSIVE\` | A bare 401/403, an HTML body, a proxy error. Proves nothing. |

An \`INCONCLUSIVE\` result **fails** a smoke step. It is not a pass.

## 6. Smoke credentials (§150)

${smokeSummary().probed} of ${smokeSummary().total} endpoints are probeable; the other
${smokeSummary().skippedWrites} are writes and are never probed, because a POST to
\`/bookings/:id/cancel\` on production enters the same state machine a real
customer's booking uses.

${accounts}

### Rules

- **storage** — ${CREDENTIAL_RULES.storage}
- **rotation** — ${CREDENTIAL_RULES.rotation}
- **personal accounts** — ${CREDENTIAL_RULES.personalAccounts}
- **least privilege** — ${CREDENTIAL_RULES.leastPrivilege}
- **on failure** — ${CREDENTIAL_RULES.onFailure}

There is no field on \`SmokeAccount\` that can hold a secret. "No secrets in
tests" is a property of the type rather than of somebody's care.
`;
}

// ─── 3. Contract CI ───────────────────────────────────────────────────────────

function contractCiDoc(): string {
  const notices = __notices.length;
  const gates = RELEASE_GATES.map(
    (g) => `| ${g.severity === 'BLOCKING' ? '**blocking**' : 'advisory'} | ${g.title} | \`${g.command}\` |`,
  ).join('\n');

  return `${header('API contract CI', `    src/observability/releaseGate.ts   (the gates)
    src/api/v1/deprecation.ts         (deprecation signalling)
    scripts/lib/migrationSafety.ts    (migration rules)`)}
> What CI checks about the contract, and what each failure would mean to a live
> client.

## 1. Drift gates (§148)

Nine generated-documentation checks run in \`npm run verify\`. Each one
regenerates a document from the code and fails if the committed copy differs, so
a contract change that is not reflected in the published documents cannot merge.

| Check | What it compares |
| --- | --- |
| \`api:docs:check\` | OpenAPI, endpoint registry and migration matrix against \`V1_CONTRACT\` |
| \`convergence:docs:check\` | the canonical call manifest against the MOUNTED router |
| \`booking:docs:check\` … \`review:docs:check\` | each domain contract against its policy declaration |
| \`safety:docs:check\` | this document, the authz matrix and the observability standard |

\`convergence:docs:check\` is the strongest of these: \`manifestDrift()\` compares
the manifest against what \`register.ts\` actually mounts, not against what the
contract claims. An entry documented and not mounted fails.

## 2. Semantic guards

Type-level agreement is not enough — a contract can typecheck and still be
wrong. These assert meaning:

- **route existence** — every implemented entry is driven over a real socket in
  \`tests/v1-router.test.ts\`; a 401 is never accepted as proof (§143).
- **serialization** — \`tests/socket-contract-serialization.test.ts\` asserts on
  raw response bytes, so a middleware that adds \`level2\` to a canonical Service
  fails even though every service-layer test passes.
- **shared domain service** — \`tests/cross-platform-convergence.test.ts\` compares
  the \`domainService\` strings behind role-split routes.
- **object ownership** — \`tests/route-health-and-authz.test.ts\` fails when a new
  object-scoped endpoint appears with no ownership rule.
- **redaction** — \`tests/observability-redaction.test.ts\` throws realistic
  payloads at the redactor and asserts on what SURVIVED.

## 3. Deprecation (§149)

${notices} legacy aliases carry deprecation headers today:

\`\`\`
Deprecation: true
Link: </api/v1/…>; rel="successor-version"
\`\`\`

Headers only. No status code, body or behaviour changes — five live clients
depend on these paths, and a deprecation notice that alters a response is not a
notice, it is a breakage.

### Why almost nothing carries a Sunset date

${NO_REMOVAL_RULE.whyNotADate}

A \`Sunset\` header is emitted only when the alias has met every non-traffic
condition, and today that is zero routes. The honest signal is \`Deprecation:
true\` with a successor link and no date.

### The no-removal rule

${NO_REMOVAL_RULE.statement}

Evidence required:

${NO_REMOVAL_RULE.evidence.map((e) => `- ${e}`).join('\n')}

Windows: ${RETIREMENT_CRITERIA.webZeroTrafficDays} days of observed silence for a
web-only alias, ${RETIREMENT_CRITERIA.mobileZeroTrafficDays} days if any mobile
client is listed — because an unupdated app keeps calling the old path for as
long as it stays installed.

## 4. Migration safety (§147)

Two rules, both enforced by \`tests/migration-safety.test.ts\`.

**The deploy wrapper owns the transaction.** \`run-migrations.ts\` wraps each
migration in \`BEGIN\`/\`COMMIT\` so the schema change and the \`schema_migrations\`
ledger row land together. The file's own transaction control is stripped first.

That stripper used to be two regexes anchored to the start and end of the file,
and they matched nothing in **16 of the 36 migrations** — every file opens with a
comment header and most close with a verification note. A surviving \`COMMIT;\`
commits the wrapper's transaction mid-migration, so the ledger insert lands
outside any transaction and the wrapper's own COMMIT fails.

The fix is in the stripper, not the files: twenty migrations are applied in
production and the runner refuses a checksum change, so editing them would break
the deploy permanently. The checksum is taken from the RAW file, so fixing the
stripper moves no checksum.

\`stripTransactionControl\` masks comments, string literals and \`$$\` bodies
before it looks, so PL/pgSQL \`BEGIN … END\` inside a \`DO\` block survives —
eleven migrations would otherwise become syntax errors.

**Created objects are owned by an approved role.** Required from migration
${OWNERSHIP_REQUIRED_FROM} onward; approved roles: ${APPROVED_OWNER_ROLES.map((r) => `\`${r}\``).join(', ')}.

Earlier migrations are advisory rather than blocking, because they are applied
and frozen — a blocking finding on one would be an instruction to break the
deploy. The live remedy is \`npm run check:db-ownership\`, which reads the actual
catalog.

The rule exists because of a specific outage: 29 of 116 tables were owned by
\`postgres\` rather than \`admin\` after migrations were applied by hand, the app
had no privileges on them, and provider document upload returned a bare 500 for
every provider until somebody read the catalog.

## 5. The gates

| | Gate | Command |
| --- | --- | --- |
${gates}

${BLOCKING_GATES.length} of ${RELEASE_GATES.length} block a deploy. That list is
deliberately short: a gate that blocks for something a human would wave through
teaches people to wave things through, and then the gate that mattered gets
waved through too.
`;
}

// ─── 4. Release checklist ─────────────────────────────────────────────────────

function releaseChecklistDoc(): string {
  const blocking = BLOCKING_GATES.map(
    (g) => `- [ ] **${g.title}**\n      \`${g.command}\`\n      _A failure means:_ ${g.failureMeans}`,
  ).join('\n\n');

  const advisory = RELEASE_GATES.filter((g) => g.severity === 'ADVISORY')
    .map((g) => `- [ ] ${g.title} — \`${g.command}\`\n      _${g.failureMeans}_`)
    .join('\n\n');

  const prohibitions = RELEASE_PROHIBITIONS.map(
    (p) => `- **${p.rule}**\n  ${p.exception}`,
  ).join('\n\n');

  return `${header('Release gate checklist', `    src/observability/releaseGate.ts  (the gates and prohibitions)`)}
> Every line is a command somebody can run. \`tests/release-gate.test.ts\`
> asserts each named script exists, because a gate whose command was renamed is
> a gate that silently stopped being checked.

## 1. Blocking — the deploy does not go out

${blocking}

## 2. Advisory — record the result, use judgement

${advisory}

## 3. Prohibitions

Not automatable. These are decisions a human makes, so they are listed rather
than checked, and each names the evidence that would justify an exception.

${prohibitions}

## 4. After the deploy

1. Watch \`[servana-metrics] http_requests_total\` for a 5xx share above the
   pre-deploy baseline. Group by \`route\` — one route is this release, every
   route is the database or the process.
2. Watch \`auth_failures_total\` grouped by \`client\`. A spike on ONE client
   version is a bad release; a spike across clients is not about you.
3. Confirm \`legacy_route_hits_total\` has not moved for a route that was reading
   zero. A route waking up means a client rolled back — do NOT retire that alias.
4. Do not run a production smoke against live records. The plan
   (\`npm run smoke:plan\`) probes GET endpoints only, with seeded least-privilege
   accounts, and treats a 401 as a FAILURE rather than as proof.

## 5. What this checklist cannot tell you

Every gate here runs against this repository. None of them observes production,
because nothing in this repository is permitted to reach it.

So a green checklist means the artifact is internally consistent, contract-true
and safe to deploy — not that the deploy succeeded. The first four minutes after
a release are the checklist above, and they are somebody watching, not a script.
`;
}

// ─── Composition ──────────────────────────────────────────────────────────────

export function generateAll(): Array<{ relPath: string; content: string }> {
  return [
    { relPath: 'docs/api/OBSERVABILITY_STANDARD.md', content: observabilityDoc() },
    { relPath: 'docs/api/SECURITY_AUTHZ_MATRIX.md', content: authzDoc() },
    { relPath: 'docs/api/API_CONTRACT_CI.md', content: contractCiDoc() },
    { relPath: 'docs/api/RELEASE_GATE_CHECKLIST.md', content: releaseChecklistDoc() },
  ];
}

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

/** §148: the authz matrix must describe every endpoint the router mounts. */
export function safetyDrift(): string[] {
  const problems: string[] = [];
  const mounted = V1_CONTRACT.filter((e) => e.status === 'implemented');
  const rows = authorizationMatrix();

  if (rows.length !== mounted.length) {
    problems.push(`authz matrix has ${rows.length} rows, router mounts ${mounted.length}`);
  }
  for (const row of rows) {
    if (row.objectScoped && !row.ownership) {
      problems.push(`${row.id}: object-scoped with no ownership rule (§145)`);
    }
  }
  for (const rule of OWNERSHIP_RULES) {
    if (rule.distinguishesAbsentFromForbidden) {
      problems.push(`${rule.domain}: refusal distinguishes absent from forbidden — enumeration oracle`);
    }
  }
  return problems;
}

if (require.main === module) {
  if (process.argv.includes('--check')) {
    const drift = safetyDrift();
    const stale = staleFiles();
    if (drift.length) console.error(`Authorization matrix does not describe the router:\n  ${drift.join('\n  ')}`);
    if (stale.length) console.error(`Release-safety docs are stale — run "npm run safety:docs":\n  ${stale.join('\n  ')}`);
    if (drift.length || stale.length) process.exitCode = 1;
    else console.log(`Release-safety docs are up to date. ${BLOCKING_GATES.length} blocking gates declared.`);
  } else {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const file of generateAll()) {
      fs.writeFileSync(path.resolve(__dirname, '..', file.relPath), file.content, 'utf8');
      console.log(`wrote ${file.relPath}`);
    }
  }
}
