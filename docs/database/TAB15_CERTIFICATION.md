# TAB 15 — P1: Database Baseline Capture + Fresh-DB Reproducibility

## Verdict

```
DATABASE BASELINE VERDICT: NOT_CERTIFIED
```

This is the honest verdict and it is deliberate.

The command's first release gate is **"a fresh database can reach current schema
automatically."** It cannot. Eleven foundational tables are altered by migrations
and created by none, so a fresh database stops at migration 009. That is now
*proven and machine-checked* rather than suspected — which is the substantive
outcome of this tab — but proving a gate fails is not passing it.

Closing it requires a schema capture from an authoritative database. This work is
forbidden to touch production, no PostgreSQL engine is reachable from this
environment, and the alternative — inferring eleven tables' DDL from what the
repository happens to reference — would produce a baseline that is plausible,
unverified, and authoritative-looking. A wrong baseline is worse than a missing
one, because a missing one is visibly missing.

```
GAP IDENTIFIED AND PROVEN                 PROVEN      ✔  11 tables, 42 proven columns, 0 unparsed statements
CANONICAL / LEGACY FK SEMANTICS CORRECT   PROVEN      ✔  12 Catalog V2 rules, all pass
SEQUENCES AND DEFAULTS CORRECT            PROVEN      ✔  START 100000, OWNED BY services.id, wired as default
OWNERSHIP CORRECT                         PROVEN      ✔  every declared owner is `admin`; no `postgres` anywhere
MIGRATION REPLAY EXPECTATIONS             PROVEN      ✔  all CREATE TABLE/INDEX guarded; 0 transaction leaks
NO PRODUCTION DATA IN ARTIFACTS           PROVEN      ✔  10 forbidden patterns; capture fails rather than writes
BASELINE CAPTURE TOOLING                  DELIVERED   ✔  3 independent refusals; catalog-only queries
BOOTSTRAP FIXTURES                        DELIVERED   ✔  3 synthetic rows, reserved id band, unbookable
FRESH-DB CI JOB                           DELIVERED   ✔  static job runs today; live job waits on a baseline
RESTORE / ROLLBACK DOCUMENTED             DELIVERED   ✔  DATABASE_BASELINE_CAPTURE.md §7–§8
FRESH DATABASE REACHES CURRENT SCHEMA     NO          ✖  the gate this tab exists to close
SANITIZED BASELINE COMMITTED              NO          ✖  requires a capture; see §2
FULL SUITE ON A FRESH DB                  NOT RUN     ✖  no engine reachable; no baseline to apply
BASELINE VALIDATED AGAINST PRODUCTION     NOT RUN     ✖  forbidden by the standing rules
```

Branch `main`, HEAD `36ca152`. **All work is uncommitted and local.** Nothing was
pushed, deployed, or run against production. No database was connected to. No
credential was read, created or rotated. No live provider, customer or booking
record was touched.

---

## 1. What was actually proven

`scripts/lib/schemaModel.ts` is an engine-free DDL interpreter. It replays the
migration chain against an empty catalog and reports what a real run would hit.

```
migrations replayed   36
statements parsed     366   (0 unparsed)
tables reached        45
bootstraps from zero  NO
```

**Zero unparsed statements** is what makes the conclusion usable. A parser that
silently skipped what it could not read would give exactly the false confidence
this file exists to remove, so the count is asserted at zero rather than "small".

The chain stops at `009-provider-profile-compliance.sql`, on
`ALTER TABLE servana.user_profile`. Eleven tables are in that position:

| Table | Needed by | Proven columns |
| --- | --- | --- |
| `booking_escalations` | 030 | 3 |
| `booking_workers` | 016, 027 | 4 |
| `bookings` | 020, 028 | 2 |
| `chat_participants` | 032 | 1 |
| `disbursements` | 017 | 1 |
| `email_otps` | 026 | 1 |
| `payments` | 017, 018, 020 | 4 |
| `service_families` | 024 | — (rename cascade) |
| `services` *(legacy)* | 024, 025 | 1 |
| `user_profile` | 009 | 9 |
| `worker_requirements` | 009, 010 | 16 |

**42 columns**, every one from hard evidence: an `ALTER … ADD COLUMN` in a real
migration, or a foreign key in another table pointing at it. Not one is
inferred from a `SELECT` list.

`npm run db:verify` prints this and exits non-zero. It is meant to go green when
a baseline exists, not to be silenced.

---

## 2. The decision not to write the missing DDL

The migrations only ever **add** columns to those eleven. Not one of them
defines a primary key, a core column, or a foreign key for any of them. Their
real shape is not in this repository to be read.

