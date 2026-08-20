# The worker surface: a disposition per route, and a correction

**Measured 20 August 2026** against the local `servana_api` working tree, in response to
TAB 01 of `SERVANA_BACKEND_WORKER_APP_ENABLEMENT_MASTER_COMMAND`.

## Verdict

```
WORKER_SURFACE_AUTHENTICATED: PASS
```

**Zero mounted worker-family routes carry no authorization rung.** The five routes the
Master Command names as unauthenticated — and leads with, as the P0 blocking any launch —
are authenticated, and have been since before the document was written.

## The correction, with its evidence

The Master Command states:

> Of 58 mounted routes: 43 carry `requireProviderRole`, 10 carry `verifyAuth`, and **5 carry
> nothing**.
>
> ```
> GET    /api/workers/all
> GET    /api/workers/role/:role
> GET    /api/workers/:uid/services
> POST   /api/workers/:uid/services          ← write
> DELETE /api/workers/:uid/services/:serviceId ← destructive
> ```

Re-measured with `buildMountedRoutes()` and `authOf()` — the classifier that resolves
middleware aliases per file:

| | Master Command | Re-measured |
|---|---|---|
| worker-family routes under `/api/worker/` | 39 | 39 |
| worker-family routes under `/api/workers/` | 19 | 19 |
| carrying `requireProviderRole` | 43 | 43 |
| carrying `verifyAuth` | 10 | **15** |
| **carrying nothing** | **5** | **0** |

The denominators agree exactly, and match the frozen protected-contract floor
(`guard:protected-contracts` prints `39 mounted` and `19 mounted`). The entire difference is
the five routes, and `10 + 5 = 15`.

All five are declared with the `...adminOnly` spread, in
`src/routes/technician.routes.ts:74`:

```ts
const adminOnly = [verifyAuth, verifyRoles([0, 1]), adminRateLimit];
router.get("/workers/role/:role", ...adminOnly, technicianController.listByRole);
router.get("/workers/all", ...adminOnly, technicianController.list);
...
router.post("/workers/:uid/services", ...adminOnly, technicianController.assignEmployeeServices);
router.delete("/workers/:uid/services/:serviceId", ...adminOnly, technicianController.removeEmployeeService);
router.get("/workers/:uid/services", ...adminOnly, technicianController.getEmployeeServices);
```

`verifyAuth` returns **401 UNAUTHENTICATED** without a bearer token or `__session` cookie,
and additionally refuses a revoked token. `verifyRoles([0, 1])` reads the caller's role from
`user_credentials` and returns **403 FORBIDDEN_ROLE** unless it is 0 or 1. Neither takes the
subject from the URL.

Provenance: the `verifyAuth + verifyRoles([0, 1])` guard has been on these routes since
**a062ef9 (2026-08-01)**; `adminRateLimit` was added in **f5c4743 (2026-08-18)** — two days
before the Master Command's measurement date.

### Why the measurement went wrong

`authOf` classifies a chain by the middleware **names** in it. The literal `...adminOnly`
contains none of the ladder's names, so a classifier that does not resolve the spread reports
the route `public` — the weakest rung. The Master Command's method line ("classified by the
middleware names in each handler chain") describes exactly that unresolved read.

**This is the third occurrence of the same misreading**, and the repository already carries
warnings about it from the first two:

1. A sweep reported "261 of 412 routes unauthenticated". The real number was 71.
   (`tests/unauthenticated-pii-routes.test.ts`)
2. A deletion pass removed 30 routes rather than 24, because the detector searched each line
   for the literal `verifyAuth`. **Six secured admin routes were deleted and had to be
   restored.** `src/routes/technician.routes.ts:36-40` now ends that note with: *"Any future
   sweep over this file must resolve middleware aliases."*
3. This document.

## Disposition per route

The Master Command asks for a decision per route: **authenticate, or delete**. All five were
already authenticated, so the decision on each is **keep as authenticated**, with the reason
each was gated rather than deleted recorded when it was gated:

| Route | Rung | Disposition | Reason |
|---|---|---|---|
| `GET /api/workers/role/:role` | `verifyAuth` + roles `[0,1]` | keep, admin-gated | Took the role from the URL over a query returning `email` and `phone_number`; role 3 is customer, so it dumped every customer's contact details. Admin-gated rather than projected because both client methods that call it have **zero call sites**. |
| `GET /api/workers/all` | `verifyAuth` + roles `[0,1]` | keep, admin-gated | Enumerates every worker. **No caller in any of the four clients.** Retained under an admin rung rather than deleted, because deletion would lower the frozen floor and it has a legitimate admin-portal use. |
| `GET /api/workers/:uid/services` | `verifyAuth` + roles `[0,1]` | keep, admin-gated | Read half of the assignment block. Called only by the admin portal, which attaches a bearer token via `AuthorizeInterceptor`. |
| `POST /api/workers/:uid/services` | `verifyAuth` + roles `[0,1]` | keep, admin-gated | **Write.** Assigns a provider's services. Admin-only; no mobile caller. |
| `DELETE /api/workers/:uid/services/:serviceId` | `verifyAuth` + roles `[0,1]` | keep, admin-gated | **Destructive.** Removes a provider's services, which silently removes them from customer search. Admin-only; no mobile caller. |

No route was deleted, so **the protected-contract floor is unchanged and needs no re-freeze**.
`guard:protected-contracts` is green at 39 / 19.

## What was actually missing, and is now present

The Master Command's second deliverable was real and is the substance of this TAB:

> Add a test that fails if any `/worker(s)/` route is mounted without an auth rung, so the
> sixth cannot appear quietly.

`tests/unauthenticated-pii-routes.test.ts` asserts guards on routes it names **one by one**.
That shape cannot notice a sixth route appearing. `tests/worker-surface-authenticated.test.ts`
now enumerates the family from the route table and refuses if any member carries no rung,
whatever its name — and proves its own instrument before believing its zero:

- a positive fixture (the family is non-empty, and splits 39 / 19 as the floor says);
- a control proving the alias resolver still widens `...adminOnly` into `verifyAuth`;
- a control proving the classifier can still return `public` for a bare chain, so an
  over-crediting classifier cannot report zero by going blind.

### Mutation transcript

| Mutation | Result |
|---|---|
| Strip `...adminOnly` from `POST /workers/:uid/services` | **RED** — `"POST /api/workers/:uid/services (src/routes/technician.routes.ts:175)"` |
| Add a new bare route `GET /workers/:uid/tax-summary` (named by no existing test) | **RED** — `"GET /api/workers/:uid/tax-summary (src/routes/technician.routes.ts:210)"` |
| Tree restored | **GREEN** — 7 passed |

## Standing note

A gate reporting a P0 it cannot see the guard for is the same failure as a gate reporting zero
because it is blind — this one just fails in the louder direction. The lesson the rest of this
programme should carry: **the five-route finding was produced by an instrument that had a known,
documented defect, and the document reported it as measured fact.** Re-measure before acting,
and resolve aliases before counting rungs.
