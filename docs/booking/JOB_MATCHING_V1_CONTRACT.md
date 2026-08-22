<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-booking-docs.ts, derived from
    src/services/booking/canonicalState.ts   (states, transition whitelist)
    src/services/booking/transitionExecutor.ts (action registry)
    src/services/booking/eligibilityPipeline.ts (stages, capability and conflict predicates)
    src/services/booking/capabilitySource.ts   (canonical adoption criteria)
    src/services/booking/candidateDiagnostics.ts (zero-candidate reasons, blocker precedence)
    src/api/v1/contract.ts                     (endpoints, callers, legacy dispositions)
  Regenerate: npm run booking:docs
-->

# Job + matching contract (v1)

A provider Job is a **projection of a Booking**, not a second record with a
lifecycle of its own. Matching qualifies providers with **one** set of
predicates, and the executor commits with the same ones.

## 1. Endpoints and their callers

Every capability below is one backend domain service. Where a role-specific
endpoint remains, §3 states why the authorization differs — never the truth.

| Endpoint | Status | Customer Mobile | Customer Web | Provider Mobile | Provider Web | Admin |
|---|---|---|---|---|---|---|
| `GET /api/v1/provider/jobs` | implemented | · | · | `migrated` | `migrated` | · |
| `GET /api/v1/provider/jobs/:bookingId` | implemented | · | · | `migrated` | `migrated` | · |
| `GET /api/v1/provider/jobs/:bookingId/evidence` | implemented | · | · | `planned` | `planned` | · |
| `POST /api/v1/provider/jobs/:bookingId/evidence` | implemented | · | · | `planned` | `planned` | · |
| `DELETE /api/v1/provider/jobs/:bookingId/evidence/:evidenceId` | implemented | · | · | `planned` | `planned` | · |
| `GET /api/v1/provider/jobs/:bookingId/cancellation-eligibility` | implemented | · | · | `planned` | `planned` | · |
| `POST /api/v1/provider/jobs/:bookingId/accept` | implemented | · | · | `migrated` | `migrated` | · |
| `POST /api/v1/provider/jobs/:bookingId/decline` | implemented | · | · | `migrated` | `migrated` | · |
| `POST /api/v1/provider/jobs/:bookingId/en-route` | implemented | · | · | `migrated` | `migrated` | · |
| `POST /api/v1/provider/jobs/:bookingId/arrived` | implemented | · | · | `migrated` | `migrated` | · |
| `POST /api/v1/provider/jobs/:bookingId/start` | implemented | · | · | `migrated` | `legacy` | · |
| `POST /api/v1/provider/jobs/:bookingId/complete` | implemented | · | · | `migrated` | `migrated` | · |
| `POST /api/v1/provider/jobs/:bookingId/cancel` | implemented | · | · | `migrated` | `migrated` | · |
| `GET /api/v1/admin/bookings/:bookingId/assignment-candidates` | implemented | · | · | · | · | `legacy` |
| `POST /api/v1/admin/bookings/:bookingId/assign` | implemented | · | · | · | · | `legacy` |
| `POST /api/v1/admin/bookings/:bookingId/reassign` | implemented | · | · | · | · | `legacy` |

`legacy` means the client is still on the pre-v1 path listed in §5 and the
alias is live. Shared surfaces move additively until every client has migrated.

## 2. One domain service per capability

