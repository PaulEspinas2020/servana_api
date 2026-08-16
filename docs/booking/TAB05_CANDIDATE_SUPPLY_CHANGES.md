# TAB 05 — declared changes to who gets offered a job

Centralising a predicate is supposed to be invisible. Six of these are not:
they change **which providers appear as candidates**, **which bookings block a
provider**, **which table is asked first**, and **how long a job is understood
to last**.

Five of the six move a PREVIEW or a SELECTOR to agree with the COMMITTER, so
they cannot change what the executor accepts. **§5 is the exception** — it
changes the rule itself, in both directions, and is declared first for that
reason.

Written by hand deliberately. The generated
[`JOB_MATCHING_V1_CONTRACT.md`](./JOB_MATCHING_V1_CONTRACT.md) describes the
system as it is now; this describes the step, and a generator cannot know which
of its outputs is new.

---

## The rule these follow

> The preview moves to meet the committer, not the other way round.

Changing what COMMITS is a larger behaviour change than changing what a preview
says. And a preview that is *narrower* than its committer does not fail safe:
it hides providers the assign call would have accepted, which reads to an
operator as "nobody is available" and to a provider as "I never get work".

---

## 0. The capability SOURCE moves to `catalog_provider_services`

**Files:** `services/booking/eligibilityPipeline.ts`,
`services/booking/capabilitySource.ts`,
`services/booking/capabilityProjection.ts`, migration
`029-capability-canonical-source.sql`, and the five capability-change writers.

| | Before | After |
|---|---|---|
| Primary source | legacy family grants only | `catalog_provider_services`, keyed on `services.id` |
| Grain | `service_families.id` (10 coarse families) | `services.id` (95 bookable services) |
| Fallback | — | the legacy family grants, **instrumented and counted** |
| Kept current by | nothing since the Catalog V2 cutover | every approval, grant, revoke, pause and reactivate |

**Direction: NEUTRAL, by construction.** Capability is now
`canonical OR legacy`, and the canonical rows are a fan-out OF the legacy
grants — so canonical is a subset of legacy and the union is exactly today's
assignable set. Nobody gains or loses capability on the day this ships.

That is the whole design. Reading the canonical table ALONE would have been a
narrowing, and a severe one: the table was backfilled once during the Catalog V2
cutover and then nothing wrote it again, so every grant made since existed only
in the legacy tables. Adopting it blind would have unassigned those providers
silently — the exact failure this tab exists to prevent.

**What is new and visible:**

- a `CAPABILITY_LEGACY_FALLBACK` warning on any candidate the canonical table
  could not qualify. Not a blocker: the executor accepts them, and hiding them
  would re-create the divergence. It costs candidate rank, and it is the visible
  edge of a missing canonical row;
- `diagnostics.capabilitySource` on every candidate pool, carrying
  `capableCanonical`, `capableLegacyOnly` and `canonicalCovers`;
- `npm run capability:parity`, which reports the grants the fallback is still
  carrying, and `npm run capability:reconcile`, which projects them.

**What to watch:** `capableLegacyOnly` and the `legacyOnly` runtime counter. Both
should fall to zero after migration 029 and stay there. A rise means a writer
stopped projecting.

**If it is wrong:** the fallback is still in the predicate, so no provider can
lose work. Revert order is: stop projecting (writers), then re-run parity — the
canonical rows are additive and harmless if left in place.

**Retirement of the fallback is NOT part of this change.** It is gated on
`CANONICAL_ADOPTION_CRITERIA`: 30 days of zero fallback decisions, a clean
parity report, every writer projecting, and a reconciler run.

---

## 1. Admin candidate preview: capability

**File:** `services/providerEligibilityEngine.ts`

| | Before | After |
|---|---|---|
| Qualification | `employee_services` row with `COALESCE(status,'active') = 'active'` | `PROVIDER_CAPABILITY_SQL` — an `employee_services` row at **any** status **OR** an approved `worker_service_application` |

**Direction: WIDENING.** Two groups become visible that were assignable all
along:

- providers whose approval exists only as an approved application, because the
  mirror into `employee_services` had not run;
- providers whose `employee_services` row carries a non-active status.

The second group is offered with a new `SERVICE_GRANT_INACTIVE` **warning**,
which costs them candidate rank (score < 100) rather than eligibility. Hiding
them would restore the divergence; promoting them silently would hide a real
signal.

**What to watch:** candidate counts per booking rising, and whether the
inactive-grant warning appears on providers an operator would not expect.

**If it is wrong:** the fix is NOT to re-narrow the preview — it is to decide
whether `employee_services.status` should gate qualification at the
**committer**, which is blocked on the lazy-DDL hazard recorded in
`eligibilityPipeline.ts`.

## 2, 3, 4. Occupancy: which bookings mark a provider busy

The canonical list is `NON_OCCUPYING_STATUSES` —
`COMPLETED`, `CANCELLED`, `CANCELED`, `REFUNDED`, `FAILED`, `EXPIRED`. Three
sites carried their own shorter list:

| Site | Before | Missed |
|---|---|---|
| `providerAvailabilityEngine.explainAvailability` | `'CANCELLED', 'COMPLETED'` | `CANCELED`, `REFUNDED`, `FAILED`, `EXPIRED` |
| `providerAvailabilityEngine.findTimeOffBookingConflicts` | `'CANCELLED', 'COMPLETED'` | same four |
| `adminBookingService.getAssignmentCandidates` | `'COMPLETED','CANCELLED','CANCELED'` | `REFUNDED`, `FAILED`, `EXPIRED` |

