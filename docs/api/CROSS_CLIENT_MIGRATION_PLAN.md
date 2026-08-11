# Cross-client migration plan — legacy → `/api/v1`

Per-client, phased, and ordered by how cheaply a client can be corrected if the
migration is wrong. Nothing here requires a backend change; every canonical
route named as `live` is mounted and tested today.

Companion documents: [`API_V1_CONTRACT.md`](API_V1_CONTRACT.md) (the rules),
[`API_ENDPOINT_REGISTRY.md`](API_ENDPOINT_REGISTRY.md) (the endpoints),
[`LEGACY_ENDPOINT_MIGRATION_MATRIX.md`](LEGACY_ENDPOINT_MIGRATION_MATRIX.md)
(every route, classified).

---

## The ordering principle

**Migrate in reverse order of correction cost.**

| Client | Correction cost | Why |
|---|---|---|
| Admin Portal | minutes | Netlify-from-git: the push *is* the deploy. A bad migration is reverted by a revert. |
| Provider Web | minutes | Same shape — a push to `main` is a production deploy. |
| Customer Web | hours | Angular, not yet deployed at `client.servana.com.ph`. |
| Provider Mobile | days–weeks | Play review, then the installed base has to update. |
| Customer Mobile | days–weeks | Same, and it is the largest installed base. |

A mobile client that adopts a wrong contract keeps calling it for as long as
customers leave the app installed. That is why the two Flutter apps go last even
though they are the reason the canonical namespace exists.

## Phase 0 — before any client moves (backend, done)

- [x] `/api/v1` mounted first, exempt from field-rewriting middleware.
- [x] 18 canonical endpoints live, driven end to end by tests.
- [x] `GET /api/catalog` unshadowed; shadow regression test over the whole app.
- [x] Legacy telemetry counting all 22 aliases, derived from the contract.
- [x] OpenAPI + registry + matrix generated, drift-tested in the gate.
- [ ] **Deploy.** Everything above is local and unpushed. No client can migrate
      against a contract that is not serving.
- [ ] **Production smoke** of the 18 endpoints against the deployed build,
      by introspecting the compiled router and calling each path — never by
      reading a 401 as proof a route exists.

## Phase 1 — Admin Portal

**Adopt first, migrate last.** The portal calls almost nothing in the canonical
set today — its surface is `/api/admin/*`, which this command classifies
`CANONICALIZE` and leaves to the admin-bookings domain command.

What it should do now:

1. Send `X-Servana-Client: admin` and `X-Servana-Client-Version` on every
   request. This is what makes the legacy telemetry able to attribute traffic,
   and it costs one interceptor.
2. Nothing else. Migrating admin reads before the permission-scoped DTO is
   settled would freeze a shape that has to change.

**Gate to Phase 2:** the header lands and `pm2 logs | grep legacy-contract`
shows `admin=` counts.

## Phase 2 — Provider Web (`Servana.com.ph`)

The cheapest real migration, and the one that proves the contract under load.

| Move from | Move to | Note |
|---|---|---|
| `GET /api/auth/me` | `GET /api/v1/me` | Same service already; envelope changes from `{status,data}` to `{data}`. |
| `GET /api/worker/job-cards` | `GET /api/v1/provider/jobs` | Legacy returns a **bare array**; v1 returns `{ data: { jobs: [...] }, meta.page }`. |
| `GET /api/worker/job-cards/:id` | `GET /api/v1/provider/jobs/:bookingId` | |
| `GET/PUT /api/provider/notification-preferences` | `GET/PUT /api/v1/settings/notification-preferences` | v1 is not role-gated — the preference table has no role column. |

Do it behind one API-client adapter, not at 40 call sites. The envelope change
is mechanical; the risk is doing it inconsistently.

**Gate to Phase 3:** provider-web hits on those four legacy routes reach zero
for 14 consecutive days.

## Phase 3 — Customer Web (`servana_Customer_WebPortal`)

Not yet deployed, so it can adopt v1 as its **only** contract rather than
migrating onto it.

| Capability | Canonical |
|---|---|
| Identity | `GET /api/v1/me` |
| Catalog | `GET /api/v1/catalog`, `/catalog/services`, `/catalog/services/:id` |
| Bookings | `GET /api/v1/bookings`, `/bookings/:id`, `/bookings/:id/timeline` |
| Notifications | `GET /api/v1/notifications`, `/unread-count`, `PATCH …/read`, `POST …/read-all` |
| Reviews | `GET /api/v1/reviews/providers/:uid`, `…/rating` |
| Settings | `GET/PUT /api/v1/settings/notification-preferences` |

