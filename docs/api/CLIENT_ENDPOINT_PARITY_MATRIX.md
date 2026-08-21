<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-convergence-docs.ts, derived from
    src/api/v1/convergence.ts      (the federated capability registry)
    src/api/v1/contract.ts         (the canonical endpoints and their callers)
    src/api/v1/legacyTelemetry.ts  (retirement criteria)
    the seven domain policy registries
  Regenerate: npm run convergence:docs
-->

# Client endpoint parity matrix

> Every cell is computed from `V1_CONTRACT[].callers`. Nothing here is typed by
> hand, because a stale "migrated" cell reads as permission to delete the alias
> behind it — and on mobile that is an outage nobody can correct for weeks.

## 1. Summary

| | |
| --- | --- |
| Capabilities | 72 |
| Canonical endpoints mounted | 161 |
| Canonical endpoints planned | 1 |
| Legacy mappings tracked | 174 |
| Converged (one route family) | 64 |
| Role-split over ONE service | 4 |
| Single-surface | 4 |
| **Divergent (forked truth)** | **0** |
| Broken (names a missing endpoint) | 0 |
| Surface × capability cells on canonical | 34 |
| Surface × capability cells still legacy | 92 |

**0 divergent capabilities.** Every capability whose
endpoints span more than one route family names exactly one domain service — the
role split is a permission boundary, never a second implementation.

**34 cells on canonical.** Each one is derived from that client's published manifest — the endpoints it calls, generated from its own source with a file:line per call site — and never asserted here by hand. A client with no manifest reads legacy, planned or n/a regardless of what it may already have shipped, because nothing in this repository has verified it; see src/api/v1/client-manifests/.

## 2. Legend

| Cell | Meaning |
| --- | --- |
| **migrated** | This client calls the canonical v1 route today |
| legacy | This client calls a legacy route the canonical entry supersedes |
| planned | This client will migrate; it calls no equivalent today |
| ⚠ mixed | This client has migrated SOME endpoints of this capability and not others |
| — | The capability does not apply to this client |

`⚠ mixed` exists because a client halfway through a capability is neither
migrated nor legacy, and rounding it to either would make the matrix lie in the
direction of whoever wrote it.

| Verdict | Meaning |
| --- | --- |
| `SHARED` | One route family; every surface that performs it calls the same endpoints |
| `ROLE_SPLIT_SHARED_SERVICE` | Several route families by role, proven over ONE domain service |
| `SINGLE_SURFACE` | Only one surface performs this operation at all |
| `DIVERGENT` | Role-split families naming different services — a forked business truth |
| `BROKEN` | The capability names a contract id that does not exist |

## 3. The matrix

| Capability | Verdict | Customer Mobile | Customer Web | Provider Mobile | Provider Web | Admin Web |
| --- | --- | --- | --- | --- | --- | --- |
| Manage my saved addresses | SHARED | legacy | legacy | — | — | — |
| What is left before my account is usable | SHARED | planned | planned | **migrated** | planned | — |
| Read and change my customer profile | SHARED | legacy | legacy | — | — | planned |
| Read and change my account record | SHARED | ⚠ mixed | ⚠ mixed | ⚠ mixed | ⚠ mixed | planned |
| Find out why I cannot work yet, and what to do about it | SHARED | — | — | planned | planned | — |
| Read and change my availability, and book time off | SHARED | — | — | ⚠ mixed | legacy | — |
| Attest a credential, and see what became of it | SHARED | — | — | planned | planned | — |
| Change the verified email or mobile my account recovers through | SHARED | — | — | planned | planned | — |
| Submit, read, preview and withdraw my documents | SHARED | — | — | ⚠ mixed | ⚠ mixed | — |
| Read and change my provider profile | SHARED | — | — | ⚠ mixed | ⚠ mixed | planned |
| Read the services I am approved for | SHARED | — | — | **migrated** | planned | — |
| Read my security posture | SHARED | planned | planned | planned | planned | planned |
| Read and change my settings | SHARED | planned | planned | **migrated** | planned | planned |
| Operate the booking queue | SINGLE_SURFACE | — | — | — | — | legacy |
| Register, sign in, and end a session | SHARED | legacy | ⚠ mixed | legacy | ⚠ mixed | legacy |
| Recover an account and verify a contact | SHARED | ⚠ mixed | ⚠ mixed | ⚠ mixed | ⚠ mixed | legacy |
| Record that cash changed hands | SHARED | — | — | planned | planned | — |
| Read booking-code state | SHARED | planned | planned | **migrated** | **migrated** | planned |
| Read a booking | SHARED | ⚠ mixed | ⚠ mixed | ⚠ mixed | planned | planned |
| Move a booking through its state machine | ROLE_SPLIT_SHARED_SERVICE | — | — | **migrated** | ⚠ mixed | legacy |
| Ask which commit is serving | SHARED | — | — | — | — | — |
| Browse the service catalog | SHARED | ⚠ mixed | planned | legacy | — | — |
| Search services | ROLE_SPLIT_SHARED_SERVICE | ⚠ mixed | planned | — | — | — |
| Ask whether this client build may still run | SHARED | planned | — | planned | — | — |
| Fetch the contract this process implements | SHARED | planned | planned | planned | planned | planned |
| Find out whether I may cancel, and why not | SHARED | — | — | planned | planned | — |
| Prove the work happened | SHARED | — | — | planned | planned | — |
| Read the support cases I raised on a booking | SHARED | planned | planned | — | — | — |
| A provider's own job queue | SHARED | — | — | **migrated** | **migrated** | — |
| Say whether I am working, where I am, and that I am safe | SHARED | — | — | planned | planned | — |
| Read a provider's public profile | SHARED | planned | planned | — | — | planned |
| See what customers said about me, and answer it | SHARED | — | — | planned | planned | — |
| Decide what work I am offered | SHARED | — | — | planned | planned | — |
| Raise a case with Servana, and follow it | SHARED | — | — | planned | planned | — |
| Resolve a refund review | SINGLE_SURFACE | — | — | — | — | legacy |
| Read the reschedule history of a booking | SHARED | planned | planned | planned | **migrated** | planned |
| Report that the product is working | SINGLE_SURFACE | — | — | planned | — | — |
| Register and release this device for push | SHARED | legacy | planned | **migrated** | **migrated** | — |
| Dismiss one notification | SHARED | planned | planned | planned | **migrated** | — |
| Read my notification inbox | SHARED | legacy | legacy | legacy | **migrated** | planned |
| Mark everything read | SHARED | legacy | legacy | legacy | **migrated** | planned |
| Mark one notification read | SHARED | legacy | legacy | legacy | **migrated** | planned |
| Read and change my notification preferences | ROLE_SPLIT_SHARED_SERVICE | planned | planned | legacy | ⚠ mixed | planned |
| How many unread I have | SHARED | legacy | legacy | legacy | **migrated** | planned |
| Additional work | SHARED | planned | planned | **migrated** | ⚠ mixed | planned |
| Cancellation | ROLE_SPLIT_SHARED_SERVICE | legacy | legacy | **migrated** | **migrated** | — |
| Disputes | SHARED | planned | planned | **migrated** | **migrated** | ⚠ mixed |
| Booking codes (OTP) | SHARED | legacy | planned | planned | **migrated** | planned |
| Reschedule | SHARED | planned | planned | — | — | legacy |
| Tracking | SHARED | legacy | legacy | **migrated** | **migrated** | planned |
| Provider earnings summary | SHARED | — | — | legacy | **migrated** | — |
| Provider earnings transactions | SHARED | — | — | legacy | **migrated** | — |
| Start or resume a booking payment | SHARED | legacy | legacy | — | — | planned |
| Read a booking's payment and price breakdown | SHARED | planned | planned | **migrated** | planned | planned |
| Provider payouts | SHARED | — | — | legacy | **migrated** | — |
| Admin ledger reconciliation | SINGLE_SURFACE | — | — | — | — | legacy |
| Refund a booking payment | SHARED | planned | planned | — | — | legacy |
| The composed home surface | SHARED | planned | planned | — | — | — |
| Which sections exist and what owns each | SHARED | planned | planned | — | — | planned |
| Attach a file to a conversation | SHARED | planned | planned | planned | planned | planned |
| Read one conversation and its participants | SHARED | legacy | legacy | legacy | **migrated** | legacy |
| List my conversations with unread counts | SHARED | legacy | legacy | legacy | **migrated** | legacy |
| Advance the read pointer | SHARED | legacy | legacy | legacy | **migrated** | legacy |
| Open (or resolve) a booking conversation | SHARED | legacy | legacy | legacy | **migrated** | legacy |
| Report a message to moderation | SHARED | planned | planned | planned | planned | — |
| Send a message | SHARED | legacy | legacy | legacy | **migrated** | legacy |
| Page through a conversation transcript | SHARED | legacy | legacy | legacy | **migrated** | legacy |
| Raise a support case about a completed booking | SHARED | planned | planned | — | — | — |
| Read a provider's published reviews | SHARED | planned | planned | — | — | — |
| A provider's rating summary | SHARED | planned | planned | — | — | — |
| Read the review I wrote for a booking | SHARED | legacy | legacy | — | — | — |
| Review a completed booking | SHARED | legacy | legacy | — | — | — |

