# Backend SWEEP — `servana_api`, 2026-08-11

Read-only discovery pass over the whole backend. Nothing was changed: no code,
no schema, no deploy, no push. Findings are ranked and each one names the file,
the line and how it was verified.

| | |
|---|---|
| Repo | `Upupapp/servana_api` (local `servana_api-main`) |
| Branch / HEAD | `main` / `2bdaf0d` |
| Tree | clean — 0 modified files |
| Unpushed | **1 commit** — `2bdaf0d` *"public canonical catalog API + the booking dual-write Phase 4 never built"* |
| Deployed | `2e03a4b` (the commit below HEAD) |

## Gate, run first, before any analysis

| Check | Result |
|---|---|
| `tsc --noEmit` | **0 errors** |
| `guard:protected-contracts` | **green** — all 11 protected route-prefix assertions |
| `jest --runInBand --ci` | **156 suites / 2,993 tests, all passing**, 11.6 s |

The gate is green and BE-01 below is a P0. That is the most useful single fact
in this report, and BE-02 explains why the two are compatible.

## Surface measured

33 route modules · **517 route registrations** (516 mounted under `/api`, one
HTML page at root) · 45 controllers · 83 services · 15 middleware · 133 test
files.

Route extraction handles multi-line `router.get(` and covers `src/chat`, which
is the trap that produced seven false "missing endpoints" in an earlier pass.

---

# Findings

## BE-01 — P0 · `GET /api/catalog` is unreachable. A booking wildcard eats it.

`src/routes/catalogPublic.routes.ts:27` registers `GET /catalog`.
`src/routes/booking.routes.ts:44` registers `GET /:id`, and **booking mounts
fifth in `src/app.ts` while catalogPublic mounts fifteenth**. Express takes the
first router that matches, so `/api/catalog` never reaches the catalog router.

**Verified, not reasoned.** Stub routers carrying the real paths, mounted in
`app.ts`'s exact order against real Express:

```
/api/catalog              -> handled by booking.routes  "/:id"
/api/catalog/summary      -> handled by catalogPublic.routes  "/catalog/summary"
/api/catalog/services     -> handled by catalogPublic.routes  "/catalog/services"
/api/catalog/services/12  -> handled by catalogPublic.routes  "/catalog/services/:serviceId"
```

Only the single-segment browse root collides; the three deeper paths are fine.

What a caller actually gets:

- **Anonymous** — `verifyAuth` answers **401**. That is the exact caller the
  route was written for: an unauthenticated customer app browsing the catalog.
- **Authenticated** — `getBooking` runs `Number("catalog")` → NaN →
  **400 `Invalid booking id`** (`bookingController.ts:201-205`).

So the browse root of the canonical public catalog — *the* surface the Client
App migration is meant to consume, per the commit message of `2bdaf0d` — is
dead in both directions, and it is dead in the commit that introduces it. It
has never been deployed, so nothing in production is broken yet.

**Second-order effect, worth its own note:** `GET /api/:id` means **the API
cannot 404 any single-segment GET**. `/api/anything` is a booking lookup, so it
answers 401 unauthenticated and 400 authenticated. The standing note that "a
401 proves nothing about whether a route exists" is right about the conclusion
but wrong about the mechanism — it is not a catch-all auth middleware, it is
this one route. `/api/admin/not-a-real-thing` is two segments and behaves
differently from `/api/notathing`.

**Recommended fix** — move the `catalogPublic` (and, for symmetry, `catalogAdmin`)
`app.use` above the booking router in `src/app.ts`. Pure ordering, additive, no
path or payload moves, no protected client affected (§2, §4). Reordering is safe
because no booking id can be the literal string `catalog`.

Rejected alternative: retiring `GET /:id` in favour of `/bookings/:id`. It is a
live protected-client contract; §5 forbids it.

**A full shadow scan of all 516 `/api` routes in mount order found exactly one
collision — this one.** Everything else is clean, which is worth knowing.

## BE-02 — P1 · 2,993 tests and not one of them resolves a URL.

This is why BE-01 shipped green.

- No jest test imports `src/app.ts` as a module. Four tests reference it — all
  four read it **as text** (`fs.readFileSync`, e.g. `admin-audit.test.js:625`).
- No test calls `express()`. Zero occurrences in `tests/`.
- `supertest` appears twice, both times in a comment saying what you would need
  to install. **It is not a dependency.**
- The only two files in the repo that make real HTTP requests —
  `tests/catalog-service.test.ts` and `tests/admin-dedup.test.ts` — are
  standalone `ts-node` scripts needing a live API, and both are named
  explicitly in `jest.config.js:5` `testPathIgnorePatterns`.

