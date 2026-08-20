# TAB 01 — the unpermissioned, unaudited path to payouts

> **Closes F-01 (P0) and F-10 (P1).** Rules engaged: §9 No Duplicate Reality,
> §10 REPEAT, §12 Backend Authorization, §15 Audit.
> Measured and implemented 2026-08-18 against `servana_api` at `1d97cb6`.

---

## 1. The defect, as it actually was

All four routes in `src/routes/disbursement.routes.ts` were guarded by
`verifyAuth, verifyRoles([1])` and nothing else. The same capability, on the
same `disbursements` rows, is exposed at `/api/admin/finance/payouts/*` behind a
named `payouts.*` permission on every route and an `auditFire` on every
mutation.

That is an authorization bypass even though each route reads as reasonable on
its own. Servana provisions admins with permissions deliberately withheld — one
live admin holds 214 grants with 18 dangerous ones withheld — so the permission
model is load-bearing: somebody is *meant* to be unable to move money. A second
unguarded path to the same domain service silently made that untrue.

### 1.1 The two "retry" routes were never the same operation

The book describes these as one capability with two guards. Reading them, they
are one capability with two guards **and two different behaviours**, and the
weaker-guarded path was the more powerful one:

| | `adminFinanceService.retryPayout` | `disbursementService.manualRetry` |
| --- | --- | --- |
| named permission | `payouts.retry_failed` | **none** |
| audit record | `finance_payout_retry_triggered` | **none** |
| retry cap | `PAYOUT_MAX_RETRIES = 3` | **none** — never read or incremented `retry_count`, so the cap was invisible to it |
| eligible status | `FAILED` only | anything except `PENDING` / `PROCESSING` / `RELEASED` |
| how the money moves | sets `PENDING`; the hourly job releases it, and that job honours an admin hold | **POSTs to PayMongo synchronously, inside the request** |

So an admin denied `payouts.retry_failed` could call the legacy route and push
an unbounded number of live transfers, leaving no record naming them.

**One thing the evidence did NOT support, stated because it was checked:** the
legacy path could not release a *held* payout. `holdPayout` leaves
`status = 'PENDING'` and writes `hold_reason`, and `manualRetry`'s update
excluded `PENDING` — so a held row failed its guard. The hold was safe. Only the
cap and the audit were not.

### 1.2 The sharpest part: the control already existed

`payouts.trigger_due_run` has been in the permission catalogue all along:

```
{ key: 'payouts.trigger_due_run', module: 'payouts',
  label: 'Trigger Due Payout Run', action_type: 'system',
  risk_level: 'critical', requires: ['payouts.view'],
  is_dangerous: true, display_order: 2010 }
```

**No route in the repository consulted it.** Somebody identified the due-payout
batch as dangerous, named the permission, and flagged it — and the route that
runs the batch never asked. F-01 is therefore a *bypass*, not an *absence*, and
the fix connects an existing control rather than inventing one.

## 2. What was changed

| Change | File | Why |
| --- | --- | --- |
| `payouts.view`, `payouts.details.view`, `payouts.retry_failed`, `payouts.trigger_due_run` added to the four routes | `src/routes/disbursement.routes.ts` | Copied from the finance twin, not chosen. The trigger's permission already existed. |
| `manualRetry` **deleted** | `src/services/disbursement.service.ts` | A guarded duplicate is still a duplicate (§9). A deleted function cannot be reached by any route — strictly stronger than guarding it. |
| `runDuePayoutBatch()` added, audited on success **and** failure | `src/services/adminFinanceService.ts` | The batch had no audited entry point. A trail recording only the runs that worked cannot answer "who tried". |
| `processPendingDisbursements()` returns `{selected, attempted, threw}` | `src/services/disbursement.service.ts` | An audit record saying "a batch ran" without saying how much it touched is barely a record. Additive — the cron ignores it. |
| Mutations delegate to the canonical service; reads keep their own shape | `src/controllers/disbursement.controller.ts` | See §3. |
| `scripts/lib/capabilityParity.ts` + `tests/authz-parity.test.ts` | new | The guard that closes the class, not the instance. |

## 3. Decisions taken autonomously, with their reasoning

**D1 — the finance surface is canonical.** It is permissioned, audited, capped,
and it is the one the admin portal actually calls (measured: the portal calls
none of the disbursement routes). The book agrees; the evidence agrees.

