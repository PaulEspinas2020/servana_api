# ADMIN_CATALOG_PRESERVATION

§55–§57. Row-level, not count-level — the earlier gap this closes is that equal
counts can hide a swapped id.

## Method

Snapshots taken from the live production database before implementation and
again after, and compared with `diff`, not by comparing totals.

| Snapshot | Columns | Rows |
|---|---|---:|
| `services_before/after` | `id, name, subcategory_id, status, display_order, bookable` | 95 |
| `capabilities_before/after` | `provider_uid, service_id, status` | 1,128 |
| `hierarchy_before` | categories + subcategories with `id, name, parent, status, order` | 3 + 12 |

## Result

```
diff services_before.txt services_after.txt      → IDENTICAL (95 rows)
diff capabilities_before.txt capabilities_after.txt → IDENTICAL (1,128 rows)
```

**Zero delta. Not one id, name, placement, status, order or bookable flag moved,
and not one (provider_uid, service_id) pair changed.**

That is the expected result and the reason it is worth stating: this phase adds
a new API and a new Admin surface. It runs no migration, and the canonical
endpoints are not yet deployed, so production data could not have changed. The
diff is what turns "could not have" into "did not".

## Counts, for completeness

| Entity | Before | After |
|---|---:|---:|
| Categories | 3 | 3 |
| Subcategories | 12 | 12 |
| Services | 95 | 95 |
| Legacy service families | 10 | 10 |
| Canonical provider capabilities | 1,128 | 1,128 |
| Legacy provider links | 49 | 49 |
| Applications | 45 | 45 |
| Documents (`worker_requirements`) | 120 | 120 |

## Integrity

| Invariant | Result |
|---|---:|
| Service → valid Subcategory → valid Category | **0 broken** |
| Canonical capability → valid `services.id` | **0 dangling** |
| `employee_services` → valid `service_families.id` | **0 dangling** |
| `worker_service_applications` → valid `service_families.id` | **0 dangling** |
| Service with more than one subcategory | **0** |
| `catalog_services_id_seq.last_value >= MAX(services.id)` | **true** — the §3 fix holds |

## Applications and documents

Untouched by design. Nothing in the canonical Admin API reads or writes
`worker_service_applications` or `worker_requirements`; the only reference to
applications anywhere in this phase is the read-only content-gap report, which
counts `employee_services` links and writes nothing.

Historical family-level applications keep their original meaning (§54). Canonical
provider capability remains a separate record and is never derived from them.

## What is NOT proven here

The API is verified by 42 contract tests, typecheck and the semantic guards, and
by construction it cannot write these tables outside the paths those tests
cover. It has **not** been exercised against production, because it is not
deployed. A post-deploy re-run of these same two diffs is the remaining
verification, and it should be run before and after the first real Admin write.