| Endpoint | Domain service |
|---|---|
| `GET /provider/jobs` | `services/technicianService.getJobCardsByWorker + controllers/jobCardView.formatJobCard` |
| `GET /provider/jobs/:bookingId` | `services/technicianService.getJobCardByWorker + controllers/jobCardView.formatJobCard` |
| `GET /provider/jobs/:bookingId/evidence` | `services/bookingEvidenceService.listEvidence + blockingRequirements` |
| `POST /provider/jobs/:bookingId/evidence` | `services/bookingEvidenceService.submitEvidence` |
| `DELETE /provider/jobs/:bookingId/evidence/:evidenceId` | `services/bookingEvidenceService.removeEvidence` |
| `GET /provider/jobs/:bookingId/cancellation-eligibility` | `services/booking/bookingPolicies.evaluateCancellation` |
| `POST /provider/jobs/:bookingId/accept` | `services/booking/transitionExecutor.transitionBooking (PROVIDER_ACCEPT)` |
| `POST /provider/jobs/:bookingId/decline` | `services/booking/transitionExecutor.transitionBooking (PROVIDER_DECLINE)` |
| `POST /provider/jobs/:bookingId/en-route` | `services/booking/transitionExecutor.transitionBooking (PROVIDER_EN_ROUTE)` |
| `POST /provider/jobs/:bookingId/arrived` | `services/booking/transitionExecutor.transitionBooking (PROVIDER_ARRIVED)` |
| `POST /provider/jobs/:bookingId/start` | `services/booking/transitionExecutor.transitionBooking (PROVIDER_START)` |
| `POST /provider/jobs/:bookingId/complete` | `services/booking/transitionExecutor.transitionBooking (PROVIDER_COMPLETE)` |
| `POST /provider/jobs/:bookingId/cancel` | `services/booking/transitionExecutor.transitionBooking (PROVIDER_CANCEL)` |
| `GET /admin/bookings/:bookingId/assignment-candidates` | `services/providerEligibilityEngine.listAssignmentCandidatePool` |
| `POST /admin/bookings/:bookingId/assign` | `services/booking/transitionExecutor.transitionBooking (ADMIN_ASSIGN)` |
| `POST /admin/bookings/:bookingId/reassign` | `services/booking/transitionExecutor.transitionBooking (ADMIN_REASSIGN)` |

## 3. Why provider and admin assignment stay separate endpoints

They are separated by **authorization**, not by business truth: every one of
them commits through `transitionBooking`, against the same state machine,
with the same guards.

- A provider action derives identity from the **token** and the **locked
  assignment row**. It cannot name another provider, so there is no payload in
  which `providerUid` would mean anything.
- An admin action's entire purpose is to name another actor as the provider,
  which requires a permission a provider does not hold
  (`bookings.assign_provider`, `bookings.reassign_provider`).

Collapsing them into one endpoint would mean accepting a provider identity in a
body on a route providers can call — the exact shape this system forbids.

## 4. The state machine is shared, so a Job cannot diverge from its Booking

11 assignment and provider actions, all on the one executor:

| Action | To | Actor | From | Advisory lock | Target validation | Reason required |
|---|---|---|---|---|---|---|
| `PROVIDER_ACCEPT` | `ACCEPTED` | Assigned provider | _any legal source_ | — | — | — |
| `PROVIDER_DECLINE` | `AWAITING_ASSIGNMENT` | Assigned provider | `ASSIGNED` | — | — | — |
| `PROVIDER_EN_ROUTE` | `EN_ROUTE` | Assigned provider | _any legal source_ | — | — | — |
| `PROVIDER_ARRIVED` | `ARRIVED` | Assigned provider | _any legal source_ | — | — | — |
| `PROVIDER_START` | `IN_PROGRESS` | Assigned provider | _any legal source_ | — | — | — |
| `PROVIDER_COMPLETE` | `COMPLETED` | Assigned provider | _any legal source_ | — | — | — |
| `PROVIDER_CANCEL` | `AWAITING_ASSIGNMENT` | Assigned provider | `ACCEPTED` `EN_ROUTE` `ARRIVED` | — | — | — |
| `ADMIN_ASSIGN` | `ASSIGNED` | Admin | `AWAITING_ASSIGNMENT` | `PROVIDER_ASSIGNMENT` | `FULL` | — |
| `AUTO_ASSIGN` | `ASSIGNED` | System | `AWAITING_ASSIGNMENT` | `PROVIDER_ASSIGNMENT` | `FULL` | — |
| `ADMIN_REASSIGN` | `ASSIGNED` | Admin | `ASSIGNED` `ACCEPTED` `EN_ROUTE` `ARRIVED` | `PROVIDER_ASSIGNMENT` | `FULL` | **yes** |
| `ADMIN_CONFIRM_ASSIGNMENT` | `ACCEPTED` | Admin | `ASSIGNED` | — | — | — |

