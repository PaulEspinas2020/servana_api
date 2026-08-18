# TAB 05 — Job Orders, Matching, Assignment, Provider Actions

## Verdict

```
JOB + MATCHING VERDICT: CERTIFIED_WITH_NONBLOCKING_GAPS
```

Every release gate is met. The two that were open at the previous revision —
auto-assignment's weak commit validation, and a relinquished provider still
being able to read a job — are closed in code, with tests.

What remains is environmental, not a defect: the PostgreSQL locking proof needs
a server this machine does not have, and migration 029 needs a database that is
not production. Both are stated below rather than absorbed, because "we proved
it" and "we believe it" are different claims and only one of them is worth
writing down.

```
JOB STATE ≠ BOOKING STATE              IMPOSSIBLE   ✔  one formatter, canonical projection
CAPABILITY SOURCE = catalog_provider_services  ADOPTED  ✔  primary, keyed on services.id
CAPABILITY FALLBACK                    INSTRUMENTED ✔  counted, with retirement criteria
MATCHING KEYED ON services.id          YES          ✔  canonical grain, both id spaces resolved
CAPABILITY PREDICATES                  1            ✔  (was 3, disagreeing)
CONFLICT PREDICATES                    1            ✔  (was 4, disagreeing)
SCHEDULE/CAPACITY RULE                 DURATION-AWARE ✔ half-open overlap on the real span
DURATION FALLBACK                      DECLARED     ✔  one constant, from the column default
CAPABILITY WRITERS PROJECTING          5 of 5       ✔  asserted in source
BACKFILL SUPPLY GUARD                  RAISES       ✔  migration aborts rather than under-cover
CLIENT-SUPPLIED PROVIDER IDENTITY      REFUSED      ✔  token + locked row only
ASSIGNMENT RACE LOGIC                  PASS         ✔  fake-database proof, 2 locks
POSTGRESQL LOCKING INTEGRATION         BLOCKED_BY_TEST_DATABASE   ✖  no server available
PROVIDER READ LEAKAGE                  PASS         ✔  A cannot read B, 10 tests
CANDIDATE POOL COLLAPSE                DIAGNOSABLE  ✔  5 reason codes + 3 denominators
OVERRIDE AUDIT                         STRUCTURAL   ✔  refused without a reason
AUTO_ASSIGN TARGET VALIDATION          FULL         ✔  same hard constraints as an admin
ASSIGNMENT REFUSALS                    ATTRIBUTED   ✔  candidate-diagnostics codes, skippable
PROVIDER PII STAGING                   ONE DECISION ✔  3 surfaces, 1 policy module
RELINQUISHED PROVIDER READ             NOT FOUND    ✔  scoped, not merely staged
MIGRATION 029 APPLIED                  NOT RUN      ⚠  deploy precondition, guarded
typecheck (src / tests)                clean        ✔
generated docs (api + booking)         no drift     ✔
suites / tests                         205 / 4,303 green ✔
deployed                               NOTHING      — local only, as instructed
```

---

## The two verdict criteria, answered

### 1. Can a Job Order's status diverge from its Booking's?

**No.** This was the failing criterion at Phase 0.

`formatJobCard` emitted raw `bookings.status` and `booking_workers.status` and
nothing else, so every provider client derived state for itself — the same
condition that let Admin's list and detail disagree about the same booking. The
formatter now emits the canonical state beside the raw fields, and it is the
ONE formatter behind all three provider surfaces (v1, Provider Web, legacy
mobile). Provider actions are **generated** from the transition whitelist
rather than pinned to it by an agreement test, so a state added to the machine
cannot silently fall through to read-only.

There is no second operational state machine. A Job is a projection of a
Booking; every lifecycle write — provider, admin and automatic — goes through
`transitionBooking`.

### 2. Can a client-supplied provider identity authorize an action?