Writing eleven `CREATE TABLE` statements that look right would have satisfied
the deliverable list and produced a CI job that proves a fresh database matches
a schema production does not have — a green gate guarding a fiction, on the
exact structure every one of the 95 canonical endpoints depends on.

So the deliverable was reframed into four things that are all true:

1. **the gap**, machine-checked (`db:verify`, `tests/schema-baseline.test.ts`);
2. **the requirements** any baseline must satisfy, derived from repository
   evidence — so a capture can be *verified* rather than trusted;
3. **the semantic rules**, which are fully derivable for Catalog V2 and all pass
   today;
4. **the capture tooling**, which produces the real baseline when someone with
   database access runs it.

`tests/schema-baseline.test.ts` asserts `fs.existsSync(BASELINE_FILE) === false`,
so this decision cannot be quietly reversed by dropping an inferred file in.

---

## 3. Catalog V2 semantics (§155–§157) — all 12 pass

Unlike the eleven, Catalog V2 is created entirely by migrations 020/024/025, so
it is checkable today and is checked:

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

### The rename chain

Migration 024 renames legacy `services` → `service_families`, then
`catalog_services` → `services`. So the baseline must supply the **legacy**
`services` table; `service_families` is what it becomes, and is a cascade of the
same missing object rather than a twelfth requirement.

Foreign keys are resolved **through renames**, as PostgreSQL does — an FK binds
to an OID, not a name. A model comparing names would have reported every FK into
`catalog_services` as dangling and buried the three real ones.

### The sequence (§156)

Three ranges, no overlap:

| Range | Meaning |
| --- | --- |
| < 100000 | carried over from `service_options` when Catalog V2 seeded `services` |
| ≥ 100001 | minted by `catalog_services_id_seq` |
| ≥ 900000 | synthetic bootstrap fixtures |

The fixture file deliberately does **not** `setval`. Doing so would push the
sequence into the fixture band and mint new services at 900202 —
indistinguishable from seed data, in precisely the environment where telling
them apart matters. That is asserted.

---

## 4. Cross-platform caller matrix

This command **adds, changes, aliases and retires no endpoint**. Its subject is
the schema every endpoint already depends on, so the useful matrix is not "which
client calls this" but "which client capabilities each missing table would
block".

Derived by mapping each table to the service modules that query it, those
modules to `V1_CONTRACT[].domainService`, and those entries to the TAB 13
capability registry:

| Missing table | Capabilities blocked | Surfaces affected |
| --- | --- | --- |
| `bookings` | 22 | Customer Mobile, Customer Web, Provider Mobile, Provider Web, Admin |
| `booking_workers` | 25 | all five |
| `services` *(legacy)* | 19 | all five |
| `payments` | 14 | all five |
| `user_profile` | 11 | all five |
| `booking_escalations` | 8 | all five |
| `disbursements` | 5 | Provider Mobile, Provider Web, Admin |
| `worker_requirements` | 5 | all five |
| `service_families` | 3 | all five |
| `email_otps` | 1 | all five |
| `chat_participants` | — * | Customer + Provider (messaging) |

\* The mapping is by domain-service module name and does not resolve
`chat_participants` → `messagingService`. It is a heuristic limitation of the
matrix, not a table with no consumers; TAB 08 established that
`chat_participants` carries conversation membership and the read pointer.

**Ten of eleven tables block capabilities on all five surfaces.** That is the
concrete answer to why this is a P1 structural gap rather than housekeeping: no
client capability is reproducible from zero, so no endpoint or migration defect
can be caught in CI before a deploy finds it.

Role-specific endpoints are unaffected by this command and continue to share one
domain service, as certified in TAB 13.

---

## 5. What was built

| Deliverable | Status | Artifact |
| --- | --- | --- |
| `DATABASE_BASELINE_CAPTURE.md` | delivered | `docs/database/` — capture, apply, restore, rollback, rebase |
| Sanitized baseline schema | **not delivered** | requires a capture; requirements + tooling delivered instead |
| Fresh DB CI job | delivered | `.github/workflows/fresh-db.yml` — 2 jobs |
| Migration replay test | delivered | `tests/schema-baseline.test.ts` (replay, idempotence, ledger) |
| Schema semantic assertions | delivered | 12 Catalog V2 rules, executed |
| Sequence/ownership tests | delivered | 5 sequence assertions, 2 ownership assertions |
| Bootstrap fixtures | delivered | `scripts/baseline/bootstrap-fixtures.sql` |
| Fresh-DB certification report | delivered | this document |

### Safety properties, each checked rather than claimed

- the capture tool refuses the configured production host, refuses the
  production database name on any remote host, and requires
  `BASELINE_SOURCE_ACK` for anything non-local;
