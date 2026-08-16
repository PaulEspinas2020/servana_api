# TAB 15 — P1: Database Baseline Capture + Fresh-DB Reproducibility

## Verdict

```
DATABASE BASELINE VERDICT: CERTIFIED_WITH_NONBLOCKING_GAPS
```

The command's first release gate is **"a fresh database can reach current schema
automatically."** It now does. `scripts/baseline/000-baseline.sql` is a captured,
sanitised schema baseline; `npm run db:verify:embedded` restores it into a real
PostgreSQL, marks the version, and proves **zero migrations pending**.

Two revisions of this document previously reported a gap of eleven tables and a
stop at migration 009. Both were wrong, and the corrections are recorded in §1
rather than quietly overwritten.

```
FRESH DATABASE REACHES CURRENT SCHEMA     PROVEN      ✔  executed; 121 tables, 0 pending
BASELINE CAPTURED AND SANITISED           PROVEN      ✔  0 rows, 0 owners, 0 grants, 0 forbidden patterns
BASELINE MEETS EVERY PROVEN REQUIREMENT   PROVEN      ✔  43 proven columns, all present
STATIC MODEL VALIDATED AGAINST AN ENGINE  PROVEN      ✔  it was under-reporting; now gated
CANONICAL / LEGACY FK SEMANTICS CORRECT   PROVEN      ✔  12 Catalog V2 rules, all pass
SEQUENCES AND DEFAULTS CORRECT            PROVEN      ✔  START 100000, OWNED BY services.id
OWNERSHIP DECLARATIONS CORRECT            PROVEN      ✔  none copied; applied as `admin`
VERSION MARK IDEMPOTENT                   PROVEN      ✔  re-applying is a no-op
NO PRODUCTION DATA IN ARTIFACTS           PROVEN      ✔  10 forbidden patterns, 0 matched
FRESH-DB CI JOB                           DELIVERED   ✔  3 jobs; all three now run
OWNERSHIP VALIDATED ON A REAL ENGINE      NOT RUN     ✖  PGlite has no role separation — the `fresh` job covers it
BASELINE DIFFED AGAINST PRODUCTION        NOT RUN     ✖  captured FROM production; not re-compared since
PRODUCTION LEDGER MARKED                  NOT DONE    ✖  production has no `schema_migrations` at all — see §6
```

Branch `main`. Nothing was pushed or deployed. **One production read was
performed under explicit authorisation** — `pg_dump --schema-only`, streamed over
SSH. No row was read, no object created or altered, no credential moved or
rotated, nothing written to the server.

---

## 1. Two corrections, and how each was found

### 1.1 The model was under-reporting (eleven → eighteen)

`scripts/lib/schemaModel.ts` recorded a table as missing only when an
`ALTER TABLE` named it. `INSERT … SELECT`, `UPDATE … FROM`, `CREATE INDEX ON`
and `COMMENT ON` were all classified *"no model impact"* and discarded, so a
table depended on **only** by DML was invisible.

The very first migration falls into that class:

```
001-massage-services.sql   seeds the catalog by reading
                           servana.service_option_meta and servana.bookings
```

`scripts/run-migrations.ts` rethrows on the first failure, so on a fresh database
**nothing after 001 ever ran.** Migration 009 was never the wall — it was just
the first table an `ALTER` happened to name.

Found by executing the chain in PGlite (PostgreSQL 18, WebAssembly, in-process).
Three tables had never been reported at all: `provider_catalog_offerings`,
`provider_onboarding_cases`, `service_options`. **A baseline verified against
the old eleven-table list would have passed that check and still been unable to
create a database.**

The model now reports eighteen, and `db:verify:embedded` fails the build if it
ever reports less than the engine proves.

### 1.2 "No engine is reachable" was also wrong

Earlier revisions justified the modelling approach with "no `psql`, no
`pg_dump`, no Docker". PostgreSQL **16.14 was installed the whole time** —
`pg_dump.exe` present, a server listening on 5432 — merely absent from `PATH`.
The probe that established the claim printed the version directory and was read
as empty output.

Both errors share one shape: **a check that only ever confirmed itself.** That
is the durable lesson of this tab, more than any number in it.

---

## 2. The capture

```
pg_dump --schema-only --no-owner --no-privileges --schema=servana
```

