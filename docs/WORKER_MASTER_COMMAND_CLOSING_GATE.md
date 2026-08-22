# Worker/Provider Master Command — closing gate

**TAB 11.** Written 2026-08-21 against the local tree. Backend only. Nothing in
this programme was pushed or deployed.

---

## The acceptance, measured

| Acceptance criterion | Result |
|---|---|
| Every one of the 54 has a disposition | **54 / 54** |
| The published contract carries required and permitted body fields for every write | **85 writes, 70 declaring a body schema, the rest declaring `null`** |
| Both provider clients can state which legacy routes they still need | **Outstanding — this is the clients' half. See below.** |

v1 surface at the close: **171 mounted operations**, from 115 at the start.
Contract digest `12eef36098f8787df30498a78aa1984c072e6310fa61d3fa0396ac2012613795`.

`tests/worker-master-command-closing-gate.test.ts` pins all 54 by name and fails
if any loses its successor. A document saying they are closed is a claim; that
suite is the check. It is mutation-verified: removing a legacy mapping turns it
red.

The 54 are **transcribed from the Master Command**, not derived from the
contract. Deriving them would be circular — a path quietly dropped from the
contract would also vanish from the expectation, and the gate would go green on
a smaller world. Transcribing produced a useful cross-check too: enumerating the
book's clusters yields exactly 54, the number the book states.

---

## What "disposition" means here

Every one of the 54 is **ALIAS_TEMPORARILY**: a canonical successor exists and is
mounted, and the legacy route stays until the clients say they have migrated.
None was retired, and that is deliberate — retiring a route is a decision that
belongs to the clients that call it, and no client has confirmed a migration
during this programme.

So the honest summary is: **the backend half is done and the client half has not
started.** Publication is what a backend can finish alone. Adoption is not.

---

## The disposition table


### TAB 01/04 — activation & compliance

| Legacy route | Disposition | Canonical successor |
|---|---|---|
| `/api/provider/account-state` | ALIAS_TEMPORARILY | `/api/v1/provider/activation` |
| `/api/provider/activation/policy-acknowledgement` | ALIAS_TEMPORARILY | `/api/v1/provider/activation/policy-acknowledgement` |
| `/api/provider/certifications` | ALIAS_TEMPORARILY | `/api/v1/provider/certifications` |
| `/api/provider/compliance` | ALIAS_TEMPORARILY | `/api/v1/provider/activation` |
| `/api/provider/contact-changes` | ALIAS_TEMPORARILY | `/api/v1/provider/contact-changes` |
| `/api/provider/contact-changes/confirm` | ALIAS_TEMPORARILY | `/api/v1/provider/contact-changes/confirm` |
| `/api/provider/profile-center` | ALIAS_TEMPORARILY | `/api/v1/provider/profile` |
| `/api/provider/profile-fields` | ALIAS_TEMPORARILY | `/api/v1/provider/profile-fields` |
| `/api/provider/public-profile-preview` | ALIAS_TEMPORARILY | `/api/v1/provider/public-profile` |
| `/api/provider/public-profile-revisions` | ALIAS_TEMPORARILY | `/api/v1/provider/profile` |
| `/api/provider/verification-timeline` | ALIAS_TEMPORARILY | `/api/v1/provider/verification-timeline` |

### TAB 02 — job cards

| Legacy route | Disposition | Canonical successor |
|---|---|---|
| `/api/worker/job-cards` | ALIAS_TEMPORARILY | `/api/v1/provider/jobs` |
| `/api/worker/job-cards/:bookingId` | ALIAS_TEMPORARILY | `/api/v1/provider/jobs/:bookingId` |

### TAB 05 — services & applications

| Legacy route | Disposition | Canonical successor |
|---|---|---|
| `/api/worker/services-overview` | ALIAS_TEMPORARILY | `/api/v1/provider/services/overview` |
| `/api/worker/service-applications` | ALIAS_TEMPORARILY | `/api/v1/provider/services` |
| `/api/worker/service-applications/:applicationId` | ALIAS_TEMPORARILY | `/api/v1/provider/service-applications/:applicationId` |
| `/api/worker/service-applications/:applicationId/resubmit` | ALIAS_TEMPORARILY | `/api/v1/provider/service-applications/:applicationId/resubmit` |
| `/api/worker/services/:serviceId/eligibility` | ALIAS_TEMPORARILY | `/api/v1/provider/services/:serviceId/eligibility` |
| `/api/worker/services/:serviceId/pause` | ALIAS_TEMPORARILY | `/api/v1/provider/services/:serviceId/pause` |
| `/api/worker/services/:serviceId/reactivate` | ALIAS_TEMPORARILY | `/api/v1/provider/services/:serviceId/reactivate` |

