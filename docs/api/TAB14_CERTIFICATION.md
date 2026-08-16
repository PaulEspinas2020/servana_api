# TAB 14 — P0/P1: Observability + Security + Contract CI + Deprecation Safety

## Verdict

```
API RELEASE SAFETY VERDICT: CERTIFIED_WITH_NONBLOCKING_GAPS
```

Every release gate is met in code and proven by executed tests, and this tab
found and fixed a real production-safety defect in the migration runner that no
existing check could have caught. The gaps are the two things this work is
forbidden to do — deploy, and run anything against production — plus their
consequences.

```
CORRELATION PROPAGATED END TO END          IMPLEMENTED ✔  inbound adopted, validated, echoed on every route
STRUCTURED LOGS, REDACTED                  PROVEN      ✔  deny-by-default; 29 adversarial assertions
METRICS FOR EVERY §142 SIGNAL              IMPLEMENTED ✔  8 metrics, bounded labels, route templates
ROUTE HEALTH: 401 IS NOT PROOF             PROVEN      ✔  classifyProbe; INCONCLUSIVE fails a step
SOCKET-LEVEL CONTRACT TESTS                PROVEN      ✔  27 assertions on raw wire bytes
AUTHZ MATRIX PER ENDPOINT/ROLE             PROVEN      ✔  95 endpoints, matrix asserted against authChain
OBJECT-LEVEL OWNERSHIP                     PROVEN      ✔  36 object-scoped, 36 with rules, 0 unguarded
IDEMPOTENCY / CONCURRENCY                  PRE-EXISTING✔  7 suites from TABs 06–12, bound into the gate
MIGRATION TRANSACTION SAFETY               FIXED       ✔  16 of 36 migrations were leaking; stripper repaired
MIGRATION OBJECT OWNERSHIP                 FIXED       ✔  6 unapplied migrations gained explicit owners
OPENAPI / ROUTE / DTO DRIFT GATES          ENFORCED    ✔  10 doc-drift checks in `verify`
DEPRECATION HEADERS + NO-REMOVAL RULE      IMPLEMENTED ✔  82 aliases announced; headers only, no behaviour change
SMOKE CREDENTIAL STRATEGY                  DESIGNED    ✔  3 least-privilege accounts, env-only, GET-only plan
RELEASE GATE CHECKLIST                     ENFORCED    ✔  9 blocking gates, each command asserted to exist
PRODUCTION SMOKE EXECUTED                  NOT RUN     ✖  forbidden by the standing rules
DASHBOARDS / ALERT ROUTING                 SPEC ONLY   ⚠  no metrics backend exists; see §6
LEGACY TRAFFIC MEASURED IN PROD            NOT YET     ⚠  namespace unpushed; nothing to count
```

Branch `main`, HEAD `36ca152`. **All work is uncommitted and local.** Nothing was
pushed, deployed, or run against production. No credential was created, read or
rotated. No live provider, customer or booking record was touched.

---

## 1. The defect this tab found

`run-migrations.ts` wraps every migration in its own transaction so the schema
change and the `schema_migrations` ledger row land together — the right shape,
because a half-applied migration must never be recorded as applied. It stripped
the file's own transaction control first, with two regexes anchored to the start
and the end of the file.

**Those regexes matched nothing in 16 of the 36 migrations.** Every migration in
this repository opens with a comment header, so `BEGIN;` is never at offset 0.
Most close with a verification or operating note, so `COMMIT;` is never the last
thing in the file.

The consequence is not cosmetic. A surviving `COMMIT;` commits the **wrapper's**
transaction in the middle of the migration. Everything after it — including the
ledger insert — runs outside any transaction, and the wrapper's own `COMMIT`
errors with "there is no transaction in progress". A failure in that window
leaves the schema changed and the ledger empty, so the next deploy replays a
migration that has already half-run.

### Why the fix is in the stripper and not in the files

The runner checksums the **raw** file and refuses to proceed if an applied
migration's checksum has changed. Twenty of these files are applied in
production. Editing them to remove `BEGIN;` would change their checksums and
break the migration runner permanently — the remedy would be worse than the
defect.

