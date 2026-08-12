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

### 3. Two event tables, and which is which

Now that `booking_tracking` is written transactionally it would be easy to
start treating it as the event store. It is not.

```
booking_transitions   canonical evidence
                      one row per lifecycle action, written by the executor
                      inside the transition transaction; the thing every new
                      surface reads and the thing an audit trusts

booking_tracking      REQUIRED LEGACY PROJECTION
                      required only while supported clients consume it
                      written by payments, refunds and admin too, so it is
                      not lifecycle-owned and the executor cannot claim it
```

Transactional consistency was granted because three supported surfaces read it,
not because it was promoted. It retires when those surfaces read
`booking_transitions`; it does not become the future event store by being
reliable in the meantime.

---

### 4. Provider cancellation policy moved into the domain

`controllers/bookingCancellationPolicy.ts` → `services/booking/bookingPolicies.ts`.

The 48-hour rule was enforced in a controller, so it applied only to callers
that went through that controller. It is now a named guard the executor runs:

```
Controller
→ authenticates / parses
→ transitionBooking(PROVIDER_CANCEL)
→ executor loads locked canonical state
→ guard: providerCancellationWindow
→ transition → timeline → commit
```

- The window is **one named constant**, `PROVIDER_CANCEL_WINDOW_HOURS = 48`.
- The action **names** its guard; the executor holds no copy of the threshold,
  asserted by test.
- Refusals return a **specific** code, never a flattened
  `BOOKING_TRANSITION_INVALID`:
  `BOOKING_PROVIDER_CANCEL_WINDOW_EXPIRED`, `…_STAGE_INVALID`,
  `…_SCHEDULE_UNKNOWN`, `…_REASON_INVALID`, with `allowedUntil`,
  `noticeHours` and `hoursUntilStart` in `details`.
- `GET /api/v1/bookings/:id/transitions` returns `availableActions[]` evaluated
  by the **same guard**, so UI visibility and executor authorization are one
  decision. Pinned by a test that walks the window boundary
  (−10, 0, 1, 47, 47.9, 48, 48.1, 49, 72, 500 hours) and fails if the two ever
  disagree.
- **Clients must never compute the window.** They render `allowed`,
  `reasonCode` and `allowedUntil`.

Interim state: `providerController` still calls `evaluateCancellation` directly,
because `cancelAcceptedJob` has not migrated to `PROVIDER_CANCEL` yet. That is
one implementation with two callers, not two implementations — the controller's
call is deleted when the service migrates.

---

### 5. ADMIN_ASSIGN and ADMIN_REASSIGN are not interchangeable

Both end at `ASSIGNED`. `from` separates them structurally — assign only from
`AWAITING_ASSIGNMENT`, reassign only from a live assignment — and the executor
additionally refuses an assign onto a booking that already has a provider and a
reassign on one that does not.

The timeline has to keep `Assigned Provider A` distinct from
`Reassigned Provider A → Provider B`; that distinction cannot be reconstructed
afterwards, and an assign that quietly closed an existing assignment would be a
reassignment recorded under the wrong name. The outgoing assignment row is
closed as `REASSIGNED` rather than overwritten, which TAB 05 depends on.

---

### 6. Migration 027 is DEPLOYMENT-CRITICAL — the release order changes

`scripts/migrations/027-booking-lifecycle-timestamps.sql` makes
`accepted_at`, `en_route_at`, `arrived_at` and `declined_at` real columns.

They are currently created by lazy DDL in
`technicianService.ensureArrivalColumns()`. That was sufficient while
technicianService was the only writer, because every entry point awaited it.
The canonical executor now writes them and performs **no schema repair**, and
`POST /api/v1/provider/jobs/:id/{accept,en-route,arrived}` reaches the executor
without ever calling the lazy DDL.

**Do not restart the application onto code that depends on these columns before
027 has applied.** Required sequence for this release:

```
1. deploy artifact
2. npm run migrations:apply   (MIGRATION_REMOTE_ACK=<host>/<database>)
3. verify 027 recorded in servana.schema_migrations
4. verify the four columns exist, and the runtime role can write them
5. start / restart the application on the new code
6. authenticated v1 smoke: ACCEPT → EN_ROUTE → ARRIVED
```

If the current pipeline starts the application before migrations run, **change
the sequence for this release** rather than accepting a window where the v1
executor can hit a missing column.

Gates, and where each is proven:

| gate | status | proven by |
|---|---|---|
| idempotent (`ADD COLUMN IF NOT EXISTS` ×4) | PASS | `tests/migration-027-arrival-columns.test.ts` |
| column types match the lazy DDL | PASS | same, compared against the source of the lazy DDL |
| nullability / default semantics unchanged | PASS | no `NOT NULL`, no `DEFAULT` |
| no embedded BEGIN/COMMIT | PASS | same |
| one table, additive only | PASS | no DROP / RENAME / UPDATE / DELETE |
| OWNER / permissions compatible with the runtime role | **NOT TESTABLE HERE** | manual step 4 above |
| applies against the CURRENT production schema | **NOT TESTABLE HERE** | `migrations:plan` against production, then step 2 |

The last two are deliberately not claimed as covered. `ALTER TABLE` requires
table ownership, and this repository cannot read production's `pg_class`
ownership or its applied-migration ledger.

**`ensureArrivalColumns()` stays until all three hold:**

```
027 applied in production
+ authenticated arrival smoke passes
+ no rollback to a pre-027 schema is possible
```

Then it is removed in a **separate cleanup commit** — never combined with a
behaviour change, so a rollback of the cleanup cannot take a migration with it.

---

### 7. Executor refusals carry the locked snapshot

`TransitionError.snapshot` exposes the rows as they were when the refusal was
decided, so a caller owing its clients a richer vocabulary — provider accept and
decline owe six codes — classifies from the same read the refusal was made on
rather than from a second, unlocked one. Additive; no existing caller changes.
