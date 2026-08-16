# Database baseline capture and fresh-database reproducibility

> The repository cannot currently build Servana's database from zero. This
> document says exactly how far it gets, why, what a baseline must contain, how
> to capture one safely, and how to restore or roll back when it goes wrong.

---

## 1. The gap, proven

`scripts/migrations/` is an **increment over a schema that exists only in
production**. Applying the chain to an empty database dies on the **first**
migration: `001-massage-services.sql` seeds the catalog by reading
`servana.service_option_meta` and `servana.bookings`, and nothing in this
repository creates either. `scripts/run-migrations.ts` rethrows on the first
failure, so on a fresh database nothing after 001 runs at all.

> **This document previously said the chain stopped at migration 009 and that
> eleven tables were missing.** Both were wrong. The static model behind those
> numbers recorded a table only when an `ALTER TABLE` named it, so every
> dependency expressed as `INSERT … SELECT`, `UPDATE … FROM` or `CREATE INDEX ON`
> was invisible to it. Executing the chain against a real PostgreSQL corrected
> it. See `TAB15_CERTIFICATION.md` §1.

Eighteen tables are in that position — thirteen proven by execution, five more
found by reading references in migrations the engine never reached because an
earlier file had already failed:

| Table | Needed by | Columns the repository proves it must already have |
| --- | --- | --- |
| `booking_escalations` | 030 | `category`, `opened_by_role`, `state_snapshot` |
| `booking_workers` | 016, 027 | `en_route_at`, `arrived_at`, `accepted_at`, `declined_at` |
| `bookings` | 001–004, 007, 020, 028 | `catalog_service_id`, `is_synthetic` |
| `chat_participants` | 032 | `last_read_at` |
| `disbursements` | 017 | `payout_attempt` |
| `email_otps` | 026 | `purpose` |
| `employee_services` | 029 | *(read-only reference)* |
| `payments` | 017, 018, 020 | `checkout_attempt`, `refund_attempt`, `return_origin`, `superseded_session_ids` |
| `provider_catalog_offerings` | 005, 006, 011 | `catalog_key`, plus `id` for an inbound FK |
| `provider_onboarding_cases` | 021 | `provider_uid` |
| `provider_onboarding_drafts` | onboarding backfill | *(read-only reference)* |
| `service_families` | 024 | *(a rename cascade — see §3)* |
| `service_option_meta` | 001 | *(read-only reference)* |
| `service_options` | 001–008 | `service_id` |
| `services` *(legacy)* | 012, 023–025 | `id` |
| `user_profile` | 009 | 9 public-profile and versioning columns |
| `worker_requirements` | 009, 010 | 16 document-lifecycle columns, plus `id` for an inbound FK |
| `worker_service_applications` | onboarding backfill | *(read-only reference)* |

**43 columns in total**, and that is a *weak lower bound* — it is only what the
repository can prove, from `ALTER … ADD COLUMN` statements and from foreign keys
in other tables that point at these. Eighteen tables sharing 43 proven columns
means most of them have almost no proven shape at all.

Run it yourself:

```
npm run db:verify            # static model, no dependencies
npm run db:verify:embedded   # executed on PostgreSQL 18 in-process (PGlite)
```

Both exit non-zero today. That is the honest state, not a broken check. The
embedded run additionally fails if the static model ever stops reporting
something the engine proves missing — the exact fail-open that produced the
correction above.

---

## 2. Why no baseline DDL is committed here

It would be easy to write eighteen `CREATE TABLE` statements that look right, and
it would be a fiction.

The migrations only ever **add** columns to these tables, or read from them. Not
one of them defines a primary key, a core column, or a foreign key for any of
them. So their real shape is not in this repository to be read. Inferring it from the
`SELECT` lists in service code would produce a baseline that is plausible,
unverified, and authoritative-looking — and CI would then prove that a fresh
database matches a schema **production does not have**.

A wrong baseline is worse than a missing one, because a missing one is visibly
missing.

What is committed instead:

1. the gap, machine-checked (`npm run db:verify`);
2. the **requirements** any baseline must satisfy, derived from repository
   evidence (`scripts/lib/schemaBaseline.ts → requirements()`);
3. the Catalog V2 semantic rules, which *are* fully derivable and all pass today;
4. capture tooling that produces the real baseline, with sanitisation enforced
   in code (`npm run baseline:plan`).

---

## 3. The rename chain, and why `service_families` is on the list

Migration 024 does two renames in sequence:

```
ALTER TABLE servana.services         RENAME TO service_families;   -- legacy families
ALTER TABLE servana.catalog_services RENAME TO services;           -- Catalog V2 canonical
```

So the baseline must supply the **legacy `services` table** — the coarse family
table. `service_families` is what that table *becomes*; it is a cascade of the
same missing object, not a twelfth independent requirement.

Getting this backwards would put the coarse family back in the canonical
bookable position, which the standing constraints forbid outright.

After the chain, the canonical shape is:

```
catalog_categories → catalog_subcategories → services        (canonical, services.id)
service_families                                              (legacy provenance only)
catalog_provider_services.service_id → services.id            (canonical capability)
employee_services / service_options / worker_service_applications → service_families
```

All of this is asserted by `tests/schema-baseline.test.ts`.

---

## 4. The `services.id` sequence (§156)

Three id ranges, deliberately non-overlapping:

| Range | Meaning |
| --- | --- |
| below 100000 | carried over from `service_options` when Catalog V2 seeded `services` |
| from 100001 | minted by `servana.catalog_services_id_seq` (`START 100000`) |
| 900000 and up | synthetic bootstrap fixtures |

The sequence is `OWNED BY servana.services.id`, owned by role `admin`, and wired
as the column default:

```sql
ALTER TABLE servana.services ALTER COLUMN id SET DEFAULT nextval('servana.catalog_services_id_seq');
```

Migration 025 reapplies the floor with
`setval(…, GREATEST(100000, MAX(id)), true)` so a restore cannot leave the
sequence behind the data.

**The fixture file deliberately does not `setval`.** Doing so would push the
sequence into the 900000 band and the next natively-created service would be
minted at 900202 — indistinguishable from seed data, in precisely the
environment where telling them apart matters.

---

## 5. Capturing a baseline

### 5.1 Never from production

The capture tool refuses three ways, and they are independent:

1. the source host must not be the configured production host, and the
   production database name is refused on any remote host;
2. non-local sources require `BASELINE_SOURCE_ACK=<host:port>`;
3. it issues **seven catalog queries only** — `information_schema` and
   `pg_catalog`. There is no code path in the file that selects from an
   application table, and `tests/schema-baseline.test.ts` asserts it.

### 5.2 The procedure

```bash
# 1. See what it would do. Connects to nothing.
npm run baseline:plan

# 2. Restore a production dump into a DISPOSABLE instance.
#    This step happens outside this repository, by someone with the dump.
createdb servana_baseline
pg_restore --schema-only --no-owner --no-privileges -d servana_baseline <dump>

# 3. Capture from that instance.
npm run baseline:capture -- --from=postgres://user@localhost:5432/servana_baseline

# 4. Verify before trusting it.
npm run db:verify
```

Step 4 checks the captured file against every requirement in §1, re-runs the
Catalog V2 semantic rules, and scans for anything that must never be committed
— row data, email addresses, phone numbers, JWTs, bcrypt hashes, role
statements, or `OWNER TO postgres`. The capture **fails rather than writes** if
any of those survive.

### 5.3 Ownership is normalised, not copied

Every object in the emitted baseline gets
`ALTER … OWNER TO admin`, regardless of who owned it in the source. Copying
ownership would reproduce the 2026-08-10 outage in a file: 29 of 116 tables
owned by `postgres` after a hand-applied migration, the app holding no
privileges on them, and provider document upload returning a bare 500 for every
provider until somebody read the catalog.

---

## 6. Applying a baseline