**No**, and this was already true at Phase 0. Provider identity comes from the
token and is re-authorized against the assignment row **loaded under lock**. A
`providerUid` in the payload of a provider action is ignored; the leakage suite
proves the read side answers the same way, and that a job that is not yours is
indistinguishable from one that does not exist.

---

## What changed in TAB 05

### The capability source is `catalog_provider_services`

The Master Command names
`catalog_provider_services.service_id -> services.id` as canonical provider
capability truth. It was not adopted at the previous revision, for a reason that
was real and is worth keeping on the record: the table had been backfilled once
during the Catalog V2 cutover and **nothing ever wrote it again**, so reading it
alone would have silently unassigned every provider granted since.

Adoption therefore has four parts, and all four had to exist before the read
could move:

1. **The predicate asks it first.** `PROVIDER_CAPABILITY_SQL` probes
   `catalog_provider_services` on the canonical `services.id`, then the legacy
   family grants on `service_families.id`. Two id spaces, two placeholders — one
   family implies up to 54 bookable services, so they are not interchangeable
   and the predicate never converts one to the other.

2. **The fallback is counted, not silent.** Every decision is classified
   `CANONICAL` / `LEGACY_ONLY` and recorded. A fallback with no counter is a
   fallback forever; `legacyOnly` reaching zero is what retires it, and the
   criteria are declared in `capabilitySource.CANONICAL_ADOPTION_CRITERIA`.

3. **Five writers project.** Both approval paths, the admin grant, the revoke
   and pause/reactivate all call `capabilityProjection`, so the gap stops
   growing. The transactional approval path projects *inside* its transaction;
   the paths that own no transaction project tolerantly and log, because failing
   a provider's approval over a projection error would be worse than the drift
   it prevents — the read still falls back, so nobody loses work.

4. **The backfill refuses to under-cover.** Migration 029 projects both legacy
   sources (021 covered only one) and then RAISES if any legacy grant would be
   left without a canonical row, or any provider without capability. Aborting
   leaves the fallback carrying the load exactly as before, which is the safe
   direction to fail in.

**Nobody gains or loses capability on the day this ships.** Canonical rows are a
fan-out OF the legacy grants, so canonical is a subset of legacy and the union
is exactly today's assignable set. That is the whole design: the source moves,
the answer does not.

`npm run capability:parity` reports what the fallback is still carrying;
`npm run capability:reconcile` projects it. Neither touches a legacy table.

### Schedule and capacity: the job's real span, not a fixed window

The conflict rule was **±2 hours around the scheduled time**, which ignores how
long a job lasts. Measured at Phase 0, it was wrong in both directions at once:

| Scenario | Fixed ±2h | Real span |
|---|---|---|
| 30-min job 10:00, second job 11:30 | **refused** | free — supply was being starved |
| 4-hour job 10:00, second job 13:00 | **assigned** | conflict — a real double-booking |

It is now **half-open overlap against each job's real span**:
`existing.start < candidate.end AND existing.end > candidate.start`, where
`end = schedule + duration`. Half-open on both sides, so back-to-back work is
allowed — which is the normal shape of a day, and the form the time-off
collision rule already used.

**Duration is not invented.** `service_options.duration_mins` is declared
`INT NOT NULL DEFAULT 120`, and three live queries already read it as
`COALESCE(duration_mins, 120)`. That convention is now one constant,
`DEFAULT_SERVICE_DURATION_MINS`, and NULL, zero and negative all fall back to
it. Zero is the case worth naming: a zero-length span overlaps nothing, so one
bad row would make a provider infinitely bookable at that instant.

Five producers moved onto it — commit-time revalidation, auto-assignment
selection, the admin candidate preview, the Admin availability answer, and the
time-off collision check — and the provider calendar now draws the same span,
having previously fallen back to the TRAVEL estimate and then to 60 minutes
while the matcher reserved 120.

Both spans are resolved **in SQL from the booking rows**, so a caller cannot
supply a duration that disagrees with the database. The comparison is between
`timestamptz` values, so unlike the JS-`Date` arithmetic it replaced it cannot
drift with a deployment region or a DST boundary.

