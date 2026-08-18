# TAB 13 — P0: Cross-Platform Endpoint Convergence + Client Migration

## Verdict

```
CROSS-PLATFORM ENDPOINT CONVERGENCE VERDICT: CERTIFIED_WITH_NONBLOCKING_GAPS
```

Every convergence gate is met in code and proven by executed tests. The gap is
singular, and it is not a design gap: **no client has migrated, because the v1
namespace has never been deployed.** A client cannot migrate against a contract
that is not serving. Everything this command asks for on the backend side exists
and is measured; the client-side half is blocked on a deploy this work is
forbidden to perform.

```
SIMILAR FEATURES → SAME CANONICAL ENDPOINT   PROVEN     ✔  54 capabilities, 0 divergent
ROLE-SPLIT ROUTES SHARE ONE DOMAIN SERVICE   PROVEN     ✔  4 splits, each 1 service, string-compared
BOOKING MACHINE IS ONE MACHINE               PROVEN     ✔  10 endpoints, 3 route families, 1 executor
EVERY ENDPOINT CLAIMED BY A CAPABILITY       PROVEN     ✔  95/95, 0 unclaimed, 0 double-claimed
NO SUPPORTED CLIENT IS BROKEN                PROVEN     ✔  every legacy-caller cell has a mounted alias
LEGACY TRAFFIC IS MEASURABLE                 EXISTS     ✔  watch list derived from the contract
ID / ENUM / TIMESTAMP / ERROR PARITY         PROVEN     ✔  29 assertions over shared fixtures
STATE PARITY ACROSS THREE PROJECTIONS        PROVEN     ✔  11 states × 3 actors, canonical carried verbatim
ARCHITECTURE-REVIEW RULE (§137)              ENFORCED   ✔  5 checks in CI, not a wiki page
MANIFEST vs ROUTER (§138)                    ENFORCED   ✔  convergence:docs:check in `verify`
DEPRECATION SCHEDULE                         DERIVED    ✔  95 aliases, each with a named blocker
CLIENTS MIGRATED                             0 of 5     ⚠  blocked on deploy; see §5
LEGACY TRAFFIC DECLINING                     NOT YET    ⚠  no traffic to count; namespace unpushed
ALIASES RETIRED                              0          ⚠  correct — none is retirable
CLIENT REPO SWEEP                            BACKEND    ⚠  app repos out of scope; see §1
PRODUCTION SMOKE                             NOT RUN    ✖  forbidden by the standing rules
```

Branch `main`, HEAD `36ca152`. **All work is uncommitted and local.** Nothing was
pushed, deployed, or run against production. No live provider, customer or
booking record was read or written.

---

## 1. The sweep, and what it could honestly be

§129 asks for a sweep of API calls in five client applications. The standing
rules place those repositories out of scope and direct that cross-platform
evidence come from backend manifests, repository documentation and telemetry
definitions.

So the sweep was performed against the evidence this repository actually holds,
which turns out to be the better source anyway: `V1_CONTRACT` already records,
per endpoint, the legacy path each client calls today and each client's
migration state. That data was collected by the twelve preceding tabs from the
client code, and it is what the router, the OpenAPI document and the telemetry
watch list are all built from — so it cannot silently disagree with what is
served.

**What this means for the matrix:** every cell is sourced from the contract, not
from a fresh read of the app repositories. A client that changed a call site
since its tab was executed would not be reflected. That is stated in the matrix
itself rather than left for a reader to assume.

### What the sweep found

| | |
| --- | --- |
| Capabilities across all domains | 54 |
| Canonical endpoints mounted | 95 |
| Canonical endpoints planned | 4 |
| Legacy mappings tracked | 114 |
| Endpoints claimed by no capability | **0** |
| Endpoints claimed twice | **0** |

Before this tab, **40 of the 95 endpoints belonged to no capability at all** —
auth, catalog, search, the booking core, provider jobs and admin booking ops.
Six domain tabs had each built a registry for their own domain; nothing joined
them up, and four domains predated the pattern entirely. A parity matrix cannot
be built over endpoints nobody has claimed, and §137 has nothing to compare a
new endpoint against. `CORE_CAPABILITIES` declares the missing twelve.

---

## 2. The gate that actually matters

> "Role-specific routes share one domain service."

This is the gate that stops a role split becoming a forked business truth, and
it is now a computation rather than a promise. `convergenceOf()` reads
`V1_CONTRACT[].domainService` — the same field the router is built from — and
compares the module names.

**The booking state machine is the proof case:**

| Route family | Endpoints | Service |
| --- | --- | --- |
| `/bookings` | `bookings.cancel` | `transitionExecutor.transitionBooking` |
| `/provider` | accept, decline, en-route, arrived, start, complete, cancel | `transitionExecutor.transitionBooking` |
| `/admin` | assign, reassign | `transitionExecutor.transitionBooking` |

