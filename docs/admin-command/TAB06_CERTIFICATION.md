# TAB 06 — `PageMeta.total` — decide null, or decide number (P1)

## Verdict

```
DECIDED: ALWAYS A NUMBER                                      CERTIFIED

PageMeta.total          integer | null  ->  integer, minimum 0
pageMeta() signature    number | null   ->  number
Handlers producing null  1 of 4         ->  0 of 4
Reintroducing the null                     FAILS the gate  ✔ proven

THE PORTAL'S DTO WAS RIGHT. Its divergence assertion should now report closed.
```

The book asks the backend to choose and to stop the divergence being permanent:

> What is not acceptable is leaving it undecided: the portal is currently
> correct only by luck.

**Decision: option 1 — always send a number.** It was measured before it was
decided.

## The measurement

Four call sites build a `PageMeta`. None of them can produce null:

| Endpoint | Where `total` comes from | Can it be null? |
| --- | --- | --- |
| `bookings.listMine` | `rows.length` | no |
| `notifications.list` | `all.length` | no |
| `provider.jobs.list` | `jobs.length` | no |
| `reviews.provider.list` | `listProviderReviews` → `COUNT(*)::int` | no |

Only the reviews handler even had a null branch:

```ts
const total = typeof result?.total === 'number' ? result.total : null;
```

and the `::int` cast is what makes it unreachable. `int4` parses to a JS number;
a bare `COUNT(*)` is `bigint`, which node-postgres hands back as a **string** —
and that string would have failed the `typeof` check and produced the null. The
cast was already doing the work.

Proven against PGlite rather than assumed:

```
COUNT(*)::int        -> 3   typeof number
COUNT(*)::int on 0   -> 0   typeof number
```

So the nullable half was never reachable. It was a hedge against a cost nothing
in this API pays, and it obliged every client to render an empty state for a
case that never occurs. The portal was not "correct only by luck" — it was
correct because the backend never had a reason to send null. It just never said
so.

## A latent bug the decision removed

The null branch carried its own heuristic:

```ts
hasMore: total === null ? returned === page.limit : page.offset + returned < total
```

`returned === page.limit` — a full page means there is more — **is wrong for a
set whose size is an exact multiple of the limit.** A 40-row set read 20 at a
time returns a full second page and reports `hasMore: true`; the client asks for
a third and gets nothing.

It never ran, because no caller passed null. It is deleted and the case is
pinned anyway, because the reason to remove a heuristic is that it is wrong, not
that it is unused.

## What was deliberately NOT added

**`totalIsEstimate`.** The book suggests it for the expensive case: *"send a
capped or estimated one and say so in a sibling field."* No endpoint estimates
anything today, so a flag no producer ever sets is a foundation without callers
— every client would branch on something permanently false.

Instead the schema **names the alternative in its own description**, so the next
person who meets a slow `COUNT` finds the answer already written and does not
rediscover it as null. A test asserts that sentence is still there.

## The gate found a hole in itself

`tests/page-meta-total.test.ts`, 14 assertions. Two negative controls were run,
and **the first one walked straight past the detector.**

The source check was `expect(envelope).not.toMatch(/total\s*===\s*null/)`.
Reinstating the branch as

```ts
hasMore: (total as number | null) === null ? returned === page.limit : …
```

still compiled, still restored the heuristic, and **still passed** — the cast
sits between `total` and `=== null`, so the pattern missed.

A detector pinned to one spelling of a defect only ever finds that spelling. It
now extracts the body of `pageMeta` and forbids the word `null` in it outright,
which has no spelling to evade and is narrow enough to stay honest: the function
is four lines and has no legitimate use for null. Re-run, the control fails.

Comments are stripped before scanning, for the reason TAB 05 met the hard way:
the docblock **explaining** the removed branch contains the very pattern the
detector searches for. A detector must read code, not prose — the alternative is
teaching it to ignore a pattern, and then it ignores the next real one.

```
NEG A  reinstate the hasMore heuristic behind a cast
         first detector : PASSED  ← the hole
         hardened       : FAILED  ✔
NEG B  restore `type: ['integer','null']` in the contract
                        : FAILED  ✔
restore both            : 14 passed, 14 total
```

## Deliverables

| File | What changed |
| --- | --- |
| `src/api/v1/envelope.ts` | `PageMeta.total: number`; `pageMeta()` takes a number; the heuristic is gone |
| `src/api/v1/domains/reviews.ts` | The one null-producing branch now yields `0` |
| `src/api/v1/openapi.ts` | `total: integer, minimum 0`, and the description names the estimate route |
| `tests/page-meta-total.test.ts` | 14 assertions, including the multiple-of-limit case the heuristic got wrong |

## Acceptance, against the book's own criteria

| Book's criterion | Status |
| --- | --- |
| Choose one, and say which in the schema description | ✅ number, with the reasoning and the escape route in the description |
| Always send a number | ✅ all four endpoints, enforced by type and by gate |
| `totalIsEstimate` sibling where the exact total is expensive | ⚠️ deliberately absent — nothing estimates yet; the schema names it for when something does |
| The portal's divergence assertion reports it closed | ✅ its DTO said `number`; the contract now agrees |

## Gate

```
npm run verify → Test Suites: 322 passed, 322 total
                 Tests:       6706 passed, 6706 total
                 EXIT=0
```

---
Servana Backend — Admin API Master Command · TAB 06