**This is the one change in TAB 05 that is not a pure widening**, and it is
declared as such in
[`TAB05_CANDIDATE_SUPPLY_CHANGES.md`](./TAB05_CANDIDATE_SUPPLY_CHANGES.md) §5.
It became safe to make when two conditions held: centralisation came first, so
the policy moves once and is attributable; and there are no live booking
records, so no historical assignment is re-decided.

### Auto-assignment commits through the same hard constraints as an admin

`AUTO_ASSIGN` carried `targetValidation: 'LEGACY_AUTO'`: the schedule conflict
and nothing else. Role, archive state and canonical capability were skipped, so
the matching engine could commit a provider `ADMIN_ASSIGN` would have refused.
Two producers of the same write, disagreeing — which contradicts the
hard-constraint gate outright.

It now declares `FULL`. The branch that skipped the validation is gone, and the
profile union has one member, so a second one has to be added in a diff
somebody reviews rather than by a flag appearing on one action. An unrecognised
profile is refused rather than falling through to "validate nothing".

**Why the tightening did not need the delta measurement it was waiting on.**
The previous revision deferred this, then measured it in shadow, because
tightening auto-assignment changes which bookings get assigned. What settles it
is the SHAPE of the refusal, not a number: `assignNearestWorker` walks a RANKED
CANDIDATE LIST, so a refused provider costs a candidate and the walk continues.
Only a booking whose entire list is ineligible ends unassigned — and that
assignment would have been wrong to make.

Every refusal carries a `reasonCode` drawn from the same
`BLOCKER_PRECEDENCE` the Admin candidate pool uses, is counted, and travels
back to the caller. A booking that finds nobody now reports the dominant cause
beside the legacy `NO_WORKER_AVAILABLE_AFTER_RECHECK` string rather than an
empty result — "why did nobody get this job" and "why is this provider greyed
out in the list" are the same question, answered in one vocabulary.

The write boundary distinguishes `busy` from `ineligible`: both mean "try the
next one", and collapsing them would make a capability gap read as a scheduling
problem.

### The leakage rule: relinquished means NOT FOUND

`disclosureLevelFor('DECLINED')` already returned `none`, so a relinquished
provider got no customer name, phone or address. The card still came back.

An empty card is still an oracle. It confirms the booking exists, that it is
still live, and roughly when it was scheduled — which is exactly what "not
found" exists to deny. Staging answers *how much*; the Master Command's
Provider A / Provider B rule needs *at all*.

So the READ is scoped too, from the same declaration that decides disclosure:
`READABLE_WORKER_STATUSES` is everything not relinquished. Both provider job
lists now filter on it — the v1/legacy job cards, and Provider Web's list
through an INNER lateral join, so a non-qualifying assignment row removes the
booking rather than returning it with a null status. The booking detail and the
calendar already excluded relinquished work.

| | Before | After |
|---|---|---|
| Outgoing provider reads the job | empty card | **not found**, byte-identical to a nonexistent booking |
| Outgoing provider acts on it | refused | refused (unchanged — the executor re-authorizes under lock) |
| Incoming provider before handover | nothing | nothing (unchanged) |
| Completed work | visible | visible — the payout window is 72 hours |

**History is preserved, not erased.** The outgoing assignment row is closed,
never deleted, so it still answers "was this provider ever on this job, and
when did it end" for an audit or a payout dispute. What changed is that no
current-provider surface reads it. The sanitized historical projection that
already existed — earnings, scoped to `b.status = 'COMPLETED'` — is untouched,
and cannot reveal a job that is now somebody else's, because a reassigned
booking is not completed for the outgoing provider.

### Provider PII staging: one decision, three surfaces

