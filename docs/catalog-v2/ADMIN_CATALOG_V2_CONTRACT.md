# ADMIN_CATALOG_V2_CONTRACT

The canonical Admin Catalog API. Mounted under `/api`, so every path below is
prefixed `/api`.

All responses use the portal's standard envelope: `{ "status": "success", "data": … }`
on success, `{ "status": "failed", "message": …, "code"?: … }` on failure.

## Why this is not `/api/services`

`/api/services*` is a **LEGACY_PROVIDER_COMPATIBILITY** projection over
`service_families` + `service_options`, consumed by live provider and customer
clients. Its shape is load-bearing and does not move in this phase (§4, §18, §19).

The physical table named `services` is the canonical Specific Service; the HTTP
route named `/services` is not. That mismatch is temporary and deliberate.

**Removal criteria for the legacy projection:** it can retire only once
ServanaClient and ServanaWorker have both shipped releases reading the canonical
endpoints, and no build older than those releases remains in the field. That is
the Client App migration phase, not this one.

## Authorization

Every route: `verifyAuth` → `verifyRoles([1])` → `requirePermission(...)`.
Enforced server-side; hiding a control in the portal is not authorization (§12, §80).

Permissions **reuse existing `services.*` keys**. New keys would be unheld by the
three regular admins in production and would 403 them out of the catalog on day
one.

| Operation | Permission |
|---|---|
| Any read | `services.view` |
| Detail read | `services.details.view` |
| Category / Subcategory create | `services.offering.create` |
| Category / Subcategory edit, move, reorder | `services.offering.edit` |
| Category / Subcategory status, archive | `services.offering.archive` |
| Service create | `services.specific.create` |
| Service edit, move, reorder | `services.specific.edit` |
| Service status, archive | `services.specific.archive` |

## Routes

### Hierarchy

```
GET /admin/catalog?includeArchived=false
```
→ `{ categories: Category[], summary: Summary }`

One request for the entire browser. Three SQL statements regardless of catalog
size; provider counts arrive aggregated (§78).

```
GET /admin/catalog/summary
GET /admin/catalog/content-gaps
```

### Categories

```
GET    /admin/catalog/categories?includeArchived=false
POST   /admin/catalog/categories
POST   /admin/catalog/categories/reorder
PATCH  /admin/catalog/categories/:categoryId
PATCH  /admin/catalog/categories/:categoryId/status
```

### Subcategories

```
GET    /admin/catalog/subcategories?categoryId=&includeArchived=false
POST   /admin/catalog/subcategories
POST   /admin/catalog/subcategories/reorder
PATCH  /admin/catalog/subcategories/:subcategoryId          ← MOVE when categoryId changes
PATCH  /admin/catalog/subcategories/:subcategoryId/status
```

### Services

```
GET    /admin/catalog/services?search=&categoryId=&subcategoryId=&status=&bookable=
                              &coverage=&includeArchived=&sortBy=&sortOrder=&page=&limit=
POST   /admin/catalog/services
POST   /admin/catalog/services/reorder
GET    /admin/catalog/services/:serviceId
GET    /admin/catalog/services/:serviceId/providers
PATCH  /admin/catalog/services/:serviceId                   ← MOVE when subcategoryId changes
PATCH  /admin/catalog/services/:serviceId/status            ← activate / deactivate / archive
```

**There is no DELETE on this router.** Ordinary catalog management archives (§48).

Route ordering is load-bearing: `/reorder` is declared before `/:id`, or Express
binds `"reorder"` as the id and the handler 400s on `NaN` — the trap
`filter-options` hit on the legacy catalog routes.

## Projections

`ServiceSummary` — `id`, `subcategoryId`, `subcategoryName`, `categoryId`,
`categoryName`, `name`, `slug`, `status`, `displayOrder`, `bookable`,
`providerCount`, `basePrice`, `unit`, `basePriceSummary`, `updatedAt`.

`ServiceDetail` — the above plus `shortDescription`, `fullDescription`,
`imageUrl`, `estimatedDurationMins`, `archivedAt`, `createdAt`,
`legacyServiceOptionId`, `legacyServiceFamilyId` (provenance only).

`Coverage` — `serviceId`, `approvedCount`, `totalCount`, `coverageStatus`,
`providers[]` of `{ providerUid, name, status, source, grantedAt }`. Nothing
else: no documents, application notes or profile fields (§82).

The hierarchy read deliberately excludes provider records, service options,
add-ons, questions, audit events and long-form copy (§7).

## Invariants this API guarantees

| Rule | Guarantee |
|---|---|
| §14 | Create omits the `id` column entirely; `services.id` comes from `catalog_services_id_seq`. A body carrying `id` is rejected `400 CLIENT_SUPPLIED_ID`. |
| §15 | Edit is `UPDATE … WHERE id = $1`. There is no delete-and-recreate path. |
| §16 | Move changes `subcategory_id` only; `catalog_provider_services` is never written. |
| §11 | Subcategory move preserves its id and every descendant `services.id`. |
| §13 | A Category contradicting the Subcategory is rejected `400 HIERARCHY_MISMATCH`. |
| §17 | Archive is `status='archived'` + `archived_at`; the row and its capabilities remain. |
| §9 | Normalised duplicate names rejected `409 DUPLICATE_NAME`; archived rows do not block reuse. |
| §19 | Every multi-table write runs in one transaction with `FOR UPDATE` on the target row. |
| §21 | Errors are safe domain messages. Non-4xx faults become a generic 500. |
| §15 | Audit fires on every mutation with actor, entity, before and after. |

## Status domain

`draft` · `active` · `inactive` · `archived` — matching the CHECK constraint on
all three tables. Provider capability status is a separate domain:
`active` · `paused` · `archived`.

## Slug generation

`slug` is `NOT NULL` with no default on all three tables and nothing wrote them
before, so every create derives one. Uniqueness is **not uniform**:

| Table | Constraint |
|---|---|
| `catalog_categories` | `UNIQUE (slug)` — global |
| `catalog_subcategories` | `UNIQUE (category_id, slug)` — per category |
| `services` | `UNIQUE (slug)` — global |

A subcategory move must therefore re-derive its slug against the destination
category even when the name has not changed. Collisions are suffixed `-2`, `-3`
rather than surfacing a constraint error the admin cannot act on.
