<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-account-docs.ts, derived from
    src/services/account/accountPolicy.ts                 (fields, sensitivity, addresses, completion)
    src/services/providerProfileComplianceService.ts      (the provider field registry)
    src/api/v1/contract.ts                                (the canonical endpoints)
  Regenerate: npm run account:docs
-->

# Profile v1 Contract

> The single account/profile truth for Customer Mobile, Customer Web, Provider
> Mobile, Provider Web and Admin Web. The disclosure matrix and the completion
> tables are produced by RUNNING the real decision functions, so they are
> evidence of the behaviour rather than a description of it.

## 1. `/me` — the common account record

Identity, contact and a verification SUMMARY. Nothing else.

The temptation is real: every client needs the account and one round trip is
cheaper than two. But a `/me` that carried the provider's compliance state and the
customer's address book would be fetched by every screen, used by almost none, and it
is the payload most likely to be cached, logged and shipped to an analytics tool.

So role data lives behind its own endpoints and `/me` carries a `profiles` POINTER —
which extensions exist for this account — rather than their contents.

| Field | Label | Class | Writable by self | Why not |
| --- | --- | --- | --- | --- |
| `uid` | Account id | `public` | — | The canonical identity. It never changes. |
| `email` | Email | `private` | — | A verified identifier. Changing it needs the re-verification workflow, not a profile PATCH. |
| `phoneNumber` | Mobile number | `private` | — | A verified identifier. Same reason as email. |
| `firstName` | First name | `private` | yes |  |
| `lastName` | Last name | `private` | yes |  |
| `displayName` | Display name | `public` | yes |  |
| `photoUrl` | Profile photo | `public` | yes |  |
| `role` | Role | `operational` | — | Set by Servana. A self-writable role is a privilege-escalation endpoint. |
| `accountStatus` | Account status | `operational` | — | Set by Servana. A self-writable status is a suspended account un-suspending itself, which is the whole point of having one. |
| `isEmailVerified` | Email verified | `private` | — | Derived from the verification workflow. |
| `isPhoneVerified` | Mobile verified | `private` | — | Derived from the verification workflow. |

Writable at `PATCH /api/v1/me`: `firstName`, `lastName`, `displayName`, `photoUrl`.

An unwritable field is **refused by name**, not dropped. Silently ignoring `email`
leaves the caller believing they changed a verified identifier.

### What `/me` deliberately does NOT carry

| Excluded | Owned by |
| --- | --- |
| `addresses` | `GET /api/v1/customer/addresses` |
| `documents` | `GET /api/v1/provider/documents` |
| `availability` | `GET /api/v1/provider/availability` |
| `services` | `GET /api/v1/provider/services` |
| `earnings` | `GET /api/v1/provider/earnings/summary` |
| `notificationPreferences` | `GET /api/v1/me/settings` |
| `complianceDetail` | `GET /api/v1/provider/profile` |

## 2. Sensitive-field policy (§107)

Four classes, and one table saying which seat may read each.

| Class | Readable by |
| --- | --- |
| `public` | `self`, `otherCustomer`, `admin` |
| `private` | `self`, `admin` |
| `operational` | `self`, `admin` |
| `internal` | `admin` |

A `seat` is a RELATIONSHIP, not a role claim from a token: `self` is the account
reading its own row, `otherCustomer` is a customer looking at a provider, `admin` is
staff. It is resolved server-side on every request.

### Provider field disclosure, by seat

Produced by RUNNING `providerFieldsVisibleTo` for each seat. If a classification
changes, this table changes with it.

| Provider field | Class | self | otherCustomer | admin |
| --- | --- | --- | --- | --- |
| `legalName` | `private` | visible | — | visible |
| `birthDate` | `private` | visible | — | visible |
| `email` | `private` | visible | — | visible |
| `mobile` | `private` | visible | — | visible |
| `legalAddress` | `private` | visible | — | visible |
| `displayName` | `public` | visible | visible | visible |
| `photo` | `public` | visible | visible | visible |
| `biography` | `public` | visible | visible | visible |
| `skills` | `public` | visible | visible | visible |
| `languages` | `public` | visible | visible | visible |
| `experienceSummary` | `public` | visible | visible | visible |
| `branch` | `operational` | visible | — | visible |
| `serviceArea` | `operational` | visible | — | visible |
| `providerType` | `operational` | visible | — | visible |
| `reviewerNotes` | `internal` | — | — | visible |

