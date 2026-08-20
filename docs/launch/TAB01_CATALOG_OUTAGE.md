# TAB 01 — The catalog 500: what is established, and what is not

**Date:** 2026-08-19 · **Status:** production still down at time of writing

---

## What is established by measurement

**The repository is self-consistent.** Replaying baseline plus the full chain in
PGlite reaches 132 tables and every catalog query resolves.
`npm run db:verify:embedded` → **PASS**.

**Production has drifted from the chain.** That is the finding, and it is why
the fault is not reproducible from source alone.

## What was ruled out — and one hypothesis of mine that was wrong

| Hypothesis | Verdict |
| --- | --- |
| `020-catalog-v2-expand.sql` broke it | ❌ genuinely additive; its docblock defers the rename to Phase 6 |
| `024-catalog-v2-canonical-rename.sql` had not run | ❌ **production has both `services` and `service_families`** — the rename is applied |
| Production's `services` lacks the columns the catalog reads | ❌ it has `subcategory_id`, `slug`, `short_description`, `image_url` — **everything the query needs** |

The third was mine, and the production baseline recapture (`82abbd0`) disproved
it. Recording that rather than quietly dropping it: the schema on the catalog
path is correct, so a missing table or column is **not** the cause.

## What remains

Data, grants/ownership, or application logic. Ownership is the most credible of
the three — this platform has an ownership incident in its history that made 29
of 116 tables unusable, and `024` carries an explicit `ALTER TABLE … OWNER TO
admin` for exactly that reason. The production baseline was captured with
`--no-owner --no-privileges`, so it cannot settle the question.

**Separating them needs one thing: the server log for a failing `requestId`.**
`envelope.ts` logs the whole exception server-side against that id while
returning only `INTERNAL` to the caller. One line almost certainly names it.

## The detector built for this class of fault

`npm run db:skew` — replays the chain and fails if the source names a relation
the chain never builds. It found one on its first real run:

```
servana.locations
  src/services/adminCreateBookingService.ts:430
  SELECT city_id FROM ${s}.locations WHERE id = $1 LIMIT 1
```

**Independently confirmed against production.** The recaptured production
baseline contains **zero** occurrences of `servana.locations`. So this is not a
repository-only gap: the admin booking-creation path queries a table that does
not exist in production, and 500s whenever a `serviceLocationId` is supplied.

That is a second live defect of the same shape as the outage — valid SQL
pointing at a relation that is not there — found by a gate that did not exist
this morning.
