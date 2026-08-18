# CATALOG_V2_PRE_CUTOVER_SNAPSHOT

Phase A preflight. Every number read live from the production database immediately
before cutover — **not** carried over from an earlier measurement, per §27/§28.

## The baseline moved, and that is the point of this step

| Entity | Earlier measurement | **Live now** | Verdict |
|---|---:|---:|---|
| Categories | 3 | **3** | unchanged |
| Subcategories | 12 | **12** | unchanged |
| **Specific Services (canonical)** | 95 | **95** | unchanged |
| Legacy Level-3 rows | 95 | **95** | unchanged |
| **Canonical provider capabilities** | 1,128 | **1,128** | unchanged |
| Service applications | 45 | **45** | unchanged |
| Provider documents | 120 | **120** | unchanged |
| Providers | 74 | **74** | unchanged |
| Legacy service families | 19 | **10** | **−9 — investigated** |
| Legacy `employee_services` links | 105 | **49** | **−56 — investigated** |

Had I used the remembered 105/19 as the gate, cutover would have aborted on a false
P0. Had I forced the counts back, I would have resurrected junk.

## Investigation of the −9 / −56 delta

The 9 removed families were **exactly the junk-named ones** flagged in
`CATALOG_CURRENT_STATE.md` — `sadas`, `sdsd`, `sdsa`, `dsad`, `test193`, `dasdasd`,
`Service 01`, `Service 0156`, `Computer  Repair` — carrying the junk category
strings `Test Category`, `sdasd`, `sdsds`, `sda`, `sadgbjsadha`, `sdada`,
`Home Servicessfdsd`.

**Every one of them had zero bookable services**, so the 56 provider links attached
to them granted no real capability.

Proof that no provider lost anything real:

| Check | Result |
|---|---|
| Canonical provider capabilities | **1,128 — unchanged** |
| Providers holding canonical capability | 19 |
| Dangling legacy links (pointing at a deleted family) | **0** |
| Specific services | **95 — unchanged** |
| Applications / documents | **45 / 120 — unchanged** |

**Conclusion: legitimate cleanup, not data loss.** It is precisely the §31 junk
exclusion, applied at source. The new baseline is adopted: **10 families, 49 legacy
links.** No count is forced back.

## Remaining families

| Family | Category | Bookable services | Legacy links |
|---|---|---:|---:|
| Beauty & Wellness | Personal Care | 54 | 12 |
| Aircon 2 | Home Services | 30 | 14 |
| Massage | Personal Care | 10 | 6 |
| Electrical Services | Home Maintenance | 1 | 0 |
| Hair | Personal Care | 0 | 6 |
| Nails | Personal Care | 0 | 6 |
| Plumbing | Home Maintenance | 0 | 2 |
| Aesthetics & Beauty | Beauty & Wellness | 0 | 1 |
| Barbering | Beauty & Wellness | 0 | 1 |
| Carpentry | Home Maintenance | 0 | 1 |

Six families still hold **17 provider links but no bookable service**. Those
providers hold an approval that grants nothing — flagged for review, not touched.

## Integrity invariants — §88

| Invariant | Result |
|---|---|
| Service → exactly one valid Subcategory → Category | **0 broken** |
| Canonical capability → valid Specific Service | **0 orphans** |
| Legacy link → valid family | **0 dangling** |

## Ownership gate — §22 / §23

**All 120 tables in `servana` are owned by `admin`**, the deploy and runtime role.
The four `catalog_*` tables were transferred after the outage. The gate passes.

The outage was caused by creating objects as `postgres`; that condition no longer
exists and must be asserted in CI before any future catalog migration.

## Cutover status

**Not started.** Phase A only. The rename is deliberately NOT repeated as a
DB-first operation — see `CATALOG_V2_CUTOVER_PLAN.md`.
