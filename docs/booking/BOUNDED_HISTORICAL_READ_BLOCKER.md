# Bounded historical read — the upper bound does not exist

**Reporting before inventing, as instructed. No write behaviour changed.**

> *"If there is no reliable persisted assignment-close timestamp, report that
> before inventing one. A bounded policy without a trustworthy upper bound is
> not actually bounded."*

There is no such timestamp for the case the policy exists to serve.

---

## 1. What each close path records

| Close path | Status written | Timestamp written |
|---|---|---|
| `PROVIDER_DECLINE` | `DECLINED` | `declined_at` ✅ |
| `PROVIDER_CANCEL` | `CANCELLED` | `cancelled_at` ✅ |
| `PROVIDER_COMPLETE` | `COMPLETED` | `completed_at` ✅ |
| **`ADMIN_REASSIGN` (old row)** | **`DECLINED`** | **none** ❌ |
| `ADMIN_CANCEL` / `CUSTOMER_CANCEL` | `CANCELLED` | **none** ❌ |

`transitionExecutor.ts:1494`:

```sql
UPDATE booking_workers SET status = 'DECLINED'
 WHERE booking_id = $1 AND worker_uid = $2
```

Status only. `declined_at` exists — migration 016 added it, 027 re-declares it —
and this path does not write it.

**Reassignment is precisely the case bounded historical read is for**, and it is
the one close path that leaves no departure time. The bound cannot be derived
from the assignment row because the assignment row does not record it.

### Why the near-misses do not work

- **`declined_at` on the reassign path** — not written. Reading it would give
  `NULL` for every reassigned provider, which under fail-closed means DENY, and
  the fairness case the policy exists to serve is exactly the reassigned
  provider. The policy would be bounded and useless.
- **`booking_transitions`** records `ADMIN_REASSIGN` with a timestamp and is
  the *only* place the moment is captured. But it is keyed to the booking and
  the incoming provider, not to the outgoing assignment row, so recovering "when
  did provider A's assignment end" means correlating transitions by ordering —
  a derivation, not a persisted fact, and wrong the moment a provider holds two
  intervals.
- **`chat_participants.left_at`** is written by the reconciler. It is explicitly
  disqualified: *"the timestamp of whichever chat reconciliation happened to
  run"*. It is also the projection this work exists to stop trusting.
- **Request time** is disqualified for the same reason it always was.

---

## 2. A second unknown: can one provider hold two intervals?

T10 cannot be classified from the source.

```sql
INSERT INTO booking_workers (booking_id, worker_uid, status, assigned_at)
VALUES ($1, $2, 'ASSIGNED', NOW())
ON CONFLICT DO NOTHING
```

`ON CONFLICT DO NOTHING` with **no conflict target**, and **no unique
constraint on `booking_workers` is declared anywhere in this repository**. So
the behaviour when provider A is reassigned *back* to a booking they previously
held depends entirely on constraints that live outside the repo:

- **If a unique `(booking_id, worker_uid)` constraint exists** → the INSERT does
  nothing, the old row is reused, and A is left holding a row still marked
  `DECLINED` with its *original* `assigned_at`. Their new assignment would be
  invisible to any assignment-derived window.
- **If no such constraint exists** → a second row is inserted, and A holds two
  intervals. A memory note records production booking 75 carrying two
  `booking_workers` rows, which suggests this branch — but that is one observed
  booking, not a schema fact.

These two produce *opposite* correct implementations. Guessing would mean
either denying a legitimately re-assigned provider all access, or unioning
intervals that the schema never permits.

---

## 3. What is already safe, and is not waiting on this

The fail-open is **closed**, and none of it depends on an upper bound:

```
authorized provider, assignment row missing        DENY
assignment row present, assigned_at missing        DENY
departed provider                                  no read, no send
chat_participants missing                          assignment still governs
participant?.joined_at ?? null                     GONE
```

A departed provider currently reads **nothing**, which is the safe end of the
range. Bounded historical read would *widen* that to their own interval. So the
blocker delays a fairness improvement; it does not leave a leak open.

---

## 4. What would unblock it

Two things, both small, both changing write behaviour and therefore not taken:

**A. Record the departure.** One statement, on the reassign close path:

```sql
UPDATE booking_workers
   SET status = 'DECLINED',
       declined_at = COALESCE(declined_at, NOW())
 WHERE booking_id = $1 AND worker_uid = $2
```

`COALESCE` so a genuine earlier decline is not overwritten by a later
reassignment. Additive, nullable, no migration required — the column exists.

It only bounds assignments closed *after* it ships. Every historical
reassignment stays unbounded and must keep resolving to DENY, which is the
correct fallback and should be asserted rather than assumed.

The same gap applies to `ADMIN_CANCEL` / `CUSTOMER_CANCEL` closing an active
row at line 1728 — worth fixing in the same change for consistency, though
cancellation is a weaker fairness case than reassignment.

**B. Settle the row lifecycle.** Read-only, and answers T10:

```sql
SELECT conname, contype, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conrelid = 'servana.booking_workers'::regclass;

SELECT booking_id, worker_uid, COUNT(*) AS rows
  FROM servana.booking_workers
 GROUP BY 1, 2 HAVING COUNT(*) > 1
 ORDER BY rows DESC LIMIT 20;
```

The second query settles it empirically whatever the constraints say.

---

## 5. Recommendation

1. **Take A** as its own declared behaviour change — it writes a timestamp that
   should always have been written, and is worth doing on its own merits.
2. **Run B** read-only whenever production access is next available.
3. **Then** implement bounded historical read, with historical unbounded
   departures resolving to DENY.

Doing 3 first would mean choosing between two opposite implementations on a
coin-flip, and the losing side is either a privacy leak or a provider locked
out of evidence they are entitled to.

---

## 6. Status

```
BOUNDED HISTORICAL READ   BLOCKED — no persisted upper bound for reassignment
T10 ROW LIFECYCLE         UNKNOWN — no repo-declared uniqueness constraint
FAIL-OPEN                 CLOSED (previous commit); departed providers read nothing
WRITE BEHAVIOUR           unchanged
SAFE TO DEFER             yes — the gap is fairness, not exposure
```
