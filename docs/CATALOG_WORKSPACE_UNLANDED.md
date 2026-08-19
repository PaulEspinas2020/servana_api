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

## Behavioural divergences between the spec and `main`

These are open questions for a product decision, not defects. `main` is the shipped
behaviour; the spec is what the branch author intended.

| Spec says | `main` does |
|---|---|
| `createMapping` throws when the offering is archived | no status check at all — only that the offering exists |
| `createMapping` throws when the mapping is already active | `ON CONFLICT DO UPDATE` silently succeeds |
| `archiveMapping` refuses to archive the **last active mapping on a published offering** | no such guard; a live offering can be left with none |
| publish preview **blocks** when a mapping has no priced specific services | emits a **warning**, and never checks price at all |
| publish preview warns when `providerWebVisible` is false | no such warning |
| `publishOffering` throws `code: 'PUBLISH_BLOCKED'` | throws `code: 'VALIDATION'` |

The third row is the one worth attention: it is a data-integrity guard, not a
preference. Everything else is a judgement call about strictness.

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

## Recovering the branch work

    git show 1fda14a:tests/admin-catalog.test.ts               # the spec
    git show 30fb364:src/services/providerCatalogService.ts    # the branch implementation
