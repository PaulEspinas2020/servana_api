# Running the fresh-database gate

**This is the only way to run it.** `fresh-db.yml` was deleted on 2026-08-20
along with every other workflow in every repository: Actions credit is not being
topped up, so this gate has no automated runner and will not get one. Two of its
three jobs needed no engine and already run locally as part of `npm run verify`.
The third —
**zero-to-current on a real engine** — is the one that cannot, and it is the one
that matters most: it applies the chain as a **least-privilege runtime role**,
which is the only way to catch the ownership class of defect that left 29 of 116
tables unusable in production on 2026-08-10.

PGlite cannot substitute for it. PGlite is a single bundled superuser, so every
grant succeeds and role separation is untestable by construction.

## Getting a real engine on a machine that has none

No Docker and no Homebrew PostgreSQL required. The `embedded-postgres` package
ships genuine server binaries per platform. Install it **outside this repo** —
it is a ~100 MB download and has no business in the dependency tree:

```bash
mkdir -p ~/.local/pgtest && cd ~/.local/pgtest
npm init -y && npm install embedded-postgres
npm approve-scripts @embedded-postgres/<your-platform>   # hydrates the binaries

BIN=node_modules/@embedded-postgres/<your-platform>/native/bin
echo "ci-not-a-secret" > pw.txt
$BIN/initdb -D data -U postgres --auth=md5 --pwfile=pw.txt -E UTF8
$BIN/pg_ctl -D data -o "-p 54329 -c listen_addresses=127.0.0.1" -l pg.log start
```

The binaries are PostgreSQL 18; the CI service container is `postgres:16`. For
the privilege and ownership questions this job asks, the two behave alike — the
`public`-schema tightening that matters here landed in 15. A defect that is
specific to a major version is not what this gate is for.

## The role setup, which is the whole point

Verbatim from the workflow. The runtime role gets `CREATE` on the **database**,
not merely on the schema, because the baseline opens with `CREATE SCHEMA` and
`CREATE EXTENSION`, both database-level. Granting only `ON SCHEMA` leaves the
role unable to run its own baseline. (Trusted extensions such as `uuid-ossp`
need `CREATE` on the database as well — not on the target schema — which is why
`WITH SCHEMA public` succeeds for a non-superuser here.)

```sql
CREATE ROLE admin LOGIN PASSWORD 'ci-not-a-secret';
GRANT CREATE ON DATABASE servana_fresh TO admin;
CREATE SCHEMA servana AUTHORIZATION admin;
GRANT ALL ON SCHEMA servana TO admin;
```

## The gate

```bash
npm run db:verify -- --live=postgres://admin:ci-not-a-secret@127.0.0.1:54329/servana_fresh
```

Expected tail, and the only acceptable one:

```
  migrations still pending: 0
  a fresh database reaches the current schema.
```

Then the assertions the workflow makes afterwards — fixtures seed as the runtime
role, and **every** table in `servana` is owned by `admin` rather than the
superuser:

```sql
SELECT count(*) FROM pg_tables WHERE schemaname='servana' AND tableowner <> 'admin';  -- 0
SELECT count(*) FROM pg_tables WHERE schemaname='servana';                            -- 132
```

## Verified

2026-08-19, PostgreSQL 18.4, as `admin`: baseline and ledger applied, 0
migrations pending, fixtures seeded, all 132 tables owned by the runtime role, 0
single-column `notification_key` unique constraints, both owner-scoped indexes
present. This is the run that found the ledger defect fixed in `6538908` — the
`fresh` job had failed on every dispatch since it first became able to execute,
and no amount of baseline recapture could have cleared it.

## Never production

`verify-fresh-db` refuses any host matching the configured production host and
any schema that already has tables, so a mistyped connection string cannot point
this at anything real. Keep it that way.
