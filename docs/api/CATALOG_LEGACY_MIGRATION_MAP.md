# Legacy catalog endpoint migration map

Every catalog-shaped route the app mounts, its canonical successor, and why it
still exists. The generated slice is in
[`CATALOG_ENDPOINT_REGISTRY.md`](CATALOG_ENDPOINT_REGISTRY.md); this file
carries the reasoning.

Caller legend: ✅ migrated · ⏳ still on the legacy route · · planned · — n/a

---

## The thing to understand first

**These are not renames.** The legacy catalog and the canonical catalog have
different inputs, different outputs and different tables. A migration map that
implied `/api/services/:serviceId/level2` simply became
`/api/v1/catalog/categories/:categoryId/subcategories` would be false in three
ways at once.

| | Legacy | Canonical |
|---|---|---|
| Taxonomy | `service_families` → `service_options.level_2` → `.level_3` | `catalog_categories` → `catalog_subcategories` → `services` |
| Identity | family id; option id | `services.id` |
| Subcategory | a **string** on an option row | a **row with an id** |
| Rows | 10 families, ≤231 options | 3 / 12 / 95 |

## Public reads

| Method | Legacy path | Disposition | Canonical | Cust Mob | Cust Web | Prov Mob |
|---|---|---|---|---|---|---|
| `GET` | `/api/services/full` | `CANONICALIZE` | `GET /api/v1/catalog` + `/search` | ⏳ | · | — |
| `GET` | `/api/services/:serviceId/level2` | `CANONICALIZE` | `GET /api/v1/catalog/categories/:categoryId/subcategories` | ⏳ | · | — |
| `GET` | `/api/services/:serviceId/options-with-addons` | `CANONICALIZE` | `GET /api/v1/catalog/subcategories/:subcategoryId/services` | · | · | · |
| `GET` | `/api/:serviceId/options-with-addons` | `ALIAS_TEMPORARILY` | same as above | · | · | ⏳ |
| `GET` | `/api/catalog`, `/catalog/summary`, `/catalog/services`, `/catalog/services/:id` | `ALIAS_TEMPORARILY` | the `/api/v1/catalog/*` twins | · | · | — |

### `/api/services/full`

The whole legacy catalog in one payload, which ServanaClient downloads and
searches **on the device**. It is the reason one absent `level2` key emptied the
search cache and every query rendered "No services match your search".

Retiring it needs the client to move to **two** things: `/api/v1/catalog` for
the tree and `/api/v1/search` for search. Moving only one leaves the other
broken.

### `/api/services/:serviceId/level2`

`:serviceId` is a **`service_families.id`**, and the route returns `DISTINCT
level_2` **strings with no ids at all**. The canonical route takes a
`catalog_categories.id` and returns identified Subcategories.

Different input, different output, different table. Calling it a rename would be
the single most misleading line this document could contain.

### The two options-with-addons routes

`/api/:serviceId/options-with-addons` is the **original, un-prefixed** form and
is what ServanaWorker calls in production. It is the only catalog route without
the `/services/` prefix its neighbours all use.

The customer app followed the convention rather than the exception, built
`/api/services/:id/options-with-addons`, and **404'd in production for months** —
while the client's own contract test asserted the unserved path, so the suite
certified the break as green. The prefixed alias was added to fix that; both now
exist and both must stay until ServanaWorker moves.

## Admin writes — untouched

| Path | Disposition |
|---|---|
| `POST /api/services`, `PUT /api/services/:serviceId` | `KEEP` |
| `POST /api/branches/slots`, `POST /api/services/:serviceId/coverage-geo` | `KEEP` |

Two admin families are kept in bulk rather than route by route. Their sizes are
counted from the mounted route tree, because a family grows every time somebody
adds an admin route and nobody comes back to this sentence to say so:

<!-- BEGIN GENERATED: catalog-admin-route-families -->
| Family | Routes mounted | Disposition |
|---|---|---|
| `/api/admin/provider-catalog/*` | 28 | `KEEP` |
| `/api/admin/catalog/*` | 20 | `KEEP` — already canonical |
<!-- END GENERATED: catalog-admin-route-families -->

The public canonical surface is **read-only** and must stay that way: §12's
server-side authorization is not satisfiable on an unauthenticated route.

### One admin route that is not a catalog migration problem but is a hazard

`DELETE /api/services/:serviceId/force` hard-deletes a legacy family, its
options and their meta in **three statements with no transaction**, no audit,
and no Catalog V2 awareness — deleting the options dangles the
`legacy_service_option_id` that canonical Services join add-ons through. It has
no caller in any of the five clients.

It is recorded as **BE-03** in the backend sweep and is out of scope here.
Flagged because a document about catalog identity that stayed silent about the
one route that can destroy catalog identity would be incomplete.

## Retirement criteria

Inherited from
[`legacyTelemetry.RETIREMENT_CRITERIA`](../../src/services/../api/v1/legacyTelemetry.ts),
so this list cannot drift from what is enforced:

1. Web-only alias: **14** consecutive days of zero recorded hits.
2. Mobile alias: **90** consecutive days — an unupdated app keeps calling the old
   path for as long as it stays installed.
3. Every client the matrix lists reads `migrated`.
4. The canonical successor is `implemented`, not `planned`.

<!-- BEGIN GENERATED: catalog-successor-status -->
All **6** canonical catalog successors are `implemented`, so criterion 4 is already met for every route above.
<!-- END GENERATED: catalog-successor-status -->

The others are blocked on a deploy: traffic
counting starts when the contract is serving, and **today every number is zero
because nothing is serving, which is not the same as nobody calling.**

Measure with `pm2 logs servana-prod | grep legacy-contract`.

## Retirement order

1. `/api/catalog*` — the four unversioned twins. Never deployed, no installed
   caller. Safe to drop as soon as the Client team confirms it has not started
   against them.
2. `/api/services/:serviceId/level2` — once the customer app moves to the
   canonical hierarchy.
3. `/api/services/full` — once the customer app moves to `/api/v1/catalog` **and**
   `/api/v1/search`.
4. `/api/:serviceId/options-with-addons` and its prefixed twin — last, gated on a
   ServanaWorker release plus 90 days.