## 4. Correction cost, which is the migration order

Migrate in reverse order of correction cost. A web client is a git push from
being fixed; a mobile client keeps calling whatever the installed build knows
for as long as the customer leaves the app installed.

| Client | Correction cost | Deploy shape | Zero-traffic window before an alias may go |
| --- | --- | --- | --- |
| 1. Admin Web | minutes | Netlify from git — the push is the deploy | 14 days |
| 2. Provider Web | minutes | push to main is a production deploy | 14 days |
| 3. Customer Web | hours | Angular, not yet deployed | 14 days |
| 4. Provider Mobile | days–weeks | Play review, then the installed base updates | 90 days |
| 5. Customer Mobile | days–weeks | Play review; the largest installed base | 90 days |

## 5. Verified delegations

A capability may name two service modules without being a fork when one is a
decision layer over the other. Each delegation below names the file and the
import that make it true, and `tests/cross-platform-convergence.test.ts` reads
those files — an exemption that stops being true stops being granted.

**`services/events/notificationPreferences` → `services/notificationService`** (evidence: `src/services/events/notificationPreferences.ts`, `from '../notification.service'`)

TAB 09 added a DECISION layer — which categories exist, what the defaults are, whether a category may go out on a channel — over the existing store. It reads and writes through `getNotificationPrefs`/`saveNotificationPrefs` and touches no table itself, because two writers to one preference row is how a provider's saved choices get overwritten by a customer-shaped default map. So `/me/notification-preferences` and `/settings/notification-preferences` read ONE table through ONE writer.

## 6. Every capability

### Manage my saved addresses

- key: `accountPolicy:addresses` · declared in `services/account/accountPolicy`
- verdict: **SHARED** · domain service: `services/account/addressBookService`
- route families: `/customer`

Canonical:
  - `GET /api/v1/customer/addresses`
  - `POST /api/v1/customer/addresses`
  - `PATCH /api/v1/customer/addresses/:addressId`
  - `DELETE /api/v1/customer/addresses/:addressId`
  - `POST /api/v1/customer/addresses/:addressId/default`

Legacy still aliased for this capability:
  - `DELETE /api/user/deleteaddress`
  - `GET /api/user/alluseraddresses`
  - `POST /api/user/adduseraddress`
  - `PUT /api/user/makeaddressprimary`

No role split. Five legacy routes with five shapes — query-param ids, a POST that doubles as an update, a separate make-primary verb — become one REST resource with stable ids. Every statement is owner-scoped in SQL rather than checked in a controller.

### What is left before my account is usable

- key: `accountPolicy:completion` · declared in `services/account/accountPolicy`
- verdict: **SHARED** · domain service: `services/account/profileCompletionService`
- route families: `/me`

Canonical:
  - `GET /api/v1/me/completion`

Legacy still aliased for this capability:
  - none

No role split; the RULES differ by role and are declared, not branched. One endpoint answers both, which is what stops a welcome card from inventing its own definition of complete and showing a green tick over an account that cannot take work.

### Read and change my customer profile

- key: `accountPolicy:customerProfile` · declared in `services/account/accountPolicy`
- verdict: **SHARED** · domain service: `services/account/accountService`
- route families: `/customer`

Canonical:
  - `GET /api/v1/customer/profile`
  - `PATCH /api/v1/customer/profile`

Legacy still aliased for this capability:
  - `GET /api/user/profile`
  - `PUT /api/user/updateprofile`

Role-specific by DATA, not by authorization: birth date and gender exist for a customer and mean nothing for a provider. Customer Web and Customer Mobile call the identical route with the identical DTO, which is what the release gate asks for.

### Read and change my account record

- key: `accountPolicy:identity` · declared in `services/account/accountPolicy`
- verdict: **SHARED** · domain service: `services/account/accountService, services/identityService`
- route families: `/me`

Canonical:
  - `GET /api/v1/me`
  - `PATCH /api/v1/me`

Legacy still aliased for this capability:
  - `GET /api/auth/me`
  - `PUT /api/user/updateprofile`

No role split. One identity record for every account, and the ROLE-specific data is deliberately not here — `/me` carries a pointer to which extensions exist, not their contents. A `/me` that carried the provider compliance state would be fetched by every screen, used by almost none, and cached everywhere.

### Find out why I cannot work yet, and what to do about it

- key: `accountPolicy:providerActivation` · declared in `services/account/accountPolicy`
- verdict: **SHARED** · domain service: `services/account/providerActivationProjection, services/providerActivationService, services/providerProfileComplianceService`
- route families: `/provider`

Canonical:
  - `POST /api/v1/provider/activation/policy-acknowledgement`
  - `GET /api/v1/provider/activation`
  - `GET /api/v1/provider/verification-timeline`

Legacy still aliased for this capability:
  - `GET /api/provider/account-state`
  - `GET /api/provider/compliance`
  - `GET /api/provider/verification-timeline`
  - `POST /api/provider/activation/policy-acknowledgement`

DELIBERATELY not folded into providerProfile, and that separation is the whole design. The ProviderProfile schema serves two seats - the provider reading their own, and a CUSTOMER reading somebody else's - so an activation checklist added to it would be declared, in the published contract, as travelling on the endpoint customers read. Rendering a provider card and driving an onboarding checklist are different purposes over different data, and separate capabilities let authorization, retention and caching differ per purpose instead of all three being set by whichever purpose is laxest. No role split within the capability: both provider surfaces perform the identical operation and receive the identical DTO. Auth is `provider`, which is STRICTER than the account-state route it supersedes and equal to the compliance route it also supersedes - the parity gate refused the looser first draft, because compliance detail must not become reachable one rung lower as a side effect of a migration. The discovery property survives: requireProviderRole admits every provider role including suspended and unapproved, so the caller who needs to know why they cannot work still gets the checklist, and a non-provider receives the branchable ROLE_REQUIRED. The uid comes from the token and no parameter can name another account.

### Read and change my availability, and book time off

- key: `accountPolicy:providerAvailability` · declared in `services/account/accountPolicy`
- verdict: **SHARED** · domain service: `services/providerAvailabilityEngine`
- route families: `/provider`

Canonical:
  - `GET /api/v1/provider/availability`
  - `PATCH /api/v1/provider/availability`
  - `DELETE /api/v1/provider/time-off/:timeOffId`
  - `POST /api/v1/provider/time-off`
  - `GET /api/v1/provider/time-off`

Legacy still aliased for this capability:
  - `DELETE /api/worker/time-off/:id`
  - `GET /api/worker/availability`
  - `GET /api/worker/time-off`
  - `POST /api/worker/time-off`
  - `PUT /api/worker/availability`

No role split. The canonical route reads and writes the SAME engine matching consumes, which is the release gate: a provider editing one source while matching reads another is a provider who is unbookable for reasons nobody can see.

### Attest a credential, and see what became of it

- key: `accountPolicy:providerCertifications` · declared in `services/account/accountPolicy`
- verdict: **SHARED** · domain service: `services/providerProfileComplianceService`
- route families: `/provider`

Canonical:
  - `POST /api/v1/provider/certifications`
  - `GET /api/v1/provider/certifications`

Legacy still aliased for this capability:
  - `GET /api/provider/certifications`
  - `POST /api/provider/certifications`

No role split. Separate from providerDocuments because the two are a FILE and an ASSERTION ABOUT a file, and they fail differently: a document can be unreadable, a certification can be expired or revoked while its document is perfectly legible. The submission carries only the last four digits of a credential, masked at write time, so the full number never reaches this table or this wire.

