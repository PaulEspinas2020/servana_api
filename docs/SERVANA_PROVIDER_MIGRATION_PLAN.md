# Servana provider contract — migration plan

**Command 3 §20 deliverable.** What changes, in what order, and what must not be
changed yet.

## Context that sets the risk

**The platform is not yet live to the public and no real bookings exist.** That
is the reason several changes below are cheap now and would be expensive later —
particularly anything touching money or status values, where a live system would
need a backfill and a reconciliation rather than an edit.

It is also why the work should happen now rather than after launch.

## Done

| # | Change | Where | Commit |
|---|---|---|---|
| 1 | Authenticated successors for the legacy worker routes | backend | `a85998e` |
| 2 | ServanaWorker migrated off `/api/workers/*` | worker | `b94f7a1` |
| 3 | ServanaClient tracking moved to `GET /api/booking/:id/provider-location` | client | `0c8af75` |
| 4 | Legacy-route traffic telemetry | backend | prior |
| 5 | `activeJob`, `cancelledJobs`, payout hold, dashboard earnings, `completedAt` | backend | `2750bfd` |
| 6 | Additional work counts toward provider pay | backend | `8a38745` |
| 7 | Worker earnings fetched, not computed | worker | `b865bfa` |
| 8 | 80/20 defined once | backend | `fbeefc2` |
| 9 | Internal fixers split 80/20 like everyone else | backend | `cb79ace` |

## Next — ordered by risk, not by size

### 1. Delete the legacy `/api/workers/*` family

**Blocked on:** both client builds reaching the field, then telemetry reading
zero.

30 unauthenticated routes serving customer names, phone numbers and home
addresses. Both clients are migrated, so nothing legitimate calls them — but
old app versions live in the field for months, and the exposure is live until
the block is deleted, not until the migration lands.

Do not skip the observation window. Watch `legacyRouteTelemetry`, then delete.

### 2. Fix the rate-limit error body

**Safe now. Six call sites. No client change required.**

`express-rate-limit` emits `{status:'error', message}` — flat — while
`adminError` emits `{status:'error', error:{code,...}}` — nested. A client
branching on `status === 'error'` and reading `body.error.code` **throws on every
429**, which is exactly when it is already retrying.

### 3. Add `error.code` alongside the existing keys

**Additive. No client breakage.**

Eight error shapes across ~494 sites. Emit the canonical `error` object *as well
as* the current keys, so old and new parsers both work. Then teach clients to
prefer `error.code`. Then remove the legacy keys once telemetry shows nothing
reads them. Add a central error handler so a ninth shape cannot appear.

### 4. Normalise `CANCELLED` / `CANCELED`

**Needs a data migration. Do it before launch.**

`bookings` uses double-L, `booking_workers` single-L. Both are load-bearing today
and queries have been written against each. One counter already read zero for
months because of it.

With no production rows this is a schema decision rather than a data migration —
which will not be true after launch.

### 5. Remove the phantom statuses

`EN_ROUTE`, `ARRIVED`, `REJECTED`, `ACCEPTED`-as-booking-status,
`payments.REFUND_PENDING` are read in `WHERE` clauses and written nowhere. Each
is a filter that silently matches nothing.

Either implement the transition or delete the predicate. Leaving it is how
`activeJob` returned null for months while looking like working code.

### 6. Stop the payment webhook clobbering the lifecycle

`bookings.status = 'PAID'` is written unconditionally from any prior state, so a
`COMPLETED` booking becomes `PAID`. Payment state must live in `payments.status`;
the booking lifecycle must not be overwritten by it.

This one changes observable behaviour for anything reading `bookings.status` —
sequence it deliberately.

### 7. `availableActions`

Client-side action inference is a UX defect, not a security hole — the SQL guards
hold regardless. Build it after the correctness work above.

### 8. Idempotency keys

The four lifecycle transitions are idempotent in effect but return a failure on
replay, so a retry after a timeout looks like an error. Needs a key and a stored
result.

## Not to be done

- **Do not add `technicianUid` as an identity alias.** It exists in no source
  file in any repository. The standing platform rule listing it is wrong — see
  `SERVANA_PROVIDER_IDENTITY_MODEL.md`.
- **Do not add tax / tip / fee / deduction fields.** No backend counterpart
  exists. Naming them in a contract invents them.
- **Do not build `MARK_EN_ROUTE`, `MARK_ARRIVED`, `PAUSE_WORK`,
  `REQUEST_RESCHEDULE`, `OPEN_DISPUTE` or `REPORT_NO_SHOW` in a client.** No
  backend route exists for any of them; the result is a button that cannot work.
- **Do not let a client compute money.** Ever.

## Compatibility rules

1. **Additive first.** New optional field, new endpoint, alias alongside — never
   a rename in place.
2. **A shipped mobile build is a hard constraint.** Users take months to update;
   assume the current version is live indefinitely.
3. **Deprecate loudly, remove quietly.** Log usage of anything on the way out,
   and delete only when the log is silent.
4. **Unknown values must fail safe in every client** — an unrecognised status
   renders as unknown, an unrecognised action is ignored. That property is what
   makes additive change possible at all.
