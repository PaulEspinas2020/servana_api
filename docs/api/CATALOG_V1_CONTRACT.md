# Servana catalog — the v1 contract

Category → Subcategory → Service, and the identity rules that make it
unambiguous. Written by hand because these are decisions; the endpoint list is
generated into [`CATALOG_ENDPOINT_REGISTRY.md`](CATALOG_ENDPOINT_REGISTRY.md)
and [`openapi.v1.json`](openapi.v1.json) from
[`src/api/v1/contract.ts`](../../src/api/v1/contract.ts).

General v1 rules — envelope, pagination, parity exemption, versioning — are in
[`API_V1_CONTRACT.md`](API_V1_CONTRACT.md).

---

## 1. The canonical model

```
catalog_categories  →  catalog_subcategories  →  services
   3 rows                  12 rows                 95 rows
```

**`services.id` is THE bookable Specific Service identity.** That is settled and
production-certified; nothing in this command reopens it.

`service_families` is **legacy coarse-family provenance only** — 10 rows,
retained because `employee_services`, `worker_service_applications`,
`service_options`, `branches` and coverage still key on those ids. It is not the
customer-bookable identity and must never become one again. Reversing that cost
a production outage once.

**The physical table names are not symmetrical**, and several older briefs get
this wrong:

| Concept | Table |
|---|---|
| Category | `catalog_categories` — *not* `categories` |
| Subcategory | `catalog_subcategories` — *not* `subcategories` |
| Service | `services` — renamed from `catalog_services` in Deploy 2 |

Only the third was renamed.

## 2. The identifier problem, and how v1 answers it

Four different things in this platform are called a "service id":

| Identifier | Means | Rows |
|---|---|---|
| `services.id` | canonical Specific Service | 95 |
| `service_families.id` | legacy coarse family | 10 |
| `service_options.id` | a legacy option, or an add-on | ≤ 231 |
| `catalog_subcategories.id` | Subcategory | 12 |

Three are small integers in overlapping ranges. And the collision is not
theoretical:

```
GET /api/services/:serviceId/level2            → service_families.id
GET /api/v1/catalog/services/:serviceId        → services.id
```

The integer `3` is meaningful to both, means a different thing to each, and
**neither errors**. A client that carries an id from one surface to the other
gets a confident wrong answer.

### The answer: qualified references

Every canonical catalog entity carries a `ref` beside its numeric `id`:

```jsonc
{ "ref": "service:180",     "id": 180,  "name": "Gluta Drip" }
{ "ref": "subcategory:7",   "id": 7,    "name": "Facial" }
{ "ref": "category:3",      "id": 3,    "name": "Personal Care" }
{ "ref": "addon:130",       "id": 130,  "name": "Vitamin C" }
```

`service:180` cannot be read as a family, an add-on or a subcategory.

**Use `ref`** as a cache key, in analytics, and to key any list mixing entity
types. **Use `id`** for path parameters — it stays authoritative and nothing
that reads the deployed contract has to change. `ref` is purely additive.

### Add-ons deserve their own note

`addons[].id` is a `service_options` id and is **not** a Service id. Today they
never collide numerically — a promoted `services.id` IS the id of a MAIN
`service_options` row, and add-ons are different rows of the same unique key —
but that is a property of how the migration ran, not a rule anything enforces.
New Services come from a sequence starting at 100000 precisely because somebody
noticed the risk. The `ref` removes the reliance on the accident.

### What no canonical endpoint does

- No `/api/v1` path resolves a `service_families.id`.
- No `/api/v1` path resolves a `service_options.id`.
- No canonical read queries `service_families` at all.
- `service_options` is touched in exactly one place — reading add-ons by
  `parent_option_id`.
- `legacy_service_option_id` is selected as a join key and **never projected**.

`tests/v1-catalog-contract.test.ts` asserts every one of those against the
contract and the source, not against this prose.

## 3. Level 1/2/3 is not the taxonomy

The legacy model called things `level_2` and `level_3`. Those names describe the
old `service_options` shape and are **not** exposed as the new taxonomy. A
canonical response has Categories, Subcategories and Services; it never has a
`level2` or `level3` field.

This is enforced, not merely intended: the global response-parity middleware
maps `name` → `level2`, and on the admin catalog it made a Service come back
claiming its own name as its Subcategory — a defect a production smoke found and
no unit test could. `/api/v1`, `/api/catalog` and `/api/admin/catalog` are all
exempt from that middleware, and a test fails if the exemption is removed.

## 4. Summaries and details

`GET /catalog` returns the whole tree in three statements — right for a cold
start, wrong for everything else. A category chooser needing three names should
not receive 95 services with prices and images.

