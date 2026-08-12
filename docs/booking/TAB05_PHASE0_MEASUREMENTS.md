# TAB 05 Phase 0 — measurements

**Read-only. No code changed, no production queries run, nothing pushed.**

Capability findings are in [`CAPABILITY_QUERY_AUDIT.md`](./CAPABILITY_QUERY_AUDIT.md)
and are excluded here — they are blocked on a sequencing decision. Everything
below is independent of that choice.

---

## 1. Verdict criterion — can Job Order status diverge from Booking status?

**Yes. This is the blocking finding.**

`controllers/jobCardView.formatJobCard` emits:

```ts
status:       job.status,        // raw bookings.status
workerStatus: job.worker_status, // raw booking_workers.status
```

No `canonicalState`. `toProviderProjection` exists in
`services/booking/projections.ts` and is wired **only** into the v1 action
response (`api/v1/domains/bookingActions.ts:144`) — never into the job card.
Another foundation without callers, the same pattern that hid the Admin
divergence.

So a provider client is handed two raw legacy fields and has to derive state
itself, which is exactly the condition that let Admin's list and detail
disagree for the same booking.

### The good news: ONE formatter, THREE callers

```
controllers/jobCardView.formatJobCard
  ├── api/v1/domains/providerJobs.ts:46,68   GET /api/v1/provider/jobs[/:bookingId]
  ├── controllers/providerController.ts:2883,2901   Provider Web
  └── controllers/technicianController.ts:225       legacy mobile
```

Adding the canonical projection to the formatter reaches all three at once.
That is the single leverage point for this criterion.

### Two callers that DUPLICATE the formatter instead of calling it

Both already carry a comment admitting the duplication:

| Site | Comment |
|---|---|
| `controllers/providerController.ts:3180` | *"Same staged disclosure as `jobCardView.formatJobCard`, for the same…"* |
| `services/providerCalendarService.ts:83` | *"The disclosure level matches `jobCardView.formatJobCard`…"* |

These are parallel implementations of the PII staging rules. They will not be
fixed by changing the formatter, and each is a place the disclosure rules can
drift apart. They must be in the caller inventory.

---

## 2. Provider actions are a fifth derivation

`controllers/bookingActions.actionsForWorkerStatus(rawStatus)` is a `switch`
over `worker_status` returning the action list a provider sees.

It is **pinned to the canonical machine by an agreement test**
(`tests/booking-actions.test.ts`), not **generated from it**. TAB 04's
single-derivation inventory lists it as a permitted consumer for exactly this
reason.

An agreement test is weaker than generation: it proves the two agree *today*
for the cases it enumerates, and a new state added to the machine does not
automatically appear here. TAB 05 should generate this from
`allowedActions(state, 'assigned_provider')` the way the Admin SQL is now
generated from the branch list.

---

## 3. Schedule / availability predicates also diverge

Same shape as the capability finding: the authoritative committer uses the
cruder rule.

| Path | Conflict model |
|---|---|
| **Executor** `assertNoScheduleConflict` | fixed **±2 hours** around `bookings.schedule`. Ignores job duration. Timezone-naive arithmetic in JS. |
| **Availability engine** `providerAvailabilityEngine` | **half-open overlap against the job's real span**, `COALESCE(so.duration_mins, 120)`, evaluated `AT TIME ZONE` the provider's zone. |

Concretely, they disagree in **both** directions:

| Scenario | Executor | Availability engine |
|---|---|---|
| 30-min job 10:00, second job 11:30 | within ±2h → **refuses** | 10:00–10:30 vs 11:30 → **available** |
| 4-hour job 10:00, second job 13:00 | 13:00 outside 08:00–12:00 → **assigns** | 10:00–14:00 covers 13:00 → **conflict** |

So the committer **over-refuses short jobs and under-refuses long ones**. The
second row is the operationally damaging one: it double-books a provider on
work the availability engine already knew overlapped.

The executor is internally consistent — one implementation shared by
`ADMIN_ASSIGN` and `AUTO_ASSIGN`, which was TAB 04's goal — but it does not
agree with the engine that models availability properly.

**This is squarely TAB 05's brief** ("availability, schedule and capacity using
backend truth") and, unlike the capability question, it needs no production
evidence: `duration_mins` is already in the schema and already used.

---

## 4. Cross-provider leak surface — clean where measured

**Scope of this check: sampled, not exhaustive.** 185 routes exist across the
three provider route files (`technician` 21, `provider` 135, `providerCatalog`
29). I traced the highest-risk shapes — path-parameter resources and
fan-out reads — not all 185.