streamed over SSH so nothing was written on the production host and no
credential left it. Verified before it entered the repository:

```
COPY statements                       0
INSERT statements                     0
OWNER TO statements                   0
GRANT statements                      0
email-shaped values                   0
bcrypt hashes                         0
JSON Web Tokens                       0
FORBIDDEN_BASELINE_PATTERNS matched   0
tables                              120
sequences                            61
```

Three transforms, each necessary and each recorded in
`DATABASE_BASELINE_CAPTURE.md` §0.1: drop the `\restrict` / `\unrestrict` psql
meta-commands (not SQL — no driver can run them); guard `CREATE SCHEMA`; and
declare `uuid-ossp`, which `--schema=servana` cannot see because it lives in
`public`, yet which the schema depends on for `public.uuid_generate_v4()`
defaults.

Ownership is **absent, not rewritten**. `--no-owner` means there is none to copy,
so ownership becomes a property of whoever applies the file — and the runner
applies it as `admin`. Copying owners is what put 29 of 116 tables under
`postgres` in the 2026-08-10 outage.

---

## 3. Why the chain is not replayed on top of the baseline

The baseline **is the current production schema**. Everything the chain has ever
done is already in it, so replaying the chain does not reproduce production — it
replays *spent history against a schema that has moved on*, and it provably
fails:

```
001–008  column s.category does not exist      Catalog V2 removed it
023/024  "service_families" is not a view      it is a table now
020/025  cannot change owner of sequence       ownership already settled
```

Those migrations are not broken. They are spent. So a fresh database is brought
to parity the way every migration framework does it — Flyway `baseline`, Sqitch
`deploy --to`: restore the schema, record the version it corresponds to, and run
only what is genuinely pending.

`ledgerAtBaselineSql()` emits that record. Checksums are computed from the
migration files at call time rather than frozen into the artifact, so editing a
migration fires the runner's `Applied migration checksum changed` guard on a
**real** edit rather than on a stale copy of a hash.

### What the gate asserts

```
restore + mark version   ok
tables reached           121
version mark idempotent  yes
migrations still pending 0
```

The pending count is read back **out of the database**, not derived from the SQL
that wrote it. Deriving it from the generator would be a check that could only
ever agree with itself — the same defect as §1.

A `pg_dump` baseline is deliberately **not** idempotent: it is restored once into
an empty schema, which is why the live gate refuses a schema that already has
tables. Asserting otherwise would fail a correct artifact. The version mark *is*
idempotent, and that is what makes a half-finished bootstrap safe to re-run.

---

## 4. Catalog V2 semantics (§155–§157) — all 12 pass

```
pass  catalog-hierarchy-exists           services + catalog_subcategories + catalog_categories
pass  services-to-subcategory            services.subcategory_id -> catalog_subcategories.id
pass  subcategory-to-category            catalog_subcategories.category_id -> catalog_categories.id
pass  services-is-catalog-v2             services former names: [catalog_services]
pass  capability-to-canonical-service    catalog_provider_services.service_id -> services.id
pass  no-canonical-fk-to-family          none
pass  services-sequence-exists           present
pass  services-sequence-floor            START 100000
pass  services-sequence-owned-by-column  OWNED BY services.id
pass  services-id-default                nextval('servana.catalog_services_id_seq')
pass  no-unapproved-owner                all declared owners in [admin]
pass  sequence-owner-approved            catalog_services_id_seq owner admin
```

Three id ranges, no overlap: `< 100000` carried over from `service_options`;
`≥ 100001` minted by the sequence; `≥ 900000` synthetic fixtures. The fixture
file deliberately does not `setval`, which would push the sequence into the
fixture band and mint real services at 900202.

---

## 5. A defect this work surfaced elsewhere

Adding the baseline made the test suite fail **intermittently, in a different
suite each run**, while the same suite passed 251/251 without it. That was
verified by stashing the work rather than assumed — the first instinct, that it
was the project's known `--runInBand` order-sensitivity, was wrong.

The mechanism: `catalog-banner` validates a 4 MB upload with
`/^data:([^;,]+);base64,(.+)$/`. V8 allocates a regex stack proportional to that
5.6 MB input, and under heap pressure the allocation fails and throws
`RangeError: Maximum call stack size exceeded` — instead of the "5 MB or smaller"
error the test asserts. Eleven un-cached re-parses of a 235 KB baseline in one
shared `--runInBand` heap were enough to tip it.

