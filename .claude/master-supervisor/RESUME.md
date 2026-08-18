# RESUME — Servana API MASTER COMMAND (12 TABs)

Repo state at handoff: branch `main`, working tree **clean**, nothing deployed.
Check the commit count yourself — `git rev-list --count origin/main..HEAD` — the
last two handoffs both recorded a number that was already stale by the time the
next session read it.

Read this, then `MEMORY.md`, `state.json`, `DECISIONS.md`, and
`docs/PRODUCTION_READINESS.md`. Everything below was measured, not remembered.

---

## 1. Prove the baseline before changing anything

```
npm run verify              expect PASS — 269 suites, 5823 tests
npm run db:verify:embedded  expect PASS — 121 restored + 7 applied = 132 tables
npm run schema:authority    expect UNMANAGED 0, MISSING 0, contested 1 / 0
                            unsatisfiable, 1 invisible index  (exits 0)
npm run ddl:inventory       expect 3 unmanaged, 3 objects  (exits 1 BY DESIGN)
                            ⚠ UNDERSTATES the backlog — it cannot see a
                            CREATE INDEX whose name is interpolated
npm run authz:legacy        expect 615 routes, 0 loosenings
npm run release:summary     writes reports/release-summary.json
```

**THREE gates exit non-zero deliberately**, not two as this file previously said:
`db:verify`, `ddl:inventory` and `migrations:baseline:plan`. None of them belongs
in `npm run verify`.

Read the numbers as a pair. `ddl:inventory` counts what no MIGRATION owns;
`schema:authority` counts what NOTHING in the repository owns. The second is the
one that blocks.

---

## 2. TAB status