**Direction: WIDENING.** Fewer false conflicts. Concretely:

- a booking cancelled under the **one-L production spelling** no longer marks a
  provider busy in the Admin availability answer;
- a **refunded** booking no longer blocks a provider's time-off request.

The one-L spelling is the operationally significant one: both spellings exist
in live data (`scripts/normalise-cancelled-spelling.ts`), so this was not a
theoretical gap.

**What to watch:** providers becoming available at times they previously
appeared busy; time-off requests that previously reported a conflict now
succeeding.

---

## 5. The conflict rule: fixed ±2 hours → the job's real span

**Files:** `services/booking/eligibilityPipeline.ts` (the rule),
`transitionExecutor`, `technicianService`, `adminBookingService`,
`providerAvailabilityEngine`, `providerCalendarService`.

| | Before | After |
|---|---|---|
| Rule | `\|existing.schedule − candidate.schedule\| ≤ 2h` | `existing.start < candidate.end AND existing.end > candidate.start` |
| Job length | ignored | `service_options.duration_mins`, default 120 |
| Boundaries | n/a | half-open: a job ending at 12:00 does not collide with one starting at 12:00 |
| Arithmetic | JS `Date`, server timezone | `timestamptz`, timezone-independent |

**Direction: BOTH.** This is the one change in this document that is not a pure
widening, and it is stated first for that reason.

| Scenario | Before | After |
|---|---|---|
| 30-min job 10:00, second job 11:30 | **refused** | **allowed** — supply increases |
| 4-hour job 10:00, second job 13:00 | **assigned** | **refused** — a real double-booking closed |
| Back-to-back, 10:00–12:00 then 12:00 | refused | allowed |
| Job with no `duration_mins` | ±2h either side | 2h forward only |

The last row is worth reading twice: the old rule reached two hours BACKWARDS
from the schedule, which is time a job does not occupy. Even for the default
duration, the new rule frees the two hours before a job.

**Why now, when the previous revision of this document said not yet.** Two
conditions had to hold, and both do:

1. **Centralisation came first.** Changing eligibility *and* centralising it in
   one step would have made a supply change impossible to attribute. Every
   producer now shares one predicate, so the policy moves once.
2. **There are no live booking records.** Provider records are live; client,
   order and booking records are not. There is no historical assignment for the
   new rule to re-decide, so the delta is prospective only — which is exactly
   the evidence the earlier "measure first" caveat was asking for and could not
   get.

**Fallback, not invented:** `service_options.duration_mins` is declared
`INT NOT NULL DEFAULT 120`, and three live queries already read it as
`COALESCE(duration_mins, 120)`. `DEFAULT_SERVICE_DURATION_MINS` names that
existing convention. NULL, zero and negative all fall back to it — zero being
the dangerous case, since a zero-length span overlaps nothing and would make a
provider infinitely bookable at that instant.

**What to watch:** short-job providers becoming assignable in windows that
previously refused them; long-job assignments now refused that previously
succeeded. Both are the rule working.

**If it is wrong:** the rule is one declaration. Reverting is a change to
`OVERLAPS_SPAN_SQL` and nothing else — no caller holds a copy.

## 6. The provider calendar draws what the matcher reserves

**File:** `services/providerCalendarService.ts`

| | Before | After |
|---|---|---|
| Block length | `duration_mins` → `eta_minutes` → 60 min | `duration_mins` → 120 min |

`eta_minutes` is the TRAVEL estimate, not the job length, so a 10-minute drive
drew a 10-minute job. And the terminal fallback was 60 minutes while every
occupancy question in the backend assumed 120 — so a provider looking at their
own calendar saw a free hour the matcher would refuse to fill.

**Direction: mostly WIDENING** (blocks get longer, matching the reservation).
Narrower only where `eta_minutes` exceeded the real duration, in which case the
old block was drawing travel time as work.

The calendar answers "can I get from the 10am to the 2pm?". It has to draw the
time the system is actually holding.

---

## What did NOT change

- **Who is assignable, on the day of the change.** Every capability change above
  is a union or a widening onto the committer's own predicate.
- **The legacy tables.** Migration 029 and the reconciler write only
  `catalog_provider_services`; no legacy row, provider record or booking is
  touched, and nothing is deleted anywhere.
- **`bookings.service_option_id`.** Still authoritative for the booking's
  service. The canonical `services.id` is RESOLVED from it
  (`bookingCanonicalServiceSql`), never written over it.

Stated because a centralisation commit is exactly where these would hide.

- **`AUTO_ASSIGN` target validation.** Still `LEGACY_AUTO`: role, active state
  and capability are not revalidated at commit for auto-assignment. Closing it
  is a tightening, so it needs the candidate-delta measurement first
  (`LEGACY_AUTO_DELTA_RUNBOOK.md`).
- **The capability FALLBACK.** The legacy family grants are still in the
  predicate. Removing them is a separate, gated step — see §0.
- **What the executor commits.** Every change above moved a preview or a
  selector onto the executor's existing predicates. No provider becomes
  assignable who was not already.

---

## One correction that is not a behaviour change

`technicianService.getAvailableWorkers` asked `role::int = 2`, excluding every
role-4 provider, and qualified through an INNER JOIN on `employee_services`. It
now uses the canonical role predicate and grant fragment.

**No behaviour change: the function has no route.** It is corrected rather than
left alone because a divergent predicate sitting in a live service file is one
`git grep` away from being wired up as though it were canonical.