### The override audit model

`ADMIN_REASSIGN` refuses to run without a non-empty `metadata.reason`, checked **before any write**. Together
with the actor and the outgoing and incoming provider uids — all written inside
the same transaction as the assignment itself — that is the record which makes a
manual override reviewable months later.

Declared on the action rather than checked by a caller, so an internal script, a
future controller or a job cannot move a booking between providers and leave a
timeline entry with an empty description.

## 5. Legacy routes still serving these capabilities

| Legacy | Successor | Disposition | Why it still exists |
|---|---|---|---|
| `GET /api/worker/job-cards` | `GET /api/v1/provider/jobs` | ALIAS_TEMPORARILY | Provider Web calls this today. Same service, same view function, legacy envelope (a bare array). |
| `GET /api/workers/:workerId/job-cards` | `GET /api/v1/provider/jobs` | ALIAS_TEMPORARILY | ServanaWorker calls this. Takes the provider uid from the PATH; it is now behind verifyAuth + verifyOwnership, but the parameter remains a BOLA shape that v1 removes. Retirement gated on a ServanaWorker release. |
| `GET /api/worker/job-cards/:bookingId` | `GET /api/v1/provider/jobs/:bookingId` | ALIAS_TEMPORARILY | Provider Web. Same service and view function. |
| `GET /api/provider/bookings/:bookingId/evidence` | `GET /api/v1/provider/jobs/:bookingId/evidence` | ALIAS_TEMPORARILY | Same service. The path moves under /provider/jobs to sit with the transitions. |
| `POST /api/provider/bookings/:bookingId/evidence` | `POST /api/v1/provider/jobs/:bookingId/evidence` | ALIAS_TEMPORARILY | SAME implementation after TAB 07 extracted it. clientRequestId is OPTIONAL there and REQUIRED here - demanding one on the legacy route would break shipped clients. |
| `DELETE /api/provider/bookings/:bookingId/evidence/:evidenceId` | `DELETE /api/v1/provider/jobs/:bookingId/evidence/:evidenceId` | ALIAS_TEMPORARILY | Same service. Soft removal, scoped by worker uid inside the UPDATE. |
| `GET /api/provider/bookings/:bookingId/cancellation-eligibility` | `GET /api/v1/provider/jobs/:bookingId/cancellation-eligibility` | ALIAS_TEMPORARILY | Same policy function, same context loader. Only the path and envelope differ. |
| `PUT /api/worker/bookings/:bookingId/accept` | `POST /api/v1/provider/jobs/:bookingId/accept` | ALIAS_TEMPORARILY | The live provider action. Still writes status directly via technicianService; Phase B of the executor migration. Authorization is equivalent — both resolve the provider from the token and check the CURRENT assignment. |
| `PUT /api/worker/bookings/:bookingId/decline` | `POST /api/v1/provider/jobs/:bookingId/decline` | ALIAS_TEMPORARILY | The live provider action. Still writes status directly via technicianService; Phase B of the executor migration. Authorization is equivalent — both resolve the provider from the token and check the CURRENT assignment. |
| `PUT /api/worker/bookings/:bookingId/en-route` | `POST /api/v1/provider/jobs/:bookingId/en-route` | ALIAS_TEMPORARILY | The live provider action. Still writes status directly via technicianService; Phase B of the executor migration. Authorization is equivalent — both resolve the provider from the token and check the CURRENT assignment. |
| `PUT /api/worker/bookings/:bookingId/arrived` | `POST /api/v1/provider/jobs/:bookingId/arrived` | ALIAS_TEMPORARILY | The live provider action. Still writes status directly via technicianService; Phase B of the executor migration. Authorization is equivalent — both resolve the provider from the token and check the CURRENT assignment. |
| `PUT /api/worker/bookings/:bookingId/start` | `POST /api/v1/provider/jobs/:bookingId/start` | ALIAS_TEMPORARILY | The live provider action. Still writes status directly via technicianService; Phase B of the executor migration. Authorization is equivalent — both resolve the provider from the token and check the CURRENT assignment. |
| `PUT /api/worker/bookings/:bookingId/complete` | `POST /api/v1/provider/jobs/:bookingId/complete` | ALIAS_TEMPORARILY | The live provider action. Still writes status directly via technicianService; Phase B of the executor migration. Authorization is equivalent — both resolve the provider from the token and check the CURRENT assignment. |
| `POST /api/provider/bookings/:bookingId/cancel` | `POST /api/v1/provider/jobs/:bookingId/cancel` | ALIAS_TEMPORARILY | The live Provider Web / Provider Mobile cancel. It ALREADY runs the executor and the same providerCancellationWindow guard — this entry gives it a canonical path and a v1 error vocabulary, it does not give it a second implementation. |
| `GET /api/provider/bookings/:bookingId/cancellation-eligibility` | `POST /api/v1/provider/jobs/:bookingId/cancel` | KEEP | NOT a duplicate. It answers "may I cancel, and until when" without cancelling, from the same evaluateCancellation function. The canonical successor for that question is the availableActions block on GET /bookings/:id/transitions. |
| `GET /api/admin/bookings/:id/assignment-candidates` | `GET /api/v1/admin/bookings/:bookingId/assignment-candidates` | CANONICALIZE | Live, and the only caller is the admin portal. Already returns the canonical pool plus its diagnostics; the diagnostics are a sibling key so the array under `data` stays exactly what the portal parses today. |
| `POST /api/admin/bookings/:id/assign` | `POST /api/v1/admin/bookings/:bookingId/assign` | CANONICALIZE | Live admin portal route, already on the canonical executor. Path-only migration: the business rules, locks and events do not move with it. |
| `POST /api/admin/bookings/:id/reassign` | `POST /api/v1/admin/bookings/:bookingId/reassign` | CANONICALIZE | Live admin portal route, already on the canonical executor. A separate permission from assign (bookings.reassign_provider), which is the reason it stays a separate endpoint rather than an assign with a different body. |