### TAB 06 — presence & safety

| Legacy route | Disposition | Canonical successor |
|---|---|---|
| `/api/provider/location/go-online` | ALIAS_TEMPORARILY | `/api/v1/provider/presence/online` |
| `/api/provider/location/go-offline` | ALIAS_TEMPORARILY | `/api/v1/provider/presence/offline` |
| `/api/worker/location` | ALIAS_TEMPORARILY | `/api/v1/provider/location` |
| `/api/provider/safety/check-in` | ALIAS_TEMPORARILY | `/api/v1/provider/safety/check-in` |
| `/api/provider/safety/emergency-config` | ALIAS_TEMPORARILY | `/api/v1/provider/safety/emergency-config` |
| `/api/provider/safety/incidents` | ALIAS_TEMPORARILY | `/api/v1/provider/safety/incidents` |

### TAB 07 — evidence, cancellation, cash

| Legacy route | Disposition | Canonical successor |
|---|---|---|
| `/api/provider/bookings/:bookingId/evidence` | ALIAS_TEMPORARILY | `/api/v1/provider/jobs/:bookingId/evidence` |
| `/api/provider/bookings/:bookingId/evidence/:evidenceId` | ALIAS_TEMPORARILY | `/api/v1/provider/jobs/:bookingId/evidence/:evidenceId` |
| `/api/provider/bookings/:bookingId/cancellation-eligibility` | ALIAS_TEMPORARILY | `/api/v1/provider/jobs/:bookingId/cancellation-eligibility` |
| `/api/:bookingId/mark-cash-paid` | ALIAS_TEMPORARILY | `/api/v1/bookings/:bookingId/cash-collected` |

### TAB 08 — support & reviews

| Legacy route | Disposition | Canonical successor |
|---|---|---|
| `/api/provider/support/case-categories` | ALIAS_TEMPORARILY | `/api/v1/provider/support/case-categories` |
| `/api/provider/support/cases` | ALIAS_TEMPORARILY | `/api/v1/provider/support/cases` |
| `/api/provider/support/cases/:caseId` | ALIAS_TEMPORARILY | `/api/v1/provider/support/cases/:caseId` |
| `/api/provider/reviews` | ALIAS_TEMPORARILY | `/api/v1/provider/reviews` |
| `/api/provider/reviews/:reviewId/response` | ALIAS_TEMPORARILY | `/api/v1/provider/reviews/:reviewId/response` |
| `/api/provider/review-moderation/:caseId/appeals` | ALIAS_TEMPORARILY | `/api/v1/provider/review-moderation/:caseId/appeals` |

### TAB 09 — auth

| Legacy route | Disposition | Canonical successor |
|---|---|---|
| `/api/auth/signin` | ALIAS_TEMPORARILY | `/api/v1/auth/login` |
| `/api/auth/signup` | ALIAS_TEMPORARILY | `/api/v1/auth/register` |
| `/api/auth/firebase-login` | ALIAS_TEMPORARILY | `/api/v1/auth/login` |
| `/api/auth/resendverification` | ALIAS_TEMPORARILY | `/api/v1/auth/resend-verification` |
| `/api/auth/resend-email-otp` | ALIAS_TEMPORARILY | `/api/v1/auth/resend-verification` |
| `/api/auth/verify-email-otp` | ALIAS_TEMPORARILY | `/api/v1/auth/verify-email` |

### TAB 10 — the remainder

| Legacy route | Disposition | Canonical successor |
|---|---|---|
| `/api/chat/attachments/upload` | ALIAS_TEMPORARILY | `/api/v1/conversations/:conversationId/attachments` |
| `/api/provider/alerts` | ALIAS_TEMPORARILY | `/api/v1/provider/alerts` |
| `/api/provider/alerts/:alertKey` | ALIAS_TEMPORARILY | `/api/v1/provider/alerts/:alertKey` |
| `/api/provider/calendar` | ALIAS_TEMPORARILY | `/api/v1/provider/calendar` |
| `/api/provider/earnings` | ALIAS_TEMPORARILY | `/api/v1/provider/earnings/transactions` |
| `/api/provider/performance` | ALIAS_TEMPORARILY | `/api/v1/provider/performance` |
| `/api/provider/fcm-token` | ALIAS_TEMPORARILY | `/api/v1/me/devices` |
| `/api/provider/account/delete` | ALIAS_TEMPORARILY | `/api/v1/provider/account/deletion-request` |
| `/api/user/updateprofile` | ALIAS_TEMPORARILY | `/api/v1/me` |
| `/api/worker/profile/photo` | ALIAS_TEMPORARILY | `/api/v1/provider/profile/photo` |
| `/api/worker/schedule` | ALIAS_TEMPORARILY | `/api/v1/provider/schedule` |
| `/api/provider-catalog/v1/offerings` | ALIAS_TEMPORARILY | `/api/v1/provider/catalog/offerings` |

