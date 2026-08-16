# TAB 15 — P1: Database Baseline Capture + Fresh-DB Reproducibility

## Verdict

```
DATABASE BASELINE VERDICT: NOT_CERTIFIED
```

This is the honest verdict and it is deliberate.

The command's first release gate is **"a fresh database can reach current schema
automatically."** It cannot. Foundational tables are altered and read by
migrations and created by none, so a fresh database dies on the **first**
migration. That is now proven by *executing the chain against PostgreSQL 18*
rather than by modelling it — which is the substantive outcome of this tab — but
proving a gate fails is not passing it.

Closing it requires a schema capture from an authoritative database. That work is
forbidden to touch production, and the alternative — inferring the missing tables'
DDL from what the repository happens to reference — would produce a baseline that
is plausible, unverified, and authoritative-looking. A wrong baseline is worse
than a missing one, because a missing one is visibly missing.

```
GAP IDENTIFIED AND PROVEN                 PROVEN      ✔  executed on PostgreSQL 18; 13 tables proven, 18 modelled
STATIC MODEL VALIDATED AGAINST AN ENGINE  PROVEN      ✔  new; it was under-reporting and is now gated
CANONICAL / LEGACY FK SEMANTICS CORRECT   PROVEN      ✔  12 Catalog V2 rules, all pass
SEQUENCES AND DEFAULTS CORRECT            PROVEN      ✔  START 100000, OWNED BY services.id, wired as default
OWNERSHIP CORRECT                         PROVEN      ✔  every declared owner is `admin`; no `postgres` anywhere
MIGRATION REPLAY EXPECTATIONS             PROVEN      ✔  all CREATE TABLE/INDEX guarded; 0 transaction leaks
NO PRODUCTION DATA IN ARTIFACTS           PROVEN      ✔  10 forbidden patterns; capture fails rather than writes
BASELINE CAPTURE TOOLING                  DELIVERED   ✔  3 independent refusals; catalog-only queries
BOOTSTRAP FIXTURES                        DELIVERED   ✔  3 synthetic rows, reserved id band, unbookable
FRESH-DB CI JOB                           DELIVERED   ✔  3 jobs; 2 execute today, 1 waits on a baseline
RESTORE / ROLLBACK DOCUMENTED             DELIVERED   ✔  DATABASE_BASELINE_CAPTURE.md §7–§8
FRESH DATABASE REACHES CURRENT SCHEMA     NO          ✖  the gate this tab exists to close
SANITIZED BASELINE COMMITTED              NO          ✖  requires a capture; see §3
OWNERSHIP VALIDATED ON A REAL ENGINE      NOT RUN     ✖  PGlite has no role separation; needs the CI container
BASELINE VALIDATED AGAINST PRODUCTION     NOT RUN     ✖  forbidden by the standing rules
```

Branch `main`. Nothing was pushed, deployed, or run against production. No
production database was connected to. No credential was read, created or
rotated. No live provider, customer or booking record was touched.

---

## 1. The correction this tab now carries

The previous revision of this document reported that **eleven** tables were
missing and that the chain **stopped at migration 009**. Both were wrong, and the
way they were wrong matters more than the numbers.

`scripts/lib/schemaModel.ts` is a hand-written DDL interpreter. It recorded a
table as missing only when an `ALTER TABLE` named it. Every other way a
migration can depend on a table — `INSERT … SELECT FROM`, `UPDATE … FROM`,
`CREATE INDEX ON`, `COMMENT ON` — was classified as *"no model impact"* and
silently discarded.

So a whole class of dependency was invisible, and the very first migration fell
into it:

```
001-massage-services.sql   seeds the catalog by reading
                           servana.service_option_meta and servana.bookings
```

`scripts/run-migrations.ts` rethrows on the first failure. On a genuinely fresh
database **nothing after 001 ever runs.** Migration 009 was never the wall; it
was just the first table an `ALTER` happened to name.

### How it was found

PGlite is PostgreSQL compiled to WebAssembly — it runs in-process, needs no
server, container or credentials. Pointing it at the chain took the question out
of the model's hands entirely:

```
runner-faithful replay   dies on 001-massage-services.sql
applied before that      0/36
continue-past-failure    7/36 applied
engine-proven missing    13 (converged in 3 rounds)
```

The three tables the ALTER-only model had never reported:

| Table | How migrations use it | Named by |
| --- | --- | --- |
| `service_options` | `INSERT … SELECT`, and 008 adds a column to it | 001–008 |
| `provider_catalog_offerings` | read and updated during catalog seeding | 005, 006, 011 |
| `provider_onboarding_cases` | backfilled by a DML-only migration | 021 |