A field reaches a customer only when **two independent signals agree**: its
classification must be readable by `otherCustomer` AND the field registry's own
`customerVisible` flag must be set. Either can veto — which is what makes "sensitive
documents do not leak" a property of the declaration rather than of every query
author remembering to omit a column.

The provider field registry is NOT restated here. It is
`providerProfileComplianceService.PROFILE_FIELD_REGISTRY`, which already carried a
classification, a customer-visible flag and a masked flag, and which
`/api/provider/profile-fields` already serves to Provider Web. Declaring a second
provider taxonomy beside it is exactly the mistake this policy exists to prevent.

### Never projected, at any seat

`password`, `password_hash`, `passwordHash`, `fcm_token`, `fcmToken`, `otp`, `otp_code`, `otpCode`, `reset_token`, `resetToken`, `document_url`, `documentUrl`, `storage_path`, `storagePath`, `id_number`, `idNumber`, `nbi_number`

Not a sensitivity class — a refusal. These are credentials and verification
artefacts. An admin who needs a document uses the document endpoint, which authorizes
per document and records the access; a profile read is not that.

Projections are built ADDITIVELY: every DTO names its fields. Nothing is built by
copying a row and deleting what should not travel, because a subtractive projection
discloses every column somebody later adds.

## 3. Customer profile and addresses

The customer EXTENSION only. The identity half is `/me`; duplicating it is how two
endpoints come to disagree about a name.

| Field | Class | Writable by self | Note |
| --- | --- | --- | --- |
| `birthDate` | `private` | yes |  |
| `gender` | `private` | yes |  |
| `photoUrl` | `public` | yes |  |
| `defaultAddressId` | `private` | — | Set through the address book, so the default and the address that carries the flag cannot disagree. |

### The address book

- **Identity** — `user_address.address_id` (CAD + 6 characters).
- **Owner** — `user_address.uid`.
- Owner-scoped in SQL on every statement. An address id is not a capability: presenting somebody else's resolves to nothing rather than to their home.
- At most **25** addresses per account.

| Field | Required on create | Max length | Note |
| --- | --- | --- | --- |
| `addressOne` | yes | 255 | Street line. The only genuinely required line. |
| `addressTwo` | — | 255 | Unit, floor, landmark. |
| `postTown` | — | 120 | City or municipality. |
| `zipCode` | — | 20 | Postal code. |
| `country` | — | 80 | Defaults to the operating country. |
| `label` | — | 60 | Home, Office. Free text the customer chose. |
| `locationId` | — | 128 | Geocode handle. Drives coverage and distance pricing. |

Validator output, produced by running `validateAddress`:

- create with nothing: `ADDRESS_FIELD_REQUIRED` — addressOne is required.
- create at the ceiling: `ADDRESS_LIMIT_REACHED` — An account may hold at most 25 addresses.
- patch without the required line: **accepted** — on PATCH an absent field means "leave it alone", never "clear it".

### The default address

- Exactly one address per account carries is_primary.
- The first address an account creates becomes the default automatically.
- Deleting the default promotes the oldest remaining address, so an account with addresses is never left without a default.
- Promotion and demotion happen in ONE transaction. Two statements without one is how an account ends up with two primaries and every reader picks whichever the planner returned first.

The legacy path set the new default and cleared the others in two separate statements
with no transaction. A failure between them left the account with TWO primaries, and
every reader picks whichever the planner returned first — including checkout, which is
how a booking gets addressed to a house somebody moved out of.

### Ownership is in SQL, not in a controller

The legacy `getAddressByAddressId` selects by id alone and the handler compares the
owner afterwards. That is correct today and is one careless caller away from not
being — the row is already in memory by the time anybody asks whose it is. Every
canonical statement carries `AND uid = $n`.

One refusal covers "no such address" and "not yours". Address ids are short generated
strings, so an endpoint that distinguished them would let a caller confirm which ids
exist, and these are people's homes.

## 4. Provider profile, documents, availability and services

### Editing is PROPOSING

A provider does not edit their public profile; they propose a change and it is
reviewed. `PATCH /api/v1/provider/profile` accepts only registry fields marked
`editable: review` — `displayName`, `photo`, `biography`, `skills`, `languages`, `experienceSummary` — and
DELEGATES to the compliance service's revision workflow rather than writing a column.

Identifier fields change through re-verification. Operational fields are set by
Servana. Both are refused by name, with the message naming where the change actually
happens.

