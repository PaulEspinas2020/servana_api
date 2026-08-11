# CATALOG V2 — DEPLOY 2 REPORT

The canonical rename. `services.id` is now the Specific Service identity.

## What changed

| | Before | After |
|---|---|---|
| `services` | 10 legacy coarse families | **95 Specific Services — BOOKABLE** |
| `service_families` | compatibility view | **real table**, 10 legacy families |
| `catalog_services` | 95 Specific Services | renamed to `services` |

One transaction, run by the deployment under `admin`. No manual DDL.

## Why there was no window

The code running during the migration was Deploy 1's, which names `service_families`
for all 45 legacy-family reads and never names the physical `services` table. Inside
the transaction `service_families` stopped being a view and became a table with the
identical rows; PostgreSQL DDL is transactional, so no session saw the intermediate
state.

Verified before shipping, against production in a rolled-back transaction — the
running code's **own queries** were executed against the post-rename schema (§16),
not assumed compatible.

## Preservation — every §32 invariant

| Entity | Baseline | After | Δ |
|---|---:|---:|---|
| **Specific Services** | 95 | **95** | 0 |
| **Canonical provider capabilities** | 1,128 | **1,128** | 0 |
| Providers | 74 | **74** | 0 |
| Applications | 45 | **45** | 0 |
| Documents | 120 | **120** | 0 |
| Legacy families | 10 | **10** | 0 |
| Legacy links | 49 | **49** | 0 |
| Categories / Subcategories | 3 / 12 | **3 / 12** | 0 |

## Integrity

| Invariant | Result |
|---|---|
| Service → Subcategory → Category | **0 broken** |
| Capability → valid Service | **0 dangling** |
| Legacy link → valid family | **0 dangling** |
| Leftover compatibility view | **0** |
| Foreign keys following the rename | **7/7** |
| Table ownership | both `admin`, asserted in the migration |

## Production smoke

`/api/services`, `/api/services/full`, `/level2`, `/options-with-addons` and the bare
ServanaWorker route: **all 200**, customer contract keys intact. Provider and admin
routes 401 (auth-gated, routing healthy).

**Log check:** the error log's last write was 11:11:18; the process restarted at
11:51:13. Every `does not exist` entry predates Deploy 2 by forty minutes and belongs
to the earlier outage. **Zero errors since.**

## Tests

**2,890 passing across 153 suites**; `tsc` clean.

## Remaining

- `service_options.level_3` still carries the service name; the canonical name now
  lives in `services.name`. Deduplicating that is cleanup, not correctness.
- The Admin Catalog still presents the old structure — it reads
  `catalog_*`/`provider-catalog` routes, which are unchanged and working. **The Admin
  rebuild is deliberately not part of this cutover.**
- Provider capability is stored canonically but matching still reads
  `employee_services`. Switching it is the next behavioural change and needs its own
  before/after diff.

## Verdict

**CATALOG V2 DEPLOY 2 VERDICT: CERTIFIED**

`Category → Subcategory → Service` is the live hierarchy, `services.id` is the
canonical bookable identity, all 95 Specific Services are preserved, and no provider
record moved.
