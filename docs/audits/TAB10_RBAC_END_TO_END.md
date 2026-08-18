# TAB 10 — RBAC end to end, from grant to route

> **Implemented 2026-08-18** against `servana_api` at `8a5aa5b`. Rules §11, §12, §15.

---

## 1. The admin surface, measured

| | |
| --- | --- |
| Admin routes mounted | **250** |
| With a named permission | **233** |
| With `requireSuperAdmin` (stricter) | **11** |
| Documented exceptions | **8** (two of them known defects — §4) |
| Genuinely unexplained | **0** |

## 2. The detector was wrong first, and that is the finding

The first pass read only `requirePermission('…')` and reported **17 admin
routes as having no named permission**. Eleven of those carry
`requireSuperAdmin`, which is **stricter** than any named permission — super
admins bypass `requirePermission`, so demanding super-admin status is the
stronger claim, not a weaker one.

The book warns about precisely this: *a route-auth detector that only reads the
route line under-reports protection and over-reports gaps.* A matrix published
in that state would have sent somebody to "fix" the **permission-granting path**
— the most protected routes in the application.

`guardsOf()` now resolves `...adminOnly` spreads and detects `verifyAuth`,
`verifyRoles`, `requirePermission`/`requireAny`/`requireAll`, and
`requireSuperAdmin`. A positive control asserts the super-admin routes are
still seen, so the under-reporting cannot come back quietly.

## 3. The 24 capability divergences from TAB 01, adjudicated

TAB 01 surfaced 24 capabilities reached by two or more routes with differing
permissions, and deferred 23 of them here rather than adjudicating them inside a
money P0. The verdict:

**17 of 24 dissolve once permission CLOSURE is applied.** They were never
defects — only two spellings of one access level, e.g. a route demanding
`payouts.retry_failed` beside one demanding `payouts.details.view`, where the
catalogue declares the former as *requiring* the latter.

**7 remain incomparable, and none is a privilege defect:**

| Capability | Why it is not a defect |
| --- | --- |
| `catalogAdminService#updateCategory` / `#updateSubcategory` | `…/status` demands `services.offering.archive`; the base update demands `services.offering.edit`. **Archiving is not editing.** The split is finer-grained than the check requires — a *better* design, not a divergence. |
| `catalogAdminService#reorder` | Category/subcategory reorder demands `services.offering.edit`; service reorder demands `services.specific.edit`. Different levels of the catalog hierarchy, deliberately different permissions. |
| `adminOnboardingService#decideRequirement` | approve / reject / request-resubmission each carry their own permission on one executor. Three distinct decisions, correctly distinguished — the same shape as assign vs reassign in TAB 06. |
| `adminCommunicationService#listCommunicationEvents` | A screen read (`communications.notification_logs.view`) and a bulk export (`communications.export`) share a query. Export is a distinct act and is separately permissioned, which is the point. |
| `adminGuestService#getClientDetail` | A client detail read and an addresses read share an internal lookup but return different payloads. |
| `providerAutoOnlineEngine#evaluateProvider` | **A false positive of the model.** 26 routes reach it, 12 of them provider/worker *self-service* routes (`/api/provider/documents`, `/api/worker/…`) guarded by provider role and ownership rather than admin permissions. Comparing an admin permission against a provider self-service guard compares two authorization models, not two guards on one capability. |

**Refinement recorded:** capability parity is only meaningful *within an actor
class*. Comparing across classes produces alarm without information.

## 4. Two known defects, listed as defects rather than as decisions

The exception list carries eight entries. Six are considered exemptions. **Two
are labelled `KNOWN DEFECT`** and a test asserts they keep saying so — an
exception list where every entry reads as "fine" is how a gap becomes permanent:

- **`PATCH /api/admin/workers/:uid/archive`** duplicates
  `/api/admin/users/:uid/archive`, which demands `users.archive`. The duplicate
  demands nothing beyond role 1.
- **`GET /api/admin/provider/reconciliation`** overlaps the permissioned v1
  reconciliation endpoint the portal calls.

