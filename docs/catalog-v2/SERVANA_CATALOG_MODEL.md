# SERVANA_CATALOG_MODEL

The canonical Servana catalog architecture, and the plan to get there from the
current state measured in `CATALOG_CURRENT_STATE.md`.

---

## The model

```
CATEGORY            broad customer need          e.g. Air Conditioning
  └── SUBCATEGORY   service family               e.g. AC Cleaning
        └── SERVICE the bookable item            e.g. Split-Type AC Cleaning
              ├── OPTIONS / VARIANTS             1.0 HP · 1.5 HP · 2.0 HP
              ├── ADD-ONS                        Drain Line Flushing
              └── SERVICE QUESTIONS              quantity, photos, symptoms
```

Rules:

- A Subcategory belongs to exactly one Category.
- A Service belongs to exactly one Subcategory.
- Category is **derived** through the Subcategory, never stored on the Service.
- Options, add-ons and questions are **configuration of a Service**, never taxonomy
  layers.
- **Booking always references the Service id.** Category and Subcategory are context.

Terminology is `Category`, `Subcategory`, `Service` everywhere. Retire
`level_2`, `level_3`, `offering`, `mapping`, `service group`, `service family` from
user-facing surfaces.

---

## Mapping from today

| Target | Today | Migration |
|---|---|---|
| Category | `services.category` (free text) | Promote to `catalog_categories`. 3 real values; 7 junk values archived. |
| Subcategory | `service_options.level_2` | Promote to `catalog_subcategories` with `category_id`. 12 values. |
| Service | `service_options` MAIN | **Unchanged.** Keeps its id. Gains `subcategory_id`. |
| Options / Add-ons | `service_options` ADD_ON | Unchanged. |
| — | `provider_catalog_offerings` + mappings | **Retired** after Provider Web moves off it. |
| — | `services` (family) | Becomes a compatibility shim: still the provider-eligibility key, no longer a taxonomy layer. |

**Service ids are preserved.** That is what keeps 109 bookings, 105 provider links
and 45 applications intact.

---

## The one genuinely hard part

Bookings are keyed to the **Service** (`service_options.id`); provider eligibility is
keyed to the **family** (`services.id`). Providers qualify at a coarser grain than
customers book at.

Under the new model the natural eligibility key is the **Subcategory** — "this
provider does AC Cleaning" — which is what the family means in practice today.
Migrating eligibility from family to subcategory is the only step that can change
*who can be assigned to what*, so it gets its own phase, its own reconciliation
report, and a before/after diff of every provider's assignable service set.

Do not fold this into the schema phase.

---

## Phases

Each phase ships independently and is reversible. Nothing touches production data
until Phase 2, and nothing changes client contracts until Phase 4.

| Phase | Scope | Risk |
|---|---|---|
| **0 — SWEEP** ✅ done | Current state measured, migration matrix generated, 95/95 AUTO_MAPPABLE | none |
| **1 — EXPAND** | Add `catalog_categories` + `catalog_subcategories`; add nullable `subcategory_id` to `service_options`. Nothing reads them yet. | none — additive DDL only |
| **2 — BACKFILL + VERIFY** | Populate from the existing tree; reconciliation asserts every active service resolves Service → Subcategory → Category and matches its old `category`/`level_2` exactly | low — reversible, old columns still authoritative |
| **3 — ADMIN UI** | Rebuild Admin catalog on the new entities: Categories, Subcategories, Services, dependent dropdowns, breadcrumbs, tree view. Retire the 8-step wizard's Mappings step. | low — admin only |
| **4 — READ SWITCH** | New `GET /api/catalog` hierarchical projection for Customer Web + Admin. **`/api/services/full` keeps its exact current shape** for the Flutter apps. | medium — new endpoint, old untouched |
| **5 — ELIGIBILITY** | Move provider qualification from family to subcategory, with a per-provider before/after diff | **high — isolate** |
| **6 — CLEANUP** | Archive 15 empty families + 7 junk categories; resolve the Massage duplicate; retire `provider_catalog_offerings` once Provider Web is off it | low |

---

## Client compatibility

`GET /api/services/full` is **unauthenticated** and its keys are a protected
contract — `serviceService.ts` documents a live customer-app outage caused by
`level2`/`level3` disappearing from that response. It does not change shape in any
phase. The hierarchical model is served through a **new** endpoint; the Flutter apps
migrate on their own schedule, per §54–56 of the command.

Functional parity during migration means the same Service ids, prices, availability
and booking result — not the same navigation depth.

---

## Status and cascade

`DRAFT` · `ACTIVE` · `INACTIVE` · `ARCHIVED` at every layer.

- Inactive Category → its Subcategories and Services are undiscoverable for **new**
  bookings. Children are never auto-deleted.
- Archived anything → still fully retrievable for historical bookings, receipts,
  refunds, support and provider history.

Catalog visibility and historical retrievability are different concepts and are
implemented separately.

---

## Not yet done

Phases 1–6, and these outputs from the command: canonical API surface, admin
permission split (`EDIT_CATEGORY` / `EDIT_SUBCATEGORY` / `MIGRATE_CATALOG`), catalog
events and cache invalidation, search synonyms, SEO slugs and redirects, the 20
CATALOG-E2E tests, and the per-platform regression reports.

**CATALOG MIGRATION VERDICT: NOT_READY** — correctly so. Phase 0 is complete and the
data is far healthier than assumed, but no schema exists, no code has changed, and
the eligibility question in Phase 5 is unresolved.