- its **seven queries are declared as data** and every one must touch
  `information_schema` or `pg_catalog` — asserted, so "it cannot copy a row" is
  a property rather than a comment;
- output is scanned for ten forbidden patterns (row data, emails, phone numbers,
  JWTs, bcrypt hashes, role statements, `OWNER TO postgres`) and the capture
  **fails rather than writes**;
- ownership is **normalised to `admin` on the way out**, never copied — copying
  it would reproduce the 2026-08-10 outage in a file;
- the live gate refuses a `servana` schema that already has tables, so it cannot
  be pointed at anything that matters;
- CI applies everything as the `admin` runtime role, never as the container
  superuser, because a migration that succeeds as superuser and fails as `admin`
  is exactly the defect that made 29 of 116 tables unusable once already.

---

## 6. P0–P3 gaps

| | Gap | Why |
| --- | --- | --- |
| **P0** | No baseline captured; fresh DB cannot bootstrap | Needs a dump restored into a disposable instance. Forbidden here, and inferring it would be worse than leaving it. |
| **P0** | Nothing validated against a production-shape database | No engine reachable — no `psql`, no `pg_dump`, no Docker. The only credentialed database is production. |
| **P1** | The live CI job is written and unexecuted | It is skipped until a baseline exists; until then `static` is the gate and it runs. |
| **P1** | 42 proven columns is a lower bound | It is what the repository can prove. The real tables have more, and only a capture supplies them. |
| **P2** | 3 dangling FKs remain after replay | `provider_catalog_offerings` and `worker_requirements` are themselves part of the gap; they resolve when the baseline lands. |
| **P2** | `chat_participants` unmapped in the caller matrix | Heuristic limitation of the module-name mapping, stated rather than smoothed over. |
| **P3** | Fixtures seed only the catalog | Deliberate. Anything else is created by the test that needs it, through the domain service that owns it. |

---

## 7. Verification actually executed

```
npm run typecheck            PASS
npm run typecheck:tests      PASS
guard:protected-contracts    PASS
10 doc-drift checks          PASS
npm run test:ci              PASS  250 suites, 5648 tests
npm run build                PASS  tsc + asset copy
npm run db:verify            FAIL (exit 1) — correctly; 11 tables missing
npm run baseline:plan        PASS  printed; connected to nothing
```

TAB 15 suite: `tests/schema-baseline.test.ts` — **57 tests**, all executed.

Two parser traps cost real time and are worth recording. Inside a JavaScript
**template literal**, `\b` is a backspace character — a `new RegExp` built that
way silently matched nothing, and a stray `0x08` byte reached a source file.
And `maskNonCode` blanks string literals, so column defaults had to be read from
offset-aligned **raw** text; read from the masked form, `DEFAULT 'active'`
returns the `CHECK` clause that follows it.

### The standing flakiness note

The intermittent `--runInBand` order-sensitivity recorded in TABs 12–14 persists
and has never involved code any of those tabs touched. Final runs here were
clean.

---

## 8. Files

**New**

```
scripts/lib/schemaModel.ts               engine-free DDL replay
scripts/lib/schemaBaseline.ts            gap, requirements, semantics, sanitisation
scripts/capture-schema-baseline.ts       capture tooling — never run
scripts/verify-fresh-db.ts               the gate, static and live
scripts/baseline/bootstrap-fixtures.sql  synthetic seed, reserved id band
.github/workflows/fresh-db.yml           zero-to-current CI
docs/database/DATABASE_BASELINE_CAPTURE.md
docs/database/TAB15_CERTIFICATION.md
tests/schema-baseline.test.ts
```

**Modified**

```
package.json                   db:verify, baseline:plan, baseline:capture
tests/suite-inventory.test.ts  249 → 250
```

**No migration file was changed. No endpoint was added, changed, aliased or
retired. No client migrated; all 114 legacy mappings remain active.** The
TAB 01–14 dirty tree was preserved in full.

---

## 9. The next safe step

1. Restore a production dump — **schema-only** — into a disposable instance.
   That step needs someone with the dump and is deliberately outside this
   repository.
2. `npm run baseline:capture -- --from=postgres://…@localhost/servana_baseline`
3. `npm run db:verify` — it checks the capture against all 42 proven columns,
   re-runs the 12 semantic rules, and scans for anything that must not be
   committed.
4. When it exits zero, flip the two assertions in `tests/schema-baseline.test.ts`
   that currently pin `bootstrapsFromZero === false`, and re-certify. The
   failing test is the prompt; it is written to fail when the gap closes.
5. Only then does the `fresh` CI job become meaningful, and only then can this
   verdict move to `CERTIFIED`.

Nothing above may be run against production. Step 1 is a restore into a
throwaway database, and every tool here refuses the production host outright.