### Change the verified email or mobile my account recovers through

- key: `accountPolicy:providerContactChanges` · declared in `services/account/accountPolicy`
- verdict: **SHARED** · domain service: `services/providerContactChangeService`
- route families: `/provider`

Canonical:
  - `POST /api/v1/provider/contact-changes/confirm`
  - `POST /api/v1/provider/contact-changes`

Legacy still aliased for this capability:
  - `POST /api/provider/contact-changes`
  - `POST /api/provider/contact-changes/confirm`

No role split, and deliberately its OWN capability rather than part of the profile: this is the only provider-facing operation that changes how an account is recovered, and it is the only one demanding a FRESH interactive sign-in rather than a valid session. Folding it into providerProfile would have put an operation with a stricter precondition behind the same name as one without, which is how a precondition gets dropped in a migration. Two steps, one capability: a canonical request whose confirm is still legacy is one flow split across two contracts.

### Submit, read, preview and withdraw my documents

- key: `accountPolicy:providerDocuments` · declared in `services/account/accountPolicy`
- verdict: **SHARED** · domain service: `services/account/providerProfileService, services/providerProfileComplianceService`
- route families: `/provider`

Canonical:
  - `POST /api/v1/provider/documents`
  - `DELETE /api/v1/provider/documents/:documentId`
  - `GET /api/v1/provider/documents`
  - `GET /api/v1/provider/documents/:documentId/preview`
  - `GET /api/v1/provider/document-types`

Legacy still aliased for this capability:
  - `DELETE /api/provider/documents/:documentId`
  - `GET /api/provider/document-types`
  - `GET /api/provider/documents`
  - `GET /api/provider/documents/:documentId/preview`
  - `POST /api/provider/documents`

Provider-only, and it must stay that way. The projection carries review STATE and never a document URL or storage path; the preview endpoint mints a short-lived signed URL after re-authorizing, which is a different operation with a different audit trail. The write half arrived on 2026-08-18: the LIST was canonical while submit, preview and withdraw were still legacy, which is the most lopsided shape a capability can have - a provider could read their onboarding state over v1 and not act on it. Submit and withdraw both re-evaluate online eligibility, because the last outstanding requirement is what gates going online in either direction.

### Read and change my provider profile

- key: `accountPolicy:providerProfile` · declared in `services/account/accountPolicy`
- verdict: **SHARED** · domain service: `services/account/providerProfileService, services/providerProfileComplianceService`
- route families: `/provider`

Canonical:
  - `GET /api/v1/provider/profile-fields`
  - `GET /api/v1/provider/profile`
  - `PATCH /api/v1/provider/profile`
  - `GET /api/v1/provider/public-profile`

Legacy still aliased for this capability:
  - `GET /api/provider/profile`
  - `GET /api/provider/profile-fields`
  - `GET /api/provider/public-profile-preview`
  - `POST /api/provider/public-profile-revisions`

Role-specific by DATA and by WORKFLOW. A provider profile field is classified, and editing a reviewable one submits a revision rather than writing a column — the compliance service owns that, and the canonical PATCH delegates to it instead of reimplementing it.

### Read the services I am approved for

- key: `accountPolicy:providerServices` · declared in `services/account/accountPolicy`
- verdict: **SHARED** · domain service: `services/account/providerProfileService`
- route families: `/provider`

Canonical:
  - `GET /api/v1/provider/services`

Legacy still aliased for this capability:
  - `GET /api/worker/services-overview`

Provider-only. Keyed on `services.id` — the Catalog V2 canonical specific-service identity — never on a service family, and it projects the same qualification the matching pipeline selects on.

### Read my security posture

- key: `accountPolicy:security` · declared in `services/account/accountPolicy`
- verdict: **SHARED** · domain service: `services/account/accountSettingsService`
- route families: `/me`

Canonical:
  - `GET /api/v1/me/security`

Legacy still aliased for this capability:
  - none

No role split. READ-ONLY on purpose: every security ACTION already has a dedicated endpoint with its own proof of possession, and folding them into a settings PATCH would put credential changes behind a JSON body — including the ability to turn 2FA OFF from a session that should not be able to.

### Read and change my settings

- key: `accountPolicy:settings` · declared in `services/account/accountPolicy`
- verdict: **SHARED** · domain service: `services/account/accountSettingsService`
- route families: `/me`

Canonical:
  - `GET /api/v1/me/settings`
  - `PATCH /api/v1/me/settings`

Legacy still aliased for this capability:
  - none

No role split, and no web/mobile split either — which is the point. The settings live in one account-keyed store, and notification preferences are a POINTER to the TAB 09 model rather than a second copy of it.

### Operate the booking queue

- key: `core:adminBookingOps` · declared in `api/v1/convergence (core)`
- verdict: **SINGLE_SURFACE** · domain service: `services/adminBookingService, services/providerEligibilityEngine`
- route families: `/admin`

Canonical:
  - `GET /api/v1/admin/bookings`
  - `GET /api/v1/admin/bookings/:bookingId/assignment-candidates`

Legacy still aliased for this capability:
  - `GET /api/admin/bookings`
  - `GET /api/admin/bookings/:id/assignment-candidates`

Genuinely role-specific. Listing every booking on the platform and reading the eligible-provider pool are operator actions with no customer or provider equivalent, behind role 1. The ASSIGN action they lead to is not separate: it is in `bookingTransitions` above, over the shared state machine.

### Register, sign in, and end a session

- key: `core:authCredentials` · declared in `api/v1/convergence (core)`
- verdict: **SHARED** · domain service: `services/auth, services/authLoginService → services/auth, services/authSessionService, services/tokenRefreshService`
- route families: `/auth`

Canonical:
  - `POST /api/v1/auth/register`
  - `POST /api/v1/auth/login`
  - `POST /api/v1/auth/refresh`
  - `POST /api/v1/auth/logout`

Legacy still aliased for this capability:
  - `POST /api/auth/admin-signin`
  - `POST /api/auth/firebase-login`
  - `POST /api/auth/logout`
  - `POST /api/auth/provider/register`
  - `POST /api/auth/refresh`
  - `POST /api/auth/signin`
  - `POST /api/auth/signup`

No role split, and this is the one that matters most: all five surfaces post to the SAME /api/v1/auth/login. The role comes back in the session, it is not chosen by the endpoint. A provider-only login route would be a second credential path with its own lockout counter, and an attacker would use whichever one counted more slowly.

### Recover an account and verify a contact

- key: `core:authRecovery` · declared in `api/v1/convergence (core)`
- verdict: **SHARED** · domain service: `services/auth, services/identityVerificationSync, services/otpService`
- route families: `/auth`

Canonical:
  - `POST /api/v1/auth/forgot-password`
  - `POST /api/v1/auth/reset-password`
  - `POST /api/v1/auth/verify-email`
  - `POST /api/v1/auth/resend-verification`
  - `POST /api/v1/auth/verify-mobile`

Legacy still aliased for this capability:
  - `GET /api/auth/resendverification`
  - `POST /api/auth/forgot-password`
  - `POST /api/auth/resend-email-otp`
  - `POST /api/auth/reset-password`
  - `POST /api/auth/verify-email-otp`

No role split. Recovery answers identically whatever the account turns out to be — a route that behaved differently for a provider would tell an unauthenticated caller which addresses belong to providers.

### Record that cash changed hands

- key: `core:bookingCashSettlement` · declared in `api/v1/convergence (core)`
- verdict: **SHARED** · domain service: `services/paymentService`
- route families: `/bookings`

Canonical:
  - `POST /api/v1/bookings/:bookingId/cash-collected`

Legacy still aliased for this capability:
  - `POST /api/:bookingId/mark-cash-paid`

ROLE-SPLIT by MEMBERSHIP rather than by role name, and that is the whole design. Authorization resolves the caller relationship to THIS booking and then refuses the CUSTOMER - a customer declaring their own cash payment is not evidence of anything - while admitting the assigned provider and admin, the latter for support-assisted recovery. Declaring a provider-only role would have looked stricter and locked admin out of that path. Idempotent by construction: paid_at is COALESCE(paid_at, NOW()), so a repeat never moves the moment money changed hands.

### Read booking-code state

