# TAB 01 — API Centralization Foundation + Endpoint Registry

## Verdict

```
API CENTRALIZATION FOUNDATION VERDICT: CERTIFIED_WITH_NONBLOCKING_GAPS
```

The foundation is built, derived from one source of truth, and green end to
end. The gaps that keep it from a bare CERTIFIED are two, both named below and
neither of them a code defect: **nothing is deployed**, so no production smoke
evidence exists; and **four canonical endpoints remain `planned`** by an
explicit sequencing decision recorded per entry.

```
canonical v1 endpoints implemented     42           ✔
canonical v1 endpoints planned          4           ⚠  documented, 404, not half-built
legacy routes inventoried             520           ✔  every one classified
legacy aliases under telemetry         42           ✔  derived from the contract
duplicate canonical mutations           0           ✔  enforced by test
registry / matrix / OpenAPI drift    none           ✔  generated + checked
hand-written docs under the gate      5 of 5        ✔  was 2 of 5 — see below
rate-limit policy                  derived         ✔  one source for wiring, docs and tests
typecheck (src)                     clean           ✔
typecheck (tests)                   clean           ✔
protected route contracts            pass           ✔
suites / tests                  198 / 4050 green    ✔
clients migrated                        0           ⚠  no client has moved yet
provider production compatibility  preserved        ✔  no legacy route touched
deployed                          NOTHING           ⚠  51 commits unpushed; local only
production smoke                  NOT PERFORMED     ⚠  cannot be self-served
```

**Branch:** `main` · **HEAD at report time:** `36ca152` · working tree carries
this session's changes, uncommitted.

---

## What this session actually changed

The foundation itself was built by earlier commands in this TAB and was already
passing. Reconciling the repository against the Master Command found one class
of defect still open, and it is the class this TAB exists to prevent.

**The generated documents were current. The hand-written ones were lying.**

| Document | Claim | Reality |
|---|---|---|
| `API_V1_CONTRACT.md` §11 | "Six exist today: `/auth/refresh`, `/search`, …" | Four planned; `/auth/refresh` and `/search` have been live for commands |
| `API_V1_CONTRACT.md` §5 | "Two v1 lists page in the API layer" | Three — `/bookings`, `/provider/jobs`, `/notifications` |
| `API_V1_CONTRACT.md` §6 | "Every mutation shipped in this phase is naturally idempotent. None needs an `Idempotency-Key`" | Twelve non-idempotent mutations ship today, all with `Idempotency-Key` handling |
| `API_V1_CONTRACT.md` §8 | "There are two today" (role-specific routes) | Four |
| `CROSS_CLIENT_MIGRATION_PLAN.md` Phase 0 | "18 canonical endpoints live", "all 22 aliases" | 42 and 42 |
| `CROSS_CLIENT_MIGRATION_PLAN.md` Phase 2/4/5 | hand-kept move tables | Missing the six provider lifecycle actions and the cancel path |
| `CROSS_CLIENT_MIGRATION_PLAN.md` closing | "deliberately did not migrate: auth … booking mutations" | Both have since been migrated by their own commands |

Every one of those was true when written. Every gate was green the whole time,
because nothing derived a countable claim from `contract.ts` — the exact failure
mode this TAB's release gate ("OpenAPI/registry/route implementation agree")
was written to catch, occurring in the two documents a client team reads first.

### The fix: generated regions inside hand-written prose

Prose stays hand-written, because the *reasons* are decisions and a generator
cannot write them. Every **countable** claim moved inside a marker:

```markdown
<!-- BEGIN GENERATED: v1-planned -->
<!-- END GENERATED: v1-planned -->
```

`npm run api:docs` now rewrites those regions from the contract and
`npm run api:docs:check` fails if a committed file disagrees — the same gate
that already covered the registry, the matrix and the OpenAPI document. Eight
regions across two documents: `v1-planned`, `v1-role-specific`, `v1-surface`,
and one per-client move table for each of the five clients.

The per-client tables are derived from the caller matrix, so a client's move
list grows as domain commands land instead of being remembered.

### The same defect, in the three documents the fix did not reach

Two documents were put under the gate. Five hand-written documents make
countable claims. Checking the other three found the identical failure in all
three, none of which any green gate would have caught:

| Document | Claim | Reality |
|---|---|---|
| `AUTH_ROUTE_MIGRATION_MATRIX.md` | the generated matrix "covers all 517 routes" | 520 |
| `CATALOG_LEGACY_MIGRATION_MAP.md` | `/api/admin/provider-catalog/*` "(29 routes)" | 28 |
| `CATALOG_LEGACY_MIGRATION_MAP.md` | "All **four** canonical catalog successors are implemented" | six catalog entries supersede a legacy route |