## 6. Matching hard constraints

The pipeline, in order. **Commit-critical** stages are the ones that can change
between selecting a provider and writing the row, so the executor repeats
exactly those inside the transaction — and only those. Re-running ranking under
a row lock would hold the lock for a scoring pass; a stale ranking is a
suboptimal assignment, a stale conflict check is a double-booked provider.

| # | Stage | Owner | Commit-critical | Why |
|---|---|---|---|---|
| 1 | `providerIdentityExists` | TAB05 | no | A uid that resolves to no provider cannot become one mid-assignment. |
| 2 | `canonicalProviderRole` | TAB05 | no | Roles 2 AND 4. Asking role = 2 reported role-4 providers as "not found", the least diagnosable message available — fixed in TAB 04 D4. |
| 3 | `activeNotArchived` | TAB05 | **yes** | RACES. A provider can be archived or deactivated between ranking and commit, and assigning a deactivated provider is exactly the case deactivation exists to prevent. |
| 4 | `capabilityForBookingService` | TAB05 | **yes** | Rechecked because it is cheap and because a revoked qualification between selection and commit would put an unqualified provider on a job. |
| 5 | `serviceAreaAndGeography` | TAB05 | no | A service area is edited by the provider, not by the flow of other bookings, so it does not race with an assignment in progress. |
| 6 | `availabilityForSchedule` | TAB05 | no | Declared availability — the weekly pattern and time off. Changed by the provider, not by concurrent assignment. |
| 7 | `bookingConflict` | TAB05 | **yes** | THE race. Two bookings selecting the same provider both read "no conflict" and both commit unless the check is repeated while holding the provider advisory lock. This is what that lock is FOR. |
| 8 | `capacityAndOperationalLimits` | TAB05 | no | No capacity limit is enforced today. Declared so the stage exists before somebody adds one somewhere else. |
| 9 | `distanceEtaRankingScoring` | TAB05 | no | Ranking, not eligibility. Never re-run at commit: a stale ranking is a suboptimal assignment, not an incorrect one. |
| 10 | `selectCandidate` | TAB05 | no | The output of selection. Everything after this is commit machinery. |
| 11 | `revalidateCommitCritical` | EXECUTOR | **yes** | Re-runs ONLY the commit-critical stages, inside the transaction, with the booking row locked and the provider advisory lock held. |
| 12 | `commitThroughTransitionBooking` | EXECUTOR | **yes** | AUTO_ASSIGN / ADMIN_ASSIGN / ADMIN_REASSIGN. The only writer. |