| Surface | Finding |
|---|---|
| `verifyOwnership` middleware | **Correct.** `req.user.uid !== req.params.uid \|\| req.params.workerId` → 403, and fail-closed when `req.user` is absent. |
| `GET /provider/earnings/:id` | **Scoped.** `WHERE b.id = $2 AND b.worker_uid = $1`; disbursement and assignment joins also pinned to `$1`. |
| `GET /provider/support/cases/:caseId` | **Correctly ordered.** `ownedCase()` throws 404 *before* the `Promise.all` fan-out, so the un-scoped `support_case_messages WHERE case_id = $1` is gated. Fragile-by-shape: moving `ownedCase` into the `Promise.all` would open it. Worth a guard. |
| Provider lifecycle actions | **Safe.** Identity from `actingWorkerUid` → token subject only; the executor re-authorizes from the locked assignment row. |
| `GET /api/workers/:workerId/job-cards` | **BOLA shape, guarded.** Provider uid in the path, behind `verifyAuth + verifyOwnership`. v1 removes the parameter; retirement gated on a ServanaWorker release. |

### One nuance, not yet a finding

Provider-scoped reads key on `bookings.worker_uid` — the **current** pointer,
not the assignment row. After `ADMIN_REASSIGN` that pointer moves, so:

- the **previous** provider loses read access to a job they actually worked;
- the **new** provider gains booking-level visibility (`final_price`,
  schedule, completion timestamps) covering the period before they were on it.

Whether that is a leak or the intended behaviour is a **product question**, not
a code defect, and it is exactly the "reassignment without leaking previous
provider-private information" item in the brief. It needs a decision before it
can be tested.

---

## 5. Legacy endpoint migration map — already exists

`docs/api/API_ENDPOINT_REGISTRY.md` and
`docs/api/LEGACY_ENDPOINT_MIGRATION_MATRIX.md` are **generated** from
`src/api/v1/contract.ts` and already carry the provider-jobs surface: eight v1
endpoints live, each with its legacy aliases and retirement gate.

```
GET  /api/v1/provider/jobs                      live
GET  /api/v1/provider/jobs/:bookingId           live
POST /api/v1/provider/jobs/:bookingId/accept    live
POST …/decline  …/en-route  …/arrived  …/start  …/complete
```

Aliases recorded with their reasons — e.g. `GET /api/worker/job-cards`
(Provider Web, legacy bare-array envelope) and `GET
/api/workers/:workerId/job-cards` (ServanaWorker, BOLA shape).

**TAB 05 should extend that generator, not write a second map.** A hand-written
`PROVIDER_JOB_V1_CONTRACT.md` would be a second source of truth for the same
facts — the mistake the capability layer is currently living with.

---

## 6. Proposed guards

Stated for review; none implemented.

1. **Job-card canonical projection** — `formatJobCard` emits `canonicalState`
   and `stateGroup` beside the raw fields, additively. Guard: the formatter's
   output must carry a canonical state, and a test asserts all three callers go
   through it.
2. **Generated provider actions** — derive `actionsForWorkerStatus` from
   `allowedActions(state, 'assigned_provider')`. Guard: a state in the machine
   with no action mapping fails the build, rather than silently offering
   nothing.
3. **Disclosure duplication** — a reviewed inventory of the two parallel PII
   implementations, each asserted to stage the same fields as the formatter.
4. **One conflict predicate** — extract the overlap rule so the executor and
   the availability engine share it. Behaviour change, declared separately:
   adopting the real-span rule *changes who can be assigned*.
5. **Ownership-before-fan-out** — a guard that `getCase`-shaped handlers
   resolve ownership before any un-scoped `case_id` query.

---

## 7. Security ambiguities needing a decision

1. **Reassignment visibility** (§4) — should the previous provider retain read
   access to a job they worked, and should the new provider see the pre-handover
   period? Currently: no, and yes, respectively.
2. **Conflict-rule change** — moving the executor to the real-span rule will
   refuse some assignments it currently allows and allow some it refuses. That
   is a live matching behaviour change and should not be folded silently into a
   centralisation commit.

---

## 8. Deliverable status

| Deliverable | State |
|---|---|
| Capability query audit | ✅ done — separate document |
| Provider action/state matrix | measured; blocked on guard 2 |
| Legacy provider endpoint migration map | ✅ exists, generated — extend it |
| Leak/security report | partial — sampled, ambiguities raised |
| `PROVIDER_JOB_V1_CONTRACT.md` | not started — should be generated |
| `MATCHING_ASSIGNMENT_CONTRACT.md` | not started |
| Assignment race test report | blocked — same test-database gap as TAB 04 |
| Final certification report | not started |

**Cannot certify today**, on the criterion in §1: Job Order status can diverge
from canonical Booking status. The other criterion — assignment authorized by
client-provided provider identity — is already satisfied.