**Only to an empty schema.** `npm run db:verify -- --live=<url>` refuses a
`servana` schema that already contains tables, because applying a baseline over
a live database would attempt to recreate tables that already hold data.

Order is: baseline → migrations 001…035 → bootstrap fixtures.

The baseline is **not** added to `scripts/migrations/`. It is applied before the
chain, not as part of it, so:

- the `schema_migrations` ledger keeps its meaning — one row per incremental
  change, none for the starting point;
- no existing migration's checksum changes, and the runner refuses a checksum
  change on an applied migration;
- a production database, which already has the baseline as its actual state,
  never has it applied again.

---

## 7. Restore and rollback

### 7.1 A fresh database is wrong

Drop it. That is the whole procedure. A fresh database built by this process
holds nothing but schema and synthetic fixtures, and both are reproducible in
minutes:

```bash
dropdb servana_fresh && createdb servana_fresh
npm run db:verify -- --live=postgres://admin@localhost:5432/servana_fresh
```

### 7.2 A migration failed part-way on a real environment

The runner wraps each migration in a transaction together with its ledger row,
so a failure rolls back both — the migration is neither applied nor recorded,
and re-running is safe.

If a failure somehow leaves the schema changed and the ledger empty (the defect
TAB 14 fixed: an embedded `COMMIT;` surviving the stripper), the recovery is:

1. `npm run migrations:plan` — it lists what it believes is pending;
2. compare against the actual schema before doing anything;
3. if the change did land, insert the ledger row manually with the correct
   checksum rather than re-running the migration;
4. if it half-landed, write a **new** forward migration that reconciles. Never
   edit an applied one — the checksum guard will refuse the deploy afterwards.

### 7.3 The baseline itself is wrong

Delete `scripts/baseline/000-baseline.sql` and re-capture. Nothing depends on
its content being stable: it is not in the ledger, not checksummed, and applied
only to empty databases. This is the one artifact here that is safe to replace
wholesale.

---

## 8. When a future migration changes the schema

**Nothing about the baseline changes.** Add the migration; the baseline stays
where it is. The chain is baseline + every migration, and it stays correct
indefinitely.

The baseline is re-captured only when it is deliberately **rebased forward** —
folding applied migrations into it so the chain does not grow without bound.
That is a decision, not maintenance, and it requires:

1. every migration being folded in is applied in **every** environment;
2. a fresh capture, verified with `npm run db:verify`;
3. the folded migration files kept in the repository — they are the audit trail,
   and the ledger still names them;
4. the fresh-database CI job green before anyone deploys.

Do not rebase to tidy up. The only reason that justifies it is a chain long
enough that a fresh database takes impractically long to build, and 36
migrations is nowhere near it.

---

## 9. What CI checks

`.github/workflows/fresh-db.yml`:

| Job | Runs | Proves |
| --- | --- | --- |
| `static` | always | the chain replays against an empty catalog; every semantic rule holds; no migration leaks transaction control |
| `fresh` | once a baseline exists | a real PostgreSQL 16 reaches the current schema from zero, as the `admin` runtime role, twice (replayability), with ownership asserted and the backend suite run against it |

`postgres:16` is pinned to the deployment's major family. A fresh-database check
on a different major proves the migrations parse, not that they behave.

Everything is applied as `admin`, never as the container superuser. Applying as
a superuser would let a migration succeed in CI and fail in production, which is
exactly the class of defect that made 29 tables unusable once already.

---

## 10. The honest limits of all of this

No PostgreSQL engine is reachable from the environment this work was done in —
no `psql`, no `pg_dump`, no Docker — and the only database with credentials is
production, which this work is forbidden to touch.

So:

- the static gate is **executed** and its findings are real;
- the live gate is **written and unexecuted**;
- the capture tool has **never been run**;
- and nothing here has been validated against a production-shape database.

That last point is the environmental gap. It is recorded in
`TAB15_CERTIFICATION.md` as a blocker rather than being smoothed over, because a
document claiming a fresh database works when nobody has built one is the same
category of mistake as a baseline that was inferred.