- key: `core:bookingOtpStatus` · declared in `api/v1/convergence (core)`
- verdict: **SHARED** · domain service: `services/booking/bookingOtpService`
- route families: `/bookings`

Canonical:
  - `GET /api/v1/bookings/:bookingId/otp/status`

Legacy still aliased for this capability:
  - none

No role split. The booking-scoped read beside the OTP writes already declared in EXPERIENCE_CAPABILITIES, over the same service — so what a client is told about a code and what the verify endpoint will accept cannot disagree.

### Read a booking

- key: `core:bookingRead` · declared in `api/v1/convergence (core)`
- verdict: **SHARED** · domain service: `services/booking/transitionExecutor, services/bookingAccessService, services/bookingService`
- route families: `/bookings`

Canonical:
  - `GET /api/v1/bookings`
  - `GET /api/v1/bookings/:bookingId`
  - `GET /api/v1/bookings/:bookingId/timeline`
  - `GET /api/v1/bookings/:bookingId/transitions`

Legacy still aliased for this capability:
  - `GET /api/:id`
  - `GET /api/:id/timeline`
  - `GET /api/users/:userId/bookings`

No role split on the READ. `bookings.get` is booking-scoped and authorizes through `bookingAccessService.assertBookingAccess`, so a customer, the assigned provider and an admin all reach it and the SAME function decides what each may see. The differences are projections of one canonical state (toCustomerProjection / toProviderProjection / toAdminProjection), not different truths.

### Move a booking through its state machine

- key: `core:bookingTransitions` · declared in `api/v1/convergence (core)`
- verdict: **ROLE_SPLIT_SHARED_SERVICE** · domain service: `services/booking/transitionExecutor`
- route families: `/admin`, `/provider`

Canonical:
  - `POST /api/v1/provider/jobs/:bookingId/accept`
  - `POST /api/v1/provider/jobs/:bookingId/decline`
  - `POST /api/v1/provider/jobs/:bookingId/en-route`
  - `POST /api/v1/provider/jobs/:bookingId/arrived`
  - `POST /api/v1/provider/jobs/:bookingId/start`
  - `POST /api/v1/provider/jobs/:bookingId/complete`
  - `POST /api/v1/admin/bookings/:bookingId/assign`
  - `POST /api/v1/admin/bookings/:bookingId/reassign`

Legacy still aliased for this capability:
  - `POST /api/admin/bookings/:id/assign`
  - `POST /api/admin/bookings/:id/reassign`
  - `PUT /api/worker/bookings/:bookingId/accept`
  - `PUT /api/worker/bookings/:bookingId/arrived`
  - `PUT /api/worker/bookings/:bookingId/complete`
  - `PUT /api/worker/bookings/:bookingId/decline`
  - `PUT /api/worker/bookings/:bookingId/en-route`
  - `PUT /api/worker/bookings/:bookingId/start`

ROLE-SPLIT, and deliberately so — but over ONE state machine. Eight endpoints across the /provider and /admin families all call `transitionExecutor.transitionBooking` with a different actor verb. The split is real because the AUTHORIZATION differs (a provider may accept a job assigned to them; an admin may assign one to somebody else) and because the actions are different verbs, not one verb behind two doors. What must never differ is the machine, and `convergenceOf` proves it does not by comparing the declared service. The customer side of the same machine is `experiencePolicy:cancel`, which spans /bookings and /provider over the same executor.

### Ask which commit is serving

- key: `core:buildProvenance` · declared in `api/v1/convergence (core)`
- verdict: **SHARED** · domain service: `api/v1/domains/health`
- route families: `/health`

Canonical:
  - `GET /api/v1/health`

Legacy still aliased for this capability:
  - none

No role split, and no role at all. The endpoint is public because a provenance check that needs a credential can only be run by somebody who already has one, which is the situation it exists to fix — a deploy whose migration step fails stops short of the PM2 restart, so the old code keeps serving and nothing outward says so. Every surface reads the same four fields from the same stamp; there is no projection to differ on.

### Browse the service catalog

- key: `core:catalogBrowse` · declared in `api/v1/convergence (core)`
- verdict: **SHARED** · domain service: `services/catalogPublicService`
- route families: `/catalog`

Canonical:
  - `GET /api/v1/catalog`
  - `GET /api/v1/catalog/summary`
  - `GET /api/v1/catalog/categories`
  - `GET /api/v1/catalog/categories/:categoryId`
  - `GET /api/v1/catalog/categories/:categoryId/subcategories`
  - `GET /api/v1/catalog/subcategories/:subcategoryId`
  - `GET /api/v1/catalog/subcategories/:subcategoryId/services`
  - `GET /api/v1/catalog/services`
  - `GET /api/v1/catalog/services/:serviceId`
  - `GET /api/v1/catalog/services/:serviceId/serviceability`

Legacy still aliased for this capability:
  - `GET /api/:serviceId/options-with-addons`
  - `GET /api/catalog`
  - `GET /api/catalog/services`
  - `GET /api/catalog/services/:serviceId`
  - `GET /api/catalog/services/:serviceId/serviceability`
  - `GET /api/catalog/summary`
  - `GET /api/services/:serviceId/level2`
  - `GET /api/services/:serviceId/options-with-addons`
  - `GET /api/services/full`

No role split. The catalog is public product data keyed on services.id — Catalog V2, category → subcategory → service. A provider browsing what they can apply for and a customer browsing what they can book are reading the same tree; a second projection would be the moment service_families crept back in as a parallel identity. Serviceability belongs to browsing rather than to booking for the same reason: it answers "can this be booked here" while the customer is still choosing, and it answers it identically for every surface.

### Search services

- key: `core:catalogSearch` · declared in `api/v1/convergence (core)`
- verdict: **ROLE_SPLIT_SHARED_SERVICE** · domain service: `services/catalogSearchService`
- route families: `/catalog`, `/search`

Canonical:
  - `GET /api/v1/search`
  - `GET /api/v1/catalog/search`

Legacy still aliased for this capability:
  - `GET /api/services/full`

No role split. Two paths, ONE service: /api/v1/search is the top-level entry a client expects and /api/v1/catalog/search is its in-domain twin. Both delegate to the same function, which is what stops them ranking differently.

### Ask whether this client build may still run

- key: `core:clientRecall` · declared in `api/v1/convergence (core)`
- verdict: **SHARED** · domain service: `api/v1/domains/clientConfig`
- route families: `/client-config`

Canonical:
  - `GET /api/v1/client-config`

Legacy still aliased for this capability:
  - none

No role split, and no role at all — the caller is a BUILD, not a person. The endpoint is public because the client being recalled may be too old to authenticate, and a kill switch reachable only with a credential cannot kill the builds that most need it. Every surface reads the same floor from the same file and applies the same comparison; a per-surface answer would let two clients disagree about whether the same version is supported. The web surfaces are listed because they reload and so are never stranded — they may read it, and it will never block them.

### Fetch the contract this process implements

- key: `core:contractDiscovery` · declared in `api/v1/convergence (core)`
- verdict: **SHARED** · domain service: `api/v1/domains/health`
- route families: `/openapi.json`

Canonical:
  - `GET /api/v1/openapi.json`

Legacy still aliased for this capability:
  - none

No role split. Every client generates types from the same document, so a per-surface projection would defeat the point — the value is that all five are reading one contract. AUTHENTICATED rather than public, unlike buildProvenance: four fields of provenance exist to be checkable by somebody holding no credential, but a full API surface is a map, and every client that wants it already holds a token. The same digest also rides on every /api/v1 response in x-contract-sha256, so a client asks "am I stale?" without calling this at all.

### Find out whether I may cancel, and why not

- key: `core:jobCancellationEligibility` · declared in `api/v1/convergence (core)`
- verdict: **SHARED** · domain service: `services/booking/bookingPolicies`
- route families: `/provider`

Canonical:
  - `GET /api/v1/provider/jobs/:bookingId/cancellation-eligibility`

Legacy still aliased for this capability:
  - `GET /api/provider/bookings/:bookingId/cancellation-eligibility`

No role split. A READ of the same policy function the cancel transition itself calls, so a Cancel button and the POST behind it cannot disagree about the window and the client never calculates the rule. Separate from the transition capability because it grants nothing and changes nothing: it exists so a refusal can be EXPLAINED before the provider commits to the action, rather than arriving as a bare error afterwards.