`catalog-service.test.ts`'s own header says it verifies "the
`/:serviceId/options-with-addons` endpoint is reachable". That is precisely the
check that would have caught BE-01, and it is excluded from the gate by name.

The catalog contract tests are good tests — `catalog-public-contract.test.ts`
pins the parity exemption and the ISO-8601 timestamps, both real production
defects. They call `catalogPublicService` directly. A service the router never
delivers a request to still passes every one of them.

**Recommended fix** — add `supertest`, mount the real `app`, and assert that a
handful of representative paths reach the handler they name. Start with the
single-segment ones, which are the whole risk class. That test fails today.

## BE-03 — P1 · A hard delete of the global catalog: three statements, no transaction, no audit, no consumer.

`DELETE /api/services/:serviceId/force` → `serviceController.ts:163` →
`serviceService.hardDeleteService` (`serviceService.ts:474`).

It issues **three separate `dbQuery.query` calls with no `BEGIN`/`COMMIT` and no
pooled client**:

1. `DELETE FROM service_option_meta WHERE service_option_id IN (…)`
2. `DELETE FROM service_options WHERE service_id = $1`
3. `DELETE FROM service_families WHERE id = $1`

A failure between 1 and 3 leaves the catalog half-deleted and unrecoverable
(§19). There is a booking-reference guard in front, which is good, and it is
`verifyRoles([1])`, which is also good. Everything else about it is a hazard:

- **No audit record.** A permanent deletion of global catalog data leaves no
  actor, no reason, no before-state (§15, §16).
- **It is blind to Catalog V2.** Step 2 deletes `service_options` rows.
  Canonical `services` rows point at those through `legacy_service_option_id`,
  and the unpushed commit resolves `bookings.catalog_service_id` *through that
  column*. Deleting the options dangles the link the new dual-write depends on.
  Nothing here touches `catalog_provider_services` (1,128 rows) either.
- **§30** says removing a provider's service must not delete the global catalog
  item. This deletes the global catalog item outright, by design.
- Its 500 handler echoes the raw error (BE-05).

**No client calls it.** Checked all five consumers directly: nothing in
ServanaClient, ServanaWorker, the Admin portal, Customer Web or Provider Web
references it. The Admin portal goes further — `catalog-browser.component.spec.ts:278`
asserts no `delete|destroy|force` method exists on that component.

So this is latent, not active. But it is reachable with any role-1 token and
curl, and it is the single most destructive route on the API.

**Recommended fix** — retire it. If a hard delete must exist, it belongs on the
canonical Catalog V2 surface, in one transaction, with an audit record and the
same "withdraw, don't orphan" discipline `4bf10f5` already applied to banners.

*(One hypothesis was checked and disproved: `service_families` was a view after
Deploy 1, which would have made step 3 throw. Migration 024 dropped that view
and renamed the physical table back to the name, so the DELETE is valid. The
migration comment at `023:17-20` names `hardDeleteService` explicitly.)*

## BE-04 — P1 · The sign-in limiter repeats the mistake the file next to it documents.

`src/routes/auth.route.ts:17` — `signInLimiter`, IP-keyed, **max 10 per 15
minutes**, shared by `/auth/signin` and `/auth/admin-signin`.

Twenty lines below it, `tokenExchangeLimiter`'s docblock (`:25-62`) explains at
length why IP keying is wrong here: *"Philippine carriers use carrier-grade NAT,
so a handful of unrelated customers behind one public address could exhaust the
budget between them."* That reasoning was applied to the token routes and not to
the password routes, which sit behind the same NAT and the same limiter.

Two consequences:

1. **Ten password sign-ins per quarter-hour, per carrier NAT egress IP**, across
   every customer behind it. The eleventh person to sign in is told they have
   made too many login attempts.
2. `express-rate-limit` counts per limiter *instance*, and one instance serves
   both routes — so **customer sign-in traffic and admin sign-in traffic share
   one budget**. Enough customer logins from an office IP locks admins out of
   the admin portal from that office.

The docblock's stated reason for not keying per account — "these routes run
before `verifyAuth`, so keying on an unverified token's subject would let a
caller choose their own bucket" — is correct for the token routes and does not
transfer. A password route receives an identifier in the body, and the standard
key is `ip + identifier`: an attacker grinding one account still hits the wall,
while unrelated customers behind one NAT never collide.