A baseline verified against the old eleven-table requirement list would have
passed that check and still been unable to create a database.

### The model, widened and now gated

`schemaModel.ts` records references from DML, index and comment statements too,
resolved through rename history and read from length-aligned masked text so a
name inside a string literal or comment cannot be mistaken for a real reference.
`DO` blocks and function bodies are excluded on purpose: PL/pgSQL resolves names
when it runs, not when it is planned, so a reference inside one proves nothing.

It now reports **18** tables — a superset of the 13 the engine proves.

The asymmetry is expected and is asserted rather than assumed. The engine stops
each file at its first error, so a file blocked by `bookings` never reveals that
it also needs `payments`; the model reads every reference regardless of
execution order. `npm run db:verify -- --embedded` fails the build if the
relationship ever inverts — if the engine proves a table missing that the model
does not report. That is the specific fail-open that produced this correction,
and it cannot recur silently.

---

## 2. What a fresh database actually needs

Thirteen tables proven by execution, eighteen by the widened model:

| Table | Proven by the engine | Needed by |
| --- | --- | --- |
| `booking_escalations` | ✔ | 030 |
| `booking_workers` | ✔ | 016, 027 |
| `bookings` | ✔ | 001–004, 007, 020, 028 |
| `chat_participants` | ✔ | 032 |
| `disbursements` | ✔ | 017 |
| `email_otps` | ✔ | 026 |
| `payments` | ✔ | 017, 018, 020 |
| `provider_catalog_offerings` | ✔ | 005, 006, 011 |
| `provider_onboarding_cases` | ✔ | 021 |
| `service_families` | ✔ | 024 (rename cascade) |
| `service_options` | ✔ | 001–008 |
| `user_profile` | ✔ | 009 |
| `worker_requirements` | ✔ | 009, 010 |
| `employee_services` | model only | 029 |
| `provider_onboarding_drafts` | model only | onboarding backfill |
| `service_option_meta` | model only | 001 |
| `services` *(legacy)* | model only | 012, 023–025 |
| `worker_service_applications` | model only | onboarding backfill |

"Model only" means the engine never reached the migration that needs it, because
an earlier file in the chain had already failed. They are not weaker findings —
they are references in the source — but they are unverified by execution, and
labelling them honestly is the point.

**43 proven columns** across all eighteen. That is a deliberately weak lower
bound: it counts only columns an `ADD COLUMN` must land on, or that an inbound
foreign key targets. Eighteen tables sharing 43 proven columns means most of
these tables have almost no proven shape at all, which is the honest measure of
how far a capture still has to go.

### The rename chain

Migration 024 renames legacy `services` → `service_families`, then
`catalog_services` → `services`. The baseline must supply the **legacy**
`services` table; `service_families` is what it becomes, and is a cascade of the
same missing object rather than a separate requirement.

Foreign keys are resolved **through renames**, as PostgreSQL does — an FK binds
to an OID, not a name. A model comparing names would have reported every FK into
`catalog_services` as dangling and buried the three real ones.

### Cascades, excluded on purpose

Four relations the engine reports are created by a migration that simply never
got to run: `catalog_categories`, `catalog_provider_services`,
`review_provider_responses` and (post-rename) `services`. They are cascades of an
earlier failure, not baseline requirements, and the gate subtracts anything the
chain does create before comparing engine against model.

---

## 3. The decision not to write the missing DDL

The migrations only ever **add** columns to these tables, or read from them. Not
one defines a primary key, a core column, or a foreign key for any of them.
Their real shape is not in this repository to be read.

Writing eighteen `CREATE TABLE` statements that look right would have satisfied
the deliverable list and produced a CI job proving a fresh database matches a
schema production does not have — a green gate guarding a fiction, on the exact
structure every one of the 95 canonical endpoints depends on.

So the deliverable was reframed into four things that are all true:

1. **the gap**, executed and machine-checked (`db:verify`, `db:verify:embedded`);
2. **the requirements** any baseline must satisfy, derived from repository
   evidence — so a capture can be *verified* rather than trusted;
3. **the semantic rules**, fully derivable for Catalog V2 and all passing today;
4. **the capture tooling**, which produces the real baseline when someone with
   database access runs it.

`tests/schema-baseline.test.ts` asserts `fs.existsSync(BASELINE_FILE) === false`,
so this decision cannot be quietly reversed by dropping an inferred file in.