Ten endpoints, three URL families, three permission models — **one executor**,
and each door carries a distinct actor verb (`PROVIDER_ACCEPT`,
`CUSTOMER_CANCEL`, `ADMIN_ASSIGN`…). The suite asserts all three: the family
count, the single service, and that no two endpoints share a verb — because two
endpoints sharing a verb would be a duplicate route rather than a role split.

The day somebody adds `providerBookingService` to make a provider-only rule
easier, the verdict flips to `DIVERGENT` and the suite fails. That is the whole
mechanism §131 asks for.

### The four role splits, all clean

| Capability | Families | Service |
| --- | --- | --- |
| Cancellation | `/bookings` + `/provider` | `services/booking/transitionExecutor` |
| Notification preferences | `/me` + `/settings` | `services/notificationService` |
| Search | `/catalog` + `/search` | `services/catalogSearchService` |
| Booking transitions | `/admin` + `/bookings` + `/provider` | `services/booking/transitionExecutor` |

### The one that needed investigating

Notification preferences serve two route families over two *named* modules —
`services/events/notificationPreferences` and `services/notificationService`.
The check flagged it, which is exactly what it is for.

It is **not** a fork. TAB 09 added a decision layer (which categories exist, what
the defaults are, whether a category may go out on a channel) over the existing
store, and it writes through `getNotificationPrefs`/`saveNotificationPrefs`
rather than touching the table, because two writers to one preference row is how
a provider's saved choices get overwritten by a customer-shaped default map.

So it is recorded as a **verified delegation** rather than waved through: the
entry names the file and the import, and
`tests/cross-platform-convergence.test.ts` reads that file and asserts the import
is there and that the module contains no INSERT or UPDATE. An exemption that
stops being true stops being granted — otherwise the delegation list becomes a
list of excuses and the check is worthless.

---

## 3. Parity, over shared fixtures

§134 asks that the same Category/Subcategory/Service/Booking response deserialize
consistently across platforms. `tests/fixtures/canonicalContracts.ts` defines one
instance of each, and every fixture is validated against the **real OpenAPI
schema** — a fixture that has drifted from the contract is a fixture testing a
shape nothing serves.

The values are chosen to fail rather than to look plausible:

- ids sit in the ranges that actually collide — `services.id` 180,
  `service_families.id` 12, `service_options.id` 903, subcategory 45 — so a
  fixture using 1/2/3 would pass under any mix-up;
- `basePrice` is `1234.56`, so a client that reformats currency or a backend that
  re-derives rather than republishes produces a different value;
- timestamps are UTC ISO-8601 with milliseconds and a `Z`, and the suite asserts
  no local-offset form appears anywhere — a client that parses to local time and
  re-serializes produces the same instant as a different string, which breaks
  cache keys and makes a "today" filter wrong for eight hours a day in Manila;
- the name carries an em dash, because a latin-1 round trip mangles it silently.

### State parity is the strongest result

Eleven canonical states × three projections (Admin, Customer, Provider), and
every projection carries `canonicalState` **verbatim**. A projection may reword
and may group; it may not lose the distinction. As long as that holds, no two
surfaces can report a booking as being in different states.

The suite also pins the case that would otherwise be invisible: Admin's
`operationsStatus` collapses `EN_ROUTE` and `ARRIVED` into `accepted` because the
portal types the field as a closed union — and `stateIsCollapsedInLegacyField` is
asserted `true` exactly there, so a client reading only the legacy field can know
it is being lied to. Neither projection is wrong on its own. The bug would be in
the pair, and only a test holding both at once can see it.

---

## 4. §137 and §138, enforced rather than published

**§137** asks for a permanent rule: no new endpoint for a single client if an
equivalent shared endpoint exists, without architecture review. A rule in a wiki
is followed until the week somebody is busy, so it is five checks that run on
every CI run:

1. every implemented entry is claimed by exactly one capability;
2. a single-surface capability must say why it has no equivalent;
3. endpoints of one capability must name one domain service module;
4. two capabilities must not claim the same endpoint;
5. a new route family for an existing capability must be a role split, never a
   second service.

A new single-client endpoint fails check 1 immediately and arrives at review by
itself. The exemption process is a code change — declare it in a capability with
a rationale — which also arrives at review.

**§138** asks for CI comparing the endpoint registry against client call
manifests. The client half is not available in this repository, so what is
enforced is the half that is: `manifestDrift()` compares
`CANONICAL_CALL_MANIFEST.json` against the mounted router — count, path, and
capability attribution — and `npm run convergence:docs:check` runs in `verify`.
The manifest is the artifact a client team diffs their own call sites against;
it carries only mounted endpoints, because generating a typed client from a
`planned` entry would ship calls to a 404.

---

## 5. The gap: nobody has migrated

**0 of 5 clients. 0 migrated cells out of 111 that could be.** This is reported
as a zero rather than dressed up, because the alternative is worse than useless:
a "migrated" cell tells a reviewer the alias behind it is safe to delete, and
deleting an alias a shipped Flutter build still calls is an outage on a platform
whose installed base cannot be corrected for weeks.