`middleware/workerCodeLimiter.ts` already implements exactly this pattern,
including `ipKeyGenerator` for correct IPv6 normalisation.

**Recommended fix** — split the two routes onto separate instances and key both
on `ip + normalised identifier`.

## BE-05 — P1 · The safe-error helper exists. 63 sites bypass it.

`helpers/status.ts:95` `sendFailure(res, context, error, opts)` logs the error,
mints a request id, and returns a safe body. It is the right shape and it
correlates with the request id already stamped on every request in `app.ts:49`.

**It has 15 call sites.** Meanwhile **63 sites answer HTTP 500 with the raw
`error.message`** (149 sites echo `error.message` at any status). A pg error
reaching one of those puts a constraint name, a column name or a schema-
qualified relation on the wire — §21, §58.

Concentrations: `providerCatalogController.ts` (13), `disbursement.controller.ts`
(3), `bookingController.ts`, `auth.controller.ts`, `serviceController.ts`.

This is a class with an existing fix and partial adoption, which makes it cheap:
the work is mechanical and each conversion is independently safe.

## BE-06 — P2 · The server starts listening before its schema exists.

`src/app.ts` runs **14 fire-and-forget schema bootstraps** — `ensureAuditSchema`,
`ensurePermissionSchema`, `ensureFinanceSchema`, `ensureOnboardingSchema`,
`initProviderCatalogSchema` + seeds, and so on — each in an unawaited
`(async () => { … })()` whose only failure handling is `console.error`.

`httpServer.listen()` at `:417` does not wait for any of them. On every restart
the API accepts traffic while tables and indexes are still being created, and a
DDL failure is a console line rather than a signal.

The individual statements are `IF NOT EXISTS`, so steady state is a no-op and
this is invisible almost always. It matters on a cold boot against a fresh
database and after any deploy that adds a column a read path assumes.

Contrast `assertContinueUrlsAreUsable()` at `:415`, which is deliberately fatal
and deliberately before `listen` — the right instinct, applied to one check out
of fifteen.

## BE-07 — P2 · One admin request, up to ~1,200 queries.

`providerSupplyHealthService.getSupplyGaps` (`:216-235`) nests
`for (d of daysAhead)` × `for (combo of combos)` and issues **two queries per
iteration** — `getAvailableProviderCount` and a demand count.

`daysAhead` is clamped 1–30 (`adminProviderAvailabilityController.ts:36`, correctly
validated — no injection) and combos are `LIMIT 20`. Worst case **30 × 20 × 2 =
1,200 round trips** for one dashboard call. §56.

The demand counts collapse into a single grouped query over
`(service_id, branch_id, schedule::date)`.

*(The same scan looked for SQL injection across all 247 non-schema template
interpolations in SQL text. Every one traced back to a server-built clause
array, a `$n` placeholder index, or an internal literal. **No injection
found.**)*

## BE-08 — P2 · A test whose name states a guarantee it does not check.

`app.ts:19` and `chat/chat.gateway.ts:18` hold two hand-copied CORS allowlists,
with a `KEEP IN SYNC` comment on the first. They are in sync today — six origins,
identical.

`tests/leak-isolation.test.js:162` is titled *"chat.gateway.ts uses
ALLOWED_ORIGINS list matching the HTTP whitelist"*. It asserts three things:
that the file contains the string `ALLOWED_ORIGINS`, the string
`servana.com.ph`, and the string `localhost:4200`. It never reads `app.ts`. Add
an origin to one list and not the other and this test stays green — the drift it
is named after is exactly what it cannot see.

Same class as the string-keyed guards that drifted in ServanaWorker: derive one
list from the other, or assert set equality across the two files.

## BE-09 — P2 · Duplicate migration numbers.

`scripts/migrations/` has **two `020-` files** (`catalog-v2-expand`,
`payment-superseded-sessions`), **two `021-` files**
(`backfill-submitted-onboarding-cases`, `catalog-v2-backfill`) and **no `022`**.

`run-migrations.ts:18` keys the ledger on the full filename and sorts
lexicographically, so nothing is skipped and nothing re-runs — the runner is
sound (advisory lock, per-migration transaction, checksum drift detection, and a
`MIGRATION_REMOTE_ACK` gate). But within a duplicated number the order is an
alphabetical accident: `020-catalog…` before `020-payment…`, `021-backfill…`
before `021-catalog…`. Catalog expand-then-backfill survives only because `c`
sorts before `p` and `b` before `c`. A future `020-apply-…` would run first.

Renumber, or make the runner refuse a duplicate prefix.

