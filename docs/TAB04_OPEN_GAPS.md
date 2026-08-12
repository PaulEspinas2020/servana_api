# TAB 04 — open gaps and deliberate behaviour changes

Live for the duration of the booking migration. Nothing here is closed by
being written down; each entry names what would close it.

---

## OPEN GAPS

### AUTH FLAKE — MECHANISM IDENTIFIED AND ELIMINATED; NOT YET DECLARED CLOSED

**Status:** `OPEN — CAUSE STRONGLY INDICATED, FIX APPLIED, AWAITING TIME`.
TAB 04 certification stays blocked until this has survived long enough to be
called closed on evidence rather than on a run of green results.

| | |
|---|---|
| Suite / test | `tests/v1-auth-security.test.ts` → `forgot-password answers identically for a real address, an unknown one and a mobile` |
| Occurrences | 2, in roughly a dozen full-suite runs (2026-08-12) |
| Since the fix | 5 consecutive clean full runs |

#### The detail that identified it

**Neither occurrence printed an `Expected` / `Received` diff**, while other
failures in the same runs printed theirs normally. An assertion mismatch always
prints a diff; a thrown error does not. So this was never a comparison failing
— it was `fetch` rejecting before any assertion ran.

That reframed the search away from the response body, and away from the
limiter, which had already been ruled out arithmetically: the failing call is
request **#1** for its identifier bucket AND the first request the app serves
in that file, so no counter can have been exhausted.

#### The mechanism

`http.Server.keepAliveTimeout` defaults to **5 seconds**. Node's `fetch`
(undici) pools connections and reuses them. Under a saturated full-suite run
the gap between two requests in one suite can exceed five seconds, and if the
server's idle timer fires just as undici dispatches on that socket, the request
rejects with a connection reset.

Every observation fits: load-only, never reproducible in isolation,
non-deterministic, no assertion diff.

#### The fix — harness only

`tests/support/httpTestServer.ts`, applied to all three suites that drive a
real socket with pooled `fetch` (`v1-auth-security`, `v1-router`,
`v1-legacy-telemetry`). `catalog-route-shadow` was checked and is not exposed —
it creates a server per request and uses raw `http.get`, so there is no pool.

Two independent measures, because either alone leaves a window:

1. `keepAliveTimeout` raised to 120s (and `headersTimeout` above it), so the
   timer cannot fire mid-suite;
2. `Connection: close` on every request, so there is no pooled socket to race
   over at all.

**No production behaviour was changed.** No limiter threshold, no timeout, no
assertion. A security test made to stop failing by weakening it is an
enumeration oracle with a green tick next to it.

The helper also names transport failures explicitly — `TRANSPORT FAILURE on
POST /path … this is a harness fault, not an assertion` — so a recurrence of
anything in this class identifies itself immediately instead of costing another
investigation.

#### Why this is not yet marked CLOSED, and what would close it

The mechanism is strongly indicated but was never captured in the act: both
occurrences were re-run before their output was read.

An arbitrary run count is not the bar — five clean runs is precisely the
evidence that existed twice before it recurred. It closes on:

```
no recurrence across the REMAINDER of TAB 04 (Phases C, D, E)
+ repeated saturated full-suite runs
+ the instrumented failure path still present
```

If it reappears, the named transport error and the captured RateLimit headers
will say immediately whether the keep-alive mechanism was the right diagnosis.
If it never reappears across that materially longer window, it closes as a
harness race with evidence — not because retries went green.

#### Related finding, now CLOSED: the typecheck gate did not cover tests

`npx tsc --noEmit` passed while `tests/v1-legacy-telemetry.test.ts` had an
undefined identifier — `tsconfig.json` sets `rootDir: ./src` and includes only
`src/**`, so the test tree was never compiled by the gate. Only jest's
transform compiled it, and a suite that fails to COMPILE does not fail its
assertions: it never runs. Jest reports one failed suite while the headline
test count silently drops (3645 → 3629), so a summary read by test count looks
like a smaller green run rather than a guard that stopped guarding.

Closed by three things:

- **`tsconfig.tests.json`** — extends the production config, adds
  `src + tests`, `noEmit`. Deliberately separate: `tests/` must never enter
  `rootDir`, the build output or the shipped artefact.
- **`npm run typecheck:tests`**, required by both `verify` and `verify:quick`.
  Verified by fixture, not assumed: with a deliberate fault in a test file the
  production typecheck exits **0** and this one exits **2**.
- **`tests/suite-inventory.test.ts`** — pins the suite count and reads the
  ignore list from `jest.config.js` rather than restating it, so a suite that
  is deleted, renamed or newly ignored must be acknowledged in a diff.

**Gate on all three, not on the test count alone:**

```
expected suite count      182
zero failed suites
legitimate test count
```

Any reduction requires an explicit explanation in the commit that causes it.

---

### POSTGRESQL LOCKING INTEGRATION — NOT YET PROVEN

`EXECUTOR RACE LOGIC: PASS` — the executor asks for the lock before deciding,
derives from the locked rows, and refuses the loser. Proven against a fake
database that serialises `FOR UPDATE`.

`POSTGRESQL LOCKING INTEGRATION: NOT YET PROVEN` — that real PostgreSQL honours
it under two concurrent accepts needs a real database. Required before TAB 04
certifies.

---

### MODEL LIMITATION — the PAID / CONFIRMED collapse, guard-compensated

**Deliberate for TAB 04. Not debt to be discovered later; debt with a trigger.**

`deriveCanonicalState` maps both of these to `AWAITING_ASSIGNMENT`:

```
PAID      + worker_uid NULL    paid, NOT yet OTP-confirmed
CONFIRMED + worker_uid NULL    confirmed, awaiting a provider
```

They share one operational reality — nobody is assigned — so the collapse is
correct for every purpose except one: whether `CUSTOMER_CONFIRM_OTP` may still
run. Because the booking OTP is never consumed, the code stays valid after
confirmation, and without something to separate the two a confirmed booking
could be confirmed again. The legacy SQL clause
`status = 'PENDING_OTP' OR (status = 'PAID' AND worker_uid IS NULL)` was the
only thing preventing that, and it was a second state machine.

**The model, as it stands:**

```
canonical operational state      AWAITING_ASSIGNMENT
transition precondition          bookingAwaitsOtpConfirmation = true | false
```

This is ACTION ELIGIBILITY, not a missing operational state. A new state
(`AWAITING_OTP_CONFIRMATION` or similar) would ripple into the customer,
provider and admin projections, state grouping, allowed-action tables, the
transitions endpoint, timeline copy, the 1,040-combination agreement matrix,
filters and analytics, notifications, and possibly installed clients — too
much semantic surface to change for one action-specific distinction that a
named precondition already expresses correctly.

**PROMOTE TO A CANONICAL STATE IF ANY BECOMES TRUE:**

- more than one action needs to distinguish the two;
- the UI must display the distinction;
- notifications depend on it;
- analytics or SLA measurement requires it;
- assignment behaviour differs between them;
- payment or refund behaviour differs between them.

Any of those means the distinction is broader than OTP eligibility, and the
honest answer becomes a state rather than a guard.

**The guard must stay narrow, and is held there by test:**

| pinned | where |
|---|---|
| exactly one action names it | `tests/booking-c-confirm-otp.test.ts` → *the guard stays narrow* |
| nothing outside the executor reads it | same |
| it derives no state — no `deriveCanonicalState`, no `canTransition` | same |
| both collapsed cases asserted directly | *the collapsed pair is intentional and observable* |

If the derivation ever changes so the two states differ, the guard is
**deleted**, not adjusted.

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