---

## What the book got wrong, and why it matters

Three of its eleven TABs rested on a premise that did not hold at this HEAD.
Recording them is not point-scoring: a client team planning from the book rather
than from the generated matrix would have rebuilt endpoints that already existed.

- **TAB 02 — job cards.** The book records both job-card routes as having no
  canonical successor. Both v1 handlers already called the *same* `formatJobCard`
  the legacy controllers call, both legacy paths were already declared
  `ALIAS_TEMPORARILY`, and the provider mobile client's own manifest cites the
  Dart file and line where it calls them. The book was written from the client's
  **frozen legacy inventory** — paths still *present* in its code — which is a
  different question from *has no canonical successor*.
- **TAB 09 — auth.** All six named paths already had declared successors, and v1
  carried nine auth operations rather than the four credited.
- **TAB 10 — the remainder.** The item the book ranks first, the chat attachment
  upload it says "holds a whole surface back", already had a successor. Three
  more of its twelve were mapped too.

**The lesson, applied from TAB 03 onward: re-measure every premise before
implementing.** TAB 01's held. TAB 02's did not.

The opposite error is more common than the book's: **counting paths undercounts
the work.** TAB 05's "seven paths" carry eight operations; TAB 08's "six paths"
carry eighteen across sixteen; TAB 10's `worker/profile/photo` is one path with
two. A path is not an operation.

---

## Defects found and fixed, that the book did not ask for

Each was found by measuring a cluster rather than by reading its description.

| TAB | Defect |
|---|---|
| 01 | `photo` sat in two disagreeing allow-lists, so a PATCH carrying it was refused with a code the operation does not declare. |
| 05 | **`employee_services.service_id` is FK-constrained to `service_families`**, but v1's `/provider/services` joined `services` — a different id space since migration 024. Providers were shown a *different service's name*. A pre-existing test asserted the opposite and had been wrong since the rename. |
| 06 | Safety-incident de-duplication was a check-then-act with **no unique index anywhere in the codebase**, so two concurrent retries could both insert. Also: a location ping could flip presence, which §27 forbids. |
| 07 | Evidence upload had **no idempotency key at all** — a doorstep retry filed a second photo. Migration 043 adds the replay key. |
| 09 | **Every 429 on a v1 route violated the v1 envelope** — no `requestId`, which `routeHealth` requires — on the one refusal an operator most needs to correlate to a log line. |
| 10 | Contract entries named modules that **do not exist**; `domainService` is meant to be true. |

---

## What is NOT done, and who owns it

Stated plainly rather than left for somebody to discover.

1. **Adoption.** Every one of the 54 successors records `providerMobile:
   'planned'`. The reconciler derives that field from each client's own published
   manifest, and no client manifest changed during this programme. **The book's
   own instruction applies: re-measure with the clients, not for them — ask both
   provider teams for their call manifests.** A backend claiming a client had
   migrated is precisely the defect `reconcile-client-manifests` exists to remove.

2. **Migration 043 is written and unapplied.** It adds the evidence replay key.
   It verifies clean against embedded PostgreSQL; it needs a real deploy to take
   effect, and nothing in this programme was deployed.

3. **A pre-existing schema divergence.** `db:verify:embedded` reports a fresh
   database reaching **133 tables against a declared 132**, caused by
   `038-telemetry-events`. Migration 043 creates zero tables. The declared number
   was **not** raised: the gate warns against doing that without knowing which
   side is stale, and guessing would destroy the signal.

4. **Account-deletion retention.** The legacy handler promises erasure "within 30
   days" in a **message string**. No client can branch on it and **no scheduled
   job in this repository executes it**. What is removed and what is retained is
   a legal decision under RA 10173, not an API one, so no schedule was asserted.

5. **Consent semantics.** `acknowledgeProviderPolicy` pins its timestamp to the
   provider, not the policy version, so acknowledging a *revised* agreement is
   indistinguishable from re-acknowledging the old one.

6. **The document-count divergence** between the readiness-driven and
   catalog-driven document counts is surfaced in one response and pinned by test,
   not reconciled. It is a question about which source owns the answer.

Items 4, 5 and 6 are **product or legal decisions**, deliberately not made inside
a migration programme.

---

## Nothing was pushed or deployed

Every TAB was committed locally to `main`. No remote operation, no production
access, no destructive data operation, no credential change. The standing
sweep→test→merge→push sequence applies whenever a push is authorised, and has
not been run because no push was authorised.