## BE-10 — P3 · Unvalidated paging on the public review list.

`customerReviewController.ts:154-155`: `Math.min(Number(req.query.limit ?? 20), 50)`
and `Number(req.query.offset ?? 0)`. `?limit=abc` → NaN; `?offset=-1` → a pg
error → 500. The route is unauthenticated. Clamp both, as
`getMissingSetup` already does five files away.

---

# What is already clean — checked, and worth not re-checking

- **BOLA on identity path params.** All 74 routes carrying a `:uid` / `:userId` /
  `:providerUid` were walked. The historically dangerous ones —
  `GET /user/:userId/addresses`, `GET /users/:userId/bookings`,
  `GET /workers/:workerId/job-cards`, the bank-account trio — all now fail
  closed on `!actor?.uid || actor.uid !== param`, with the reasoning written
  beside the check. `getByUid` projects by the caller's relationship rather than
  returning the full provider record.
- **The PayMongo webhook.** HMAC-SHA256 over `timestamp.rawBody`, both `li` and
  `te` keys, a 5-minute replay window, `timingSafeEqual`, a livemode/environment
  assertion, and an event-id uniqueness index behind the cheap SELECT.
  (`paymentService.ts:371-404`, `:579-635`.) This is the strongest code in the repo.
- **The public review projection.** `listProviderReviews` selects rating, comment
  and provider response only — no customer identity, and visibility, publication
  state and moderation state are all filtered server-side (§58).
- **Logging.** No OTP value, token, password or full phone number is logged
  anywhere. Emails are masked to three characters at the two sites that log one.
- **`verifyAuth`.** Verifies the signature, then checks revocation against
  `tokenRevocation` rather than trusting expiry alone — and the `TEMP_ID`
  developer bypass calls `process.exit(1)` outside dev/local/test rather than
  merely warning.
- **The migration runner.** Advisory lock, transaction per migration, checksum
  drift detection, and a remote-apply acknowledgement gate.
- **No SQL injection**, across 247 interpolation sites (see BE-07).

# Cross-platform consumer map

Every route was matched against all five consumers — ServanaClient,
ServanaWorker, Admin Portal, Customer Web, Provider Web — resolving the
`${apiUrl}/admin/finance`-style base constants that make a naive whole-path grep
report 239 false orphans.

**480 of 517 routes have a located caller. 37 do not.**

Read that number as a candidate list, not a finding. Suffixes made only of
generic words (`/summary`, `/status`) are deliberately not treated as evidence,
so the four `…/summary` endpoints in the list are near-certainly false negatives.
The ones worth an operator decision:

| Route | Note |
|---|---|
| `DELETE /api/services/:serviceId/force` | BE-03 — verified absent from all five clients |
| `GET /api/workers/all`, `GET /api/workers/role/:role` | admin-gated; `technician.routes.ts:72` already says all has no caller |
| `PUT/GET/DELETE /api/workers/:uid/bank-account` | provider web moved to the `/worker/*` successors |
| `GET /api/workers/:uid/disbursement-history`, `…/earnings-history` | same |
| `GET /api/provider/bookings/:bookingId/dispute-status` | built, never consumed |
| `POST /api/quote` | public, rate-limited, no caller found |
| `GET /api/admin/provider-onboarding/cases…` (5) | worth confirming against the portal |

Full machine-readable map: the consumer scan output, kept out of the repo.

# §62 completion report

| | |
|---|---|
| Repositories changed | **none** — SWEEP is discovery-only |
| Protected apps modified | none |
| Protected releases required | none |
| Routes / payloads / IDs / statuses changed | none |
| Backward compatibility | unaffected |
| Tests | 156 suites / 2,993 tests green, unchanged |
| Build | `tsc` 0 errors, guard green |
| Rollback | not applicable |

# Recommended order of work

1. **BE-01** — one-line reorder in `app.ts`. It unblocks the Catalog V2 Client
   migration and it is in an unpushed commit, so it costs nothing now and a
   deploy later.
2. **BE-02** — mount the app in one test and assert BE-01 stays fixed. Without
   it, the next wildcard does the same thing and the gate stays green again.
3. **BE-04** — a live availability defect for customers on carrier NAT, and an
   admin-lockout path. Small, self-contained.
4. **BE-03** — retire or wrap the force-delete. Latent, but it is the one route
   that can destroy catalog data irreversibly.
5. **BE-05** — mechanical, 63 sites, safe one at a time.
6. **BE-06 / BE-07 / BE-08 / BE-09 / BE-10** — as capacity allows.
