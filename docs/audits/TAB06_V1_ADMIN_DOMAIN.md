# TAB 06 — building the v1 admin domain (wave 1)

> **Closes the backend half of F-04 (P0) for wave 1.** Implemented 2026-08-18
> against `servana_api` at `db3497a`.

---

## 1. The gap, restated from measurement

| | Before | After wave 1 |
| --- | --- | --- |
| v1 entries | 109 (105 implemented, **4 planned**) | 109 (**109 implemented, 0 planned**) |
| admin-authenticated, implemented | **1** | **5** |
| admin entries declaring a permission | 1, in a map inside `register.ts` | **5, on the contract, enforced at import** |

The portal could not migrate onto v1 because there was no admin domain to
migrate to. v1 was built for the client applications; its 105 implemented routes
contained exactly one admin-authenticated endpoint. That — not a failed deploy —
was the integration gap.

The four `admin.bookings.*` entries were already written in the contract as
`planned`, with their domain services, replay guards, legacy dispositions and
even their permission reasoning recorded. Wave 1 builds them.

## 2. The single largest risk, and how it is closed

The book names it: *v1's `AuthMode` models role, not permission — extend the
contract with a permission field and enforce it in `register.ts`, or v1 will
silently be a weaker guard than the legacy route it replaces.*

`auth: 'admin'` proves role 1 and nothing more. Every legacy admin route
additionally gates on a named permission. A v1 successor that stopped at the
role would be reachable by an admin the legacy route refuses — **same data,
weaker door, arriving as a migration rather than as a change to authorization.**
Nothing fails. The endpoint works. It simply answers people it should not.

### 2.1 The objection that had to be answered first

A `V1_PERMISSIONS` map already existed inside `register.ts`, with one entry, and
its docblock gave a fair reason for living there rather than on the contract:

> *a permission key sitting unused in a data file reads as protection that is
> not mounted.*

That is a real objection, and moving the data without answering it would have
made things worse. It is answered by making "unused" **impossible**:

1. every implemented `auth: 'admin'` entry **must** declare a permission —
   a missing one throws at import, before any route is mounted;
2. every declared permission **must** end up mounted — a key that describes
   protection nobody applied throws too.

That is the same discipline `register.ts` already applied to handlers, where a
key naming no implemented entry is a throw and not a silent no-op. With both
checks in place the contract is the better home: it is the surface the docs, the
OpenAPI document and the parity tests all read, and a permission declared beside
the route it guards can be compared against the legacy route without anybody
parsing an Express middleware chain.

**Mutation-verified, and the second one is the strong form:**

```
MUTATION 1  weaken admin.bookings.reassign to `bookings.view`
            → tests/v1-admin-permission-parity.test.ts: 1 failed

MUTATION 2  delete the permission from admin.bookings.assign
            → register.ts REFUSES TO START:
              "v1 contract: 1 admin endpoint(s) declare no permission —
               admin.bookings.assign. auth: 'admin' proves role 1 and nothing
               more…"
            → the build fails, not a test
```

## 3. What was built

| Entry | Permission (copied from its legacy twin) | Domain service |
| --- | --- | --- |
| `admin.bookings.list` | `bookings.view` | `adminBookingService.getAdminBookings` |
| `admin.bookings.assignmentCandidates` | `bookings.assign_provider` | `providerEligibilityEngine.listAssignmentCandidatePool` |
| `admin.bookings.assign` | `bookings.assign_provider` | `adminBookingService.adminAssignProvider` |
| `admin.bookings.reassign` | `bookings.reassign_provider` | `adminBookingService.adminReassignProvider` |

Every handler in `src/api/v1/domains/adminBookings.ts` is **transport only**.
The locks, the state machine, the override audit and the eligibility predicate
stay in the domain services. A transport layer that can disagree with its domain
service is a second implementation of the rule — and for booking assignment,
that second implementation would be the one that skips the override audit.

**All legacy routes remain mounted and unchanged (§4).** Nothing was removed,
renamed or reshaped.

## 4. Decisions taken autonomously

**D1 — permissions on the contract, with two import-time throws.** See §2.1.

**D2 — `reason` mandatory on reassign, optional on assign.** Carried forward
deliberately rather than by inertia: taking a job away from a provider who
already has it is an override, and an override with no stated reason is an audit
record that cannot answer the only question it will ever be asked.

**D3 — diagnostics ride in `meta`, not spliced into `data`.** The legacy route
put them in a sibling key for the same reason: the array under `data` is what a
client parses, and widening it later is a breaking change.

**D4 — `bookingId` is refused, not coerced.** `Number('12abc')` is `NaN` and
`Number('')` is `0`; both would reach a domain service as a query for a booking
that cannot exist. A 400 naming the parameter is the honest answer.