Both are TAB 09 `CONVERGE` classifications awaiting the telemetry gate. Until
deleted they are live gaps, and the matrix says so.

### 4.1 The pattern, now named

This is the **fourth** occurrence in this book of one shape:

| # | Where | The duplicate was also the weaker door |
| --- | --- | --- |
| F-01 | payouts | `/admin/disbursements/*` — no permission, no audit, no retry cap |
| F-11 | refunds | v1 one-shot refund — no permission, no review, no second actor |
| TAB 09 | worker archive | no named permission vs `users.archive` |
| TAB 09 | reconciliation | no named permission vs `reconciliation.view` |

It is not four incidents. It is a **class**: when a capability grows a second
surface, the newer one is written without the guard because the guard is
remembered as belonging to the original. `tests/authz-parity.test.ts` (TAB 01)
is the standing detector for it.

## 5. The grant path cannot be used to escalate yourself — verified, not assumed

Every grant-path mutation (`POST /admin/admin-users`, `PATCH …/:adminUid`,
`PATCH …/:adminUid/permissions`, `…/status`, invites) is `requireSuperAdmin`.
A non-super admin who could edit grants could grant themselves anything, which
would make every other permission in the system advisory.

The one deliberate opening is `POST /admin/admin-users/bootstrap-super-admin`,
reachable by any authenticated caller **because it exists for the moment when no
admin exists and therefore nobody can hold a permission**. Its control is in the
service, and it is sound:

- `pg_advisory_xact_lock` serialises concurrent attempts, so two callers cannot
  both pass the "is there a super admin?" check;
- refuses outright if any super admin exists — **including a suspended one**;
- refuses a caller who is not already an admin when admin rows exist;
- audits every denial with `outcome: 'blocked'` and the counts it saw.

TAB 05 additionally placed it on the strictest rate-limit tier.

## 6. Two open questions closed by reading, not deferred

The notification exceptions were written with follow-ups asking whether the
queries are actually actor-scoped, because *"an admin's own inbox"* is an
exception only if it is genuinely their own. Both were then checked:

- `listForAdmin` → `WHERE admin_uid = $1`
- `markRead` → `WHERE admin_uid = $1 AND read_at IS NULL AND id = $2`

Scoped by actor **and** id. Worth asking rather than assuming: `id` alone would
have been a cross-actor write behind a route that looks self-scoped. Both
follow-ups are now recorded as VERIFIED with the date and the predicate.

## 7. Gates

```
npm run verify        PASS exit 0 — 291 suites, 6179 tests
npm run authz:legacy  PASS exit 0 — 615 legacy routes, 0 v1 loosenings
tests/admin-authz-matrix.test.ts    15 tests
```

**Mutation-verified:** removing a documented exception makes its route
unexplained and fails the matrix.

> **A process note, recorded because it nearly cost work.** The restore step
> after that mutation used `git checkout <path>` on a file that was new and
> uncommitted, so it silently did nothing and left the mutation in place. Caught
> by re-measuring rather than by assuming the restore worked — 7 exceptions
> where there should have been 8. `git checkout` is not a restore for untracked
> files, and "the command exited 0" is not evidence that it did the thing.

## 8. What could NOT be done here

| Book step | State | Why |
| --- | --- | --- |
| Negative test per permission — a token holding everything *except* X gets 403 from every route requiring X | **NOT DONE** | Needs a real Firebase identity and a live permission store. The structural half (every route names what it demands) is asserted; the behavioural half is manual task 10.1. |
| Verify the portal's permission-driven navigation matches the server | **NOT DONE** | `NO-REPO`. Manual task 10.2. |
| Confirm a hidden button is never the only control — call routes with an under-permissioned token | **NOT DONE** | `PROD-ACCESS` / `NO-CRED`. Manual task 10.3. |
| Cross-user isolation sweep (§11) | **PARTIAL** | The notification queries were verified actor-scoped (§6) and v1 object-ownership is covered by `authzMatrix` §145. A full sweep of all 250 admin routes' internal scoping is manual task 10.4. |