### Prove the work happened

- key: `core:jobEvidence` · declared in `api/v1/convergence (core)`
- verdict: **SHARED** · domain service: `services/bookingEvidenceService`
- route families: `/provider`

Canonical:
  - `POST /api/v1/provider/jobs/:bookingId/evidence`
  - `DELETE /api/v1/provider/jobs/:bookingId/evidence/:evidenceId`
  - `GET /api/v1/provider/jobs/:bookingId/evidence`

Legacy still aliased for this capability:
  - `DELETE /api/provider/bookings/:bookingId/evidence/:evidenceId`
  - `GET /api/provider/bookings/:bookingId/evidence`
  - `POST /api/provider/bookings/:bookingId/evidence`

No role split: the ASSIGNED provider only, scoped by worker_uid inside every statement rather than by a check above it. Held apart from settlement and from cancellation eligibility because the three answer to three different services, and a capability spanning several is one that cannot be retired or reasoned about as a unit — which is exactly what cross-platform-convergence refused when this was first declared as one. Evidence is what a DISPUTE is decided on, which is why the canonical write requires a replay key that the legacy route only accepts optionally.

### Read the support cases I raised on a booking

- key: `core:postServiceSupportRead` · declared in `api/v1/convergence (core)`
- verdict: **SHARED** · domain service: `services/reviews/postServiceSupportService`
- route families: `/bookings`

Canonical:
  - `GET /api/v1/bookings/:bookingId/support-cases`

Legacy still aliased for this capability:
  - none

No role split. The read beside the TAB 12 write, owner-scoped in SQL and over the same service.

### A provider's own job queue

- key: `core:providerJobQueue` · declared in `api/v1/convergence (core)`
- verdict: **SHARED** · domain service: `services/technicianService`
- route families: `/provider`

Canonical:
  - `GET /api/v1/provider/jobs`
  - `GET /api/v1/provider/jobs/:bookingId`

Legacy still aliased for this capability:
  - `GET /api/worker/job-cards`
  - `GET /api/worker/job-cards/:bookingId`
  - `GET /api/workers/:workerId/job-cards`

Genuinely role-specific. "The jobs assigned to me" has no customer equivalent: the query is scoped by worker uid, the card carries earnings and travel fields a customer must never see, and the customer-facing answer to "my bookings" is a different question over a different scope. It reads the same bookings and the same canonical state; it is a provider PROJECTION, not a provider truth.

### Say whether I am working, where I am, and that I am safe

- key: `core:providerPresenceAndSafety` · declared in `api/v1/convergence (core)`
- verdict: **SHARED** · domain service: `services/providerOperationalAvailabilityService, services/providerSafetyService, services/technicianService`
- route families: `/provider`

Canonical:
  - `POST /api/v1/provider/location`
  - `GET /api/v1/provider/presence`
  - `POST /api/v1/provider/presence/offline`
  - `POST /api/v1/provider/presence/online`
  - `POST /api/v1/provider/safety/check-in`
  - `GET /api/v1/provider/safety/emergency-config`
  - `POST /api/v1/provider/safety/incidents`
  - `GET /api/v1/provider/safety/incidents`

Legacy still aliased for this capability:
  - `GET /api/provider/location/status`
  - `GET /api/provider/safety/emergency-config`
  - `GET /api/provider/safety/incidents`
  - `POST /api/provider/location/go-offline`
  - `POST /api/provider/location/go-online`
  - `POST /api/provider/safety/check-in`
  - `POST /api/provider/safety/incidents`
  - `POST /api/worker/location`

No role split. Presence and safety are held as ONE capability because they share a failure mode rather than a screen: both are things a provider does on a doorstep, on a link that drops, where a refusal the client renders as an error is worse than the duplicate it was avoiding. That is why the incident write REPLAYS instead of refusing and the check-in is append-only with `none-accepted` declared. Location is the most sensitive data this product holds, and nothing here widened who can read it: a provider reads their own, admin reads it, and a customer reaches it only through a booking they own while it is live.

### Read a provider's public profile

- key: `core:providerPublicProfile` · declared in `api/v1/convergence (core)`
- verdict: **SHARED** · domain service: `services/account/providerProfileService`
- route families: `/providers`

Canonical:
  - `GET /api/v1/providers/:providerUid/profile`

Legacy still aliased for this capability:
  - none

No role split. One public projection, and the disclosure rules are the provider disclosure policy — not a per-caller decision made at the route.

### See what customers said about me, and answer it

- key: `core:providerReputation` · declared in `api/v1/convergence (core)`
- verdict: **SHARED** · domain service: `services/providerReputationService`
- route families: `/provider`

Canonical:
  - `GET /api/v1/provider/reputation/summary`
  - `POST /api/v1/provider/review-moderation/:caseId/appeals`
  - `GET /api/v1/provider/reviews/:reviewId`
  - `GET /api/v1/provider/reviews`
  - `POST /api/v1/provider/reviews/:reviewId/report`
  - `POST /api/v1/provider/reviews/:reviewId/response`

Legacy still aliased for this capability:
  - `GET /api/provider/reputation/summary`
  - `GET /api/provider/reviews`
  - `GET /api/provider/reviews/:reviewId`
  - `POST /api/provider/review-moderation/:caseId/appeals`
  - `POST /api/provider/reviews/:reviewId/report`
  - `POST /api/provider/reviews/:reviewId/response`

No role split, and distinct from the customer-facing review reads (/v1/reviews/providers/:providerUid) because this surface carries RESPONSE and MODERATION state, neither of which is public. The write half is what v1 lacked entirely: a provider could be reviewed canonically and could not answer. A response is public-facing text, so the moderation that applies today applies to the canonical route on day one rather than being added afterwards.

### Decide what work I am offered

- key: `core:providerServiceCatalogue` · declared in `api/v1/convergence (core)`
- verdict: **SHARED** · domain service: `services/serviceApplicationService, services/technicianService`
- route families: `/provider`

Canonical:
  - `POST /api/v1/provider/service-applications`
  - `GET /api/v1/provider/service-applications/:applicationId`
  - `GET /api/v1/provider/service-applications`
  - `POST /api/v1/provider/service-applications/:applicationId/resubmit`
  - `DELETE /api/v1/provider/service-applications/:applicationId`
  - `GET /api/v1/provider/services/:serviceId/eligibility`
  - `GET /api/v1/provider/services/overview`
  - `PATCH /api/v1/provider/services/:serviceId/pause`
  - `PATCH /api/v1/provider/services/:serviceId/reactivate`

Legacy still aliased for this capability:
  - `DELETE /api/worker/service-applications/:applicationId`
  - `GET /api/worker/service-applications`
  - `GET /api/worker/service-applications/:applicationId`
  - `GET /api/worker/services-overview`
  - `GET /api/worker/services/:serviceId/eligibility`
  - `PATCH /api/worker/services/:serviceId/pause`
  - `PATCH /api/worker/services/:serviceId/reactivate`
  - `POST /api/worker/service-applications`
  - `POST /api/worker/service-applications/:applicationId/resubmit`

No role split. One capability rather than two because a read and a write here act on the SAME row: a pause and an approval both change what matching offers, and splitting them would let a pause be published canonically while the reactivate that undoes it stayed legacy. Held separately from providerProfile because a service list looked like part of a profile and is not - it is the input to matching, and it is the only provider-facing surface whose state decides earnings. `provider.services.list` stays in the account capability: it is the four-field chip, and the overview here is the management screen.

### Raise a case with Servana, and follow it

- key: `core:providerSupportCases` · declared in `api/v1/convergence (core)`
- verdict: **SHARED** · domain service: `services/providerSupportCaseService`
- route families: `/provider`

Canonical:
  - `POST /api/v1/provider/support/cases/:caseId/appeals`
  - `POST /api/v1/provider/support/cases/:caseId/attachments`
  - `GET /api/v1/provider/support/cases/:caseId/attachments/:attachmentId/preview`
  - `POST /api/v1/provider/support/cases`
  - `GET /api/v1/provider/support/cases/:caseId`
  - `GET /api/v1/provider/support/cases`
  - `POST /api/v1/provider/support/cases/:caseId/reopen`
  - `POST /api/v1/provider/support/cases/:caseId/messages`
  - `POST /api/v1/provider/support/cases/:caseId/withdraw`
  - `GET /api/v1/provider/support/case-categories`

