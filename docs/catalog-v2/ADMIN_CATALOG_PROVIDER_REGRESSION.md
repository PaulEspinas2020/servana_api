# ADMIN_CATALOG_PROVIDER_REGRESSION

§91. Provider and customer clients are live. This phase must not move anything
they read.

## 1. Nothing provider-facing was changed — by inspection

Full diff of this phase, backend `2109829..HEAD`:

```
docs/catalog-v2/ADMIN_CATALOG_CURRENT_SWEEP.md   +133   new
src/app.ts                                        +7    mounts the new router
src/controllers/catalogAdminController.ts        +258   new
src/routes/catalogAdmin.routes.ts                +102   new
src/services/adminAuditService.ts                 +3    3 entity types added to a union
src/services/catalogAdminService.ts             +1124   new
tests/catalog-admin-contract.test.ts             +571   new
```

**2,198 insertions, 0 deletions.** Every change is additive.

Grep across the diff for provider- or customer-facing modules —
`service.route`, `serviceController`, `serviceService`, `provider.routes`,
`technician*`, `worker*`, `customer*` — returns **nothing**. Not one of those
files is in the diff.

The only edit to an existing behavioural file is `src/app.ts`, which mounts a
new router after the existing ones. Express matches in declaration order and the
new paths (`/api/admin/catalog/*`) do not collide with any existing route.

`adminAuditService.ts` gains three members on the `AuditEntityType` union
(`catalog_category`, `catalog_subcategory`, `catalog_service`). A widened union
cannot invalidate an existing caller.

## 2. Live production contract — measured

Against the running production API (`127.0.0.1:8000` on the prod host, which is
what nginx proxies):

| Endpoint | Status |
|---|---:|
| `GET /api/services` | **200** |
| `GET /api/services/full` | **200** |
| `GET /api/services/1/level2` | **200** |
| `GET /api/services/1/options-with-addons` | **200** |
| `GET /api/1/options-with-addons` (bare form ServanaWorker calls) | **200** |

`/api/services/full` — the unauthenticated contract whose keys are load-bearing —
returns every protected key intact:

```
serviceId, name, category,
options[].level2,
items[].{ level3id, level3, unit, base_price, inclusions, exclusions, addons }
+ the parity aliases serviceType, service_type, level_3, type
```

This is the **baseline**, taken before deploy. It confirms the contract as it
stands and gives the post-deploy comparison something to diff against.

## 3. Backend regression suite

`npm run verify`: tsc clean, **2,964 tests / 155 suites pass**, including the
existing provider, worker-application, booking and service-catalog suites and
the **31 catalog semantic guards**.

One guard failed during development and was **fixed in the implementation, not
weakened** (§58): the first content-gaps query placed the legacy `category`
column in the same statement as `FROM services`, which is textually the query
that caused the Deploy-3 outage. Split into two reads.

## 4. What is NOT proven

**PROVIDER AUTHENTICATED SMOKE: BLOCKED_BY_TEST_CREDENTIAL.** No provider
Firebase ID token is available in this environment, so authenticated provider
routes (`/provider/documents`, `/provider/catalog`, My Services) were not
exercised end-to-end. They return 401 unauthenticated, as expected.

Mitigating evidence: those routes are covered by the backend suite, none of
their files appear in the diff, and the unauthenticated catalog projections they
depend on all return 200 with keys intact.

**The canonical endpoints are not deployed.** `/api/admin/catalog` returns 401 on
production — but so does `/api/not-admin-nonsense`, because a catch-all auth
middleware answers before routing. That 401 is therefore **not** evidence the
routes exist. They are verified by tests and typecheck, not by live HTTP.

## Verdict

**Provider regression: PASS**, with the authenticated provider smoke recorded as
an explicit credential-only gap.
