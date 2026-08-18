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
| Category | `services.category` (free text) | Promote to `catalog_categories`. 3 real values; the 7 junk strings are never migrated. |
| Subcategory | `service_options.level_2` | Promote to `catalog_subcategories` with `category_id`. 12 values. |
| **Service — BOOKABLE** | `service_options` MAIN (`level_3`) | Promote to `catalog_services`. **These are Specific Services masquerading as level-3 options.** |
| Options / Variants | — | `service_options` becomes configuration only (1.0 HP / 1.5 HP). Today it holds the service itself, which is the confusion being removed. |
| Add-ons | `service_options` ADD_ON | Unchanged, hangs off the Service. |
| — | `provider_catalog_offerings` + mappings | **Retired** after Provider Web moves off it. |
| — | `services` (the 19 families) | Dissolved. It is a redundant fourth layer; its 4 non-empty rows are already represented by Category + Subcategory. Renamed out of the way, then the name `services` is freed for the bookable entity in Phase 6. |

### The identifier decision

`catalog_services.id` is **seeded from `service_options.id`**, not from a fresh
sequence. So the number a customer already booked *is* its canonical service id.

That single choice is what makes this safe:

- the legacy mapping is an identity function — no lookup table to drift;
- historical bookings resolve through the new model without being rewritten;
- the shipped Flutter app keeps posting `serviceOptionId` and it keeps resolving;
- `bookings.service_option_id` stays authoritative until Phase 4.

**Proven by dry run against production, rolled back:** 3 categories, 12
subcategories, 95 services, 109 bookings linked, **0 broken chains, 0 fidelity
mismatches** — every migrated service keeps exactly the category and subcategory it
has today.

---

## The one genuinely hard part — now measured and solved

Bookings key on the **Service**; provider eligibility keys on the **family**. One
family approval covers every bookable service beneath it — measured: 14 providers
approved for `Aircon 2` (30 services each), 12 for `Beauty & Wellness` (54 each).

The migration **fans each family approval out to one row per bookable service**:
105 legacy links become **1,128** rows. This is behaviour-preserving, not widening —
those providers are already assignable to all of those services today, because
eligibility is checked at family grain. Approvals against the 15 empty families
produce nothing, because those families contain no bookable service.

Verified in the dry run: 1,128 rows, every one carrying `legacy_service_family_id`
so the expansion is reversible and auditable.

---

## Phases

Each phase ships independently and is reversible. Nothing touches production data
until Phase 2, and nothing changes client contracts until Phase 4.

| Phase | Scope | Risk |
|---|---|---|
| **0 — SWEEP** ✅ done | Current state measured, migration matrix generated, 95/95 AUTO_MAPPABLE | none |
| **1 — EXPAND** ✅ written, dry-run clean | `020-catalog-v2-expand.sql` — creates `catalog_categories`, `catalog_subcategories`, `catalog_services`, `catalog_provider_services` + nullable `bookings.catalog_service_id`. Nothing reads them. **Not applied.** | none — additive DDL only |
| **2 — BACKFILL** ✅ written, dry-run clean | `021-catalog-v2-backfill.sql` — proven against production and rolled back: 3 / 12 / 95 / 1,128 / 109, 0 broken chains, 0 fidelity mismatches. **Not applied.** | low — writes only into catalog_* |
| **3 — ADMIN UI** | Rebuild Admin catalog on the new entities: Categories, Subcategories, Services, dependent dropdowns, breadcrumbs, tree view. Retire the 8-step wizard's Mappings step. | low — admin only |
| **4 — READ SWITCH** | New `GET /api/catalog` hierarchical projection for Customer Web + Admin. **`/api/services/full` keeps its exact current shape** for the Flutter apps. | medium — new endpoint, old untouched |
| **5 — ELIGIBILITY SWITCH** | Point assignment at `catalog_provider_services` instead of `employee_services`. The rows already exist from Phase 2 and are behaviour-identical, so this is a read switch with a per-provider before/after diff, not a data change | **high — isolate** |
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

**CATALOG MIGRATION VERDICT: READY_WITH_NONBLOCKING_GAPS** for Phases 1–2.

The schema and backfill are written and have been proven end to end against the
production database inside a rolled-back transaction: 3 categories, 12
subcategories, 95 bookable services, 1,128 provider capabilities, 109 bookings
linked, **0 broken chains and 0 fidelity mismatches**. Neither file has been
applied — applying is a one-word decision.

Phases 3–6 remain NOT_READY: no API, no Admin UI, no client migration, and the
CATALOG-E2E suite is unwritten.
