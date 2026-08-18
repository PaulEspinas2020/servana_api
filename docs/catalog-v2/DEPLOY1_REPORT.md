# CATALOG V2 — DEPLOY 1 REPORT

Consolidates the §31 deliverables for Deploy 1: preflight, repoint classification,
test, smoke, data integrity and Deploy 2 readiness.

## What Deploy 1 did

Introduced the **name** `service_families` as a view over the legacy families table,
and repointed the backend's legacy-family queries at it. **Nothing was renamed. No
row changed. No semantics changed.**

Migration `023-catalog-v2-service-families-view.sql`, run by the deployment under
`admin`. No manual production DDL (§20).

## Preflight vs after — §24

| Entity | Preflight | After | Δ |
|---|---:|---:|---|
| Categories | 3 | **3** | 0 |
| Subcategories | 12 | **12** | 0 |
| **Specific Services** | 95 | **95** | 0 |
| **Canonical provider capabilities** | 1,128 | **1,128** | 0 |
| Providers | 74 | **74** | 0 |
| Applications | 45 | **45** | 0 |
| Documents | 120 | **120** | 0 |
| Legacy families | 10 | **10** | 0 |
| Legacy links | 49 | **49** | 0 |

Every §32 preservation invariant holds. **No differences to explain.**

## Integrity — §25 / §26

| Invariant | Result |
|---|---|
| Broken hierarchy chains | **0** |
| Dangling canonical capabilities | **0** |
| Dangling legacy links | **0** |
| View rows vs table rows | **10 = 10**, 0 differing either direction (EXCEPT both ways) |

## Repoint classification — §6

All 46 `${dbSchema}.services` references were classified before any edit. **All 46
are `LEGACY_FAMILY_QUERY`** — each joins a `service_id` originating from
`service_options`, `employee_services`, `worker_service_applications`, offering
mappings or `employee_catalog_capabilities`, all of which key on the family id.
**Zero `CANONICAL_SPECIFIC_SERVICE_QUERY` were touched**; those live in
`catalog_services` and were not modified.

**45 repointed. 1 deliberately not:**

`serviceApplicationService.ts` declares
`service_id INT NOT NULL REFERENCES ${dbSchema}.services(id)` inside a lazy
`CREATE TABLE IF NOT EXISTS`. **A FOREIGN KEY cannot reference a VIEW.** Harmless
today because the table exists so the DDL is skipped — but on a fresh database it
would bind to the wrong table once Deploy 2 renames `services`. Documented in place.

## Compatibility — §16 / §17

| Combination | Result |
|---|---|
| **OLD code + Deploy 1 schema** | ✅ the exact query the running code issues executes unchanged; `services` untouched |
| **NEW code + Deploy 1 schema** | ✅ 2,890 tests, live smoke green |

The view is **auto-updatable** (`is_insertable_into` YES, `is_updatable` YES), so the
legacy `createService` / `updateFullService` / `hardDeleteService` write paths work
through it without change.

## Tests — §18

**2,890 passing across 153 suites**; `tsc` clean. One suite pinned the literal
`'services s'` and was updated to `'service_families s'`; every behavioural
assertion in it (LEFT not INNER, correct FK, matching aliases) is unchanged.

## Production smoke — §22

| Endpoint | Status |
|---|---|
| `/api/services` | **200** |
| `/api/services/full` | **200** (contract keys intact) |
| `/api/services/1/level2` | **200** |
| `/api/services/1/options-with-addons` | **200** |
| `/api/1/options-with-addons` (bare, ServanaWorker) | **200** |
| `/api/worker/services`, `/api/worker/service-applications` | 401 — auth-gated, routing healthy |
| `/api/admin/provider-catalog/specific-services` | 401 — same |

## Log monitoring — §27

**0 occurrences** of `column s.category does not exist`, `permission denied`, or
`relation ... does not exist` since deploy.

## Not done

- §23 automated ownership assertion in CI — gate verified manually this deploy.
- §83 authenticated provider smoke — needs a controlled provider credential; the
  provider routes were verified reachable (401) but not exercised signed-in.
- §28 observation window under real provider traffic — **not yet elapsed.**

## Verdict

**CATALOG V2 DEPLOY 1 VERDICT: CERTIFIED_WITH_NONBLOCKING_GAPS**

Certified: every preservation invariant holds, both compatibility directions pass,
the deployment is green and production is healthy. The gaps are the CI ownership
assertion, the authenticated provider smoke, and the observation window — none of
which affect the correctness of what shipped, and the last of which is a matter of
elapsed time.

**Deploy 2 is NOT started.** No view dropped, no table renamed.