Two places used to decide independently how much of a customer a provider may
see, one carrying a comment saying it matched the other. They did match — by
inspection, until somebody edited one. A comment claiming kinship is not a
mechanism, and the consequence was not cosmetic: `getProviderBookingDetail`
once spread the raw row, so an ASSIGNED provider who had accepted nothing could
read the street address by calling it directly.

`providerDisclosure` is now the single policy: `full` / `area` / `none`, with an
unrecognised status failing towards LESS exposure. The job card and the booking
detail both consume it; the calendar is not a third copy — it emits the city
unconditionally, sits at the `area` floor by construction, and excludes
relinquished work entirely, so the "none" case cannot arise there. A detector
fails the build if a fourth site starts staging PII on its own.

Reassignment needs no separate rule: `ADMIN_REASSIGN` closes the outgoing
assignment as `DECLINED`, which is in the relinquished set, so the same decision
that granted the street address takes it back. All three surfaces scope on the
provider uid **in SQL**, and the calendar reads the assignment row rather than
`bookings.worker_uid` — the current pointer, which moves on reassignment and
would otherwise hand the incoming provider the outgoing one's history.

### One eligibility pipeline, and the split that makes it safe

Twelve declared stages, with ownership split at stage 10: selection is TAB 05's,
commit is the executor's. The executor revalidates **only** the three stages
that can race — active state, capability, booking conflict — inside the
transaction, holding the booking row lock and a provider advisory lock. It
deliberately does not re-run ranking: a stale ranking is a suboptimal
assignment, a stale conflict check is a double-booked provider.

### Predicates: from seven to two

The capability audit found **three** capability predicates and **two** conflict
predicates, disagreeing. Two more conflict predicates surfaced during the
sweep. All of them are now built from one declaration each:

| Question | Producers now sharing one answer |
|---|---|
| Is this provider qualified? | executor, admin candidate pool, admin preview, `getAvailableWorkers` |
| Does this booking occupy the provider? | executor, auto-assignment selection, admin preview, availability answer, time-off collision |

Every one of those moves a **preview or a selector** onto the **committer's**
predicate. Nothing became assignable that the executor would not already have
accepted. The four resulting behaviour changes are declared, with direction and
blast radius, in [`TAB05_CANDIDATE_SUPPLY_CHANGES.md`](./TAB05_CANDIDATE_SUPPLY_CHANGES.md).

### Candidate diagnostics: "no providers available" now says why

Five reason codes, ordered from "nothing to work with" to "something is wrong",
plus the two counts that make them meaningful:

- **capable** — the denominator, unfiltered by account state. Zero eligible out
  of zero capable is a catalog fact; zero out of fourteen is an incident, and
  nothing downstream could tell them apart before. A failed count reports
  `null`, never `0`, so a broken query cannot fabricate the outage it exists to
  detect.
- **population / evaluated / cap** — the pool was silently capped at 20 after
  ordering by first name. A provider whose name sorted late was invisible with
  no error anybody sees. The cap is named, published, and the diagnosis
  distinguishes "capped" from "no supply".

`capabilityEvaluated: false` flags the more dangerous pool: a booking with no
canonical service produces a full list of confident candidates nobody checked.

### The override audit is structural, not conventional

`ADMIN_REASSIGN` declares `requiresReason`, enforced by the executor before any
write. Previously one caller validated the reason; any other path could move a
job between providers and leave a timeline entry with an empty description. The
actor, the reason, the outgoing provider and the incoming one are written
**inside the transaction**, so the record cannot be skipped by a caller that
forgets to audit.

### Shadow matching

Twelve fixture providers, one interesting combination each, with the expected
verdict declared beside them. A predicate change that moves any provider between
eligible and blocked flips a named cell rather than a count. The suite also
pins three properties the composition must hold: determinism across identical
runs, independence from population order, and exactly one attributed cause per
blocked provider.

---

## Cross-platform caller matrix

Generated into [`JOB_MATCHING_V1_CONTRACT.md`](./JOB_MATCHING_V1_CONTRACT.md)
§1 from `src/api/v1/contract.ts`, so it cannot drift from the routes.

