# Catalog Endpoint Registry

> GENERATED from `src/api/v1/contract.ts` by `npm run api:docs`. Do not edit by hand.

**11 canonical catalog and search endpoints.** All public, all read-only.

Mutation lives on `/api/admin/catalog/*` behind `verifyAuth → verifyRoles([1]) →
requirePermission`. There is no write handler on the public surface and there must not be —
server-side authorization is not satisfiable on an unauthenticated route.

## Endpoints

| Method | Path | Response | Errors |
|---|---|---|---|
| `GET` | `/api/v1/catalog` | `CatalogTree` | `INTERNAL` |
| `GET` | `/api/v1/catalog/summary` | `CatalogSummary` | `INTERNAL` |
| `GET` | `/api/v1/catalog/services` | `CatalogServiceList` | `INTERNAL` |
| `GET` | `/api/v1/catalog/services/:serviceId` | `CatalogServiceDetail` | `CATALOG_SERVICE_NOT_FOUND`, `INTERNAL`, `VALIDATION_FAILED` |
| `GET` | `/api/v1/search` | `SearchResults` | `INTERNAL`, `VALIDATION_FAILED` |
| `GET` | `/api/v1/catalog/search` | `SearchResults` | `INTERNAL`, `VALIDATION_FAILED` |
| `GET` | `/api/v1/catalog/categories` | `CategorySummaryList` | `INTERNAL` |
| `GET` | `/api/v1/catalog/categories/:categoryId` | `CategoryDetail` | `CATALOG_CATEGORY_NOT_FOUND`, `INTERNAL`, `VALIDATION_FAILED` |
| `GET` | `/api/v1/catalog/categories/:categoryId/subcategories` | `SubcategorySummaryList` | `CATALOG_CATEGORY_NOT_FOUND`, `INTERNAL`, `VALIDATION_FAILED` |
| `GET` | `/api/v1/catalog/subcategories/:subcategoryId` | `SubcategoryDetail` | `CATALOG_SUBCATEGORY_NOT_FOUND`, `INTERNAL`, `VALIDATION_FAILED` |
| `GET` | `/api/v1/catalog/subcategories/:subcategoryId/services` | `CatalogServiceList` | `CATALOG_SUBCATEGORY_NOT_FOUND`, `INTERNAL`, `VALIDATION_FAILED` |

## What every path parameter resolves against

This is the table that matters. `GET /api/services/:serviceId/level2` resolves its
parameter against `service_families.id`; `GET /api/v1/catalog/services/:serviceId`
resolves the same-named parameter against `services.id`. The integer `3` is meaningful
to both and means different things to each.

| Endpoint | Parameter | Resolves against |
|---|---|---|
| `/api/v1/catalog/services/:serviceId` | `serviceId` | `services.id` — the canonical Specific Service (95 rows) |
| `/api/v1/catalog/categories/:categoryId` | `categoryId` | `catalog_categories.id` (3 rows) |
| `/api/v1/catalog/categories/:categoryId/subcategories` | `categoryId` | `catalog_categories.id` (3 rows) |
| `/api/v1/catalog/subcategories/:subcategoryId` | `subcategoryId` | `catalog_subcategories.id` (12 rows) |
| `/api/v1/catalog/subcategories/:subcategoryId/services` | `subcategoryId` | `catalog_subcategories.id` (12 rows) |

**No canonical endpoint accepts a `service_families.id` or a `service_options.id`.**
`tests/v1-catalog-contract.test.ts` asserts it against the contract, not against prose.

## Domain services

| Endpoint | Delegates to |
|---|---|
| `GET /api/v1/catalog` | `services/catalogPublicService.getPublicCatalog + getPublicCatalogSummary` |
| `GET /api/v1/catalog/summary` | `services/catalogPublicService.getPublicCatalogSummary` |
| `GET /api/v1/catalog/services` | `services/catalogPublicService.listPublicServices` |
| `GET /api/v1/catalog/services/:serviceId` | `services/catalogPublicService.getServiceDetail` |
| `GET /api/v1/search` | `services/catalogSearchService.searchCatalog` |
| `GET /api/v1/catalog/search` | `services/catalogSearchService.searchCatalog` |
| `GET /api/v1/catalog/categories` | `services/catalogPublicService.listCategories` |
| `GET /api/v1/catalog/categories/:categoryId` | `services/catalogPublicService.getCategory` |
| `GET /api/v1/catalog/categories/:categoryId/subcategories` | `services/catalogPublicService.listSubcategoriesOfCategory` |
| `GET /api/v1/catalog/subcategories/:subcategoryId` | `services/catalogPublicService.getSubcategory` |
| `GET /api/v1/catalog/subcategories/:subcategoryId/services` | `services/catalogPublicService.listServicesOfSubcategory` |

## Caller matrix

| Endpoint | Cust Mobile | Cust Web | Prov Mobile | Prov Web | Admin |
|---|---|---|---|---|---|
| `/api/v1/catalog` | · | · | — | — | — |
| `/api/v1/catalog/summary` | · | · | — | — | — |
| `/api/v1/catalog/services` | · | · | — | — | — |
| `/api/v1/catalog/services/:serviceId` | · | · | — | — | — |
| `/api/v1/search` | ⏳ | · | — | — | — |
| `/api/v1/catalog/search` | · | · | — | — | — |
| `/api/v1/catalog/categories` | · | · | — | — | — |
| `/api/v1/catalog/categories/:categoryId` | · | · | — | — | — |
| `/api/v1/catalog/categories/:categoryId/subcategories` | ⏳ | · | — | — | — |
| `/api/v1/catalog/subcategories/:subcategoryId` | · | · | — | — | — |
| `/api/v1/catalog/subcategories/:subcategoryId/services` | · | · | ⏳ | — | — |

Legend: ✅ migrated · ⏳ still on a legacy route · · planned · — not applicable.

## Legacy catalog routes this replaces

| Method | Legacy path | Disposition | Canonical |
|---|---|---|---|
| `GET` | `/api/catalog` | `ALIAS_TEMPORARILY` | `/api/v1/catalog` |
| `GET` | `/api/services/full` | `CANONICALIZE` | `/api/v1/catalog` |
| `GET` | `/api/catalog/summary` | `ALIAS_TEMPORARILY` | `/api/v1/catalog/summary` |
| `GET` | `/api/catalog/services` | `ALIAS_TEMPORARILY` | `/api/v1/catalog/services` |
| `GET` | `/api/catalog/services/:serviceId` | `ALIAS_TEMPORARILY` | `/api/v1/catalog/services/:serviceId` |
| `GET` | `/api/services/full` | `CANONICALIZE` | `/api/v1/search` |
| `GET` | `/api/services/:serviceId/level2` | `CANONICALIZE` | `/api/v1/catalog/categories/:categoryId/subcategories` |
| `GET` | `/api/services/:serviceId/options-with-addons` | `CANONICALIZE` | `/api/v1/catalog/subcategories/:subcategoryId/services` |
| `GET` | `/api/:serviceId/options-with-addons` | `ALIAS_TEMPORARILY` | `/api/v1/catalog/subcategories/:subcategoryId/services` |

Full reasoning per route: [`CATALOG_LEGACY_MIGRATION_MAP.md`](CATALOG_LEGACY_MIGRATION_MAP.md).
