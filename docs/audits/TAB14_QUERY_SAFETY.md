# TAB 14 — the query defects this codebase has actually had

> **Backend half of TAB 14 (P2).** Implemented 2026-08-18 against `servana_api`
> at `ca07888`. Bundle budgets, lazy routing, cache headers and Lighthouse are
> portal-side and are not touched here.

---

## 1. The three defect classes, re-audited

The book names each as a **measured** defect rather than a hypothetical. All
three were re-audited against the current tree. **All three are clean**, and the
reasons differ in ways worth recording — "we looked and found nothing" is only
useful if it says what was looked at.

| Defect class | Verdict |
| --- | --- |
| INNER JOIN on an optional relation in a "show everything" list | **Absent** — see §2 |
| Array filtering computing a cross product | **Absent** — there is no `unnest(` anywhere in the service layer, so the class cannot occur |
| Pagination applied before filtering / wrong `meta.total` | **Correct** — see §3 |

## 2. The join audit: 31 sites, two different reasons for being safe

The sharpest of the three is worth quoting in full, because it is why any of
this deserves a gate:

> *95 services existed, 55 were reachable, 40 were invisible — and the duplicate
> rows from the same join were being counted into the total.*

Nothing looked broken. The page rendered, the count was a number, and 40 rows
simply were not there. **Silent, plausible, and invisible to anyone who does not
already know the expected row count.**

31 inner-semantics joins exist in the admin and catalog services. Every one was
read. They are safe for two distinct reasons:

**Structurally, not by care.** The catalog chain —
`services → catalog_subcategories → catalog_categories` — accounts for 12 of the
31. Both join keys are `NOT NULL` with foreign keys:

```sql
services.subcategory_id           integer NOT NULL   -- FK → catalog_subcategories
catalog_subcategories.category_id integer NOT NULL   -- FK → catalog_categories
```

The relation is **mandatory**, so an inner join along it cannot hide a row.
Catalog V2 did not merely fix the historical defect, it made it
**unrepresentable**. That is the strongest form of fix available and it is worth
naming as the reason rather than logging "no issues found".

**Predicates, not spines.** The remaining 19 are inside filtering contexts where
an inner join is the point. The clearest example, and the one that looked most
suspicious on first read:

```sql
payment_stats AS (
  SELECT DISTINCT b.guest_customer_id
  FROM bookings b
  JOIN payments pay ON pay.booking_id = b.id      -- inner, deliberately
  WHERE pay.status NOT IN ('PAID','REFUNDED')
)
...
FROM guest_customers gc
LEFT JOIN payment_stats ps ON ps.guest_customer_id = gc.guest_customer_id
```

`payments.booking_id` **is** nullable, so this looked like the defect. It is
not: the CTE's *purpose* is to select guests with an outstanding payment, and
the outer query `LEFT JOIN`s it — so a guest with no payment still appears in
the total. **An inner join is only a defect on the spine of a "show me
everything" query.** That distinction is the difference between an audit and a
grep.

Similarly: `JOIN disbursements ON booking_id` inside a reconciliation check for
*refunds approved while a payout was already released* — the join **is** the
predicate; and `JOIN booking_workers` inside a `COUNT(*)` that blocks removing a
service while active bookings exist.

## 3. Pagination counts what it filters

```sql
-- count
SELECT COUNT(*) AS total FROM (${baseSQL}) AS sub
-- page
${baseSQL} ORDER BY created_at DESC LIMIT $n OFFSET $n+1
```

Same `baseSQL`, same params, `LIMIT` only on the data query. Counting the
paginated rows is how `meta.total` ends up equal to the page size; counting a
*different* query is how it ends up plausible and wrong. This does neither.

## 4. The gate

`tests/admin-list-query-safety.test.ts` (9 assertions) keeps all three true:

- **the two `NOT NULL` declarations are asserted against the baseline.** If
  either column ever becomes nullable, every join along the chain silently
  starts hiding rows again — and the page that hides them is the one whose
  purpose is to show all of them;
- **a declared count of reviewed inner joins (31).** No static check can
  distinguish a safe inner join from an unsafe one — it depends on whether the
  relation is optional and whether the join is on the spine, and both are
  judgement. What a gate *can* do is refuse to let a new one arrive unnoticed.
  The failure message asks the one question that matters: *can the row on the
  left exist without a match on the right?*
- **`unnest(` is absent and must stay absent**, so the cross-product class fails
  the day it appears — which is the right moment to check which form it is;
- **the count/page invariant** is asserted on the largest admin list.

**Mutation-verified, both halves:**

```
MUTATION  add an unreviewed inner join to catalogAdminService  → 1 failed
MUTATION  make services.subcategory_id nullable in the baseline
          (re-enabling the historical defect)                  → 1 failed
```

Both reverted and both files verified restored — after TAB 10's lesson that
"the command exited 0" is not evidence a restore happened.

### 4.1 The detector was wrong first, and that is recorded

The first version matched `Array.prototype.join` and reported **188** inner
joins where there are **87** — it counted every string concatenation in the
service layer as a database join. Excluding a preceding dot is the whole
difference.

Recorded because the book's own evidence base makes exactly this point about a
different matcher: *any endpoint-coverage number produced by a matcher must be
spot-verified against real call sites before it is acted on.* Acting on 188
would have meant "auditing" 101 `.join(',')` calls and losing confidence in the
real 87.

## 5. What could NOT be done here

| Book step | State | Why |
| --- | --- | --- |
| Bundle budgets that **fail** the build, not warn | **NOT DONE** | `NO-REPO` — portal. Manual task 14.1. |
| Confirm every feature area is lazily routed | **NOT DONE** | `NO-REPO`. Manual task 14.2. |
| Verify cache headers on live hashed assets | **NOT DONE** | `NO-REPO`, `PROD-ACCESS`. TAB 02 proved the `/*.html` rule never fires; the asset rules need the same live check. Manual task 14.3. |
| Profile admin list endpoints at production scale; `EXPLAIN ANALYZE` each | **NOT DONE** | `PROD-ACCESS`. The queries are *correct*; whether they are *fast* on production-shaped data is unmeasured, and 111 bookings locally proves nothing. Manual task 14.4. |
| Add indexes for the admin list and search paths | **NOT DONE** | Depends on 14.4 — adding indexes without `EXPLAIN` output is guessing. Manual task 14.5. |
| p95 latency budget per admin screen | **NOT DONE** | `PROD-ACCESS`, and it belongs with TAB 13's SLOs. Manual task 14.6. |

**The honest headline: the admin list queries are CORRECT. Whether they are FAST
is unmeasured**, and nothing in this environment can measure it — the local
dataset is 111 bookings, which is not a scale problem and would produce
`EXPLAIN` plans that mislead.