Still legacy for this client, by design: booking **creation** and cancellation,
auth, and chat. Each is owned by a later domain command; see the matrix.

**One-line fix to fold in while here:** `notification.types.ts` `ROUTE_KEYS` has
`MESSAGES` but not `CONVERSATION`, so the customer chat notification renders
un-clickable. Safe by design (unknown key → never navigate), but it is a dead
tap today.

## Phase 4 — Provider Mobile (ServanaWorker)

First Flutter client. Two aliases to leave behind:

| Move from | Move to | Why it matters |
|---|---|---|
| `GET /api/workers/:workerId/job-cards` | `GET /api/v1/provider/jobs` | Kills the path-parameter identity that produced the BOLA. |
| `GET/PUT /api/workers/:uid/notification-preferences` | `GET/PUT /api/v1/settings/notification-preferences` | Same. |

Also adopt `GET /api/v1/me`.

**Sequencing note:** this app already has a release blocked on **MS-02** — the
only SHA registered for `com.servana.worker` is a debug keystore, so phone auth
fails in every release build. Fold the migration into that release rather than
cutting one for it.

**Gate to Phase 5:** 90 consecutive days of zero hits on both aliases. Ninety,
not fourteen: an unupdated app keeps calling the old path for as long as it
stays installed, and no server-side measurement of the current build sees that.

## Phase 5 — Customer Mobile (ServanaClient)

Largest installed base, so last.

| Move from | Move to |
|---|---|
| `GET /api/services/full` (legacy L2/L3 catalog) | `GET /api/v1/catalog` |
| `GET /api/users/:userId/bookings` | `GET /api/v1/bookings` |
| `GET /api/:id`, `/api/:id/timeline` | `GET /api/v1/bookings/:bookingId`, `…/timeline` |
| `GET /api/user/notifications*` | `GET /api/v1/notifications*` |

The catalog move is the substantial one: the app currently searches
**client-side** over the `/api/services/full` payload, which is why an empty
`level2` silently emptied the search cache and every query rendered "No services
match your search." A canonical tree with a canonical `services.id` removes the
class. `/api/v1/search` is planned and not built — do not wait for it; the
client-side search over the canonical list is strictly better than what ships
today.

## Retiring an alias

All four must hold. Criteria live in code —
[`RETIREMENT_CRITERIA`](../../src/api/v1/legacyTelemetry.ts) — and the matrix is
generated from them, so this list cannot drift from what is enforced.

1. Web-only alias: **14** consecutive days of zero recorded hits.
2. Mobile alias: **90** consecutive days of zero recorded hits.
3. Every client the matrix lists for the route reads `migrated`.
4. The canonical successor is `implemented`, not `planned`.

Measure with `pm2 logs servana-prod | grep legacy-contract`. One summary line
per legacy route per hour: hits, how many carried a bearer token, and a
breakdown by client and version. No uid, no path parameter, no query string, no
raw User-Agent.

**`GET /api/:id` is a special case.** It is a live protected-client contract, it
is the reason no unknown single-segment GET can 404, and it is what swallowed
`GET /api/catalog`. Retiring it needs the criteria above **and** evidence of
zero non-numeric ids reaching it — otherwise something is still relying on the
accident.

## What this command deliberately did not migrate

Named here so the omissions are decisions rather than oversights.

- **Auth.** All five clients hold a session from `/api/auth/refresh`. A second
  path to the same credential exchange, before the auth domain is swept, is how
  you get two session state machines.
- **Chat.** Chat endpoints do not use the `{status,data}` envelope at all — the
  store reads a top-level `conversations` key. Re-enveloping is a real client
  change and belongs with the messaging work.
- **Provider earnings.** The payout window is documented as 48h in copy and 72h
  in reality. A second read path before that is settled would give two answers
  to "when am I paid".
- **Booking mutations.** Create, cancel and confirm are state-machine
  transitions with idempotency, notification and audit obligations. A second
  path to them in a foundation command is how a booking gets two lifecycles.
- **Admin.** The admin list carries permission-scoped columns; the DTO needs the
  permission model resolved first.