All three are now generated regions: `legacy-route-total`,
`catalog-admin-route-families`, `catalog-successor-status`. Five of five
hand-written documents are under `npm run api:docs:check`.

### And one that was not a count but a security claim

`AUTH_V1_CONTRACT.md` §8: **"Every credential endpoint carries two limiters and
both must pass."** Six of the nine do. `refresh` and `verify-mobile` carry the
per-IP limiter alone, and `logout` carries none.

Each of those three is *correct*. A refresh token and a Firebase ID token carry
no identifier to key an account bucket on, and keying on the unverified token's
subject would let a caller choose their own counter — which is the objection
`tokenExchangeLimiter`'s own docblock raises. The sentence was a fair summary of
the five endpoints that existed when it was written, and the domain grew.

The test named `every credential endpoint carries both a per-account and a
per-IP limiter` did not enforce it. It read `register.ts` as **text** and looped
over a hand-listed five ids, so the three endpoints that contradicted the
sentence were never examined, and a tenth endpoint added with no limiter at all
would have passed in silence.

`src/api/v1/rateLimitPolicy.ts` now holds the mapping and the budgets as data.
`register.ts` builds the middleware chains from it, §8 renders from it, and the
tests read it instead of scraping source. An endpoint with no per-account bucket
must state why **in the declaration**, and the module throws at import if one
does not — or if an implemented auth endpoint has no policy at all. That is the
only durable form of "documented": the reason and the wiring are one object.

The wiring is unchanged. All eight endpoint→limiter chains and all five budgets
were diffed against the committed version and are identical, including limiter
order within each chain; `perAccountRegister` and `perAccountRecovery` now state
`skipSuccessfulRequests: false` where they previously relied on the default.

### A bug in the mechanism, found by using it

The first parser accepted only lowercase region names. `v1-moves:providerWeb`
did not match, was copied through as ordinary text with an **empty body**, and
`--check` reported the file up to date. A region that reads as machine-kept and
is not is strictly worse than no region. A malformed marker is now a throw, and
`tests/v1-docs-drift.test.ts` pins both that and the unknown-region case.

### Also closed: a release gate that rested on review

> *"No two canonical endpoints represent the same business mutation with
> different semantics."*

That was true and unenforced. `tests/v1-contract.test.ts` now groups every
implemented non-idempotent entry by the domain service it names and fails on a
collision, with a fixture-driven companion test so the check cannot rot into a
tautology. Two canonical reads *may* share a service — `/search` and
`/catalog/search` are one implementation behind two names, asserted separately —
but a mutation may not.

---

## The canonical surface, against the Master Command's target

| Target namespace | State |
|---|---|
| `/api/v1/auth/*` | **live** — 9 endpoints, rate-limited per account and per IP |
| `/api/v1/me` | **live** — same `identityService.getIdentity` as `/api/auth/me` |
| `/api/v1/catalog/*` | **live** — 10 endpoints over Catalog V2, `services.id` canonical |
| `/api/v1/search` | **live** — server-side, ranked, qualified `ref` per hit |
| `/api/v1/home` | *planned* — no legacy equivalent; composing it is a product decision |
| `/api/v1/bookings/*` | **live** — list, get, timeline, transitions, cancel |
| `/api/v1/provider/jobs/*` | **live** — list, get, and six lifecycle actions on the executor |
| `/api/v1/admin/bookings/*` | *planned* — DTO waits on the permission model |
| `/api/v1/conversations/*` | *planned* — chat does not use the `{status,data}` envelope; owned by messaging |
| `/api/v1/notifications/*` | **live** — 4 endpoints |
| `/api/v1/reviews/*` | **live** — 2 endpoints |
| `/api/v1/provider/earnings/*` | *planned* — payout window says 48h in copy and 72h in reality; one answer first |
| `/api/v1/settings/*` | **live** — GET/PUT notification preferences, not role-gated |

Nine of thirteen namespaces are live. The four that are not are `planned`
entries: documented, **not mounted**, answering 404, with
`tests/v1-router.test.ts` asserting each one 404s so "planned" cannot quietly
become "half-built".

---

## Release gates