---

## 4. Catalog V2 semantics (§155–§157) — all 12 pass

Unlike the missing tables, Catalog V2 is created entirely by migrations
020/024/025, so it is checkable today and is checked:

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

### The sequence (§156)

Three ranges, no overlap:

| Range | Meaning |
| --- | --- |
| < 100000 | carried over from `service_options` when Catalog V2 seeded `services` |
| ≥ 100001 | minted by `catalog_services_id_seq` |
| ≥ 900000 | synthetic bootstrap fixtures |

The fixture file deliberately does **not** `setval`. Doing so would push the
sequence into the fixture band and mint new services at 900202 —
indistinguishable from seed data, in precisely the environment where telling them
apart matters. That is asserted.

---

## 5. Cross-platform caller matrix

This command **adds, changes, aliases and retires no endpoint**. Its subject is
the schema every endpoint already depends on, so the useful matrix is not "which
client calls this" but "which client capabilities each missing table would
block".

| Missing table | Capabilities blocked | Surfaces affected |
| --- | --- | --- |
| `booking_workers` | 25 | all five |
| `bookings` | 22 | all five |
| `services` *(legacy)* | 19 | all five |
| `service_options` | 19 | all five |
| `payments` | 14 | all five |
| `user_profile` | 11 | all five |
| `booking_escalations` | 8 | all five |
| `provider_catalog_offerings` | 6 | Provider Mobile, Provider Web, Admin |
| `disbursements` | 5 | Provider Mobile, Provider Web, Admin |
| `worker_requirements` | 5 | all five |
| `service_families` | 3 | all five |
| `provider_onboarding_cases` | 3 | Provider Mobile, Provider Web, Admin |
| `email_otps` | 1 | all five |
| `chat_participants` | messaging | Customer + Provider |

`chat_participants` is mapped explicitly rather than through the module-name
heuristic, which never resolved it. TAB 08 established that it carries
conversation membership and the read pointer, so messaging is dead without it.

**Most of these block capabilities on all five surfaces.** That is the concrete
answer to why this is a P1 structural gap rather than housekeeping: no client
capability is reproducible from zero, so no endpoint or migration defect can be
caught in CI before a deploy finds it.

Role-specific endpoints are unaffected by this command and continue to share one
domain service, as certified in TAB 13.

---

## 6. What was built

| Deliverable | Status | Artifact |
| --- | --- | --- |
| `DATABASE_BASELINE_CAPTURE.md` | delivered | `docs/database/` — capture, apply, restore, rollback, rebase |
| Sanitized baseline schema | **not delivered** | requires a capture; requirements + tooling delivered instead |
| Fresh DB CI job | delivered | `.github/workflows/fresh-db.yml` — 3 jobs, 2 executing |
| Migration replay test | delivered | `tests/schema-baseline.test.ts` (replay, idempotence, ledger) |
| **Executed engine gate** | delivered | `scripts/lib/embeddedEngine.ts` + `db:verify:embedded` |
| Schema semantic assertions | delivered | 12 Catalog V2 rules, executed |
| Sequence/ownership tests | delivered | 5 sequence assertions, 2 ownership assertions |
| Bootstrap fixtures | delivered | `scripts/baseline/bootstrap-fixtures.sql` |
| Fresh-DB certification report | delivered | this document |

### Safety properties, each checked rather than claimed

- the capture tool refuses the configured production host, refuses the
  production database name on any remote host, and requires
  `BASELINE_SOURCE_ACK` for anything non-local;
- its **seven queries are declared as data** and every one must touch
  `information_schema` or `pg_catalog` — asserted, so "it cannot copy a row" is a
  property rather than a comment;
- output is scanned for ten forbidden patterns (row data, emails, phone numbers,
  JWTs, bcrypt hashes, role statements, `OWNER TO postgres`) and the capture
  **fails rather than writes**;
- ownership is **normalised to `admin` on the way out**, never copied — copying it
  would reproduce the 2026-08-10 outage in a file;
- the live gate refuses a `servana` schema that already has tables, so it cannot
  be pointed at anything that matters;
- the embedded gate creates its own throwaway in-memory database and has no
  connection string at all, so it cannot be pointed anywhere;
- CI applies everything as the `admin` runtime role, never as the container
  superuser, because a migration that succeeds as superuser and fails as `admin`
  is exactly the defect that made 29 of 116 tables unusable once already.

### What the embedded engine cannot check