Legacy still aliased for this capability:
  - `GET /api/provider/support/case-categories`
  - `GET /api/provider/support/cases`
  - `GET /api/provider/support/cases/:caseId`
  - `GET /api/provider/support/cases/:caseId/attachments/:attachmentId/preview`
  - `POST /api/provider/support/cases`
  - `POST /api/provider/support/cases/:caseId/appeals`
  - `POST /api/provider/support/cases/:caseId/attachments`
  - `POST /api/provider/support/cases/:caseId/messages`
  - `POST /api/provider/support/cases/:caseId/reopen`
  - `POST /api/provider/support/cases/:caseId/withdraw`

No role split. Held apart from the CUSTOMER post-service support cases (bookings/:bookingId/support-cases, services/reviews/postServiceSupportService) and from customer CONVERSATIONS, and the separation is the point rather than an accident of naming. A provider case is with Servana, is not bound to a booking, and is authorized by OWNERSHIP of the case; a conversation is authorized by MEMBERSHIP of a booking and read by a customer. A client classifier already matched this thread onto /v1/conversations/:id/messages on the word "messages" and was wrong. Three things share the words "support case" in this product and they are three resources.

### Resolve a refund review

- key: `core:refundLifecycle` · declared in `api/v1/convergence (core)`
- verdict: **SINGLE_SURFACE** · domain service: `services/adminFinanceService`
- route families: `/admin`

Canonical:
  - `POST /api/v1/admin/refunds/:refundId/mark-failed`

Legacy still aliased for this capability:
  - `POST /api/admin/finance/refunds/:refundId/mark-failed`

Genuinely operator-only, and deliberately narrow for now. A customer requests a refund through the booking surface; deciding one is an operator action behind role 1 and a named permission. Only the `failed` terminal is canonical so far: the rest of the lifecycle (open, approve, reject, mark-processed) stays legacy until the disbursement surface is unified, because canonicalising a refund before its payout twin would fix the duplicate rather than remove it. `failed` came first because it did not exist at all — an approved refund the processor rejected had no terminal, so it stayed `approved` and blocked every retry for that booking.

### Read the reschedule history of a booking

- key: `core:rescheduleHistory` · declared in `api/v1/convergence (core)`
- verdict: **SHARED** · domain service: `services/booking/bookingRescheduleService`
- route families: `/bookings`

Canonical:
  - `GET /api/v1/bookings/:bookingId/reschedule`

Legacy still aliased for this capability:
  - none

No role split. One booking-scoped read; the requesting and deciding endpoints beside it are in EXPERIENCE_CAPABILITIES over the same service.

### Report that the product is working

- key: `core:workerTelemetry` · declared in `api/v1/convergence (core)`
- verdict: **SINGLE_SURFACE** · domain service: `services/telemetryService`
- route families: `/telemetry`

Canonical:
  - `POST /api/v1/telemetry`

Legacy still aliased for this capability:
  - none

Role-specific, and the narrowest capability in this registry. The worker app is the only client whose failures are silent by nature — a job offer that never arrives produces no error anywhere, so its working-ness cannot be inferred from the request log the way a browser surface's can, because a browser retries in front of a person who reports it. There is deliberately NO CUSTOMER equivalent and no admin one: the customer app is not in this programme, publishes no manifest, and giving it an ingest here would be inventing a client's requirements on its behalf — the same error the caller matrix was built to stop. Opening this to every surface would also turn a seven-event product signal into a general analytics endpoint, which docs/TELEMETRY_DECISION.md explicitly refuses. A second surface wanting this is a new decision, not a new entry in an array.

### Register and release this device for push

- key: `domainEvents:deviceTokens` · declared in `services/events/domainEvents`
- verdict: **SHARED** · domain service: `services/events/deviceTokenService`
- route families: `/me`

Canonical:
  - `POST /api/v1/me/devices`
  - `DELETE /api/v1/me/devices`

Legacy still aliased for this capability:
  - `DELETE /api/provider/fcm-token`
  - `DELETE /api/user/fcm-token`
  - `POST /api/provider/fcm-token`
  - `POST /api/user/fcm-token`

No role split. Providers had a multi-device token TABLE and customers had a single column, so a customer with two devices could only ever receive push on the last one to sign in. One account-scoped token store for both, with the provider table kept and dual-written until ServanaWorker migrates.

### Dismiss one notification

- key: `domainEvents:dismiss` · declared in `services/events/domainEvents`
- verdict: **SHARED** · domain service: `services/events/notificationInbox`
- route families: `/notifications`

Canonical:
  - `DELETE /api/v1/notifications/:key`

Legacy still aliased for this capability:
  - `DELETE /api/provider/notifications/:key`

No role split, and it is the fourth verb of an inbox that already had three. The legacy route was provider-only and reached provider_notifications directly, which is why customers have never been able to dismiss anything: their rows are in customer_notifications and nothing looked there. Resolving the store from the caller is the same decision list, unread-count and markRead already made — a second, provider-shaped dismiss endpoint would rebuild the defect the inbox exists to end. Admin is a declared surface and answers NOTIFICATION_NOT_ACTIONABLE: that store has no dismiss, and saying so is not the same as claiming the notification is missing.

### Read my notification inbox

- key: `domainEvents:inbox` · declared in `services/events/domainEvents`
- verdict: **SHARED** · domain service: `services/events/notificationInbox`
- route families: `/notifications`

Canonical:
  - `GET /api/v1/notifications`

Legacy still aliased for this capability:
  - `GET /api/user/notifications`

No role split, and this is where the split USED to be. The canonical route read the customer table only, so a provider calling it received an empty inbox while their notifications sat in provider_notifications. One inbox service now resolves the owner's store from their account and reads it — two physical tables, one logical inbox, one DTO.

### Mark everything read

- key: `domainEvents:markAllRead` · declared in `services/events/domainEvents`
- verdict: **SHARED** · domain service: `services/events/notificationInbox`
- route families: `/notifications`

Canonical:
  - `POST /api/v1/notifications/read-all`

Legacy still aliased for this capability:
  - `POST /api/user/notifications/mark-all-read`

No role split. The subject is the token; there is no parameter naming whose inbox to clear.

### Mark one notification read

- key: `domainEvents:markRead` · declared in `services/events/domainEvents`
- verdict: **SHARED** · domain service: `services/events/notificationInbox`
- route families: `/notifications`

Canonical:
  - `PATCH /api/v1/notifications/:key/read`

Legacy still aliased for this capability:
  - `PATCH /api/user/notifications/:key/read`

No role split. The key is opaque and owner-scoped: the same key can exist for two accounts and each only ever resolves their own row, because every statement is predicated on the owner uid from the token.

### Read and change my notification preferences

- key: `domainEvents:preferences` · declared in `services/events/domainEvents`
- verdict: **ROLE_SPLIT_SHARED_SERVICE** · domain service: `services/notificationService`
- route families: `/me`, `/settings`

Canonical:
  - `GET /api/v1/me/notification-preferences`
  - `PATCH /api/v1/me/notification-preferences`
  - `GET /api/v1/settings/notification-preferences`
  - `PUT /api/v1/settings/notification-preferences`

Legacy still aliased for this capability:
  - `GET /api/provider/notification-preferences`
  - `GET /api/workers/:uid/notification-preferences`
  - `PUT /api/provider/notification-preferences`
  - `PUT /api/workers/:uid/notification-preferences`

No role split, and again this is where one used to be. The preference table is keyed on a uid and has no role column, yet both legacy routes were gated on a provider role — so customers received notifications they had no way to configure, and their push ignored the table entirely. One model, one table, every account.

### How many unread I have

- key: `domainEvents:unreadCount` · declared in `services/events/domainEvents`
- verdict: **SHARED** · domain service: `services/events/notificationInbox`
- route families: `/notifications`

Canonical:
  - `GET /api/v1/notifications/unread-count`

Legacy still aliased for this capability:
  - `GET /api/user/notifications/unread-count`

No role split. Counted from the SAME store resolution the list uses, so the badge and the screen cannot disagree about which table they are reading.

### Additional work

- key: `experiencePolicy:additionalWork` · declared in `services/booking/experiencePolicy`
- verdict: **SHARED** · domain service: `services/additional`
- route families: `/bookings`

Canonical:
  - `POST /api/v1/bookings/:bookingId/additional-work`
  - `GET /api/v1/bookings/:bookingId/additional-work`