Repeated under lock by the executor: `activeNotArchived`, `capabilityForBookingService`, `bookingConflict`.

### Capability

Qualification for a service, run identically by candidate generation, Admin
assignment and the executor:

```sql
SELECT 'CANONICAL' AS source FROM <schema>.catalog_provider_services g
   WHERE g.provider_uid = $1 AND g.service_id = $2 AND g.status = 'active'
  UNION ALL
  SELECT 'LEGACY_EMPLOYEE_SERVICE' AS source FROM <schema>.employee_services g
   WHERE g.employee_uid = $1 AND g.service_id = $3
  UNION ALL
  SELECT 'LEGACY_APPROVED_APPLICATION' AS source FROM <schema>.worker_service_applications g
   WHERE g.worker_uid = $1 AND g.service_id = $3 AND g.status = 'approved'
```

**`catalog_provider_services` is the authoritative source**, keyed on the
canonical `services.id` (`$2`). It is asked first and every decision records
which source answered.

The legacy family grants — `employee_services` and `worker_service_applications` —
remain as an **instrumented fallback**, keyed on the legacy
`service_families.id` (`$3`). They are two different id spaces: one family
implies every bookable service under it, up to 54, so the predicate takes both
rather than converting one to the other.

Removing the fallback today would be a NARROWING, and a narrowing of capability
is the silent supply collapse this tab exists to prevent: a provider whose
canonical row was never projected would simply stop being assignable. Because
canonical rows are a fan-out OF the legacy grants, canonical is a subset of
legacy and the union preserves today's assignability exactly.

A provider qualified only by the fallback is offered with a
`CAPABILITY_LEGACY_FALLBACK` warning rather than hidden, and one qualified
only by an inactive legacy grant with `SERVICE_GRANT_INACTIVE`. The executor
would commit both, and a preview narrower than its committer hides assignable
providers instead of failing safe.

`employee_services.status` is still not filtered: that column is created by
lazy DDL, so filtering on it would make qualification depend on which code path
ran first. The canonical table has a real `status` column with a CHECK
constraint and IS filtered — one of the reasons to move.

#### Retiring the fallback

Measured, not promised. `npm run capability:parity` reports the grants the
fallback is still carrying; the criteria are:

- `zeroFallbackDays`: `30`
- `requireParityClean`: `true`
- `requireAllWritersProject`: `true`
- `requireReconcilerRun`: `true`

### Conflict

**Half-open overlap against each job's real span.** Two jobs conflict when

```
existing.start < candidate.end  AND  existing.end > candidate.start
```

where `end = schedule + duration`. Half-open on both sides, so a job ending at
12:00 does not collide with one starting at 12:00 — back-to-back work is the
normal shape of a day, and the time-off collision rule already used this form.

Duration comes from `service_options.duration_mins`. NULL, zero and negative
all fall back to **120 minutes**, which is the
column's own default and the convention every existing query already used. Zero
is the dangerous case: a zero-length span overlaps nothing, so one bad row would
make a provider infinitely bookable at that instant.

Statuses that do **not** occupy a provider:
`COMPLETED`, `CANCELLED`, `CANCELED`, `REFUNDED`, `FAILED`, `EXPIRED`. Both cancellation
spellings are listed because both exist in production data.