PGlite runs everything as one bundled superuser. Role separation is not
enforceable inside it, so **ownership is still unproven on a real engine** — it is
covered only by the static owner assertions and by the `fresh` CI job's service
container. This gate proves *reachability*, not *ownership*, and the two are not
substitutes.

---

## 7. P0–P3 gaps

| | Gap | Why |
| --- | --- | --- |
| **P0** | No baseline captured; fresh DB cannot bootstrap | Needs a schema-only dump restored into a disposable instance. Forbidden here, and inferring it would be worse than leaving it. |
| **P0** | Nothing validated against a production-shape database | The only credentialed database is production. PGlite proves the chain's shape, not that it matches what production has. |
| **P1** | Ownership unverified on a real engine | PGlite has no role separation; the `fresh` job covers it and is skipped until a baseline exists. |
| **P1** | 5 of 18 missing tables are model-only | The engine never reached the migrations that need them, because earlier files failed first. They resolve as the chain unblocks. |
| **P1** | 43 proven columns is a weak lower bound | It is what the repository can prove. The real tables have far more, and only a capture supplies them. |
| **P2** | 3 dangling FKs remain after replay | `provider_catalog_offerings` and `worker_requirements` are themselves part of the gap; they resolve when the baseline lands. |
| **P3** | Fixtures seed only the catalog | Deliberate. Anything else is created by the test that needs it, through the domain service that owns it. |

---

## 8. Verification actually executed

```
npm run typecheck            PASS
npm run typecheck:tests      PASS
guard:protected-contracts    PASS
10 doc-drift checks          PASS
npm run test:ci              PASS  251 suites, 5654 tests
npm run db:verify            FAIL (exit 1) — correctly; 18 tables missing
npm run db:verify:embedded   FAIL (exit 1) — correctly; dies on 001. Model/engine AGREE.
npm run baseline:plan        PASS  printed; connected to nothing
```

TAB 15 suites: `tests/schema-baseline.test.ts` (57) and
`tests/schema-baseline-engine.test.ts` (6) — **63 tests**, all executed.

Two parser traps are worth keeping on record. Inside a JavaScript **template
literal**, `\b` is a backspace character — a `new RegExp` built that way silently
matched nothing, and a stray `0x08` byte reached a source file. And `maskNonCode`
blanks string literals, so column defaults had to be read from offset-aligned
**raw** text; read from the masked form, `DEFAULT 'active'` returns the `CHECK`
clause that follows it.

A third now joins them, and it is the important one: **a detector that only ever
validates itself will eventually report a clean number that is wrong.** The
engine-free model was careful, well-tested against its own expectations, and
under-reported the gap by seven tables while naming the wrong migration as the
cause. Nothing in its own suite could have caught that.

---

## 9. Files

**New**

```
scripts/lib/embeddedEngine.ts             executed replay on PostgreSQL 18 (PGlite)
tests/schema-baseline-engine.test.ts      harness tests; the engine runs in the gate
```

**Changed**

```
scripts/lib/schemaModel.ts        records DML/index/comment references, not just ALTER
scripts/lib/schemaBaseline.ts     TableRequirement.neededBy
scripts/verify-fresh-db.ts        --embedded mode + model/engine agreement check
.github/workflows/fresh-db.yml    third job: embedded, runs today
package.json                      db:verify:embedded; @electric-sql/pglite devDependency
tests/schema-baseline.test.ts     corrected: 18 tables, wall at 001, 43 columns
tests/suite-inventory.test.ts     250 → 251
```

**No migration file was changed. No endpoint was added, changed, aliased or
retired. No client migrated; all 114 legacy mappings remain active.**

---

## 10. The next safe step

1. Restore a production dump — **schema-only** — into a disposable instance.
   That step needs someone with the dump and is deliberately outside this
   repository.
2. `npm run baseline:capture -- --from=postgres://…@localhost/servana_baseline`
3. `npm run db:verify` — checks the capture against all 43 proven columns,
   re-runs the 12 semantic rules, and scans for anything that must not be
   committed.
4. `npm run db:verify:embedded` — proves the chain now applies from zero on a
   real PostgreSQL, and that the model still agrees with it.
5. When both exit zero, flip the assertions in `tests/schema-baseline.test.ts`
   that currently pin `bootstrapsFromZero === false`, and re-certify. The failing
   test is the prompt; it is written to fail when the gap closes.
6. Only then does the `fresh` CI job become meaningful — and it remains the only
   place ownership is checked on a real engine.

Nothing above may be run against production. Step 1 is a restore into a throwaway
database, and every tool here refuses the production host outright.