Legacy still aliased for this capability:
  - `GET /api/additional/booking/:bookingId`
  - `POST /api/additional/request/:userId`

Creation is provider-only because only the provider on site can observe work the booking did not cover; the READ is shared. Approval and payment remain on the legacy `/api/additional/*` family, which Provider Web calls today, and both families call the same `additionalService` instance.

### Cancellation

- key: `experiencePolicy:cancel` · declared in `services/booking/experiencePolicy`
- verdict: **ROLE_SPLIT_SHARED_SERVICE** · domain service: `services/booking/transitionExecutor`
- route families: `/bookings`, `/provider`

Canonical:
  - `POST /api/v1/bookings/:bookingId/cancel`
  - `POST /api/v1/provider/jobs/:bookingId/cancel`

Legacy still aliased for this capability:
  - `POST /api/bookings/:id/cancel`
  - `POST /api/provider/bookings/:bookingId/cancel`

Role-specific endpoints, one state machine. Customer, provider and admin cancellation are three different ACTIONS with three different guards and three different notification fan-outs — but all three are `transitionBooking` calls against the same transition whitelist, so no client can cancel from a state another client could not.

### Disputes

- key: `experiencePolicy:disputes` · declared in `services/booking/experiencePolicy`
- verdict: **SHARED** · domain service: `services/booking/bookingDisputeService`
- route families: `/bookings`

Canonical:
  - `POST /api/v1/bookings/:bookingId/disputes`
  - `GET /api/v1/bookings/:bookingId/disputes`

Legacy still aliased for this capability:
  - `POST /api/admin/bookings/:id/escalate`

No role split. One open endpoint for all three actors writing one `booking_escalations` row, so admin, provider and customer cannot disagree about whether a booking is disputed. What each actor may READ back differs; what is RECORDED does not.

### Booking codes (OTP)

- key: `experiencePolicy:otp` · declared in `services/booking/experiencePolicy`
- verdict: **SHARED** · domain service: `services/booking/bookingOtpService`
- route families: `/bookings`

Canonical:
  - `POST /api/v1/bookings/:bookingId/otp/request`
  - `POST /api/v1/bookings/:bookingId/otp/verify`

Legacy still aliased for this capability:
  - `POST /api/:bookingId/resend-otp`
  - `POST /api/:id/confirm-otp`

No role split. One request endpoint and one verify endpoint, both scoped by `purpose`. The actor rules differ PER PURPOSE, not per client: only the holder of a code may verify it, and a provider may never request the code they are required to be told.

### Reschedule

- key: `experiencePolicy:reschedule` · declared in `services/booking/experiencePolicy`
- verdict: **SHARED** · domain service: `services/booking/bookingRescheduleService`
- route families: `/bookings`

Canonical:
  - `POST /api/v1/bookings/:bookingId/reschedule`

Legacy still aliased for this capability:
  - `POST /api/admin/bookings/:id/reschedule`

No role split. The admin path differs only in which policy checks apply (an admin may move a booking inside the customer notice window), and that difference is evaluated by the same function from the same declaration below rather than by a second endpoint.

### Tracking

- key: `experiencePolicy:tracking` · declared in `services/booking/experiencePolicy`
- verdict: **SHARED** · domain service: `services/booking/bookingTrackingService`
- route families: `/bookings`

Canonical:
  - `GET /api/v1/bookings/:bookingId/tracking`

Legacy still aliased for this capability:
  - `GET /api/:id/tracking`
  - `GET /api/booking/:bookingId/provider-location`

No role split. One booking-scoped endpoint answers all three actors; the provider position is withheld or disclosed by the SAME visibility rule regardless of who asks, so a provider reading their own job and a customer watching it see one authorization decision.

### Provider earnings summary

- key: `financePolicy:earningsSummary` · declared in `services/finance/financePolicy`
- verdict: **SHARED** · domain service: `services/finance/providerEarningsService`
- route families: `/provider`

Canonical:
  - `GET /api/v1/provider/earnings/summary`

Legacy still aliased for this capability:
  - `GET /api/provider/earnings/summary`

No role split. Provider Web and Provider Mobile call the same path and receive the same DTO from the same aggregate query, which is what makes "earnings match exactly" a property rather than a coincidence of two implementations.

### Provider earnings transactions

- key: `financePolicy:earningsTransactions` · declared in `services/finance/financePolicy`
- verdict: **SHARED** · domain service: `services/finance/providerEarningsService`
- route families: `/provider`

Canonical:
  - `GET /api/v1/provider/earnings/transactions`

Legacy still aliased for this capability:
  - `GET /api/provider/earnings`
  - `GET /api/provider/ledger`

No role split. Replaces three legacy shapes — `/provider/earnings`, `/provider/ledger` and the job-card earnings fields — that read the same columns and answered in three vocabularies.

### Start or resume a booking payment

- key: `financePolicy:paymentIntent` · declared in `services/finance/financePolicy`
- verdict: **SHARED** · domain service: `services/finance/bookingPaymentService`
- route families: `/bookings`

Canonical:
  - `POST /api/v1/bookings/:bookingId/payment-intents`

Legacy still aliased for this capability:
  - `POST /api/:bookingId/paymongo/create`

No role split. One booking-scoped endpoint; the caller's relationship to the booking is resolved by `assertBookingAccess`, and an admin starting a payment on a customer's behalf runs the identical `createCheckoutSession` call. A provider is refused — they are never a party to the customer's charge.

### Read a booking's payment and price breakdown

- key: `financePolicy:paymentView` · declared in `services/finance/financePolicy`
- verdict: **SHARED** · domain service: `services/finance/bookingPaymentService`
- route families: `/bookings`

Canonical:
  - `GET /api/v1/bookings/:bookingId/payment`

Legacy still aliased for this capability:
  - none

No role split, but the DTO is FIELD-SCOPED by actor from one declaration: a provider sees their own share and never the processor reference or the customer's method, and a customer sees what they paid and never the provider share. One endpoint, one calculator, one projection function — not three endpoints that could each compute a different total.

### Provider payouts

- key: `financePolicy:payouts` · declared in `services/finance/financePolicy`
- verdict: **SHARED** · domain service: `services/finance/providerEarningsService`
- route families: `/provider`

Canonical:
  - `GET /api/v1/provider/earnings/payouts`

Legacy still aliased for this capability:
  - `GET /api/provider/payouts`

No role split. The provider's own payouts only; the subject is the token, never a uid in the path. Admin payout administration is a genuinely different operation — it can hold, retry and see processor references — and lives under /admin/finance with its own permissions.

### Admin ledger reconciliation

- key: `financePolicy:reconciliation` · declared in `services/finance/financePolicy`
- verdict: **SINGLE_SURFACE** · domain service: `services/finance/financeReconciliationService`
- route families: `/admin`

Canonical:
  - `GET /api/v1/admin/finance/reconciliation`

Legacy still aliased for this capability:
  - `GET /api/admin/finance/reconciliation/exceptions`

Admin only, and legitimately so: it reads across every booking, provider and payment on the platform. It reconciles the SAME ledger the provider and customer endpoints project from, so an admin investigating a break and a provider reading their earnings are looking at one set of records.

### Refund a booking payment

- key: `financePolicy:refund` · declared in `services/finance/financePolicy`
- verdict: **SHARED** · domain service: `services/finance/bookingPaymentService`
- route families: `/bookings`

Canonical:
  - `POST /api/v1/bookings/:bookingId/refunds`

Legacy still aliased for this capability:
  - `POST /api/admin/finance/refunds`

One endpoint, two outcomes decided by the actor: a customer REQUESTS (opening a refund review) and an admin ISSUES (moving money). Both call `evaluateRefundEligibility` first, so a request can never be accepted for a booking an issue would refuse. A provider is refused outright.

### The composed home surface

- key: `homePolicy:homeFeed` · declared in `services/home/homePolicy`
- verdict: **SHARED** · domain service: `services/home/homeService`
- route families: `/home`

Canonical:
  - `GET /api/v1/home`

Legacy still aliased for this capability:
  - none

No role split, and no client split — which IS the capability. Customer Web and Customer Mobile receive the identical section set and the identical DTOs from one composition, so "equivalent shared content" is a property of there being one endpoint rather than two implementations kept in step. Providers have a dashboard with genuinely different content and their own endpoint; folding both into one surface would give the response a role branch and two meanings.

