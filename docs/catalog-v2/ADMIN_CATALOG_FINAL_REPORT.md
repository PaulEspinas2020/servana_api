# ADMIN CATALOG V2 — FINAL REPORT

Phase: canonical Admin Catalog API + Admin rebuild. Started at §110 step 5 /
§94 step B, after re-verifying the existing gates.

---

## ADMIN + CANONICAL CATALOG API VERDICT

```
CERTIFIED_WITH_NONBLOCKING_GAPS
```

Everything §96 requires is implemented and verified by test, typecheck, guard and
live database measurement. The gaps are all of one kind: **this phase was not
deployed**, so nothing is verified against live HTTP, and one pre-existing
credential gap remains open. None of them is a defect in the work.

---

## Required statement

```
CANONICAL HIERARCHY:
Category → Subcategory → Service

CANONICAL SERVICE:
services.id

SERVICE SEMANTIC GUARDS:
PASS — 31 / 31

CATEGORIES BEFORE / AFTER:
3 / 3

SUBCATEGORIES BEFORE / AFTER:
12 / 12

SERVICES BEFORE / AFTER:
95 / 95   (row-level diff on id, name, subcategory_id, status,
           display_order, bookable — IDENTICAL)

CANONICAL PROVIDER CAPABILITIES BEFORE / AFTER:
1,128 / 1,128   (row-level diff on (provider_uid, service_id, status)
                 — IDENTICAL)

LEGACY LINKS BEFORE / AFTER:
49 / 49

APPLICATIONS BEFORE / AFTER:
45 / 45

DOCUMENTS BEFORE / AFTER:
120 / 120   (table is `worker_requirements`; `provider_documents`
             does not exist)

LEGACY LEVEL-BASED ADMIN UI:
REMOVED from the normal workflow. The Catalog tab is now
Category → Subcategory → Service and contains no Level or Service
Family wording (asserted by test). The 8-step offering wizard and the
offering workspace REMAIN ROUTABLE with reason: they build
provider-facing offerings, which is a different job from creating a
Service, and the offering model still backs the live provider catalog.
Neither is reachable from ordinary catalog management.

NORMAL FORCE DELETE:
REMOVED — and it was already absent. Measured: the portal contained no
call to /services/:id/force and no hard-delete control. The canonical
API adds no destructive route, and a test asserts the API client
exposes no method matching /delete|destroy|force/. The backend's
legacy DELETE /api/services/:id/force remains as an emergency path on
the legacy service_families surface, reachable from no UI.

ADMIN CATALOG E2E:
PASS — 35 component-level specs. No browser-driver harness exists in
this portal; see gaps.

MOBILEVIEW:
PASS — 55 assertions across all 12 required viewports, on both the
catalog and the Service page.

ACCESSIBILITY:
PASS — with two open items (no automated axe run; dialog focus is
moved but not trapped or returned).

PROVIDER AUTHENTICATED SMOKE:
BLOCKED_BY_TEST_CREDENTIAL

FRESH DATABASE BASELINE:
BLOCKED — SEPARATE DATABASE BASELINE CAPTURE REQUIRED
```

---

## Gate results

| Gate | Result |
|---|---|
| Semantic guards | **31 / 31 PASS** |
| Backend `tsc` + `jest` | clean · **2,964 tests / 155 suites PASS** |
| Portal `tsc` · `eslint` · specs · prod build | clean · **0 errors** · **1,163 PASS** · succeeds |
| `guard:protected-integrations` | clean |
| CONTRACT | PASS — documented in `ADMIN_CATALOG_V2_CONTRACT.md`; 42 backend contract tests |
| INTEGRITY | PASS — 0 broken hierarchy, 0 dangling capabilities, 0 dangling legacy links, 0 dangling application FKs, 0 services with >1 subcategory, sequence `last_value >= MAX(id)` |
| RECONCILE | PASS — the exact projections the API computes, measured against the DB: 3 / 12 / 95 / 95 active / 1 without providers |
| STITCH | PASS at the contract boundary — Admin → canonical API → `services.id` → hierarchy. The final hop (a real HTTP write) is untested; not deployed |
| ACTIONS | PASS — 48 buttons across the new UI, **0 without a handler** |
| ALIGN | PASS — no "Level 1/2/3", "Service Family" or "MAIN" in the new catalog UI, asserted by test |
| LEAK | PASS — coverage returns `{providerUid, name, status, source, grantedAt}` only; no documents, notes or profile fields |
| Admin regression | PASS — full portal suite, 1,163 specs |
| Provider regression | PASS — 2,198 insertions / 0 deletions, no provider-facing file in the diff, all 5 live provider/customer endpoints 200 with contract keys intact |

## Content gaps — surfaced, not resolved

Measured live: **6** legacy families hold provider approvals with no canonical
Service (Nails, Hair, Plumbing, Aesthetics & Beauty, Barbering, Carpentry — 17
links across 8 providers). They appear in the Admin gap panel as a read-only
report with a recommended action.

**Treated as a product decision, per instruction.** No approval was deleted and
no Service was invented.

---

## Non-blocking gaps

1. **Not deployed.** Both commits are local. The canonical endpoints have never
   answered a real request. `/api/admin/catalog` returns 401 on production, but
   so does `/api/not-admin-nonsense` — a catch-all auth middleware answers before
   routing, so that 401 is **not** evidence the routes exist.
2. **`PROVIDER AUTHENTICATED SMOKE: BLOCKED_BY_TEST_CREDENTIAL`** — no provider
   Firebase ID token in this environment. Pre-existing; mitigated by route
   coverage in the backend suite and by the diff containing no provider file.
3. **No browser-driver E2E.** The portal has no Cypress/Playwright harness.
   Covered at the component and contract boundaries instead.
4. **No automated axe-core pass**, and dialog focus is moved but not trapped or
   returned to the trigger. Shared with the portal's existing dialogs.
5. **Fresh-database baseline** remains out of scope (§92/§93).

## Recommended next steps, in order

1. **Deploy the backend, then re-run the two preservation diffs** before and
   after the first real Admin write. That closes gaps 1 and most of 3.
2. **Queue `DATABASE BASELINE CAPTURE`** as its own command. Unchanged
   recommendation: the semantic guards protect today's schema; baseline capture
   solves the different problem of making a new database reproducible in CI.
3. **Wire axe-core into `test:ci`** — one change, covers this screen and every
   existing one.
4. **Obtain a provider test credential** and close the authenticated smoke gap
   once, for every future phase.
5. **Then** begin `CATALOG V2 — CLIENT APP CANONICAL CATALOG MIGRATION`, sweeping
   the Client App against `ADMIN_CATALOG_V2_CONTRACT.md` rather than any legacy
   Level-2/Level-3 model.

The legacy `/api/services*` projection stays until both mobile clients have
shipped releases reading canonical endpoints and no older build remains in the
field.