**D2 — converge the mutations, leave the read payloads alone.** Both writes now
delegate to `adminFinanceService`, so there is one implementation of "retry a
payout" and one of "run the due batch". The two reads keep their own queries and
their `{ success, disbursements }` envelope. Converging those would change a
response shape an unmeasured client may parse, and §4 forbids that. *The defect
was authorization; the payload was not.*

**D3 — delete `manualRetry` rather than guard it.** Its only caller was the
legacy controller, which now delegates. Leaving an uncapped, unaudited,
synchronous-release function in a money service is an invitation: wiring a route
to a function that exists is easier than writing one that does not.

**D4 — the behavioural change is stated, not hidden.** An admin retry now
*queues*: the row goes to `PENDING` and the hourly job releases it. That is
already what the admin portal experiences, because the portal calls the finance
surface — so this converges the odd one out onto the behaviour operations
already has, and onto the path that honours holds and the retry cap.

**D5 — the routes are NOT deleted.** Deleting a route while a caller may exist
is the one move §4 forbids outright, and the caller count outside the admin
portal has not been measured: the other five consumer repositories are not on
this machine. Guarded and converged now; retired later on telemetry showing
observed silence — not once somebody believes they are unused.

**D6 — no `Deprecation`/`Sunset` header yet, and this is deliberate.**
`src/api/v1/deprecation.ts` already implements RFC 8594 / RFC 8288 signalling,
derived from the v1 contract, and it requires an **implemented v1 successor**.
The successor for disbursements is TAB 06 wave 3, which does not exist yet.
Emitting `Link: rel="successor-version"` pointing at another *legacy* route
would tell clients to migrate to something that is itself scheduled for
retirement — actively harmful guidance, and precisely the failure that module's
own docblock warns against ("emitting a date the platform cannot keep is worse
than emitting none"). Writing a second, parallel deprecation mechanism to say it
anyway would be the duplicate reality this TAB exists to remove.
**Carried to TAB 06 as an explicit dependency.**

## 4. The gate: `tests/authz-parity.test.ts`

Two properties, both derived — nothing in the suite contains a list of routes, so
a third route to `retryPayout` fails it without anybody updating it.

- **Property A — deny by default on money.** Every route reaching a money-domain
  function must demand at least one named permission. This is what F-01
  violated. Stated as "at least one" rather than "the right one", because which
  permission is right is a judgement and whether there is one at all is not.
- **Property B — two routes to one money capability must be ordered.** One
  route's permission *closure* must contain the other's. **Containment, not
  equality** — and that correction came from the analyzer's first run, which
  flagged a pair that is not a defect: the retry route reads its own row back
  through `getPayoutDetail`, which the plain detail read also calls. The
  catalogue declares `payouts.retry_failed` as `requires: ['payouts.view',
  'payouts.details.view']`, so nobody holds the first without the second. The
  sets differ; the access does not. Comparing raw sets would have made this gate
  cry wolf on its first day, which is how a gate gets switched off.

**Mutation-verified. Watched failing, twice, against real source:**

```
MUTATION 1  strip requirePermission from POST /admin/finance/payouts/:id/retry
            → Property A fails: 1 failed, 13 passed

MUTATION 2  reintroduce the original F-01 — remove payouts.trigger_due_run from
            POST /admin/disbursements/trigger
            → 4 failed, 10 passed
```

Both reverted; the suite is green at 14/14. The suite also carries permanent
**positive controls** — synthetic fixtures reproducing the pre-fix state — so if
somebody weakens the detector, the fixtures go green and the suite fails on
them. The gate cannot rot into a check that always passes.

Measured coverage: **625 routes analysed, 404 resolved to a capability, 29 that
touch money, 0 violations of either property.**

## 5. What this found and did NOT fix — handed to TAB 10

The analyzer reports **24** capabilities reached by two or more routes with
differing permission sets. Exactly one was money (§4 above, adjudicated as not a
defect). The remaining **23 are outside this TAB's scope and are listed here
rather than silently dropped**, because a number produced by a matcher must be
spot-verified against real call sites before it is acted on — and adjudicating
23 route pairs inside a money TAB is how a P0 turns into a sweep.

They belong to **TAB 10 (Prove RBAC end to end)**, which generates the
authoritative matrix. Several are probably benign in the same way the payout
pair was — `requires`-chain containment rather than divergence. Some may not be.


| Capability | Routes | Guards |
| --- | --- | --- |
| `adminCommunicationService.ts#getNotificationTemplate` | 2 | `POST /api/admin/communications/templates/:templateKey/preview` → communications.templates.preview<br>`GET /api/admin/communications/templates/:templateKey` → communications.templates.view |
| `adminCommunicationService.ts#listCommunicationEvents` | 2 | `GET /api/admin/communications/events` → communications.notification_logs.view<br>`POST /api/admin/communications/export` → communications.export |
| `adminCommunicationService.ts#markEventRetried` | 2 | `POST /api/admin/communications/events/bulk-retry` → communications.bulk_retry_failed<br>`POST /api/admin/communications/events/:eventKey/retry` → communications.retry_failed |
| `adminGuestService.ts#getClientDetail` | 2 | `GET /api/admin/customers/clients/:identityId` → customers.read<br>`GET /api/admin/customers/clients/:identityId/addresses` → customers.addresses.view |
| `adminOnboardingService.ts#decideRequirement` | 3 | `POST /api/admin/provider-onboarding/requirements/:id/approve` → onboarding.requirement.approve<br>`POST /api/admin/provider-onboarding/requirements/:id/reject` → onboarding.requirement.reject<br>`POST /api/admin/provider-onboarding/requirements/:id/request-resubmission` → onboarding.requirement.request_resubmission |
| `adminOnboardingService.ts#getCaseDetail` | 2 | `GET /api/admin/provider-onboarding/cases/:caseId` → onboarding.case.view<br>`GET /api/admin/provider-onboarding/cases/:caseId/readiness` → onboarding.readiness.run |
| `adminProviderService.ts#getProviderIdentity` | 2 | `GET /api/admin/providers/:uid` → providers.profile.view<br>`POST /api/admin/providers/:uid/availability/force-offline` → providers.availability.force_offline |
| `catalogAdminService.ts#reorder` | 3 | `POST /api/admin/catalog/categories/reorder` → services.offering.edit<br>`POST /api/admin/catalog/subcategories/reorder` → services.offering.edit<br>`POST /api/admin/catalog/services/reorder` → services.specific.edit |
| `catalogAdminService.ts#updateCategory` | 2 | `PATCH /api/admin/catalog/categories/:categoryId/status` → services.offering.archive<br>`PATCH /api/admin/catalog/categories/:categoryId` → services.offering.edit |
| `catalogAdminService.ts#updateSubcategory` | 2 | `PATCH /api/admin/catalog/subcategories/:subcategoryId/status` → services.offering.archive<br>`PATCH /api/admin/catalog/subcategories/:subcategoryId` → services.offering.edit |
| `providerAutoOnlineEngine.ts#evaluateAllProviders` | 2 | `GET /api/admin/auto-online/backfill-preview` → auto_online.backfill_preview<br>`POST /api/admin/auto-online/backfill-apply` → auto_online.backfill_apply |
| `providerAutoOnlineEngine.ts#evaluateProvider` | 26 | `POST /api/auth/provider/register` → **none**<br>`POST /api/auth/add-employees` → **none**<br>`POST /api/workers/:uid/services` → **none**<br>`DELETE /api/workers/:uid/services/:serviceId` → **none**<br>`POST /api/provider/documents` → **none**<br>`DELETE /api/provider/documents/:documentId` → **none**<br>`POST /api/worker/onboarding/submit` → **none**<br>`POST /api/worker/service-applications` → **none**<br>`DELETE /api/worker/service-applications/:applicationId` → **none**<br>`PATCH /api/worker/services/:serviceId/pause` → **none**<br>`PATCH /api/worker/services/:serviceId/reactivate` → **none**<br>`DELETE /api/worker/services/:serviceId` → **none**<br>`PATCH /api/admin/providers/service-applications/:id/approve` → providers.status.change<br>`PATCH /api/admin/providers/service-applications/:id/reject` → providers.status.change<br>`POST /api/admin/providers/:uid/requirements` → providers.documents.upload<br>`DELETE /api/admin/providers/:uid/requirements/:id` → providers.documents.delete<br>`PATCH /api/admin/providers/:uid/requirements/:id/verify` → providers.documents.verify<br>`PATCH /api/admin/providers/:uid/requirements/:id/reject` → providers.documents.reject<br>`PATCH /api/admin/providers/:uid/requirements/:id/request-resubmission` → providers.documents.request_resubmission<br>`PATCH /api/admin/providers/:uid/account-status` → providers.status.change<br>`PATCH /api/admin/providers/:uid/archive` → providers.archive<br>`POST /api/admin/providers/:uid/services` → providers.services.assign<br>`DELETE /api/admin/providers/:uid/services/:serviceId` → providers.services.remove<br>`GET /api/admin/providers/:uid/auto-online/readiness` → auto_online.readiness.view<br>`POST /api/admin/providers/:uid/auto-online/re-evaluate` → auto_online.reevaluate<br>`POST /api/admin/providers/:uid/auto-online/enable-override` → auto_online.enable_override |
| `providerAvailabilityEngine.ts#cancelTimeOff` | 2 | `DELETE /api/worker/time-off/:id` → **none**<br>`PATCH /api/admin/providers/:uid/time-off/:timeOffId/cancel` → provider_availability.time_off.cancel |
| `providerAvailabilityEngine.ts#createTimeOff` | 2 | `POST /api/worker/time-off` → **none**<br>`POST /api/admin/providers/:uid/time-off` → provider_availability.time_off.add |
| `providerAvailabilityEngine.ts#getAvailabilityProfile` | 3 | `GET /api/worker/availability` → **none**<br>`GET /api/admin/providers/:uid/availability` → provider_availability.view<br>`GET /api/admin/providers/:uid/availability/timeline` → provider_availability.view |
| `providerAvailabilityEngine.ts#listTimeOff` | 2 | `GET /api/worker/time-off` → **none**<br>`GET /api/admin/providers/:uid/time-off` → provider_availability.view |
| `providerAvailabilityEngine.ts#saveWeeklySchedule` | 3 | `PUT /api/worker/availability` → **none**<br>`PUT /api/admin/providers/:uid/availability` → provider_availability.weekly_schedule.edit<br>`DELETE /api/admin/providers/:uid/availability` → provider_availability.weekly_schedule.edit |
| `providerOperationalAvailabilityService.ts#setOffline` | 2 | `POST /api/provider/location/go-offline` → **none**<br>`POST /api/admin/providers/:uid/availability/force-offline` → providers.availability.force_offline |
| `providerProfileMediaService.ts#listProfilePhotos` | 2 | `GET /api/provider/profile-photo-submissions` → **none**<br>`GET /api/admin/providers/:uid/profile-photo-submissions` → providers.profile.view |
| `providerProfileMediaService.ts#previewProfilePhoto` | 2 | `GET /api/provider/profile-photo-submissions/:submissionId/preview` → **none**<br>`GET /api/admin/providers/:uid/profile-photo-submissions/:submissionId/preview` → providers.profile.view |
| `providerServiceAreaEngine.ts#getServiceAreaProfile` | 2 | `GET /api/worker/service-area` → **none**<br>`GET /api/admin/providers/:uid/service-area` → provider_service_area.view |
| `providerServiceAreaEngine.ts#saveServiceArea` | 2 | `PUT /api/worker/service-area` → **none**<br>`PUT /api/admin/providers/:uid/service-area` → provider_service_area.edit |
| `technicianService.ts#assignServicesToEmployee` | 2 | `POST /api/workers/:uid/services` → **none**<br>`POST /api/admin/providers/:uid/services` → providers.services.assign |

> Note also `GET /api/workers/:uid/disbursement-history`, which reads
> disbursement data through `technicianService` and so does not trip Property A.
> It is a provider self-read behind `verifyAuth + verifyOwnership`, not an admin
> money route — correct as it stands, recorded so the omission is deliberate
> rather than missed.

## 6. Acceptance criteria

| Criterion | State | Evidence |
| --- | --- | --- |
| No route reaches `processPendingDisbursements` or `manualRetry` without a named payout permission | **MET** | `manualRetry` deleted; every batch route asserted permissioned by test |
| Every payout mutation writes an audit record naming the admin actor, from either path | **MET** | Both mutations delegate to `adminFinanceService`, which audits; the batch audits on failure too |
| The authorization-parity test exists, is mutation-verified, and runs in `verify` | **MET** | `tests/authz-parity.test.ts`, 14 tests, two mutations demonstrated red |
| Proven additive: no route removed or renamed; the four other client repos unchanged and unreleased | **PARTIAL** | No route removed or renamed, and no client repo was touched. But §4 demands this be proven *by reading* those repositories, and they are not on this machine — manual task 01.2. |

## 7. Deployment risk and rollback

Enforcing a permission can lock out an admin who legitimately lacked the grant.
Super Admins bypass `requirePermission`, so the batch stays reachable for them;
every other operator needs `payouts.trigger_due_run` granted first.

**Grant first, enforce second.** If a lockout occurs the reversal is a grant —
never a redeploy that removes the guard. The grant query is a production read
this environment is not authorised to perform: manual task **01.1**.
