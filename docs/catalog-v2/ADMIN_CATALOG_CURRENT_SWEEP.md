# ADMIN_CATALOG_CURRENT_SWEEP

Step A + §20 sweep, run 2026-08-11 against the live branch and the production
database. Every number here was measured, not carried forward.

## Step A — drift check (all green)

| Gate | Result |
|---|---|
| `tests/catalog-semantic-guards.test.ts` | **31 / 31 PASS** |
| `npm run verify` (tsc + jest) | **tsc clean · 2,921 tests / 154 suites PASS** |
| Backend HEAD | `2109829` (main, clean tree) |
| Admin portal HEAD | `1e2d0d2` (main, clean tree) |

### Preservation baseline — live production

| Entity | Handoff | **Measured now** | Verdict |
|---|---:|---:|---|
| Categories | 3 | **3** | unchanged |
| Subcategories | 12 | **12** | unchanged |
| Services (canonical) | 95 | **95** | unchanged |
| Legacy service families | 10 | **10** | unchanged |
| Canonical provider capabilities | 1,128 | **1,128** | unchanged |
| Legacy provider links | 49 | **49** | unchanged |
| Applications | 45 | **45** | unchanged |
| Documents | 120 | **120** | unchanged |
| Broken hierarchy / dangling caps / dangling legacy | 0/0/0 | **0 / 0 / 0** | unchanged |

**No drift.** The handoff state is accurate.

## Deltas against the command's §0

Two corrections, both legitimate and both affecting implementation:

1. **The canonical tables are `catalog_categories` and `catalog_subcategories`,
   not bare `categories` / `subcategories`.** Only `catalog_services` was renamed
   to `services` in Deploy 2. §0's physical-entity list was wrong on two of three
   names. The API is built against the real names.
2. **Documents live in `worker_requirements`**, not `provider_documents` — that
   table does not exist. The count (120) matches regardless.

## Canonical schema — measured from `information_schema`

`catalog_categories` — `id` (seq), `name`, `slug` NOT NULL, `description`,
`icon_key`, `image_url`, `display_order` NOT NULL d0, `status` NOT NULL d`active`,
`legacy_category_text`, `created_at`, `updated_at`, `archived_at`.

`catalog_subcategories` — as above plus `category_id` NOT NULL,
`legacy_service_family_id`, `legacy_level_2`.

`services` — `id` default **`nextval('catalog_services_id_seq')`** (the §3 fix is
in place and verified), `subcategory_id` NOT NULL, `name`, `slug` NOT NULL,
`short_description`, `full_description`, `image_url`, `base_price` numeric,
`unit`, `estimated_duration_mins`, `display_order`, `bookable` NOT NULL d`true`,
`status` NOT NULL d`active`, `legacy_service_option_id`, `legacy_service_family_id`,
timestamps, `archived_at`.

`catalog_provider_services` — `provider_uid` **text** (canonical §7 identity),
`service_id`, `status`, `legacy_service_family_id`, `source`.

Two implementation consequences:
- `slug` is NOT NULL with no default on all three tables → every create path must
  generate and uniqueness-check a slug. Nothing in the codebase did this before.
- `display_order` is **0 for all 15 hierarchy rows today** — reorder has never
  been exercised. Ordering must therefore tie-break by name, or the UI order is
  arbitrary.

## Backend — what exists

| Path | Reads | Verdict |
|---|---|---|
| `/api/services`, `/services/full`, `/:id/level2`, `/:id/options-with-addons` | `service_families` + `service_options` | **LEGACY_PROVIDER_COMPATIBILITY** — live clients depend on it, do not touch (§18/§19) |
| `/api/admin/provider-catalog/*` (`providerCatalog.routes.ts`, 2,529 LOC) | `provider_catalog_offerings`, `service_options` | Legacy admin surface — offering/mapping/level-2/level-3 model |
| **`catalog_categories`, `catalog_subcategories`, `services`** | — | **Zero readers. The canonical API is greenfield.** |

`DELETE /api/services/:serviceId/force` → `forceDeleteService` exists and operates
on **`service_families`** (legacy), not canonical services.

### Permission mapping — reuse only, no new keys

Adding new permission keys would 403 the three regular admins who hold only
`services.view / .specific.create / .specific.edit / .specific.archive`. The
canonical API therefore reuses existing keys:

| Operation | Permission |
|---|---|
| Any catalog read | `services.view` / `services.details.view` |
| Category + Subcategory create | `services.offering.create` |
| Category + Subcategory edit / move / reorder | `services.offering.edit` |
| Category + Subcategory status / archive | `services.offering.archive` |
| Service create | `services.specific.create` |
| Service edit / move / reorder | `services.specific.edit` |
| Service status / archive | `services.specific.archive` |

## Admin frontend — what exists (§21 classification)

The portal moved **4 commits past** the `ac1d7a9` recorded in memory; a parallel
session has been editing this exact area. Notably `1e2d0d2` already collapsed
three competing service editors into one `SpecificServiceEditorComponent`
(name / description / price / picture) shared by the list and the workspace tab.

| Component | LOC | Class | Note |
|---|---:|---|---|
| `specific-service-editor` | 302+222 | **KEEP / REFACTOR** | Already the single editor. Repoint from `serviceOptionId` to canonical `services.id`. Do **not** build a third editor. |
| `specific-services-list` | 446+622 | **REFACTOR** | Becomes the All-Services flat view (§29). |
| `services-catalog` | 187+505 | **REPLACE** | Offering-grid landing → three-pane catalog browser. |
| `services-tabs-page` | 63+54 | **REFACTOR** | Tab host; catalog tab repointed. |
| `service-detail-workspace` | 546+1,238 | **REFACTOR** | 8-tab offering workspace. Offering-grain, not service-grain. |
| `create-service-wizard` | 459+718 | **REMOVE from normal flow** | The 8-step whole-tree offering builder (§37/§40). |
| `admin-catalog-api.service` | 228 | **KEEP + EXTEND** | Add canonical methods alongside legacy ones. |

### Force delete — already absent

**Measured: the Admin portal contains no call to `/services/:id/force` and no
hard-delete control anywhere.** The only `force*` symbols are `forceOffline` /
`forceOfflineReason` on provider availability, which is unrelated. §49 requires no
removal work on the frontend; the backend route stays as an emergency-only path
that no normal UI reaches.

### Legacy routes — already redirecting

`services.routes.ts` already maps `update-service/:id` and `service-details/:id`
to the catalog root. §50 is partially satisfied; the remaining work is to route a
known id to its canonical service page rather than dropping to the root.

## Product decision held out of scope

The six legacy families with provider intent and no bookable service (Nails, Hair,
Plumbing, Aesthetics & Beauty, Barbering, Carpentry — 17 links, 8 providers) are a
**product decision, not a build task**. This phase surfaces them in the §47 gap
panel and changes none of them.

`DATABASE BASELINE CAPTURE` remains queued and out of scope (§92/§93).
