# FRESH_DATABASE_BASELINE_GAP

Per §96. Recorded so it is tracked, not solved accidentally inside catalog work.

## The gap

**The repository cannot build a database from zero.** There is no DDL anywhere —
not in `scripts/migrations/`, not in lazy bootstrap code — for the foundational
tables:

`user_credentials` · `bookings` · `services` (pre-rename families) ·
`service_options` · `employee_services` · `worker_requirements`

The 26 migrations are all *additive alterations* to a schema that was created
outside version control.

## What it costs

- **§31's fresh-database test is impossible.** A from-zero run cannot produce a
  working schema, so the migration chain cannot be validated end to end.
- New environments (staging, a reviewer's laptop, disaster recovery) cannot be
  provisioned from the repository.
- Defects that only appear on a fresh database — like the
  `worker_service_applications` foreign key that pointed at the wrong table — are
  invisible to CI. That one was closed by inspection and is now covered by a
  targeted guard in `catalog-semantic-guards`, but the *class* of defect remains
  undetectable.

## Not a catalog problem

This predates Catalog V2 and is unrelated to it. It must not be fixed opportunistically
inside a catalog phase — capturing a baseline is its own piece of work with its own
verification.

## Recommendation

A separate command, `DATABASE BASELINE CAPTURE`:

1. `pg_dump --schema-only` production into a reviewed baseline migration.
2. Prove a from-zero run reproduces the live schema exactly (compare
   `information_schema` between fresh and production).
3. Re-point the migration runner so 001+ apply on top of the baseline.
4. Then §31's fresh-database test becomes possible, and the class of defect above
   becomes catchable.

**Status: BLOCKED — tracked, not scheduled.**
