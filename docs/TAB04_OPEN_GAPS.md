# TAB 04 — open gaps and deliberate behaviour changes

Live for the duration of the booking migration. Nothing here is closed by
being written down; each entry names what would close it.

---

## OPEN GAPS

### AUTH FLAKE — OPEN, NONREPRODUCIBLE

**Status:** `OPEN — NONREPRODUCIBLE`. Do not call this fixed.

| | |
|---|---|
| Suite | `tests/v1-auth-security.test.ts` |
| Test | `an unknown account is indistinguishable from a known one › forgot-password answers identically for a real address, an unknown one and a mobile` |
| Location | `tests/v1-auth-security.test.ts:220` |
| First seen | 2026-08-12, during the full-suite run that gated the LEGACY_STATUS_PROJECTION commit |
| Reproduction | None. 4 subsequent passes — 3 isolated runs, 1 full suite. Later full runs also green. |

**What the failure output said.** Only the suite and test name were captured
before the run was re-executed; the failing assertion within the test was not
recorded. That is a gap in the evidence, not in the test — noted so the next
occurrence is captured properly. **If it fails again, capture the full jest
output before doing anything else.**

**Run context at the time of failure.** Full suite, all workers busy; the suite
took 97s versus ~20s isolated. Two suites failed in that run; the other
(`source-reads-normalise-line-endings`) was a genuine failure with an
identified cause, since fixed.

**Leading suspect, and why it is not yet convincing.** `perIpLoginLimiter` is
mounted on every `/api/v1/auth/*` route (`src/api/v1/register.ts:238-246`) and
keyed on one IP for the whole suite, so earlier tests in the file consume the
same budget. But the timing runs the wrong way: a slow, loaded run spreads
requests across *more* limiter windows and should trip *less* often, not more.
The theory does not explain the observation.

**The ratchet.** One more failure in any subsequent full suite → **stop and
investigate before continuing release certification**. Several clean full-suite
runs are required before TAB 04 certifies regardless, ideally alongside the
real PostgreSQL concurrency work.

**If it is shared limiter state:** the fix is test isolation — resetting the
limiter store between suites. Not raising the limit, and not weakening the
security assertion. A uniformity test that has been relaxed to stop flaking is
an enumeration oracle with a green tick next to it.

---

### POSTGRESQL LOCKING INTEGRATION — NOT YET PROVEN

`EXECUTOR RACE LOGIC: PASS` — the executor asks for the lock before deciding,
derives from the locked rows, and refuses the loser. Proven against a fake
database that serialises `FOR UPDATE`.

`POSTGRESQL LOCKING INTEGRATION: NOT YET PROVEN` — that real PostgreSQL honours
it under two concurrent accepts needs a real database. Required before TAB 04
certifies.

---

## DELIBERATE BEHAVIOUR CHANGES SHIPPING WITH TAB 04

### 1. Admin: a closed assignment reports `awaiting_assignment`

**Ships with the TAB 04 backend. Does not wait for the portal `canonicalState`
patch.**

```
CLOSED ASSIGNMENT
+ worker_uid = NULL
+ bookings.status = WORKER_ASSIGNED
→ canonicalState     = AWAITING_ASSIGNMENT
→ Admin projection   = awaiting_assignment
```

`declineJob` clears `worker_uid` and closes the `booking_workers` row but never
rewrites `bookings.status`. Reading only that column reported ASSIGNED for a
booking with nobody on it — so the queue that most needed an operator was the
one hidden from them, and the machine let the provider who had just declined
accept the same job.

This is correcting false operational truth, not a wire change. Unlike
EN_ROUTE / ARRIVED, both values are already in the Admin portal's closed union,
so nothing renders a blank badge. The incorrect `assigned` result is **not**
preserved for visual continuity.

Customer and Provider are unchanged byte-for-byte: ASSIGNED and
AWAITING_ASSIGNMENT both project to the raw booking status.

Gate: `tests/booking-single-derivation.test.ts` →
`an ended assignment does not read as ASSIGNED`.

The later portal patch should still migrate Admin onto `canonicalState`. This
correction ships independently of it.

---

### 2. LEGACY_TRACKING_PROJECTION failure semantics → REQUIRED

**Decision: B — the legacy `booking_tracking` row is written in the same
transaction as the canonical transition, and a failure rolls the transition
back.**

The legacy semantics were not uniform. Measured before deciding:

| write site | legacy semantics |
|---|---|
| `acceptJob` | in-transaction, unguarded → **already required** |
| `assignWorker` | in-transaction, unguarded → **already required** |
| `advanceArrivalStage` (EN_ROUTE, ARRIVED) | `try/catch` + `console.warn` → **best-effort** |
| decline / release | separate autocommit statement, unguarded → **neither** |

So B1.1 ACCEPT changed nothing: it was required before and is required now.
B1.3 / B1.4 promote arrival from best-effort. Decline is not a policy choice at
all — today a tracking failure there leaves the booking reset, the timeline
empty, reassignment never attempted and an error returned. Moving it into the
transaction fixes a partial-failure bug.

**Why required is right.** Three supported surfaces read these rows —
`controllers/providerController.ts:3241`, `services/adminBookingService.ts:723`,
`services/bookingService.ts:666`. A missing row is a permanently wrong timeline:
silent, and unrecoverable without a backfill.

**Why it does not put accepts at risk.** The arrival `try/catch` justified
itself as *"the state change is already committed and is the thing that
matters"* — true when the state change was a separate autocommit statement.
Inside the executor nothing is committed yet, so the catch guards nothing, and
keeping it would manufacture the exact outcome it was written to tolerate.

The failure surface is narrow by construction: `LEGACY_TRACKING` copies the
status value and note text **verbatim** from the legacy site, into the same
table, on the same connection, inside the same transaction as the status write.
A constraint the legacy write already satisfies cannot reject an identical
value; a table lock or a dropped table takes the status write too. There is no
tracking-only failure mode.

> Caveat on the evidence: no `CREATE TABLE booking_tracking` exists in this
> repository — the table is created outside it, so its constraints were not
> read, only reasoned about from the values already written to it in
> production.

Gate: `tests/booking-b1-*.test.ts` → a failing tracking insert rolls back the
transition and leaves the assignment row untouched.

---

### 3. Executor refusals carry the locked snapshot

`TransitionError.snapshot` exposes the rows as they were when the refusal was
decided, so a caller owing its clients a richer vocabulary — provider accept and
decline owe six codes — classifies from the same read the refusal was made on
rather than from a second, unlocked one. Additive; no existing caller changes.