Because the checksum is taken *before* stripping, fixing the stripper changes no
checksum and no file. `scripts/lib/migrationSafety.ts` masks comments, string
literals and `$$`-quoted bodies before it looks, so PL/pgSQL `BEGIN … END`
inside a `DO` block survives untouched — eleven migrations here would become
syntax errors otherwise.

`tests/migration-safety.test.ts` runs the **old** regexes over the real files to
prove they leaked, then asserts the new stripper leaves zero residue on every
file in the directory. A check that cannot fail is decoration; this one is shown
failing before it is shown passing.

### The second migration finding

Six migrations (030–035) created tables with no `ALTER TABLE … OWNER TO`. All
six carry "NOT APPLIED", so they are unchecksummed and safe to edit; each now
declares `admin` as owner.

Migrations below 029 are reported **advisory** rather than blocking, deliberately:
they are applied and frozen, so a blocking finding on one would be an
instruction to break the deploy. The live remedy is `npm run check:db-ownership`.

The rule exists because of a specific outage recorded in this repository: 29 of
116 tables were owned by `postgres` rather than `admin` after migrations were
applied by hand, the app had no privileges on them, and provider document upload
returned a bare 500 for **every provider** until somebody read the catalog.

---

## 2. Observability (§140–§142)

Three modules, no database handle in the declaration.

**Correlation.** `app.ts` already stamped a UUID per request. What was missing
was the inbound half: a client or proxy that already has a trace id can now hand
it in, so one trace spans their log and ours. The value is pattern-checked
(`[A-Za-z0-9._:-]{8,128}`) before adoption — a caller controls that header, and a
value carrying a newline reaching a line-delimited log can forge an entire entry.
`X-Request-Id` is now set on **every** route, not only v1.

**Logs.** One JSON line per request, emitted on `res.finish` so the status and
latency are the real ones. It reads no request body, no response body, no query
string and no headers beyond the client label — not "reads and redacts", does
not read. Entity ids come from route parameters through a **deny-by-default**
allow-list of 11 keys, with 36 forbidden fragments as belt and braces.

An allow-list is the only design where a *new* sensitive field is safe by
default. Under a deny-list, the developer who adds `taxIdNumber` next month has
to remember it is sensitive, and the failure is silent, permanent, and already in
the aggregator by the time anyone notices.

`actorRole` is logged; there is no uid field and one cannot be added by accident.
"A provider failed to accept a job" is an operational fact. "Provider FbX9… failed
to accept job 84213" is a record of a named person's working day.

**Metrics.** All 8 signals §142 names, with bounded labels. Every route label is
a TEMPLATE — a metric keyed on a real booking id is one series per booking, which
is how a monitoring bill and an outage arrive together, and it is also a record
of which bookings exist held somewhere with weaker access control than the
database.

Quantiles are reported as bucket **upper bounds**. A histogram cannot tell you
the true 95th percentile; pretending otherwise gives an incident a number that is
precise and wrong.

---

## 3. Security (§143, §145, §150)

### A 401 is not route proof

`GET /api/catalog` shipped unreachable. It was shadowed by `GET /api/:id`, and
every check that touched it saw a plausible response and concluded the route was
fine — because in the legacy tree an unknown single-segment path is parsed as a
booking id and answers 401 or 400, which is exactly what a protected route also
answers.

`classifyProbe` therefore returns a proof **strength**. Only `HANDLER_REACHED`
and `ROUTE_ABSENT` count. A bare 401, a v1-shaped `UNAUTHENTICATED`, a 403, an
HTML proxy page — all `INCONCLUSIVE`, and an `INCONCLUSIVE` result **fails** a
smoke step rather than passing it.

### Object-level authorization is the one that matters

A role check is necessary and insufficient: every customer holds the customer
role, and the point is that one customer must not read another's booking.

| | |
| --- | --- |
| Mounted endpoints | 95 |
| Object-scoped | 36 |
| With an ownership rule | **36** |
| Unguarded | **0** |