A `clientRequestId` is REQUIRED. Without it a provider on a flaky connection queues
three copies of one biography change for a human to review.

### Documents are STATE, never content (§104)

`worker_requirements` is the real model. The command is explicit that
`provider_documents` must not be invented if it does not exist, and it does not.

The list is driven by the document CATALOG rather than by the stored rows, so a
required document that has never been submitted appears as `missing`. A list built
from rows alone shows an empty screen to a provider who has everything left to do.

No URL and no storage path appears. The preview endpoint mints a short-lived signed
URL after re-authorizing, which is a different operation with a different audit trail
— folding it into a profile read would turn every profile fetch into a document
disclosure.

### Availability reads what matching consumes (§105)

`GET/PATCH /api/v1/provider/availability` reads and writes
`providerAvailabilityEngine` — the same engine the matching pipeline selects on.

That equality is the release gate. A provider editing one source while matching reads
another is a provider who is unbookable for reasons nobody can see.

The PATCH REPLACES the week, which is why it is idempotent: the same body twice
reaches the same schedule. `expectedVersion` is what stops two devices silently
overwriting each other.

### Services are keyed on `services.id`

The Catalog V2 canonical specific-service identity. Never a service family:
`service_families` is legacy coarse provenance, and a provider service list keyed on a
family is how the family becomes the bookable identity again.

## 5. Profile completion (§109)

Backend-derived. A client cannot compute this: document review state, service
qualification and availability all live behind endpoints a welcome card does not call,
and two of the three are what matching actually selects on.

| Requirement | Role | Blocking | Why |
| --- | --- | --- | --- |
| `name` | customer | yes | A booking has to be addressed to somebody. |
| `contact` | customer | yes | A verified email or mobile. Without one a booking cannot be confirmed. |
| `address` | customer | yes | Serviceability is decided from an address; there is nothing to check without one. |
| `photo` | customer | — | Presentation only. Never blocks. |
| `name` | provider | yes | Appears on the job card the customer sees. |
| `contact` | provider | yes | Assignment notifications have to reach somebody. |
| `documents` | provider | yes | Every document the catalog marks required, present and not rejected. |
| `services` | provider | yes | Matching selects on services; a provider with none is invisible to it. |
| `availability` | provider | yes | Matching selects on availability. The same source the provider edits. |
| `photo` | provider | — | Presentation only. Never blocks. |

### `percent` and `canProceed` answer different questions

`percent` counts every requirement including the cosmetic ones, because that is what a
progress bar means to a person. `canProceed` counts only the BLOCKING ones, because
that is what the product gates on. Conflating them is how a client shows "80%
complete" beside a button that does not work.

Produced by running `computeCompletion`:

- **everything but a photo**: 83% complete, `canProceed: true`, missing `photo`
- **photo but no accepted documents**: 83% complete, `canProceed: false`, blocked by `documents`

The second is the case the gate exists for: a provider who looks nearly done and
cannot take work, because matching cannot select them.

## 6. Account-switch invalidation (§108)

**Server guarantee** — Every account response is derived from the token subject. No endpoint in this domain accepts a uid parameter, so there is no cached response that could belong to another account.

**Client obligation** — drop, on every account switch:

- profile (/me, /customer/profile, /provider/profile)
- addresses
- settings and notification preferences
- provider services and availability
- completion state

Sign-out already evicts chat sockets and clears the push token via endAllSessions. Account state is fetched fresh after a switch because none of it is cached across identities.

Stated as a contract rather than left as an assumption about what the apps happen to
do — the same shape TAB 08 used for chat session hygiene, and for the same reason: a
cached profile rendered under the next person's identity is a leak the server cannot
see.

## Canonical endpoints