Eleven capabilities: eight provider-job endpoints (implemented, live v1) and
three admin assignment endpoints (declared `planned`, legacy routes live and
already on the canonical executor).

**Where role-specific endpoints remain, they differ by authorization only.** A
provider action derives identity from the token and offers no field in which
another provider could be named; an admin action's entire purpose is to name
one, behind a permission (`bookings.assign_provider`,
`bookings.reassign_provider`) a provider does not hold. Both commit through
`transitionBooking` against the same machine. Collapsing them would mean
accepting a provider identity in a body on a route providers can call.

---

## Gaps

### P1 — migration 029 has not been applied anywhere

The code reads the canonical table today and falls back where a row is missing,
so it is correct against a database that has *not* run the migration — that is
what the fallback is for. But the adoption gap does not close until 029 runs.

**Deploy precondition, in order:**

1. `npm run migrations:plan` — 029 appears as pending;
2. `npm run migrations:apply` — the guard RAISES rather than committing an
   incomplete backfill, so a failure here is the migration doing its job;
3. `npm run capability:parity` — expect `legacyOnly: 0`;
4. watch `diagnostics.capabilitySource.canonicalCovers` on candidate views.

Not run locally: this repository has no disposable PostgreSQL, and the
application database is production.

### P1 — PostgreSQL locking integration unproven

`tests/booking-postgres-races.test.ts` covers seven races with non-overlapping
controls and skips with `BLOCKED_BY_TEST_DATABASE` when no server is reachable.
The fakes serialise `FOR UPDATE` because they were written to; only a real
server can say whether PostgreSQL honours the lock order. Inherited from TAB 04,
unchanged by TAB 05, and not self-servable without touching production.

**Attempted this session and refused, correctly.** `tests/support/raceDatabase.ts`
requires `ALLOW_POSTGRES_RACE_TESTS=true` plus a full set of `PG_RACE_TEST_*`
variables that are DELIBERATELY separate from the application's `DB_*` — there is
no fallback, because a fallback is how a concurrency suite ends up pointed at
production. None were set, so the suite reported
`BLOCKED_BY_TEST_DATABASE` and passed its skip assertion.

No PostgreSQL client or container runtime is available on this machine (`psql`,
`pg_isready` and `docker` are all absent). Port 5432 does answer on `127.0.0.1`,
and it was **deliberately not probed**: without a client there is no way to
establish whether it is a local server or a tunnel to production, and the race
fixtures create and destroy booking rows. Connecting to an unidentified endpoint
with production credentials to find out is precisely the irreversible action the
standing rules forbid.

A second, independent blocker survives even a confirmed local server: the suite
needs a production-COMPATIBLE schema, and this repository has no `CREATE TABLE`
for `bookings`, so the fixtures cannot build one from zero.

**Needs:** a disposable PostgreSQL carrying a schema snapshot, the
`PG_RACE_TEST_*` variables, and `PG_RACE_ROUNDS`.

### P3 — bounded historical read is still unpersisted

Closed for the purpose the leakage rule cares about: a relinquished provider
reads nothing from any current-provider surface, so there is no window to bound.

What remains is narrower and is not a leak. If a product decision were ever
made to give an outgoing provider a read of the period they actually worked,
the upper bound of that period is not persisted — `BOUNDED_HISTORICAL_READ_BLOCKER.md`
records why. Nothing depends on it today.

### P3 — the candidate pool cap is still 20

Now reported rather than silent, which was the dangerous half. Whether 20 is the
right number is a supply question, answerable once the diagnostics have run
against real pools.

---

## Tests actually executed

