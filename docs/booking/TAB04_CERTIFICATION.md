# TAB 04 — Booking Core + Canonical State Machine

## Verdict

**CERTIFIED WITH ONE NAMED BLOCKER, AND ONE DEPLOYMENT PRECONDITION.**

The migration is complete and the code gate is met. What is *not* met is a
proof that requires infrastructure this repository does not have and that could
not be self-served without touching production. That is stated as a blocker
rather than absorbed, because the difference between "we proved it" and "we
believe it" is the whole point of the exercise.

```
RAW STATUS MUTATION OUTSIDE EXECUTOR   0            ✔  (was 21)
CANONICAL STATE DERIVATIONS            1            ✔  (was 2 independent)
EXECUTOR RACE LOGIC                    PASS         ✔  fake-database proof
POSTGRESQL LOCKING INTEGRATION         BLOCKED_BY_TEST_DATABASE   ✖
AUTH FLAKE                             CLOSED       ✔  5,560 clean executions
MIGRATION 027 APPLIED IN PRODUCTION    NOT PROVEN   ⚠  deploy precondition
typecheck (src)                        clean        ✔
typecheck (tests)                      clean        ✔
generated docs (api + booking)         no drift     ✔
suites / tests                         188 / 3,785 green ✔
deployed                               NOTHING      — local only, as instructed
```

---

## What "certified" covers

**Every lifecycle write in the backend goes through `transitionBooking`.** Not
most of them, and not the ones that were convenient — the count is zero, it is
enforced by `tests/booking-raw-write-guard.test.ts` with an approved baseline of
**0**, and the boundary rule itself is tested against synthetic fixtures so the
detector cannot rot into a rubber stamp.

Migrated, one commit each, behaviour preserved unless declared:

| Phase | Actions |
|---|---|
| A | canonical machine, executor, idempotency, worker-code atomicity |
| B1 | `PROVIDER_ACCEPT` `PROVIDER_DECLINE` `PROVIDER_EN_ROUTE` `PROVIDER_ARRIVED` `PROVIDER_START` |
| B2 | `PROVIDER_COMPLETE` |
| C | `CUSTOMER_CONFIRM_OTP` `CUSTOMER_CANCEL` |
| D | `ADMIN_CONFIRM_ASSIGNMENT` `ADMIN_CANCEL` `ADMIN_APPROVE_COMPLETION` `ADMIN_ASSIGN` `ADMIN_REASSIGN` |
| E | `PROVIDER_CANCEL` `AUTO_ASSIGN` |

Three services reached zero raw writes: `bookingService`,
`adminBookingService`, `technicianService`.

### Nine latent defects, found by measuring rather than assuming

Each was either fixed or preserved-and-documented; none was fixed silently.

1. A declined provider read as `ASSIGNED` and could accept the same job again —
   an ended assignment is not an assignment.
2. `canTransition` let a decline be executed as a cancellation, because two
   actions shared a `(to, actor)` pair. Fixed with `from` restrictions plus a
   class-level collision detector, which immediately caught a second instance
   of the same mistake in my own code.
3. Role-4 providers were reported "Provider not found" — the least diagnosable
   message available — because one predicate said `role = 2` while the same
   file used `IN (2, 4)` elsewhere.
4. Auto-assignment and admin assignment took the booking and provider locks in
   **opposite orders**. That is a deadlock; it is now one order for every
   producer.
5. A booking wildcard route was eating a sibling; service-level tests never
   resolve a URL and so could not see it.
6. The typecheck gate did not cover the test tree at all.
7. The auth "flake" was a real mechanism — `keepAliveTimeout` racing undici's
   pooled socket — not noise.
8. `bookings.status` was not rewritten on decline, leaving derivations
   disagreeing with reality.
9. Guards could reach a writable client; they are now read-only by construction.

### The discipline that produced them

Classification by measurement before implementation; behaviour changes declared
separately from migrations; guards followed to their new home rather than
deleted; positive **and** negative fixtures for every detector; and the symbol
inventory diffed before and after each rewrite — which is how two silently
dropped functions (`handleProviderReassignment`, `ensureCancellationColumns`)
were caught rather than shipped.

---

## The blocker

### `POSTGRESQL LOCKING INTEGRATION: BLOCKED_BY_TEST_DATABASE`

Not PASS. Not FAIL. The seven-race suite is written, complete and committed
(`tests/booking-postgres-races.test.ts`); it has never executed, because there
is nothing safe to execute it against.

Every existing suite proves the executor **asks** for the right locks in the
right order. None proves PostgreSQL **honours** it — the fakes serialise
`FOR UPDATE` because they were written to.

Two things are needed, and neither is self-servable:

1. a **schema-only** production-compatible snapshot restored into a
   disposably-named database (no data required);
2. production's **PostgreSQL major version**, for equivalence.

No production access was taken to obtain either. The repository contains no
`CREATE TABLE bookings`, so the schema cannot be built from it; a hand-written
approximation would run and would certify nothing, which is worse than an open
gap. Full detail, including the three safety refusals and the exact run
command, is in [`../TAB04_OPEN_GAPS.md`](../TAB04_OPEN_GAPS.md).

---

## The deployment precondition

### Migration 027 must apply BEFORE the executor deploys

`scripts/migrations/027-booking-lifecycle-timestamps.sql` makes `accepted_at`,
`en_route_at`, `arrived_at` and `declined_at` real columns. **The executor
writes them and performs no schema repair.** Deploying the code first produces
runtime failures on the provider lifecycle.

Release order, non-negotiable:

```
1. apply 027 in production, verify the four columns exist
2. THEN deploy the executor
3. THEN (separate cleanup commit) remove ensureArrivalColumns()
```

A migration that carries its own `BEGIN`/`COMMIT` cannot be dry-run — the inner
`COMMIT` ends the wrapping transaction on production — so 027 deliberately
carries neither; the runner wraps it.

---

## Still open, deliberately

Carried with named triggers rather than quietly, in
[`../TAB04_OPEN_GAPS.md`](../TAB04_OPEN_GAPS.md):

- the `PAID`/`CONFIRMED` collapse, guard-compensated with a promotion trigger;
- `LEGACY_AUTO` target validation weaker than `FULL`, made explicit rather than
  accidental;
- worker-code rotation on reassignment — a product decision, not a bug;
- provider acceptance-rate distortion from admin reassignment;
- the jest worker-teardown warning, measured as pre-existing;
- fixed-window source-slicing in older suites, a detector-hygiene cleanup.

---

## What this does not certify

The five consumers have not been re-verified against the migrated backend.
Nothing here has been deployed, and the standing instruction is that the backend
stays local. Consumer certification is `CONNECT`'s job, and it should run
against a backend whose locking has actually been proven — which is to say,
after the blocker above is cleared.