Fixed here by caching the baseline read and both replays (`schemaBaseline.ts`).

**The underlying fragility is in product code and is left untouched deliberately
— it is outside this tab's scope and it is real:** a large banner upload can fail
with a stack-overflow `RangeError` rather than a clean 400. See §7 P1.

---

## 6. P0–P3 gaps

| | Gap | Why |
| --- | --- | --- |
| **P0** | Production has **no `schema_migrations` ledger at all** | It has never existed. `deploy.yml` never invokes the runner, so migrations there were applied by hand with no record. `npm run migrations:apply` against production today would create the ledger, find all 36 pending, and fail on 001. Marking production at its true baseline version is a deliberate operation and nothing in this repository performs it. |
| **P1** | Ownership unverified on a real engine | PGlite runs as one bundled superuser. The `fresh` CI job with a service container covers it and now activates, but has not been observed running. |
| **P1** | A 4 MB+ banner upload can throw `RangeError` instead of a 400 | Product-code regex fragility surfaced in §5. Outside this tab; needs an `indexOf`/`slice` parse rather than `(.+)` over a multi-MB string. |
| **P2** | Baseline not re-diffed against production since capture | It was captured *from* production, so it matched at that instant. Drift after that is unmeasured; a periodic diff would close it. |
| **P2** | `scripts/**` is typechecked by neither tsconfig | `typecheck` covers `src/**`, `typecheck:tests` covers `src/` + `tests/`. A type error in `scripts/` surfaces only when ts-node runs it — which is how the PGlite subpath import was caught. |
| **P3** | Fixtures seed only the catalog | Deliberate. Anything else is created by the test that needs it, through the domain service that owns it. |

---

## 7. Verification actually executed

```
npm run verify              PASS  exit 0 — 251 suites, 5656 tests
npm run db:verify           PASS  exit 0 — requirements, semantics, sanitisation
npm run db:verify:embedded  PASS  exit 0 — restored into PostgreSQL 18; 0 pending
npm run typecheck           PASS
npm run typecheck:tests     PASS
guard:protected-contracts   PASS
10 doc-drift checks         PASS
```

TAB 15 suites: `tests/schema-baseline.test.ts` (59) and
`tests/schema-baseline-engine.test.ts` (6).

The suite was additionally run at the **pre-baseline** commit to confirm the
intermittent failures in §5 were caused by this work and not inherited: 251/251
clean there, intermittent with the baseline, 251/251 again after the caching fix.

Three parser traps are on record from this tab. Inside a JavaScript template
literal `\b` is a backspace, so a `new RegExp` built that way silently matched
nothing. `maskNonCode` blanks string literals, so defaults must be read from
offset-aligned **raw** text. And a shell heredoc containing backticks executes
them as command substitution — which spliced command output into a memory file
mid-write.

---

## 8. Files

**New**

```
scripts/baseline/000-baseline.sql         the capture — 120 tables, 61 sequences
scripts/lib/embeddedEngine.ts             executed replay on PostgreSQL 18 (PGlite)
tests/schema-baseline-engine.test.ts      harness tests; the engine runs in the gate
```

**Changed**

```
scripts/lib/schemaModel.ts        records DML/index/comment references, not just ALTER
scripts/lib/schemaBaseline.ts     ledgerAtBaselineSql, neededBy, read-through caches
scripts/verify-fresh-db.ts        --embedded mode; baseline-version model in live + embedded
.github/workflows/fresh-db.yml    third job; `fresh` now activates
package.json                      db:verify:embedded; @electric-sql/pglite
tests/schema-baseline.test.ts     assertions flipped to the closed state
```

**No migration file was changed. No endpoint was added, changed, aliased or
retired. No client migrated.**

---

## 9. The next safe step

1. **Decide how production gets its ledger.** It has none. Until it does, the
   repository's own migration runner cannot safely be used against it. The safe
   operation is to create `servana.schema_migrations` and insert all 36 rows
   *without executing them* — production already has their effects. That is a
   production write and is **not** authorised by anything done here.
2. Let the `fresh` CI job run once and confirm ownership lands on `admin`.
3. Fix the banner-upload regex (§6 P1) — it is a live 500-instead-of-400 path.
4. Add `scripts/**` to a typecheck config (§6 P2).