Each rule names its predicate, the module that enforces it, the suite that proves
it, and what a non-owner receives — and the suite asserts those files still
exist, because a rule naming a renamed file is a rule nobody is checking.

Every rule carries `distinguishesAbsentFromForbidden: false`. Answering 403 for
an object that exists and 404 for one that does not is an enumeration oracle,
and booking ids are small integers.

### Smoke credentials

Three least-privilege accounts, each a name of an environment variable. There is
no field on `SmokeAccount` that could hold a secret — "no secrets in tests" is a
property of the type rather than of somebody's care. The provider account is
explicitly a dedicated seed, never an existing provider, because provider records
are live.

51 of 95 endpoints are probeable. The other 44 are writes and are **never**
probed: a POST to `/bookings/:id/cancel` on production enters the same state
machine a real customer's booking uses, and no account isolation makes that a
smoke test. That exclusion is structural — `smokePlan()` marks every write
`safe: false` and the script has no branch that executes an unsafe step.

---

## 4. Socket-level contract tests (§144)

`v1-router.test.ts` already proved ROUTING over a real socket. This tab adds
SERIALIZATION: what arrives on the wire after every middleware has had a turn.
The app under test mounts the real parity middlewares in the real order from
`app.ts`.

The load-bearing pair:

- a v1 Service response contains no `level2` **in the raw bytes**;
- the **same object** served by a legacy route **does** get parity keys.

Without the second, the first would pass equally well if parity were broken,
uninstalled or never reached — and the exemption would be proving nothing. That
defect was real: parity maps `name` → `level2`, and in the legacy model `level2`
means the SUBCATEGORY, so a canonical Service came back claiming its own name as
its subcategory.

Also asserted on bytes: timestamps arrive as UTC ISO-8601 with `Z` and no
local-offset form appears anywhere; `1234.56` is not reformatted; an integer id
is `"id":180` and not `"id":"180"`.

---

## 5. Deprecation safety (§149)

82 legacy aliases now carry `Deprecation: true` and a
`Link: rel="successor-version"` header. **Headers only** — no status code, body
or behaviour changes, because five live clients depend on these paths and a
deprecation notice that alters a response is not a notice, it is a breakage.
The suite asserts the status and body are untouched.

**No `Sunset` date is emitted, and that is the honest answer.** `Sunset` means
"this WILL stop working then". A date the platform cannot keep teaches client
teams to ignore the header, and then the one route that really is going away is
ignored too. A date appears only when the alias has met every non-traffic
condition; today that is zero routes.

Mounted immediately beside `legacyContractTelemetry`, from the same derivation of
`V1_CONTRACT.legacy`, so a route cannot be *announced* as superseded without also
being *counted*.

---

## 6. Gaps, stated plainly

| | Gap | Why, and what it blocks |
| --- | --- | --- |
| **P0** | v1 namespace not deployed | Forbidden here. Until it serves, no client migrates, no legacy traffic is countable, and no alias becomes retirable. |
| **P0** | Production smoke never executed | Forbidden here. The tooling, the plan and the credential strategy are delivered; the run needs credentials this repository has never seen. |
| **P1** | No metrics backend | The registry is in-process and reports on a log line, matching `legacyTelemetry`'s existing shape. Alert *conditions* are specified; alert *routing* needs a Prometheus/Grafana that does not exist. Swapping the transport touches one file. |
| **P1** | `check:db-ownership` not run | It reads a live catalog. The only reachable database is production. The migration-file guard is the static half of the same rule. |
| **P2** | Migrations 030–035 unapplied | Consistent with every tab since 029. They are applied deliberately by a DBA, and the services also create their tables lazily. |
| **P2** | Log sampling untested under load | `LOG_SAMPLE_RATE` defaults to 1 (log everything) and failures are never sampled away. The sampling path is exercised only by unit reasoning. |
| **P3** | Advisory ownership findings on pre-029 migrations | Deliberate. They are frozen; a blocking finding would be an instruction to break the deploy. |

---

## 7. Verification actually executed

