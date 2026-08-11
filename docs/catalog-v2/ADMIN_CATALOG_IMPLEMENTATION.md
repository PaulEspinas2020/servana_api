# ADMIN_CATALOG_IMPLEMENTATION

What was built, and the decisions that are not obvious from the code.

## Backend — `servana_api`, commit `4036243`

| File | Role |
|---|---|
| `src/services/catalogAdminService.ts` | All business rules. 1,124 lines. |
| `src/controllers/catalogAdminController.ts` | Shape/identity validation, safe error mapping. |
| `src/routes/catalogAdmin.routes.ts` | Routing + permissions. |
| `src/app.ts` | Mounts the router (additive). |
| `src/services/adminAuditService.ts` | +3 entity types on a union. |
| `tests/catalog-admin-contract.test.ts` | 42 contract tests. |

## Frontend — `servana_adminportal`, commit `43851c4`

| File | Role |
|---|---|
| `core/dto/admin-catalog-v2.dto.ts` | Canonical types, separate from the legacy DTOs. |
| `core/api/admin-catalog-v2-api.service.ts` | Canonical client. No delete method exists. |
| `pages/services/pages/catalog-browser/` | Three-pane browser + summary + gaps + search/filters. |
| `pages/services/pages/catalog-service-page/` | `/portal/services/:serviceId`. |
| `components/catalog-taxonomy-dialog/` | Category + Subcategory create/edit/move. |
| `components/catalog-service-dialog/` | Service create/edit/move. |
| `services.routes.ts` | Canonical routes + legacy redirects. |

## Decisions worth recording

**Two DTO files, not one.** An id in `admin-catalog-v2.dto.ts` is a `services.id`;
an id in `admin-catalog.dto.ts` is a `service_options.id`. Merging them would put
two different entities behind one type name, which is the exact ambiguity the
migration existed to remove.

**Permissions reuse existing keys.** Adding `catalog.category.create` and friends
would have been cleaner naming and would have 403'd the three regular admins out
of the catalog the moment it shipped, because nobody holds a key that did not
exist yesterday.

**The existing `SpecificServiceEditorComponent` was left alone.** A parallel
session had just collapsed three competing service editors into it. It edits by
`serviceOptionId` on the legacy surface; the canonical dialog edits by
`services.id`. Both exist during cutover — but the legacy one is reached only
from the legacy Specific Services tab, not from the new catalog, so there is no
screen offering two ways to edit the same thing.

**Move is a field, not a flow.** Changing a Subcategory's Category, or a
Service's Subcategory, is an ordinary `PATCH`. Both dialogs state that ids and
provider approvals are preserved, because "will this break my services?" is what
stops admins reorganising a catalog.

**The 8-step wizard stays routable.** It builds provider-facing *offerings*,
which is a different job from creating a Service. It is no longer reachable from
ordinary catalog management (§37, §51), and `new-service` — the link that used to
open it — now goes to the canonical create form.

**Force delete needed no removal.** Measured: the portal contained no call to
`/services/:id/force` and no hard-delete control at all. The only `force*`
symbols are `forceOffline` on provider availability. §49 was already satisfied;
the new API adds no destructive route, and a test pins that the client exposes
none.

## Two corrections the database forced

**The brief's §0 named the wrong tables.** The canonical tables are
`catalog_categories` and `catalog_subcategories`; only `catalog_services` was
renamed to `services` in Deploy 2. Two of three names were wrong. Also
`provider_documents` does not exist — documents live in `worker_requirements`.

**`slug` is `NOT NULL` with no default, and its uniqueness is not uniform.**
Category and service slugs are globally unique; subcategory slugs are unique per
category. So a subcategory *move* must re-derive its slug against the
destination even when the name has not changed. Nothing had ever written these
tables, so no code generated a slug at all.

`display_order` is 0 on all 15 hierarchy rows in production — reorder has never
been exercised — so every ordering tie-breaks on name.

## Three defects found and fixed during the build

1. **A semantic guard failed** on the first content-gaps query: it put the legacy
   `category` column in the same statement as `FROM services`. Fixed in the
   implementation by splitting into two reads (§58 — never weaken the guard).
2. **Duplicate `class` attributes.** Angular rejects a static `class` alongside
   `[class.x]` on the same element. Pane visibility is one computed string.
3. **`as` aliasing does not resolve inside `@else if`** in Angular 18 — `s` was
   undefined through the entire body of the Service page. Split into two
   independent `@if` blocks.

And one in the test rather than the product: the first MOBILEVIEW run failed
three overlay assertions because a `position: fixed` element lays out against the
real browser viewport, not the resized test host. Measuring one reports Karma's
window width — a false failure that, left as a passing exclusion, would have been
a false pass dressed as a real one.

## Gates

| Gate | Result |
|---|---|
| Backend `tsc --noEmit` | clean |
| Backend `jest --ci` | **2,964 / 155 suites PASS** |
| Semantic guards | **31 / 31 PASS** |
| Portal `tsc --noEmit` | clean |
| Portal `eslint` | **0 errors** (559 pre-existing warnings) |
| Portal specs | **1,163 PASS** |
| Portal production build | succeeds |
| `guard:protected-integrations` | clean |