| TAB | Priority | State |
| --- | --- | --- |
| 01 Establish the release gate | P0 | **Done** except the concurrency suite |
| 02 Migrations the sole schema authority | P0 | **Rescoped and half-done — see §3** |
| 03 Atomic startup lifecycle | P0 | **Done** — BOOTED and observed, see §2b |
| 04 Centralize authorization policy | P0 | Rules derived, parity gated, audit wired |
| 05 Converge clients onto v1 | P1 | Not started — 0 of 108 migrated |
| 06 Booking transitions the only write path | P0 | Not started (largely done by the previous command's TAB 04) |
| 07 Harden money movement | P0 | Not started |
| 08 Schedulers safe under scale | P1 | **Done** — six jobs lease-protected |
| 09 Unify errors/logging/observability | P1 | **Done** — terminal handler added; rest pre-existed |
| 10 Remove query amplification | P1 | Not started |
| 11 Data ownership / cross-store | P1 | Not started |
| 12 Security + dependency hygiene | P1 | **Mostly** — env schema added; CI scan still absent |

---

## 2b. The startup was BOOTED — what that proved, and what it did not

Run against a database that does not exist (every target a closed local port; the
ECONNREFUSED address in the log proves which host it reached, so no production
was contacted):

```
[env] degraded — unset: PAYMONGO_SECRET_KEY, MAILER_KEY, ...
[scheduler] 6 cron jobs started (lease-protected).
Magic is running on port 39217
[lifecycle] 1/6 dependencies ready — degraded:
  admin-permission-seed(required/failed), customer-review-schema(optional/failed), ...
GET /healthz → 200 {"status":"alive"}
GET /readyz  → 503 {"phase":"degraded","ready":false,"live":true,...}
```

PROVED: the graph resolves, a failed REQUIRED dependency leaves readiness false
while liveness stays true, the process stays up and says why, `listen` and
`startScheduler` both run inside `startServer` rather than at import.

NOT PROVED: that the six dependencies SUCCEED against real schema.
`admin-permission-seed` writes data, which is a production action. A staging or
restored-backup database answers this without that write landing in production.

⚠ **Readiness gates NOTHING but the probe.** `isReady()` is read only by
`/readyz`, so a failed required dependency leaves the app serving traffic while
the probe returns 503 to whoever asks. app.ts chose this deliberately — refusing
to bind leaves an operator no endpoint to ask WHY — and it assumes a load
balancer routes on `/readyz`. Production is PM2 behind nginx, which does not
health-gate by default, so in practice nothing acts on the 503. An in-process
request gate is NOT an obvious fix: a flapping dependency would take the whole
API down. This needs a decision, not a patch.

⚠ **Booting found a defect that reading did not.** Every dependency in `/readyz`
came back carrying `serviceName`, `service_name`, `level2` and `level_2` — the
legacy catalog parity middleware was rewriting operational probes, because
`/healthz` and `/readyz` were missing from `CANONICAL_CONTRACT_PREFIXES`. Fixed,
narrowly, with a test asserting legacy routes are STILL rewritten.

**Reproduce it:** set DB_* / MONGO_* to a closed local port, NODE_ENV=development,
then `node -r ts-node/register/transpile-only -e "require('./src/app.ts').startServer()"`.

---

## 3. TAB 02 was scoped from a number that meant something else

The previous handoff said: *"move 154 runtime DDL statements into migrations …
this is the multi-week core of the command and the thing everything else waits
on."* That was wrong, and `npm run schema:authority` now shows why.

`ddl:inventory` asks only whether a **migration** owns an object. Migrations
stopped being the only schema authority here when TAB 15 added
`scripts/baseline/000-baseline.sql` — production's own `pg_dump`, which
`db:verify:embedded` restores and then applies pending migrations on top of. The
154 was the union of two unrelated problems:

- **148 statements** touch an object the baseline already declares. Verified
  against the real engine, not a regex: restore the baseline into PGlite, ask
  PostgreSQL which tables exist, and all 51 tables and 39 ALTER targets are
  there. These are **redundant statements to DELETE**. Nothing to author.
- **6 statements and 3 columns** were declared by nothing in the repository.
  That was the whole authoring gap, and it was booking-critical:
  `booking_transitions`, `idx_booking_transitions_booking`,
  `booking_transition_idempotency` (the ONE canonical transition writer),
  `booking_evidence`, `idx_booking_evidence_booking_worker`,
  `worker_onboarding`, and `booking_workers.{cancelled_at,
  cancellation_reason_code, cancellation_note}`.

They are absent from production's dump, so they exist only where this unreleased
code has already run. On deploy the application would create them itself, at
runtime, on the booking write path — and would fail outright once DDL privileges
are revoked.

`scripts/migrations/036-booking-transition-evidence-onboarding.sql` closes that
gap. Every definition is a fingerprint of the runtime statement it replaces, and
that is proven rather than asserted — three orderings on real PostgreSQL
(migration-first, runtime-DDL-first, double-apply) all converge on 132 tables.

### What is actually left

**Three runtime DDL statements remain, and all three are the deferred
`chat.repository`.** 148 → 3 is done (objects 106 → 3, startup graph 19 → 6),
across twenty-two services. Only ONE startup entry is still `required`, and it
seeds DATA rather than schema:

- `accountDeletionService`, `providerOperationalAvailabilityService`
- `adminNotificationService`, `adminMobileAttributionService`,
  `adminBookingDraftService`, `providerOnboardingService`,
  `providerActivationService`, `identityColumns`, `adminOnboardingService`
- `providerAvailabilityEngine`, `providerServiceAreaEngine`
- `adminProviderService`, `adminInviteState`, `adminAuditService`,
  `adminFinanceService`, `adminGuestService`
- `adminPermissionService` (**split**, not deleted), `customerSupportService`
- `adminCommunicationService`, `providerCatalogService`
- `serviceApplicationService`, `technicianService` (six of its seven bootstraps)
- `notification.service` (both), `providerAutoOnlineEngine`,
  `adminBookingService`, `adminCreateBookingService`

`adminPermissionService` is the pattern for a bootstrap that does DDL **and**
seeding: the DDL goes, the seeding stays, and the function gets RENAMED —
`seedAdminPermissions`, because a function called `ensurePermissionSchema` that
touches no schema is a lie the next reader has to find by reading the body. Its
startup entry stays `required` for a reason that is now stated on it: a grant row
is meaningless without its definition row, so an unseeded database holds grants
that resolve to nothing.

`providerCatalogService` needed NO split — its seeding was already a separate
export, so the DDL half came out on its own. That is the shape to aim for.

⛔ **`technicianService.ensureOnboardingTable` is the LAST gated deletion.** It
creates `worker_onboarding`, which migration 036 claims and production lacks. Six
sibling bootstraps in that same file were removed and this one was deliberately
left — which is exactly what a sweep would have taken along with the rest. When 036
is applied, this comes out with the other five 036 objects.

⛔ **`chat.repository` is DEFERRED, not overlooked.** `ensureChatLifecycleSchema`
also runs a DML derivation — `UPDATE chat_conversations SET status = 'CLOSED'
WHERE is_closed = TRUE` — and `is_closed` has three consumers. Whether that can be
dropped needs the writers traced. See `project_servana_booking_conversation`.

The `finance-schema` (payment) and `identity-columns` (identity) entries are the
notable removals: TAB 03 classified both `required`. They are REMOVED, not
downgraded to optional — there is no DDL left to gate on. `ensureFinanceSchema`
also carried a FUNCTION, the schema's only TRIGGER, and a one-time DML backfill of
`payments.updated_at`; all three were verified in the baseline individually,
because a trigger whose function is missing fails at the first UPDATE rather than
at creation.

⛔ **A SECOND P1: notification idempotency has never worked.**

`notification.service` and migration 015 both ran

    ALTER TABLE provider_notifications
      DROP CONSTRAINT IF EXISTS provider_notifications_notification_key_key;

against a name that has never existed. Production carries `..._key1` through
`..._key37`, plus two on `customer_notifications` — 39 constraints, each UNIQUE
on `notification_key` with no owner column. So GLOBAL uniqueness is still
enforced, and `ON CONFLICT (worker_uid, notification_key) DO NOTHING` cannot
absorb a violation of a *different* constraint; it raises 23505.

Any deterministic key that is not owner-scoped therefore fails for every
recipient after the first. `scheduler.ts:184` uses
`daily_active_bookings_${day}` — one key per DAY across all providers.

`037-notification-key-drop-global-uniques.sql` fixes it by enumerating
`pg_constraint` rather than guessing suffixes. **Proven on real PostgreSQL**:
39 → 0, both `uq_*_owner_key` indexes surviving, second apply a no-op.
**AUTHORED, NOT APPLIED** — destructive, needs the same authorisation as 030–035.

⛔ **A P1 defect surfaced doing this — see the note at the top of
`adminMobileAttributionService`.** Two services defined
`provider_source_attribution` with incompatible shapes behind
`CREATE TABLE IF NOT EXISTS`; production has the provider-web shape, so
`GET /admin/providers/:uid/attribution` and
`POST /admin/providers/attribution/backfill` fail with 42703 today.

**That class is now GATED rather than stumbled upon.** `schema:authority` lists
every object created by more than one runtime path and fails when a losing
definition names a column nothing in the repo declares. All seven contested
objects were audited against the baseline: **no second 42703**. Four have since
been cleared — three by the two engines above, and `guest_customers` when
`adminGuestService` went — leaving two: `booking_escalations` and
`user_profile`. `chat_message_reports` left when `adminCommunicationService` did —
and the definition that WENT was the SUPERSET. `chat.repository` still declares it
without the four moderation columns, and is now the only runtime creator. That is
safe ONLY because the baseline owns the full table; do not promote the subset.

⚠ The check compares column NAMES only. Same names with different types, or a
different PRIMARY KEY over the same columns, passes it. `db:verify:embedded` is
the real guarantee.

⚠ **The 036 objects are the exception, and they are NOT part of this 3.**
Their runtime DDL stays until 036 is applied to production — deleting it first
makes booking transitions depend on a migration that has not run. Everything
else targets an object production already has, so it is safe now.

#### The recipe, per object

1. `npm run schema:authority` — confirm the object is `baseline`-owned, never
   `UNMANAGED`.
2. `grep -c '<object>' scripts/baseline/000-baseline.sql` — see the definition
   you are relying on, and cite its line in the replacement comment.
3. Delete the `ensure*` function. Replace it with a comment saying where the
   schema comes from **and what the deleted DDL guaranteed** — a partial unique
   index that an `ON CONFLICT DO NOTHING` depends on is invisible once the
   `CREATE INDEX` is gone.
4. Remove every caller: the `startup.ts` import and entry, AND the lazy
   `await ensure*()` at the top of each operation. Most of this DDL is awaited on
   a REQUEST path, not only at startup.
5. `npm run typecheck`, then `npm run verify`.
6. Lower `UNMANAGED_BUDGET` / `DISTINCT_OBJECT_BUDGET` in
   `tests/runtime-ddl-budget.test.ts` in the same commit.

#### The traps, every one of them hit for real

Two more, added after the finance/audit batch:

- **A suite that fails to PARSE does not fail — it vanishes.** A duplicated
  `});` from a bad splice stopped two suites compiling. `verify` reported 265
  suites, 2 failed, **0 failed tests**, and a total down 91. `suite-inventory`
  is what catches this; do not read a green-looking test count without it. When
  replacing a block programmatically, slice PAST its closing `});`, not to it.

- **A heredoc turns `\b` into a BACKSPACE.** Three regexes in
  `admin-finance.test.js` ended up containing literal 0x08 and silently matched
  nothing. `cat -A` finds them. Backticks in a shell string run as COMMANDS and
  silently delete words — that mangled a RESUME.md edit in the same session. Use
  the Edit tool for code and for prose containing backticks; it does not
  interpret either.
- **Assert on the DECLARATION, not the bare name.**
  `expect(src).not.toContain('ensureAuditSchema')` fails against the comment that
  replaces the function, because the comment names it. Match
  `export async function ensureAuditSchema` instead.


- **Source-introspection tests pin the DDL, and grep UNDER-REPORTS which ones.**
  Tests assert on source TEXT that a bootstrap exists and creates a table — e.g.
  `admin-audit.test.js` expects `svcSrc` to contain
  `export async function ensureAuditSchema`. Deleting the function turns those
  red and they must be rewritten in the same commit.

  ⚠ Do NOT estimate this with a grep. Mine matched only
  `toContain('CREATE TABLE'|'CREATE INDEX'|'export … ensure')` and so missed
  `toContain('ADD COLUMN IF NOT EXISTS …')`, `toMatch(/is_mobile_verified …/)`
  and `toContain('CREATE UNIQUE INDEX IF NOT EXISTS ${name}')` — two suites went
  red that the list said were clean. **Delete the bootstrap, then run the full
  gate, and let jest tell you.** That is faster and honest; the grep is a hint.

  Known remaining coupling, by service: audit, finance, permissions,
  invite-state, chat lifecycle, provider-catalog, communication.

  When rewriting one, do not delete the assertion — **repoint it at the
  baseline**. `identity-normalization-wiring.test.ts` and
  `admin-create-booking.test.js` in commit `5666a64` are the worked examples.
  Asserting the column exists in `000-baseline.sql` is STRONGER than asserting
  some code meant to create it.

- **Your own gates can be the thing that breaks.** `schema-authority`'s positive
  fixture was pinned at `> 200` statements, just under the then-current 214, and
  failed the moment the deletion pass worked. A positive fixture proves the scan
  functions; it must not double as a budget or it fails on progress.

- **A test DOUBLE can encode the bootstrap too, not just an assertion.**
  `scheduling-partial-day-time-off` did
  `mockResolvedValueOnce(ddlOk).mockResolvedValueOnce(ddlOk)` to absorb the two
  DDL calls the bootstrap made. With no DDL those swallowed the first REAL query
  and the operation read `rows[0]` of an empty result. Prefer SQL-routed mocks
  (`mockImplementation` switching on the query text) over call-order ones — the
  same suite's second block was already written that way and survived untouched.
  After fixing such a mock, MUTATION-TEST the suite: a double that stops
  asserting still passes.

- **A new source read must normalise line endings.**
  `source-reads-normalise-line-endings.test.ts` catches a `readFileSync` without
  `.replace(/\r\n/g, '\n')` in any fixed-window suite. This repo has MIXED line
  endings — `adminNotificationService.ts` is CRLF, `providerOperationalAvailabilityService.ts`
  is LF — so a `perl -0pi -e 's/…\n//'` that works on one file silently does
  nothing on the next. Use `\r?\n`.
- **Removing a line from a ROUTE file breaks a doc gate.** `api:docs:check`
  records `src/routes/*.ts:NN`, so deleting one dead import shifted three line
  numbers and failed `verify` BEFORE jest ran. Fix with `npm run api:docs` and
  check the diff is line numbers only. Service files are not affected — no
  generated doc cites a `src/services/**` line.

Acceptance is unchanged: the API starts with DDL privileges revoked.

---

## 4. Blocked on the human — say so early

1. **One real boot.** Nobody has started the actual server since `app.ts`
   startup was rewritten: 14 fire-and-forget bootstraps became a 19-dependency
   graph awaited before `listen`, plus `/healthz`, `/readyz` and SIGTERM
   draining. Verified as far as tests allow; not against reality. This remains
   the single largest unverified assumption in the whole body of work.
2. **The deploy decision.** A push to `main` **IS** the deploy. It also
   conflicts with the standing local-only rule, and 0 of 108 endpoints have
   migrated, so that rule is unsatisfied.
3. **Apply migration 036.** Authored, gated, committed, NOT applied. Until it
   is, production lacks four tables its own booking code writes to, and the
   deletion work in §3 cannot start. Applying it is a production write and needs
   the same explicit authorisation 030–035 got.
4. **`race go`.** A disposable `servana_race_test` database on the Linode host
   unblocks `tests/booking-postgres-races.test.ts`, which currently reports
   `BLOCKED_BY_TEST_DATABASE`. Measured as safe: the harness caps at 8
   connections and 2 concurrent transactions; the server is idle with 481 MB
   free. PGlite CANNOT substitute — single-connection, so no lock contention and
   no `40P01`.

---

## 5. Working rules that were earned the hard way

- **A number is not a scope.** TAB 02 was budgeted at one to two weeks from a
  count that answered a different question than the one being asked. Before
  costing work off a metric, read what the metric actually measures.
- **Check a classification against the engine, not the regex.** The
  baseline-owned claim was re-derived by restoring the baseline into PGlite and
  asking PostgreSQL. Regex and engine agreed — but that agreement is the
  evidence, and it was cheap.
- **Mutation-test every gate, and confirm the mutation landed.** Both new gates
  here were mutation-tested: a probe file adding one runtime `CREATE TABLE` and
  one undeclared column turned 4 assertions red. Six checks in an earlier
  session passed while broken; three were hunting that exact class.
- **Pipelines hide exit codes.** `npm run verify | tail` reported `exited with
  code 0` over a run with 2 failed suites. Redirect and check `$?`, or read the
  summary line — never trust the pipe.
- **Grep counts are not findings.** `ensureAccountDeletionTable` looked like a
  live route-module bootstrap and is a dead import; the "5 missing columns" were
  3, two being the SQL keyword `IF` captured by a backtracking regex.
- **Never let observability change a decision.** The authz audit threw inside a
  denial branch and turned a 403 into a bypass in a test.
- **Prefer the Edit tool to shell heredocs for code.** Heredocs mangled
  backslashes repeatedly — including writing real CR/LF into a JS regex, which
  stopped five suites parsing and dropped 586 tests with nothing red.
- **`\b` in a template literal is a backspace.** Use `String.raw`.
- **Do not read credential contents** to establish a finding; presence and
  permissions suffice.

---

## 6. Production state

The database is **ahead of** the deployed code, deliberately.

```
servana.schema_migrations   36 rows   (30 marked + 6 applied 2026-08-16)
servana tables             128
not owned by admin           0
servana-prod              online, 0 restarts through the change
```

Production has the schema for the finance ledger, outbox, account settings and
support cases — and not the code that writes to them. Harmless until v1 traffic
exists, but not a steady state.

It does **not** have 036's four tables. A fresh database built from this
repository now reaches **132** tables; production is at 128. That difference is
the one open schema gap, and it is on the booking write path.