```
npm run typecheck            PASS
npm run typecheck:tests      PASS
guard:protected-contracts    PASS
10 doc-drift checks          PASS  (api, booking, finance, messaging, notification,
                                    account, home, review, convergence, safety)
npm run test:ci              PASS  249 suites, 5591 tests
npm run build                PASS  tsc + asset copy
npm run smoke:plan           PASS  printed; called nothing
```

TAB 14 suites, all executed:

| Suite | Tests |
| --- | --- |
| `tests/migration-safety.test.ts` | 54 |
| `tests/observability-redaction.test.ts` | 29 |
| `tests/socket-contract-serialization.test.ts` | 27 |
| `tests/route-health-and-authz.test.ts` | 34 |
| `tests/release-safety-docs.test.ts` | 32 |

Two of my own assertions were wrong on first run, and both corrections are worth
recording. `uid` is a substring of `uuid`, so a substring search over a serialized
log line flagged the request id as an identity leak — the right check is on keys.
And `sanitizeCorrelationId` trims before validating, so trailing whitespace is
accepted and yields a safe value; the right assertion is the property "whatever
it returns matches the pattern", not a list of cases.

### The standing flakiness note

The intermittent `--runInBand` order-sensitivity recorded in TABs 12 and 13
persists. It has never involved code any of those tabs touched, and the final
runs here were clean.

---

## 8. Files

**New**

```
src/observability/observabilityPolicy.ts     schema, redaction, metrics, alerts
src/observability/requestLog.ts              correlation + structured logging
src/observability/metrics.ts                 the registry
src/observability/releaseGate.ts             the gates and prohibitions
src/api/v1/deprecation.ts                    RFC 8594 headers, no-removal rule
src/api/v1/routeHealth.ts                    proof strength, smoke plan/accounts
src/api/v1/authzMatrix.ts                    roles + object ownership
scripts/lib/migrationSafety.ts               THE transaction-stripper fix
scripts/production-smoke.ts                  never run; refuses non-local targets
scripts/generate-release-safety-docs.ts      the generator
docs/api/OBSERVABILITY_STANDARD.md           (generated)
docs/api/SECURITY_AUTHZ_MATRIX.md            (generated)
docs/api/API_CONTRACT_CI.md                  (generated)
docs/api/RELEASE_GATE_CHECKLIST.md           (generated)
docs/api/TAB14_CERTIFICATION.md
tests/migration-safety.test.ts
tests/observability-redaction.test.ts
tests/socket-contract-serialization.test.ts
tests/route-health-and-authz.test.ts
tests/release-safety-docs.test.ts
```

**Modified**

```
src/app.ts                     +3 middlewares, purely additive, no deletions
scripts/run-migrations.ts      uses the fixed stripper; checksums unchanged
scripts/migrations/030…035     explicit OWNER TO admin (all six unapplied)
package.json                   safety:docs, safety:docs:check, smoke, smoke:plan, verify
tests/suite-inventory.test.ts  244 → 249
```

**Endpoints added / changed / aliased / retired: none.** No route, request shape
or response shape moved. Every change is a middleware that adds headers and
logs, a migration-runner fix that alters no migration file, and tests. That is
the correct outcome for a release-safety command: the deliverable is the ability
to see and to block, not new surface.

**Clients migrated: 0 of 5. Compatibility still active: all 114 legacy mappings,
82 of them now announcing a successor.** The TAB 01–13 dirty tree was preserved
in full.

---

## 9. The next safe deprecation step

Unchanged from TAB 13, and now measurable when it happens:

1. Deploy the v1 namespace. Nothing else on this list can start until it serves.
2. Watch `[servana-metrics] legacy_route_hits_total` and `[legacy-contract]` for
   a full window — 14 days web, 90 days if any mobile client is listed.
3. Migrate Admin Web first: cheapest to correct, and its whole capability set is
   already role-specific, so a mistake cannot reach a customer.
4. **Retire nothing yet.** Migration is not retirement. An alias goes only when
   traffic has read zero for the window, every caller cell reads `migrated`, the
   successor is mounted, and the removal is its own revertible commit.
