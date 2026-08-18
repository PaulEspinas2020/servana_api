# CATALOG_V2_CUTOVER_PLAN — the deployment-safe rename

Satisfies §21, §24, §25, §26, §79, §80. Written after the DB-first attempt took
production down.

## Why the previous attempt failed

The rename itself was correct — tables moved, all 7 foreign keys followed, 2,890
tests passed. **The rollout order was wrong.**

```
migration renames tables   →   running code still queries the old meaning   →   500s
                               deploy fails   →   window never closes
```

The running code queried `services` expecting `(id, name, category)` — families.
After the rename `services` held 95 bookable rows with no `category` column, so
`/api/services` and `/api/services/full` returned
`column s.category does not exist`.

**A rename cannot be rolled out gradually.** One name cannot satisfy both the old
and the new meaning at the same instant. That is the whole problem, and it is solved
by never asking it to.

## The mechanism: a view carries the new name before the table does

Split across **two deploys**. The running code is schema-compatible at every instant
in both.

### Deploy 1 — introduce the new name as a view

Migration (runs before the new code starts, as the deploy does):

```sql
CREATE OR REPLACE VIEW servana.service_families AS SELECT * FROM servana.services;
ALTER VIEW servana.service_families OWNER TO admin;
```

Then the code is repointed: all 46 legacy references `${dbSchema}.services` →
`${dbSchema}.service_families`.

Why this is safe at every instant:

| Moment | `services` | `service_families` | Running code reads | OK? |
|---|---|---|---|---|
| before migration | table (families) | — | `services` | ✅ |
| after migration, before restart | table (families) | **view → same rows** | `services` | ✅ unchanged |
| after restart | table (families) | view → same rows | `service_families` | ✅ same rows |

Nothing is renamed. The old name keeps working throughout, so a failed deploy is
harmless — the previous code still reads `services` and finds exactly what it always
found.

### Deploy 2 — swap the view for the real table

Migration:

```sql
DROP VIEW servana.service_families;
ALTER TABLE servana.services RENAME TO service_families;
ALTER TABLE servana.service_families RENAME CONSTRAINT services_pkey TO service_families_pkey;
ALTER TABLE servana.catalog_services RENAME TO services;
ALTER TABLE servana.services RENAME CONSTRAINT catalog_services_pkey TO services_pkey;
```

(The constraint order matters — `services_pkey` must be renamed away before the new
table can claim it, or the migration fails with `relation "services_pkey" already
exists`. Discovered the hard way; `--single-transaction` rolled it back cleanly.)

Why this is safe at every instant:

| Moment | Running code reads | Resolves to | OK? |
|---|---|---|---|
| before | `service_families` | view over families | ✅ |
| during (single transaction) | — | — | atomic |
| after | `service_families` | **real table**, same rows | ✅ |

The code from Deploy 1 never mentions `services`, so it does not care that the name
now points at the 95 bookable rows. **There is no window.**

After Deploy 2, `services` means the 95 Specific Services — §4's requirement — and
canonical code can start reading it.

## Preflight gates — must pass before each deploy

1. **Ownership** (§22/§23) — every `catalog_*` table, view and sequence owned by
   `admin`. The outage's root cause; assert it in CI, do not eyeball it.
2. **Old-code compatibility** (§80) — take the currently deployed commit's queries
   and run them against the post-migration schema. Deploy 1 passes trivially
   (nothing renamed). Deploy 2 passes because Deploy 1's code only names
   `service_families`.
3. **Counts** (§27) — re-read live, never remembered. Phase A already caught a real
   −9/−56 drift this way.
4. **No manual DDL** (§79) — both migrations ship in the repo and run under the
   deploy's own role.

## Rollback

| Deploy | Reverse |
|---|---|
| 1 | `DROP VIEW service_families;` + revert the code commit. The `services` table was never touched. |
| 2 | Rename the two tables back (proven — this is exactly what restored service during the outage, in seconds). |

## Status

Designed and documented. **Not executed.** Deploy 1 is a small, low-risk change;
Deploy 2 must not run until Deploy 1 is live and verified.