**D5 — the `admin-bookings` ownership rule says "none", explicitly.** §145
requires every object-scoped entry to declare how the object is scoped, and
`safetyDrift()` caught all three new entries. The honest answer is that there is
**no ownership relationship** — an admin is not the booking's customer or
provider. Authority is role plus permission, which is a different kind of claim:
not *"this is yours"* but *"you may act on anyone's"*.

Declaring that is not a formality. An endpoint addressing `:bookingId` with no
rule is indistinguishable, to a later reader and to the drift checker, from one
whose ownership check was simply forgotten. **Saying "none, and here is what
replaces it" is the difference between a considered exemption and an omission.**

And `distinguishesAbsentFromForbidden: false` is genuinely true here, for a
better reason than elsewhere: `requirePermission` runs **before** the handler
reads anything, so an under-permissioned admin gets 403 whether the booking
exists or not. There is no enumeration oracle because the object is never
consulted — a stronger position than the 404-for-everything the
relationship-scoped rules rely on.

## 5. Three existing tests were restated, not weakened

Wave 1 **emptied the planned backlog**, and three assertions were written when it
was non-empty:

| Test | Was | Now |
| --- | --- | --- |
| `v1-contract` — "there is at least one planned entry, or the distinction is untested" | `PLANNED.length > 0` | asserts the **enforcement**: `buildV1Router` throws when a handler is supplied for an entry that is not implemented — against the real handler set plus one bogus key, so it cannot pass for the wrong reason |
| `v1-router` — "planned entries are not reachable" | `it.each(PLANNED)` — a Jest error on an empty array | states the empty backlog explicitly; the rule itself is asserted at build time |
| `cross-platform-convergence` — "omits planned entries" | `planned.length > 0` | asserts the manifest contains **exactly** the implemented entries and no strays — holds whether the backlog has ten entries or none |

An empty backlog is the desired state. Requiring one to exist would mean
**keeping an endpoint unbuilt to satisfy a test.**

A fourth was widened: `route-health-and-authz` asserted every ownership rule's
`enforcedBy` matches `^services/`. That was accurate while every rule was
relationship-scoped. The first permission-scoped rule is enforced by
`middleware/requirePermission`, which is middleware by design — so the pattern
now accepts `services/` or `middleware/`. The assertion's intent ("name a real
module, not prose") is preserved; forcing a permission check under `services/`
to satisfy a regex would move code to suit a test.

## 6. Gates

```
npm run verify        PASS exit 0 — 286 suites, 6076 tests
npm run authz:legacy  PASS exit 0 — 0 v1 entries weaker than their legacy origin
generated docs        regenerate to a clean diff (api, booking, finance, messaging,
                      notification, account, home, review, convergence, safety)
tests/v1-admin-permission-parity.test.ts   16 tests
```

The parity test reads **both** sides rather than restating either: the v1
permission from `ContractEntry.permission`, the legacy permission from the
`requirePermission('…')` literal in the mounted chain, linked by
`ContractEntry.legacy[].path`. It contains no list of routes and no list of
permissions, so a fifth admin endpoint added tomorrow is compared without
anybody editing it. Comparison is by permission **closure**, not string equality
— `bookings.assign_provider` satisfies a legacy route demanding `bookings.view`
because the catalogue declares the former as requiring the latter.

## 7. Scope: waves 2 and 3 are NOT done, deliberately

The book is explicit — *DO NOT PORT 251 ROUTES* — and says to port by
capability, highest-value first. Wave 1 is complete. The rest is recorded rather
than started:

| Wave | Scope | State |
| --- | --- | --- |
| 1 — bookings admin | the four `planned` entries | **DONE** |
| 2 — provider operations | Provider 360 reads (45 call sites in one portal service), onboarding decisions, availability | **NOT STARTED** |
| 3 — finance | payouts and reconciliation, joined with TAB 08's refund lifecycle | **NOT STARTED** — and it is now unblocked, because TAB 01 unified the disbursement surface. Starting it earlier would have canonicalised the duplicate. |

Wave 3 additionally carries the TAB 01 dependency noted there: the
`Deprecation`/`Sunset` headers for `/api/admin/disbursements/*` cannot be
emitted until a v1 finance successor exists, because the existing RFC 8594
mechanism requires an implemented v1 successor and pointing clients at another
legacy route is actively harmful guidance.

## 8. What could NOT be done here

| Book step | State | Why |
| --- | --- | --- |
| Probe each wave on production after deploy — 401 unauthenticated, 200 authorized | **NOT DONE** | `PROD-ACCESS`. Manual task 06.1. |
| Prove additive against the four client repos | **PARTIAL** | No route removed or renamed and no client repo touched, but §4 demands proof by *reading* those repositories. `NO-REPO`. Manual task 01.2 covers the same repos. |