The cause is a deployment gap, not a design gap. Every canonical route is
mounted, tested and documented, and the namespace is unpushed. Nothing can
migrate against a contract that is not serving, and no traffic can be counted
until traffic exists.

### What each client faces

| Client | Order | Capabilities | On legacy | Partial | No equivalent yet |
| --- | --- | --- | --- | --- | --- |
| Admin Web | 1 | 34 | 13 | 1 | 20 |
| Provider Web | 2 | 36 | 24 | 1 | 11 |
| Customer Web | 3 | 43 | 17 | 4 | 22 |
| Provider Mobile | 4 | 37 | 22 | 4 | 11 |
| Customer Mobile | 5 | 43 | 20 | 5 | 18 |

Ordered by correction cost: a web client is a git push from being fixed, a
mobile client keeps calling whatever the installed build knows for as long as
the customer leaves the app installed. That ordering is data
(`SURFACE_CORRECTION_COST[].order`) and the generated plan is asserted to follow
it, so it cannot drift into "whatever sorted first".

### Retirement

**95 aliases in the plan, 0 retirable, and that is the correct answer.** Each row
names its blocker rather than saying "not yet". The gate is four conditions —
canonical mounted, every caller migrated, observed zero traffic for 14 days
(web) or 90 days (any mobile caller), and the deletion as its own revertible
change.

Nothing in `/services/full` or `/level2` moves until then. They are marked
`CANONICALIZE`, not `ALIAS_TEMPORARILY`, because they are still the canonical
path for their callers — the customer app has never consumed any other catalog.

---

## 6. P0–P3 gaps

| | Gap | Why it is not blocking |
| --- | --- | --- |
| **P0** | v1 namespace not deployed | Forbidden by the standing rules. Everything downstream — migration, telemetry, retirement — waits on it. |
| **P1** | 0 clients migrated | Follows from P0. |
| **P1** | Client-repo call manifests unavailable | App repos out of scope. §138 enforces the backend half; the client half needs a manifest each app can emit. |
| **P2** | 4 endpoints still `planned` | Documented, unmounted, and excluded from the manifest so no client can generate a call to them. |
| **P2** | Parity cells sourced from the contract, not a fresh app-repo read | Stated in the matrix. The contract is the same data the router is built from. |
| **P3** | `operationsStatus` still collapses EN_ROUTE/ARRIVED | Deliberate and flagged; removing it breaks the live portal. Canonical state travels beside it. |

---

## 7. Verification actually executed

```
npm run typecheck            PASS
npm run typecheck:tests      PASS
guard:protected-contracts    PASS
9 doc-drift checks           PASS  (api, booking, finance, messaging, notification,
                                    account, home, review, convergence)
npm run test:ci              PASS  244 suites, 5410 tests
npm run build                PASS  tsc + asset copy
```

TAB 13 suites, all executed:

| Suite | Tests |
| --- | --- |
| `tests/cross-platform-convergence.test.ts` | 34 |
| `tests/cross-platform-parity.test.ts` | 29 |
| `tests/convergence-docs-generated.test.ts` | 31 |

### The same honest note as TAB 12

The full suite remains intermittently order-sensitive under `--runInBand`:
across TAB 12 and TAB 13, different runs have failed different suites
(`catalog-banner`, `booking-c-confirm-otp`, `catalog-service`, `admin-dedup`),
all of which pass in isolation, and clean runs pass everything. None is in code
either tab touched. It is recorded rather than omitted because a suite that
fails intermittently is a real thing to fix, and it is not this tab's to fix
silently.

---

## 8. Files

**New**

```
src/api/v1/convergence.ts                       the federated registry + verdicts
scripts/generate-convergence-docs.ts            the generator
docs/api/CLIENT_ENDPOINT_PARITY_MATRIX.md       (generated)
docs/api/PER_CLIENT_MIGRATION_PLAN.md           (generated)
docs/api/CANONICAL_CALL_MANIFEST.json           (generated)
docs/api/DEPRECATION_SCHEDULE.md                (generated)
docs/api/LEGACY_TELEMETRY_SPEC.md               (generated)
docs/api/TAB13_CERTIFICATION.md
tests/fixtures/canonicalContracts.ts            shared contract fixtures
tests/cross-platform-convergence.test.ts
tests/cross-platform-parity.test.ts
tests/convergence-docs-generated.test.ts
```

**Modified**

```
package.json                          convergence:docs, convergence:docs:check, verify
docs/api/CROSS_CLIENT_MIGRATION_PLAN.md  pointer to the derived documents
tests/suite-inventory.test.ts         241 → 244
```

**No endpoint was added, changed, aliased or retired.** That is the correct
outcome for this command: convergence was already achieved by the twelve
preceding tabs, and what was missing was the proof, the join, and the enforcement
that keeps it true. Changing routes here would have risked five live clients to
demonstrate activity.

The TAB 01–12 dirty tree was preserved in full.