Every number below comes from a run in this session. Nothing is claimed that
was not executed.

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run typecheck:tests` | clean |
| `npm run guard:protected-contracts` | all protected route contracts verified |
| `npm run api:docs:check` | no drift |
| `npm run booking:docs:check` | no drift |
| `npm run test:ci` | **205 suites / 4,303 tests, all green** |
| `npm run build` | clean (`tsc` emit) |

Suites added by TAB 05, all executed:

- `tests/auto-assign-strict-validation.test.ts` — 23 tests (one validation for
  every producer, attribution, skippability, the caller surviving a refusal,
  the no-assignment diagnosis, and the counters)
- `tests/reassignment-leakage.test.ts` — 19 tests (Provider A after handover,
  Provider B before it, every surface's scoping, and history preserved)
- `tests/booking-conflict-overlap.test.ts` — 31 tests (the span rule: boundary,
  adjacency, containment, long jobs, zero/missing duration, timezone
  independence, and one-predicate parity across producers)
- `tests/capability-canonical-source.test.ts` — 45 tests (the capability-source
  gate: classification, the adoption counter, the projection writer, all five
  writers, parity, the migration and the parity script)
- `tests/shadow-matching.test.ts` — 24 tests
- `tests/candidate-diagnostics.test.ts` — 40 tests
- `tests/provider-job-leakage.test.ts` — 10 tests

Suites extended: `eligibility-pipeline`, `booking-d5-admin-reassign`,
`booking-policy-guards`, `admin-booking-boundary`, `booking-docs-generated`,
`scheduling-time-off-booking-conflicts`, `provider-disclosure` (reassignment,
account-switch scoping), `legacy-auto-delta-harness`, `assigned-booking-integrity`,
`suite-inventory`.

**Attempted and not executed, with the reason recorded:**

- `tests/booking-postgres-races.test.ts` — reported
  `BLOCKED_BY_TEST_DATABASE`. No disposable PostgreSQL, no client tooling, and a
  schema snapshot the repository cannot generate. See the P1 gap above; the
  refusal path itself was exercised and asserted.
- `npm run migrations:apply` (029) — the only reachable database is production.
- `npm run capability:parity` — same reason. It is read-only, but it still
  connects, and the standing rule is that production is not accessed.
- `scripts/measure-legacy-auto-delta.ts` — needs production data.

No production smoke evidence exists, because nothing was deployed.

---

## Endpoints

**Added:** none. Every canonical provider-job endpoint was already live.

**Changed, additively:**

| Endpoint | Change |
|---|---|
| `GET /api/admin/bookings/:id/assignment-candidates` | `diagnostics` added as a sibling key; `data` unchanged |
| `POST /api/admin/provider-availability/evaluate-booking` | `diagnostics` added under `meta`; `data` unchanged |

**Declared:** `admin.bookings.assign`, `admin.bookings.reassign`,
`admin.bookings.assignmentCandidates` registered as `planned` v1 entries with
their legacy routes marked `CANONICALIZE`, so the generated registry and
migration matrix name the successor.

**Retired:** none. **Clients migrated:** none — no client change was required,
and none was made. The capability-source move is invisible on the wire: the
same providers qualify, and `diagnostics.capabilitySource` is additive.

**Operational commands added:** `npm run capability:parity` (read-only) and
`npm run capability:reconcile` (writes only `catalog_provider_services`, refuses
a remote database without `CAPABILITY_REMOTE_ACK`).

**Compatibility still active:** all provider-job legacy aliases
(`/api/worker/job-cards`, `/api/workers/:workerId/job-cards`, the six
`PUT /api/worker/bookings/:bookingId/*` actions) and the three legacy admin
assignment routes.

---

## The next safe deprecation step

`GET /api/workers/:workerId/job-cards` — the BOLA-shaped alias that takes the
provider uid from the path. It is authenticated and ownership-checked, so it is
not a live leak, but it is the only remaining provider-job route where the
subject is nameable by the caller.

**Gate:** a ServanaWorker release on `GET /api/v1/provider/jobs`, then legacy
telemetry showing zero calls for a full release cycle. The telemetry is already
wired (`tests/v1-legacy-telemetry.test.ts` covers every legacy mapping in the
contract), so the evidence collects itself.