| Endpoint | Auth | Idempotent | Domain service |
| --- | --- | --- | --- |
| `PATCH /api/v1/me` | authenticated | yes | `services/account/accountService.patchAccount` |
| `GET /api/v1/me/settings` | authenticated | yes | `services/account/accountSettingsService.getSettings` |
| `PATCH /api/v1/me/settings` | authenticated | yes | `services/account/accountSettingsService.patchSettings` |
| `GET /api/v1/me/security` | authenticated | yes | `services/account/accountSettingsService.getSecurity` |
| `GET /api/v1/me/completion` | authenticated | yes | `services/account/profileCompletionService.getCompletion` |
| `GET /api/v1/customer/profile` | authenticated | yes | `services/account/accountService.getCustomerProfile` |
| `PATCH /api/v1/customer/profile` | authenticated | yes | `services/account/accountService.patchCustomerProfile` |
| `GET /api/v1/customer/addresses` | authenticated | yes | `services/account/addressBookService.listAddresses` |
| `POST /api/v1/customer/addresses` | authenticated | no | `services/account/addressBookService.createAddress` |
| `PATCH /api/v1/customer/addresses/:addressId` | authenticated | yes | `services/account/addressBookService.updateAddress` |
| `DELETE /api/v1/customer/addresses/:addressId` | authenticated | yes | `services/account/addressBookService.deleteAddress` |
| `POST /api/v1/customer/addresses/:addressId/default` | authenticated | yes | `services/account/addressBookService.setDefaultAddress` |
| `GET /api/v1/provider/profile` | provider | yes | `services/account/providerProfileService.getProviderProfile` |
| `PATCH /api/v1/provider/profile` | provider | no | `services/account/providerProfileService.patchProviderProfile` |
| `GET /api/v1/providers/:providerUid/profile` | authenticated | yes | `services/account/providerProfileService.getProviderProfile` |
| `GET /api/v1/provider/documents` | provider | yes | `services/account/providerProfileService.listDocuments` |
| `GET /api/v1/provider/document-types` | provider | yes | `services/providerProfileComplianceService.DOCUMENT_TYPE_CATALOG` |
| `POST /api/v1/provider/documents` | provider | no | `services/providerProfileComplianceService.uploadDocument` |
| `GET /api/v1/provider/documents/:documentId/preview` | provider | yes | `services/providerProfileComplianceService.getDocumentPreview` |
| `DELETE /api/v1/provider/documents/:documentId` | provider | yes | `services/providerProfileComplianceService.deleteDocument` |
| `GET /api/v1/provider/availability` | provider | yes | `services/providerAvailabilityEngine.getAvailabilityProfile` |
| `PATCH /api/v1/provider/availability` | provider | yes | `services/providerAvailabilityEngine.saveWeeklySchedule` |
| `GET /api/v1/provider/time-off` | provider | yes | `services/providerAvailabilityEngine.listTimeOff` |
| `POST /api/v1/provider/time-off` | provider | no | `services/providerAvailabilityEngine.createTimeOff` |
| `DELETE /api/v1/provider/time-off/:timeOffId` | provider | yes | `services/providerAvailabilityEngine.cancelTimeOff` |
| `GET /api/v1/provider/services` | provider | yes | `services/account/providerProfileService.listServices` |

### Legacy routes still mounted

Every one stays until the client that calls it has migrated, and every one is counted
by `api/v1/legacyTelemetry` — the watch list is derived from this same contract, so a
route can only be documented as superseded if it is also being measured.