The comparison is between `timestamptz` values, so it is timezone-independent
by construction — unlike the fixed window it replaced, which did its arithmetic
on JS `Date` objects in the server's zone.

This REPLACED a fixed ±2 hours around the scheduled time, which ignored job
length and was wrong in both directions: it blocked a provider for four hours
around a 30-minute job, and let a second job be assigned three hours into a
four-hour one. Both spans are now resolved in SQL from the booking rows, so a
preview and its committer cannot disagree about how long a job lasts.

### The auto-assignment gap: **CLOSED**

`AUTO_ASSIGN` used to validate its target more weakly than `ADMIN_ASSIGN` —
skipping `canonicalProviderRole`, `activeNotArchived`, `capabilityForBookingService` —
so the matching engine could commit a provider an admin would be refused.

AUTO_ASSIGN declares targetValidation: 'FULL'. The refusal is skippable — the caller walks a ranked candidate list, so a refused provider costs a candidate rather than a booking — and every refusal is attributed to a candidate-diagnostics reason code and counted in autoAssignDiagnostics.

Still outstanding: **nothing** — every producer of an assignment now passes the same hard constraints under the same two locks.

## 7. Candidate diagnostics

"No providers available" is emitted identically when nobody holds the service,
when everybody who does is deactivated, and when the pool was capped before
anyone was evaluated. The pool therefore carries a diagnosis.

| Reason | What it means | What to do |
|---|---|---|
| `BOOKING_HAS_NO_SERVICE` | This booking is not tied to a canonical service, so provider capability cannot be evaluated. | Fix the booking's service option before assigning. |
| `NO_PROVIDER_POPULATION` | No provider accounts were returned by the candidate query at all. | Supply problem or a broken population query — not a per-provider block. |
| `NO_PROVIDER_HAS_CAPABILITY` | No provider holds this service. The pool is empty by catalog, not by rules. | Approve a provider for this service, or reassign the booking to a service somebody holds. |
| `POOL_TRUNCATED_BEFORE_EVALUATION` | Capable providers exist but the pool was capped before they were evaluated, so "none available" is not a supply fact. | Raise the cap or narrow the population; do not read this as zero supply. |
| `ALL_CANDIDATES_BLOCKED` | Every evaluated provider was blocked. The dominant blocker names the stage. | Read dominantBlocker — one cause usually accounts for the whole pool. |

A blocked provider is attributed to **one** cause, the earliest of:

`ACCOUNT_INACTIVE` → `ACCOUNT_ARCHIVED` → `PROVIDER_ACTIVATION_NOT_ACTIVE` → `PROVIDER_COMPLIANCE_BLOCKED` → `PROVIDER_COMPLIANCE_UNAVAILABLE` → `NO_ACTIVE_SERVICE` → `SERVICE_POLICY_UNAVAILABLE` → `NO_SERVICE_AREA` → `CITY_NOT_IN_AREA` → `BRANCH_NOT_IN_AREA` → `NO_AVAILABILITY_SET` → `DAY_NOT_AVAILABLE` → `OUTSIDE_SCHEDULE_WINDOW` → `TIME_OFF` → `BOOKING_CONFLICT`

running from "this account cannot work at all" to "this account cannot work on
THIS job", so the dominant cause reported is the most general true one.

Two counts make the diagnosis possible:

- **capable** — providers holding the canonical grant for the service,
  unfiltered by account state. The denominator: zero eligible out of zero
  capable is a catalog fact, zero out of fourteen is an incident. A failed
  count reports `null`, never `0`.
- **population / evaluated / cap** — a bound on the pool is necessary, but a
  bound applied to a name-ordered list is an undeclared filter. It is published,
  so "none available" can never silently mean "sorted after the cap".

`supplyCollapse.suspected` is raised only when capable providers exist and
none are assignable. Truncation is reported separately: folding it in would
make one flag mean two things.