| Need | Endpoint | Returns |
|---|---|---|
| Category chooser | `GET /catalog/categories` | summaries + counts, no children |
| One category | `GET /catalog/categories/:id` | summary + `available` |
| Its subcategories | `GET /catalog/categories/:id/subcategories` | summaries + counts |
| One subcategory | `GET /catalog/subcategories/:id` | summary + `available` |
| Its services | `GET /catalog/subcategories/:id/services` | full Service rows |
| One service | `GET /catalog/services/:id` | detail + inclusions, add-ons, `available` |
| Everything | `GET /catalog` | the whole tree |

## 5. Status, ordering and availability

`displayOrder`, `status` and `bookable` are returned consistently everywhere
they apply. An absent `bookable` reads as "not bookable" in most template
engines, which is why it is always present rather than omitted when true.

**Browse shows `active` only**, at all three levels. A Service under a
deactivated Subcategory is not listed — returning it would produce a result that
dead-ends.

**Detail is deliberately NOT status-filtered.** A deep link to an archived
Service, Category or Subcategory resolves and reports `available: false`. A 404
there is indistinguishable from a typo, and an old link landing on a dead end is
the worse outcome. `available` folds in every ancestor, so a Service under a
deactivated Category is unavailable whatever its own status says.

**Ordering is `display_order, name`.** The name tie-break is load-bearing:
every hierarchy row in production still has `display_order = 0` because reorder
has never been exercised, so ordering by `display_order` alone would hand the
customer an arbitrary insertion order that changes between deploys.

## 6. Timestamps

ISO 8601 with an explicit UTC designator, always.

Postgres emits `2026-08-11 11:03:23.421016+00` — a space where ISO wants `T`,
and a two-digit offset where ISO wants ±HH:MM. Repairing only the separator
returns `NaN` from `new Date()` and falls through to the raw value, so both
deviations are fixed together. A production smoke found this; the unit tests at
the time did not.

`lastUpdatedAt` on the summary is `MAX(services.updated_at)` and drives the
client's ETag. An admin edit moves it, which is precisely the event a cached
client must not miss.

## 7. Empty is not missing

A Subcategory with no visible Services, and a Category with no visible
Subcategories, are still returned by browse — the client needs the row to render
an empty state, and dropping it would make an empty Category indistinguishable
from a deleted one.

The child-list endpoints do the opposite and **404 on a missing parent** rather
than returning `[]`. Empty and missing are different facts, and a client
rendering "no subcategories yet" for a deleted id is showing a page that should
not exist.

## 8. What is never exposed publicly

`providerCount`, `catalog_provider_services` rows, `legacy_service_option_id`,
`legacy_service_family_id`, `archived_at`, admin audit fields and content-gap
analytics. A customer learns what they can book, never how thin supply is behind
it or how the catalog was migrated.

## 9. Hierarchy integrity

Six rules, in [`catalogIntegrityService.ts`](../../src/services/catalogIntegrityService.ts)
as pure functions over rows:

| Code | Severity | Catches |
|---|---|---|
| `ORPHAN_SUBCATEGORY` / `ORPHAN_SERVICE` | error | a parent id naming no row |
| `DUPLICATE_CATEGORY_SLUG` / `_SUBCATEGORY_SLUG` / `_SERVICE_SLUG` | error | slug collisions, **at the right scope** |
| `DANGLING_LEGACY_OPTION` | error | add-ons that would silently vanish |
| `DUPLICATE_SUBCATEGORY_NAME` | warning | a content error for a human |
| `VISIBLE_UNDER_HIDDEN` | warning | `active` under an inactive ancestor |
| `MISSING_TIMESTAMP` | warning | a NULL that contributes nothing to the ETag |

**Slug scope is not uniform** and the checks reflect that: category and service
slugs are global, subcategory slugs are unique **per category**. A single global
check would report legitimate pairs as duplicates; a single per-parent check
would miss real collisions.

Run it: `npm run catalog:integrity` (add `--json` for machine output). It exits
non-zero on any error-severity finding, so it can gate a deploy. Warnings do not
fail — an active Service under a deactivated Category is worth knowing and is
not a reason to refuse a release.

## 10. Adding a catalog endpoint

Same five steps as any v1 endpoint (`API_V1_CONTRACT.md` §10), plus:

- Every id parameter's `description` must name the table it resolves against.
  A test fails otherwise, and that test is the certification bar.
- Every entity you return must carry a `ref`.
- If it touches `service_families` or resolves a `service_options.id`, it is not
  a canonical catalog endpoint.