| Legacy route | Disposition | Canonical successor | Why it is still there |
| --- | --- | --- | --- |
| `PUT /api/user/updateprofile` | ALIAS_TEMPORARILY | `me.patch` | The live profile write for every client. Same writer - this entry delegates to `user.service.updateUserProfile` rather than touching the columns, so the two paths cannot grow different rules. It additionally REFUSES unwritable fields by name instead of stripping them silently. |
| `GET /api/provider/account-state` | KEEP | `me.completion.get` | NOT a duplicate. Account state answers "what may this provider do RIGHT NOW" - suspended, pending, active - and is what gates the app. Completion answers "what is left to fill in". A suspended provider can be 100% complete, and a pending one can be active-eligible and missing a photo. |
| `GET /api/user/profile` | ALIAS_TEMPORARILY | `customer.profile.get` | The live customer profile aggregate. It returns the credential row joined to the profile row; this entry returns the customer EXTENSION only, because the identity half is `/me` and duplicating it is how two endpoints come to disagree about a name. |
| `PUT /api/user/updateprofile` | ALIAS_TEMPORARILY | `customer.profile.patch` | One legacy route wrote both halves. Same writer underneath; the split is in the DTO. |
| `GET /api/user/alluseraddresses` | ALIAS_TEMPORARILY | `customer.addresses.list` | The live list for Customer Web and Mobile. It branches on role inside the service and returns EVERY customer address to an admin; the canonical route is owner-scoped in SQL with no role branch, and admin address access belongs on an admin route. |
| `GET /api/user/:userId/addresses` | ROLE_SPECIFIC | `customer.addresses.list` | The provider portal reading a booking customer's address. A genuinely different authorization question - it is answered from the booking relationship, not from ownership - and it stays on its own route rather than becoming a uid parameter here. |
| `POST /api/user/adduseraddress` | ALIAS_TEMPORARILY | `customer.addresses.create` | A create verb that doubles as an update when the body happens to carry an addressId. The canonical pair splits them, and both reach the same writer so the MongoDB geocode sync has one caller. |
| `POST /api/user/adduseraddress` | ALIAS_TEMPORARILY | `customer.addresses.update` | The same legacy route, taking the update branch when the body carries an addressId. |
| `DELETE /api/user/deleteaddress` | ALIAS_TEMPORARILY | `customer.addresses.delete` | Takes the id in a query string and leaves the account with NO default when the primary is removed - a checkout screen with nothing selected and no way to tell why. |
| `PUT /api/user/makeaddressprimary` | ALIAS_TEMPORARILY | `customer.addresses.setDefault` | TWO statements with no transaction - set the new default, then clear the others. A failure between them leaves the account with two primaries, and every reader picks whichever the planner returned first, including checkout. |
| `GET /api/provider/profile` | ALIAS_TEMPORARILY | `provider.profile.get` | The live provider profile, built inline in a controller with a hand-written column list. Safe only for as long as nobody adds a column; the canonical route emits the fields the policy says this seat may read. |
| `GET /api/provider/profile-center` | ROLE_SPECIFIC | `provider.profile.get` | The compliance view: revision history, review state, field-level edit affordances. A genuinely different question, and it already reads the same field registry this entry projects from. |
| `POST /api/provider/public-profile-revisions` | ALIAS_TEMPORARILY | `provider.profile.patch` | The live revision submit. IDENTICAL domain call - this is a second URL onto one workflow. |
| `GET /api/provider/documents` | ALIAS_TEMPORARILY | `provider.documents.list` | The live document list. Same `worker_requirements` model - the command is explicit that provider_documents must not be invented, and it does not exist. |
| `GET /api/provider/document-types` | ALIAS_TEMPORARILY | `provider.documents.types` | The same static catalog constant. No per-caller data of any kind. |
| `POST /api/provider/documents` | ALIAS_TEMPORARILY | `provider.documents.create` | The live submit for both provider clients. IDENTICAL domain call, and it carries the same post-commit `autoOnlineEngine.evaluateProvider` — submitting the last outstanding requirement is what makes a provider eligible to go online, so an endpoint that stored the file without re-evaluating would leave them blocked. |
| `GET /api/provider/documents/:documentId/preview` | ALIAS_TEMPORARILY | `provider.documents.preview` | Same authorization and the same short-lived grant. The `Cache-Control: private, no-store` and `Pragma: no-cache` headers are set by the handler rather than the route, so they travel with the only v1 response that contains a private storage URL. |
| `DELETE /api/provider/documents/:documentId` | ALIAS_TEMPORARILY | `provider.documents.delete` | IDENTICAL domain call, and it re-evaluates online eligibility for the same reason the upload does: withdrawing a requirement can make a provider ineligible, and skipping it would leave someone online against a document they just removed. |
| `GET /api/worker/availability` | ALIAS_TEMPORARILY | `provider.availability.get` | The live provider availability read. Same engine; the legacy shape bridges it to a web schedule. |
| `PUT /api/worker/availability` | ALIAS_TEMPORARILY | `provider.availability.patch` | The live write. IDENTICAL engine call, including its expectedVersion check. |
| `GET /api/worker/time-off` | ALIAS_TEMPORARILY | `provider.timeOff.list` | Same engine, same active-only filter. A cancelled period is history rather than a commitment and appears in neither. |
| `POST /api/worker/time-off` | ALIAS_TEMPORARILY | `provider.timeOff.create` | IDENTICAL engine call, and it carries the same bookingConflicts and conflictNotice. Time off is created even when it overlaps confirmed work - a provider who is ill must be able to record it - but the work is still theirs, and a response that did not say so would leave them assuming leave cancels their jobs. |
| `DELETE /api/worker/time-off/:id` | ALIAS_TEMPORARILY | `provider.timeOff.cancel` | IDENTICAL engine call. Cancels rather than deletes; the row survives as history. |
| `GET /api/worker/services-overview` | ALIAS_TEMPORARILY | `provider.services.list` | The live provider services screen. Same `employee_services` qualification; the canonical entry projects it keyed on services.id with the active flag matching actually selects on. |
| `GET /api/worker/service-applications` | KEEP | `provider.services.list` | NOT a duplicate. An application is the REQUEST to be approved for a service and carries its own lifecycle; this entry is the resulting qualification. A provider can have a pending application and no qualification, which is exactly the state the two endpoints exist to tell apart. |

