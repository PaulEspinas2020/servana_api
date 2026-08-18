# Admin catalog workspace — unlanded work on `feat/catalog-workspace`

**Decision (2026-08-19): do NOT merge this branch. Treat it as a specification and
reimplement against Catalog V2. The branch is kept, not deleted.**

## What exists

Branch `feat/catalog-workspace`, tip `1fda14a`, two commits:

| Commit | Contents |
|---|---|
| `30fb364` | `feat(catalog): add overview, mappings CRUD, publish flow, audit trail` |
| `1fda14a` | `test(catalog): add integration test spec for admin catalog workspace` — 206 lines |

It adds three service functions and a test suite covering them:

- `getAdminCatalogOverview` — offering list, status and `mobileProtected` filters,
  nested mapping rows with `specificServiceCount`
- `createMapping` — including "reactivates an archived mapping instead of
  duplicating" and refusal on an archived offering
- `archiveMapping`

**None of the three exists anywhere on `main`**, and no `main` test references them.
This is unlanded feature work, not a superseded duplicate — which is why the branch
was kept when two genuinely superseded branches (`fix/deploy-eaddrinuse` `f7d417d`,
`codex/backup-pre-sync-20260807` `c4a5a60`) were deleted the same day.

## Why merging it is the wrong move

The branch point is `89b33ec`, **2026-07-10**. Every Catalog V2 migration landed
**2026-08-11**, a month later:

    020-catalog-v2-expand            021-catalog-v2-backfill
    023-catalog-v2-service-families-view
    024-catalog-v2-canonical-rename  025-catalog-v2-services-sequence

`024` is the problem. It does not add tables, it **renames and swaps** them:

    ALTER TABLE servana.services         RENAME TO catalog_services;
    ALTER TABLE servana.service_families RENAME TO services;

The branch's service is written against `service_id`, `service_options`,
`service_option_meta` and `service_family_name` with their **pre-swap** meaning. A
merge would therefore produce code that uses the same identifiers to mean the
opposite table. That compiles, runs, returns 200 and reads the wrong rows — the
failure mode with no symptom until someone reconciles the data by hand.

`git merge-tree main feat/catalog-workspace` also reports content conflicts in
`src/controllers/providerCatalogController.ts` and
`src/services/providerCatalogService.ts`, so there is no mechanical resolution
available either. Hand-resolving a conflict in a service whose underlying tables
were swapped underneath it is not a merge, it is a rewrite with extra steps.

## What to do instead

Reimplement the three functions against the V2 schema, and port `1fda14a`'s test
spec — that test is the most valuable thing on the branch, because it states the
intended behaviour independently of the schema it was written for. Note in
particular the two cases that are easy to miss: reactivating an archived mapping
rather than inserting a duplicate, and refusing a mapping on an archived offering.

Recover the originals with:

    git show 1fda14a:tests/admin-catalog.test.ts
    git show 30fb364:src/services/providerCatalogService.ts