| Gate | State | Evidence |
|---|---|---|
| No two canonical endpoints are the same business mutation with different semantics | **met** | `tests/v1-contract.test.ts` — mechanical as of this session |
| All canonical endpoints have explicit auth/role requirements and typed DTOs | **met** | `auth` on every entry drives the middleware chain; `tests/v1-router.test.ts` drives every entry in every mode |
| Provider production compatibility preserved | **met** | No legacy route, payload, envelope or status changed. 42 aliases still mounted; `npm run guard:protected-contracts` green |
| OpenAPI / registry / route implementation agree | **met** | All four generated documents regenerate byte-identical; all five hand-written docs are in the same gate |
| Legacy route usage observable | **met** | 42 aliases watched, watch list derived from the contract (`tests/v1-legacy-telemetry.test.ts`) |
| No unexplained P0/P1 route drift | **met** | 520 routes classified; `KEEP` is a stated classification, not an omission |

---

## Tests actually executed

`npm run verify`, complete, on this working tree:

```
typecheck (src)                 clean
typecheck (tests)               clean
guard:protected-contracts       all protected route contracts verified
api:docs:check                  API docs are up to date
booking:docs:check              Booking docs are up to date
jest --runInBand --ci           198 suites / 4050 tests, all passed
```

`npm run verify` was run twice: once on arrival, to establish that the tree was
green before anything was touched (4033 tests), and once on the finished tree
(4050). The 17 new tests are the added rate-limit-policy assertions in
`v1-auth-contract` and the drift coverage of the three new regions. The suite
count is unchanged at 198 — no new file, so `suite-inventory` stays pinned.

Targeted runs during the work: `v1-router`, `v1-contract`, `v1-catalog-contract`,
`v1-auth-contract`, `v1-auth-security`, `v1-docs-drift`, `v1-legacy-telemetry`,
`v1-parity-exemption`, `route-shadowing`, `legacy-route-telemetry` — all passed.
`v1-auth-security` matters most among them here: it mounts the real router from
`register.ts` and drives it over HTTP, so it exercises the rebuilt limiter chain
rather than only its types.

**Nothing here is a claim about production.** Every number above came from a
local run against mocked infrastructure. No endpoint was called against a
deployed build, and none of these tests would notice if the deployed build
differed from this tree.

---

## Gaps

**P1 — no deployment, therefore no production smoke.**
51 commits are unpushed. Deploying is explicitly outside what may be done
without human authorization, so this cannot be self-served. Until it is, no
client can migrate against a contract that is not serving, and the Phase 0
checklist in the cross-client plan stays open. The smoke, when it runs, must
introspect the compiled router and call each path — a 401 is not proof a route
exists.

**P2 — four `planned` endpoints.**
`/home`, `/conversations`, `/provider/earnings`, `/admin/bookings`. Each names
its blocking decision on the contract entry. None is an oversight; all four are
sequencing.

**P2 — three lists page in the API layer, not in the query.**
`/bookings`, `/provider/jobs` and `/notifications` fetch the whole set and slice
it. That bounds the response, not the database work. It is an honest improvement
on the legacy routes, which bound neither, and it is now stated in §5 rather
than implied.

**P3 — "both must pass" is proven by wiring, not by a 429.**
The two-limiter rule is now enforced as policy and mounted from that policy, and
`v1-auth-security` drives the real chain over HTTP — but no test exhausts a
budget on a v1 auth endpoint and asserts the 429. Doing it properly needs
per-test limiter isolation: `express-rate-limit` counts per instance, the
instances are module-level, and a suite that spends a budget changes what a
later suite sees. That is worth building, and building it badly would introduce
the kind of order-dependent flake this suite already carries one of.

**P3 — client telemetry attribution is not yet real.**
The legacy telemetry counts hits and can attribute them by client, but no client
sends `X-Servana-Client` yet. Until one does, the retirement criteria can prove
"no traffic" but not "no traffic *from a given client*".

**P3 — caller state is recorded per capability, not per legacy path.**
`auth.login` carries four legacy forms and no client calls all four. The
generated move tables now say so explicitly rather than implying a client should
migrate a route it never called.

---

## Compatibility still active

All 42 aliases remain mounted and none has been retired. Zero clients have
migrated, so this is expected: the retirement criteria require 14 days of zero
recorded hits for a web alias and 90 for a mobile one, and the clock cannot
start before the contract is serving.

## Next safe deprecation step

Not a deletion. In order:

1. **Deploy** (needs authorization), then smoke the 42 live endpoints against
   the deployed build by router introspection.
2. **Admin Portal sends `X-Servana-Client` and `X-Servana-Client-Version`.** One
   interceptor, reverted by a revert, and it is what makes every later
   retirement decision measurable rather than argued.
3. **Provider Web takes the auth and identity moves**, which are the cheapest
   real migration and prove the envelope change under load.
4. Only then does any alias become a retirement *candidate*, and
   `GET /api/:id` is not among the early ones — it is a live protected contract
   and the reason no unknown single-segment GET can 404.