## Cross-platform caller matrix

`migrated` — this client calls the canonical v1 route today.
`legacy` — this client calls a legacy route the canonical entry supersedes.
`planned` — this client will migrate; it calls no equivalent today.
`—` — the capability does not apply to this client.

| Capability | Customer Mobile | Customer Web | Provider Mobile | Provider Web | Admin Web |
| --- | --- | --- | --- | --- | --- |
| Read and change my account record | legacy | legacy | legacy | legacy | planned |
| Read and change my settings | planned | planned | migrated | planned | planned |
| Read my security posture | planned | planned | planned | planned | planned |
| Read and change my customer profile | legacy | legacy | — | — | planned |
| Manage my saved addresses | legacy | legacy | — | — | — |
| Read and change my provider profile | — | — | legacy | migrated | planned |
| Submit, read, preview and withdraw my documents | — | — | legacy | legacy | — |
| Read and change my availability, and book time off | — | — | legacy | legacy | — |
| Read the services I am approved for | — | — | migrated | planned | — |
| What is left before my account is usable | planned | planned | migrated | planned | — |

No client is `migrated` yet: the platform application repositories are out of scope
until the backend Master Command completes. Every legacy route above stays mounted and
reaches the same domain service, so a client migrating later changes its URL and its
response parsing — not what it is allowed to see.

### Why each capability is or is not role-split

**Read and change my account record** (`services/account/accountService`)

No role split. One identity record for every account, and the ROLE-specific data is deliberately not here — `/me` carries a pointer to which extensions exist, not their contents. A `/me` that carried the provider compliance state would be fetched by every screen, used by almost none, and cached everywhere.

**Read and change my settings** (`services/account/accountSettingsService`)

No role split, and no web/mobile split either — which is the point. The settings live in one account-keyed store, and notification preferences are a POINTER to the TAB 09 model rather than a second copy of it.

**Read my security posture** (`services/account/accountSettingsService`)

No role split. READ-ONLY on purpose: every security ACTION already has a dedicated endpoint with its own proof of possession, and folding them into a settings PATCH would put credential changes behind a JSON body — including the ability to turn 2FA OFF from a session that should not be able to.

**Read and change my customer profile** (`services/account/accountService`)

Role-specific by DATA, not by authorization: birth date and gender exist for a customer and mean nothing for a provider. Customer Web and Customer Mobile call the identical route with the identical DTO, which is what the release gate asks for.

**Manage my saved addresses** (`services/account/addressBookService`)

No role split. Five legacy routes with five shapes — query-param ids, a POST that doubles as an update, a separate make-primary verb — become one REST resource with stable ids. Every statement is owner-scoped in SQL rather than checked in a controller.

**Read and change my provider profile** (`services/account/providerProfileService`)

Role-specific by DATA and by WORKFLOW. A provider profile field is classified, and editing a reviewable one submits a revision rather than writing a column — the compliance service owns that, and the canonical PATCH delegates to it instead of reimplementing it.

**Submit, read, preview and withdraw my documents** (`services/providerProfileComplianceService`)

Provider-only, and it must stay that way. The projection carries review STATE and never a document URL or storage path; the preview endpoint mints a short-lived signed URL after re-authorizing, which is a different operation with a different audit trail. The write half arrived on 2026-08-18: the LIST was canonical while submit, preview and withdraw were still legacy, which is the most lopsided shape a capability can have - a provider could read their onboarding state over v1 and not act on it. Submit and withdraw both re-evaluate online eligibility, because the last outstanding requirement is what gates going online in either direction.

**Read and change my availability, and book time off** (`services/providerAvailabilityEngine`)

No role split. The canonical route reads and writes the SAME engine matching consumes, which is the release gate: a provider editing one source while matching reads another is a provider who is unbookable for reasons nobody can see.

**Read the services I am approved for** (`services/account/providerProfileService`)

Provider-only. Keyed on `services.id` — the Catalog V2 canonical specific-service identity — never on a service family, and it projects the same qualification the matching pipeline selects on.

**What is left before my account is usable** (`services/account/profileCompletionService`)

No role split; the RULES differ by role and are declared, not branched. One endpoint answers both, which is what stops a welcome card from inventing its own definition of complete and showing a green tick over an account that cannot take work.
