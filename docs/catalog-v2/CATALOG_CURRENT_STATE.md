# CATALOG_CURRENT_STATE

SWEEP of the Servana catalog as it exists today. Every number here was measured
against the **production database** on 2026-08-11, not inferred from code.

---

## The headline finding

**The hierarchy you asked for already exists in the data, and it is already a strict
tree.** It is not modelled as one, not named as one, and a second parallel taxonomy
sits beside it — which is what makes the Admin experience feel complicated.

| Target layer | What holds it today | Count |
|---|---|---|
| **CATEGORY** | `services.category` — a free-text column, no entity | **3** in use |
| **SUBCATEGORY** | `service_options.level_2` | **12** in use |
| **SPECIFIC SERVICE** | `service_options` rows where `option_type='MAIN'` | **95** |
| Options / Add-ons | `service_options` where `option_type='ADD_ON'` | 5 |

Integrity checks, all measured:

| Check | Result |
|---|---|
| A subcategory appearing under more than one category | **0** — already a strict tree |
| Services with no category | **0** |
| Services with no subcategory | **0** |
| Duplicate service names within the same subcategory | **0** |

**Nothing in the data needs restructuring to satisfy CATEGORY → SUBCATEGORY →
SPECIFIC SERVICE.** The migration is a naming and modelling exercise, not a risky
data reshaping. All 95 services are `AUTO_MAPPABLE`.

---

## The actual tree today

| Category | Subcategory | Services | Price range |
|---|---|---:|---|
| Home Maintenance | Electrical | 1 | ₱5,000 |
| Home Services | Cleaning | 15 | ₱690 – ₱4,990 |
| Home Services | Installation | 3 | ₱1,400 – ₱7,400 |
| Home Services | Maintenance Plan | 1 | ₱3,000 |
| Home Services | Refrigerant (freon) | 1 | ₱1,800 |
| Home Services | Repair | 10 | ₱300 – ₱7,900 |
| Personal Care | Beauty Drip | 5 | ₱990 – ₱4,500 |
| Personal Care | Facial | 8 | ₱1,000 – ₱6,000 |
| Personal Care | Hair | 14 | ₱300 – ₱1,350 |
| Personal Care | Massage | 10 | ₱400 – ₱1,000 |
| Personal Care | Massage & Wellness | 10 | ₱400 – ₱1,000 |
| Personal Care | Nails | 17 | ₱10 – ₱1,500 |

---

## The redundant layer — this is what to remove

`provider_catalog_offerings` (8 rows) + `provider_catalog_offering_mappings` form a
**second, parallel taxonomy** over the same services, keyed on
`(service_id, level_2)`. It is the "ambiguous intermediate catalog layer".

Evidence it is not carrying its weight:

- **40 of the 95 services were mapped into it at all.** The Admin list INNER JOINed
  those mappings, so 42% of the catalog was invisible to admins until this was fixed
  earlier today (`bc32e6a`).
- Its 8 offerings restate the same idea as the 3 categories and 12 subcategories.
- It is the only reason the Admin catalog needs an 8-step wizard with a "Mappings"
  step that says *"Mappings for mobile-protected offerings are seeded automatically
  and cannot be changed here"* — a step that exists but cannot be used.

---

## Junk in the catalog

`services` has **19 rows but only 4 carry any services**:

| Family | Category | Services |
|---|---|---:|
| Beauty & Wellness | Personal Care | 54 |
| Aircon 2 | Home Services | 30 |
| Massage | Personal Care | 10 |
| Electrical Services | Home Maintenance | 1 |

The other **15 are empty**, and 9 are plainly test data — `sadas`, `sdsd`, `sdsa`,
`dsad`, `test193`, `dasdasd`, `Service 01`, `Service 0156`, `Computer  Repair` (note
the double space). Their `category` values are junk too: `Test Category`, `sdasd`,
`sdsds`, `sda`, `sadgbjsadha`, `sdada`, `Home Servicessfdsd`.

They are invisible today only because they contain nothing. Under a model where
Category is a real entity, **they become 7 junk categories in every dropdown**.
They must be archived as part of the migration, not after it.

Also note `Aircon 2` — the family name for 30 real services, including all aircon
cleaning. A customer-facing rename is warranted.

---

## Duplicate candidates — ADMIN_REVIEW_REQUIRED

| Candidate | Why |
|---|---|
| `Massage` vs `Massage & Wellness` | Both under Personal Care, both 10 services, both ₱400–₱1,000. Almost certainly the same set entered twice. **Do not auto-merge** — 10 of these carry booking history. |
| `services` families `Hair`, `Nails`, `Aesthetics & Beauty`, `Barbering`, `Plumbing`, `Carpentry` | Exist as empty families while the same names exist as `level_2` subcategories under `Beauty & Wellness`. The family layer and the subcategory layer disagree about what these are. |

---

## What must survive migration

| Dependency | Count | References |
|---|---:|---|
| Bookings | **109** | `bookings.service_option_id` |
| Provider service links | **105** | `employee_services.service_id` → `services.id` |
| Provider applications | **45** | `worker_service_applications.service_id` |
| Add-ons | 5 | `service_options.parent_option_id` |

**16 services carry booking history** and can never be hard-deleted.

Note the asymmetry that matters for §49 of the command: **bookings point at the
specific service (`service_options.id`), but provider eligibility points at the
FAMILY (`services.id`)**. Providers are qualified at a coarser grain than customers
book at. Any model change must preserve that or it silently changes who can be
assigned to what.

---

## Consumers that must not break

| Consumer | Reads | Risk |
|---|---|---|
| Customer Flutter | `GET /api/services/full` (unauthenticated) | Contract documented in `serviceService.ts` as having caused a live outage before. Field names `level2`/`level3`/`base_price` are load-bearing. |
| Worker Flutter | `GET /api/:serviceId/options-with-addons` (bare path) | The bare route is explicitly kept "because ServanaWorker calls it in production". |
| Customer Web | `/api/services/*` | |
| Provider Web | `/api/provider-catalog/v1/offerings` | The only consumer of the offerings layer. |
| Admin Portal | `/api/admin/provider-catalog/*` | 25 routes, all permission-gated. |

`GET /api/services/full` is **unauthenticated** and returns the nested shape the
customer app renders. Its keys are a protected contract.

---

## Reusable artefacts produced

- `CATALOG_MIGRATION_MATRIX.csv` — all 95 services with current category, family,
  subcategory, offering, price, unit, status, booking count and migration action.
  Every row is `AUTO_MAPPABLE`.

---

## Verdict on the data

The catalog does **not** need the restructuring the command assumes. It needs:

1. Category and Subcategory promoted from free-text columns to real entities.
2. The `provider_catalog_offerings` layer retired.
3. 15 empty families and 7 junk categories archived.
4. One duplicate subcategory pair reviewed.
5. Terminology aligned (`level_2` → Subcategory, `level_3` → Service).

Steps 1–2 are additive schema work behind a compatibility view. Step 3 is cleanup.
Nothing here requires rewriting a booking or a provider approval.