### Which sections exist and what owns each

- key: `homePolicy:homeSections` · declared in `services/home/homePolicy`
- verdict: **SHARED** · domain service: `services/home/homeService`
- route families: `/home`

Canonical:
  - `GET /api/v1/home/sections`

Legacy still aliased for this capability:
  - none

No role split. The registry is metadata about the page, not content: it says which section types exist, what owns each and how long each may be cached. A client uses it to render unknown sections safely; an admin uses it to see what home is made of without reading the source.

### Attach a file to a conversation

- key: `messagingPolicy:attach` · declared in `services/messaging/messagingPolicy`
- verdict: **SHARED** · domain service: `chat/chat`
- route families: `/conversations`

Canonical:
  - `POST /api/v1/conversations/:conversationId/attachments`

Legacy still aliased for this capability:
  - `POST /api/chat/attachments/upload`

No role split, and the conversation is named by the PATH rather than the body. That is the difference that matters: the legacy route took it as an optional body field and ran the access check only when the caller supplied one, so omitting it stored a file and returned a URL without any conversation being consulted. The allowlist and the size ceiling are checked by file SIGNATURE, so a renamed executable is refused on its contents rather than on its declared type.

### Read one conversation and its participants

- key: `messagingPolicy:conversationDetail` · declared in `services/messaging/messagingPolicy`
- verdict: **SHARED** · domain service: `services/messaging/messagingService`
- route families: `/conversations`

Canonical:
  - `GET /api/v1/conversations/:conversationId`

Legacy still aliased for this capability:
  - `GET /api/chat/conversations/:id`

No role split, but the DTO is field-scoped by seat from one projection: contact details of other participants are never disclosed, and only support sees departed participants. One projection function, not three endpoints that could each over-disclose.

### List my conversations with unread counts

- key: `messagingPolicy:inbox` · declared in `services/messaging/messagingPolicy`
- verdict: **SHARED** · domain service: `services/messaging/messagingService`
- route families: `/conversations`

Canonical:
  - `GET /api/v1/conversations`

Legacy still aliased for this capability:
  - `GET /api/chat/conversations`

No role split. The subject is the TOKEN — there is no uid parameter to substitute. An admin gets the oversight list from the same handler, which is a privileged read of the same resource rather than a second inbox with its own rules.

### Advance the read pointer

- key: `messagingPolicy:markRead` · declared in `services/messaging/messagingPolicy`
- verdict: **SHARED** · domain service: `services/messaging/messagingService`
- route families: `/conversations`

Canonical:
  - `POST /api/v1/conversations/:conversationId/read`

Legacy still aliased for this capability:
  - `POST /api/chat/conversations/:id/read`

No role split. The pointer belongs to the caller and is taken from the token; there is no parameter naming whose pointer to move. It is monotonic, so an out-of-order client cannot un-read a conversation.

### Open (or resolve) a booking conversation

- key: `messagingPolicy:openConversation` · declared in `services/messaging/messagingPolicy`
- verdict: **SHARED** · domain service: `services/messaging/messagingService`
- route families: `/conversations`

Canonical:
  - `POST /api/v1/conversations`

Legacy still aliased for this capability:
  - `GET /api/bookings/:bookingId/conversation`

No role split. One endpoint, idempotent: it returns the booking's existing conversation or opens it. Who may open one is a policy decision — `mayOpenConversation` — not a second endpoint, so a customer and an admin run the same code and differ only in what the policy allows.

### Report a message to moderation

- key: `messagingPolicy:report` · declared in `services/messaging/messagingPolicy`
- verdict: **SHARED** · domain service: `chat/chat`
- route families: `/conversations`

Canonical:
  - `POST /api/v1/conversations/:conversationId/messages/:messageId/report`

Legacy still aliased for this capability:
  - `POST /api/chat/conversations/:id/messages/:msgId/report`

No role split among the four participant surfaces. Admin is deliberately absent: staff act on reports through the admin communications routes, which are permissioned and audited, and an admin filing a participant report would enter the same queue they resolve. The reporter is the token subject, so no request can file one as somebody else.

### Send a message

- key: `messagingPolicy:send` · declared in `services/messaging/messagingPolicy`
- verdict: **SHARED** · domain service: `chat/chat`
- route families: `/conversations`

Canonical:
  - `POST /api/v1/conversations/:conversationId/messages`

Legacy still aliased for this capability:
  - `POST /api/chat/conversations/:id/messages`

No role split, and three transports on one write: the canonical REST endpoint, the legacy REST route and the `message:send` socket event all call the same function. The admin portal's send goes through it too, so an admin message is subject to the same idempotency, validation and attachment rules as anyone else's.

### Page through a conversation transcript

- key: `messagingPolicy:transcript` · declared in `services/messaging/messagingPolicy`
- verdict: **SHARED** · domain service: `services/messaging/messagingService`
- route families: `/conversations`

Canonical:
  - `GET /api/v1/conversations/:conversationId/messages`

Legacy still aliased for this capability:
  - `GET /api/chat/conversations/:id/messages`

No role split. The read FLOOR differs by seat — a provider reads from their own assignment forward — and that is a policy applied inside one handler by `messageReadFloor`, not a separate provider endpoint that could forget it.

### Raise a support case about a completed booking

- key: `reviewPolicy:postServiceSupport` · declared in `services/reviews/reviewPolicy`
- verdict: **SHARED** · domain service: `services/reviews/postServiceSupportService`
- route families: `/bookings`

Canonical:
  - `POST /api/v1/bookings/:bookingId/support-cases`

Legacy still aliased for this capability:
  - none

No role split. Providers raise support cases through their own endpoint, which is a genuinely different operation: a provider case is about their account or a job they worked, and a customer case is about a booking they paid for. A BILLING category is ROUTED to the finance domain rather than handled here - handling it would fork the refund rules into a second, weaker path.

### Read a provider's published reviews

- key: `reviewPolicy:providerReviews` · declared in `services/reviews/reviewPolicy`
- verdict: **SHARED** · domain service: `services/customerReviewService`
- route families: `/reviews`

Canonical:
  - `GET /api/v1/reviews/providers/:providerUid`

Legacy still aliased for this capability:
  - `GET /api/providers/:providerUid/reviews`

No role split on the shared list, and a genuinely different one for admin: `/admin/providers/:uid/reviews` carries moderation state, internal notes and rejected reviews, all behind a named permission. Same table, different question - and the public route cannot answer it because the projection does not carry those fields at all.

### A provider's rating summary

- key: `reviewPolicy:ratingSummary` · declared in `services/reviews/reviewPolicy`
- verdict: **SHARED** · domain service: `services/customerReviewService`
- route families: `/reviews`

Canonical:
  - `GET /api/v1/reviews/providers/:providerUid/rating`

Legacy still aliased for this capability:
  - `GET /api/providers/:providerUid/rating`

No role split, and this is the gate: one summary service and one contract, so a provider cannot be shown a different average from the one on their own customer-facing card. Backend-derived throughout - no endpoint accepts a rating, because a rating a caller can set is one a caller can inflate.

### Read the review I wrote for a booking

- key: `reviewPolicy:readOwnReview` · declared in `services/reviews/reviewPolicy`
- verdict: **SHARED** · domain service: `services/customerReviewService`
- route families: `/bookings`

Canonical:
  - `GET /api/v1/bookings/:bookingId/review`

Legacy still aliased for this capability:
  - `GET /api/bookings/:bookingId/review-eligibility`
  - `GET /api/bookings/:bookingId/reviews`

No role split. Scoped to the author, and it returns the private feedback the public projection never carries - which is the whole reason it is a separate read rather than a filter on the provider list.

### Review a completed booking

- key: `reviewPolicy:writeReview` · declared in `services/reviews/reviewPolicy`
- verdict: **SHARED** · domain service: `services/customerReviewService`
- route families: `/bookings`

Canonical:
  - `POST /api/v1/bookings/:bookingId/review`

Legacy still aliased for this capability:
  - `POST /api/bookings/:bookingId/reviews`

No role split. Only the booking's customer may write, and that is not a role check - it is a relationship resolved from `bookings.user_id`. The provider is taken from the COMPLETED assignment, never from the payload, so there is no shape of request that reviews somebody the customer did not book.
