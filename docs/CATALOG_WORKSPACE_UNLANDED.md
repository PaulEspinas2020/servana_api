# Admin catalog workspace — `feat/catalog-workspace` vs `main`

**Corrected 2026-08-19. An earlier version of this file claimed the admin catalog
workspace had never landed. That was wrong.** It was written after grepping `main`
for the branch's exact function names, finding none, and concluding the feature was
absent. Every one of them exists on `main` under a different name.

| Spec name on the branch  | Name on `main`           |
|--------------------------|--------------------------|
| `getAdminCatalogOverview`| `getCatalogOverview`     |
| `createMapping`          | `createOfferingMapping`  |
| `archiveMapping`         | `archiveOfferingMapping` |
| `runPublishPreview`      | `getPublishPreview`      |
| `publishOffering`        | `publishOffering`        |
| `getAuditTrail`          | `getCatalogAuditTrail`   |

`main` also has `updateOfferingMapping`, which the branch never had. The decision not
to merge still stands — see the schema section below — but the reason is not that the
work is missing.

The branch's test file is worth one clarification too: **all 25 of its assertions are
`expect(true).toBe(true)`.** It is a specification written in the shape of a test file,
not a suite. Nothing regressed when it was left unmerged, because it never tested
anything.

## Why the branch still must not be merged

Branch point `89b33ec`, 2026-07-10. Every Catalog V2 migration landed 2026-08-11, and
`024-catalog-v2-canonical-rename` **swaps two tables**:

    ALTER TABLE servana.services         RENAME TO catalog_services;
    ALTER TABLE servana.service_families RENAME TO services;

The branch's code uses `service_id`, `service_options` and `service_family_name` with
their pre-swap meaning, so merging it produces code using the same identifiers for the
opposite table — it would compile, run, return 200 and read the wrong rows.
`git merge-tree` also conflicts in both catalog files.

Both branches are now on the remote (`origin/feat/catalog-workspace`,
`origin/feat/admin-integration`), so nothing depends on one laptop.

## Behavioural divergences between the spec and `main` — resolved 2026-08-19

| Spec says | Decision |
|---|---|
| `archiveMapping` refuses to archive the **last active mapping on a published offering** | **IMPLEMENTED.** This was the one integrity rule, not a preference — a live offering could be left showing providers nothing. Guarded in `archiveOfferingMapping`, scoped to published offerings and to mappings that are currently active, so drafts and repeat-archives are unaffected. |
| publish preview **blocks** when a mapping has no priced specific services | **PARTIALLY — as a warning, not a blocker.** The spec was right that a row count hid the real state: a mapping whose services all sit at null or zero `base_price` is as unusable as an empty one, so the preview now counts priced services and says so. It does **not** block, because refusing publishes that succeed today is a behaviour change for the admin portal rather than an additive one. |
| publish preview warns when `providerWebVisible` is false | **IMPLEMENTED.** Publishing an invisible offering is an easy mistake: it goes `status='active'` and still appears nowhere, because `getOfferingsForProvider` filters on `provider_web_visible`. |
| `createMapping` throws when the offering is archived | **DECLINED for now.** `getPublishPreview` already blocks publishing an archived offering, so the damaging path is closed; refusing the mapping as well is strictness with no live failure behind it. |
| `createMapping` throws when the mapping is already active | **DECLINED.** `ON CONFLICT DO UPDATE` makes the call idempotent, which is the better property for an admin action that may be retried. Throwing would turn a harmless repeat into an error. |
| `publishOffering` throws `code: 'PUBLISH_BLOCKED'` | **DECLINED — deliberately.** Nothing consumes `PUBLISH_BLOCKED`; it appears nowhere outside this document. Changing the code that clients already branch on would be a breaking contract change in exchange for nothing, against the additive-only rule for this backend. `VALIDATION` stays. |

All of the above are covered by `tests/catalog-publish-integrity.test.ts`, mutation-tested: disabling the guard fails exactly its two tests, and disabling both new warnings fails exactly three.

## Defects found during this audit, and fixed

Independent of the spec, in code that had already shipped:

1. **`getCatalogAuditTrail` ordered by `created_at` alone.** Audit rows written in one
   transaction share a timestamp, so their relative order was undefined — and the query
   pages with `LIMIT`/`OFFSET`, so a row could appear on two pages or on neither. Now
   `ORDER BY ae.created_at DESC, ae.id DESC`.
2. **The same query ended in `.catch(() => ({ rows: [] }))`.** A failed read reported
   "no audit events". An audit trail that cannot distinguish *nothing happened* from
   *I could not look* is worse than one that errors. The catch is gone.

Both are covered by `tests/catalog-audit-trail.test.ts`, which was mutation-tested:
reverting either fix fails exactly the test written for it.

## Status of the branch: KEEP, as the specification

`feat/catalog-workspace` is **not to be deleted**. Its implementation is superseded and
must never be merged, but its test file is the only written statement of what the admin
catalog workspace is supposed to guarantee, and three of those statements turned into
real changes on `main` this week. It is kept as the spec, on `origin`.

    git show 1fda14a:tests/admin-catalog.test.ts               # the spec — keep this
    git show 30fb364:src/services/providerCatalogService.ts    # superseded implementation

## `feat/admin-integration` — fully superseded, checked by capability

Assessed the same way, and this time by route rather than by function name:

| Branch route | Equivalent on `main` |
|---|---|
| `GET /admin/workers` | `GET /admin/providers` |
| `GET /admin/workers/:uid` | `GET /admin/providers/:uid` |
| `PATCH /admin/workers/:uid/account-status` | `PATCH /admin/providers/:uid/account-status` |
| `GET /admin/workers/:uid/service-applications` | `GET /admin/providers/:uid/service-applications` |
| `GET /admin/service-applications` | `GET /admin/providers/service-applications` |
| `PATCH /admin/service-applications/:id/approve` | `PATCH /admin/providers/service-applications/:id/approve` |
| `PATCH /admin/service-applications/:id/reject` | `PATCH /admin/providers/service-applications/:id/reject` |

Every capability landed under `provider` naming, and `main` adds
`PATCH /admin/providers/service-applications/:id/flag-action-required`, which the branch
never had. `npm run guard:protected-contracts` asserts `/admin/providers` stays mounted.
Nothing on that branch is needed.
