# SERVANA CUSTOMER APP — THE BACKEND MASTER COMMAND

| | |
| --- | --- |
| **For** | the backend developer on `servana_api` |
| **Subject** | everything `servana_api` owes **ServanaClientAPP**, the customer mobile app |
| **Issued** | 2026-08-23 |
| **Measured against** | `servana_api` `origin/main` `3d09337` · client `25d4bcf` |
| **Scope** | **BACKEND ONLY.** Every item here is closed in this repository. Nothing here is a Flutter change. |
| **Supersedes** | consolidates `SERVANA_CLIENT_APP_BACKEND_MASTER_COMMAND.md` and `SERVANA_CUSTOMER_SWEEP_BACKEND_MASTER_COMMAND.md` into one ordered list |

**76 open backend findings** carry the customer app's `SC-###` ids. This document
orders them, explains the ten that matter most, and indexes the rest in §9.

---

## 0. THE ONE THING TO READ

**The customer app is not waiting on itself. It is waiting on this repository.**

Of 148 open findings against the customer app, **76 are tagged `Fix in: backend`** —
just over half. The app's own defects have largely been fixed; what is left is
here.

Two of those 76 are **blocking an App Store submission today**, and three more
are **security findings that should not wait for a queue**.

Use the existing `SC-###` ids. Do not start a new numbering scheme — the client's
`docs/MASTERLIST_PENDING_ITEMS_SERVANA_CLIENT_APP.md` is the shared register and
`SC-194` is the highest id in use.

---

## 1. CRITICAL PATH — what blocks the App Store submission

The customer app was **rejected by App Store Review on 2026-08-22**. Of three
guidelines cited, the app has fixed one; **the other two are yours.**

### 1.1 — Sign in with Apple refuses any returning email · Guideline 2.1(a)

**This is the single highest-priority item in this document.**

Traced end to end — operation, not filename:

```
POST /api/auth/customer-firebase-login          routes/auth.route.ts:124
  -> customerFirebaseLogin                      services/firebaseFunctions.service.ts:287
    -> findLinkCollision                        services/accountLinkGuard.ts:62
```

1. The Firebase ID token is verified; the Firebase user is fetched.
2. If the uid has **no row** in `user_credentials` — a *first-sight* uid — the
   route calls `findLinkCollision(uid, email, phone)`.
3. That returns a hit when **any other uid carries the same normalised email**
   (or normalised PH mobile).
4. On a hit the route **refuses**: `auth.controller.ts:302` answers **HTTP 200**
   with `{status:'failed', message}` — deliberately 200 so the shipped app can
   display the message rather than treat it as a session expiry.
5. The app's `AuthTokenExchanger` sees a 200 with an empty `token` and emits
   `AuthenticationUnauthenticated`.

**Sign in with Apple ALWAYS produces a first-sight uid**, because Firebase issues
a new uid per provider. So step 2 is always entered and step 3 decides on email
alone.

> **Any customer whose email already exists under a different uid can never sign
> in with Apple.** To a reviewer who signed in with Google in an earlier round,
> that is exactly *"the app did not log us in."*

**The refusal is deliberate and well-reasoned — do not simply delete it.**
Firebase issues a uid per identifier and `upsertFirebaseUser` is
`ON CONFLICT (uid)`. Without the guard the same person signing in a second way
gets a **second, empty account** — no bookings, no addresses, nothing errored,
which reads as data loss.

**And do not reach for the existing merge path.** `mergePhoneIntoExistingAccount`
**deletes the incoming Firebase user and returns a custom token**, which the
shipped app cannot exchange — it uses `data.token` directly as a bearer. Merging
here would hand the app a token for a uid that no longer exists. The author
refused to trade one silent failure for another, and was right.

**What to build.** Link the Apple provider to the **existing** account and return
a **normal bearer token** in the shape the installed app already reads. That is
the only option that fixes builds already on devices.

- Preserve the duplicate-account guard that motivated the refusal — link to the
  existing account, never create a second.
- Treat Apple **private relay** addresses (`@privaterelay.appleid.com`) as real,
  deliverable emails.
- Keep the 200-with-message shape for cases that still legitimately refuse
  (archived, disabled) — and make those distinguishable.

**Certify when** an Apple sign-in whose email already exists returns a usable
bearer token and lands on the existing account with its bookings intact, proven
by a test that fails against today's code.

**Verify first (`B-2`):** confirm the Apple provider is enabled in Firebase for
`servana-59bee`. If it is not, that is a second, independent cause.

### 1.2 — Deletion requests are recorded and never fulfilled · Guideline 5.1.1(v) · `SC-191`

`recordDeletionRequest` / `recordDeletionRequestForUid`
(`services/accountDeletionService.ts:67, :95`) perform an `INSERT` into
`account_deletion_requests` with status `pending`. The docblock describes the
intended design — anonymise the identity columns, keep the financial trail,
because a hard `DELETE` throws a foreign-key violation the moment an account has
history. **A targeted search across `src/` and `scripts/` found no code that
performs that anonymisation.**

Stated precisely because it decides the work: *a request is recorded; no
fulfilment mechanism was found.*

**Why this is urgent rather than merely open.** The customer app **shipped the
deletion flow on 2026-08-23**. Settings → Privacy & Legal → Delete Account is
live and calling `POST /api/account/deletion-request/me`. **Real requests are
arriving now**, and Apple re-checks this guideline on resubmission. "Recorded as
pending" is not deletion.

**Do:**
1. **First:** query `account_deletion_requests` and establish whether any row has
   ever moved past `pending`. That answer decides everything else.
2. Implement fulfilment to the design the service already describes.
3. Define the window between request and fulfilment; write it down; make it short
   enough to defend to a reviewer.
4. Ensure a fulfilled account cannot be signed back into, and that tokens and FCM
   registrations are revoked.
5. Confirm the duplicate collapse still holds — `idx_adr_open_identifier` is
   UNIQUE on `(identifier)` WHERE `status='pending'`. **The app relies on
   pressing twice being safe.**

---

## 2. SECURITY — do not let these sit in a queue

Four findings from the LEAK pass. The first is the sharpest.

### `SC-074` — a customer token can bootstrap a super admin, and it fails OPEN

`POST /api/admin/admin-users/bootstrap-super-admin` is callable with **any
customer's Firebase token**, and fails **open** when no super admin exists.
A privilege boundary that fails open is not a boundary.

### `SC-075` — Socket.IO `join_room` ownership bypass

On the root namespace, a **client-supplied `type` label** bypasses the booking
ownership check, letting any authenticated account join another customer's room.

### `SC-076` — `verifyAuthOptional` makes "no credentials" the most privileged state

It silently downgrades an invalid or expired token to anonymous. Any route where
anonymous is treated more permissively than a wrong token is exploitable by
simply sending a bad token.

### `SC-136` / `SC-130` — a booking conversation is created with no state gate

Created on the customer's first access, with no assigned-or-confirmed check.

---

## 3. MONEY AND BOOKING CORRECTNESS

These are what a customer sees and what an accountant reconciles.

| id | finding |
| --- | --- |
| `SC-024` | `totalAmount` is not a registered alias of `finalPrice` — **customer booking detail renders ₱0.00 for every booking** |
| `SC-021` | 'Pay Now' is unreachable on booking detail: `_needsPayment` can never be true |
| `SC-068` | The PayMongo webhook overwrites `bookings.status` with `PAID`, **regressing an in-progress or completed booking** |
| `SC-089` | `PAYMENT.SETTLE` has four implementations that leave the system in four different states |
| `SC-088` | The booking↔payment join is scoped by `additional_request_id` in the provider read model but not the customer one |
| `SC-125` | `approvePayment` / `markCashPaid` have no state guard and no idempotency — replay resets `paid_at` and re-fires the provider notification |
| `SC-133` | Payment response envelopes diverge three ways on one surface; `checkout_url` is the only snake_case key |
| `SC-023` | `paymentMethod` vocabulary diverges — `'PAYMONGO'` is never written to `payments.method` |

**`SC-024` first.** Every customer currently sees ₱0.00 on every booking detail.

---

## 4. DUPLICATION AND REPLAY

**The pattern to notice: the fix was applied to the provider surface and not to
the customer surface that mirrors it. Twice.**

### `SC-189` — customer safety incidents can still duplicate

`customerSupportService.ts` does `findOne` then `insertOne` on
`(uid, clientIncidentId)`. `providerSafetyService.ts` carries the definitive
analysis of why that is not idempotent under retry, and was fixed with **an
atomic upsert PLUS a unique index** — both halves, because a MongoDB upsert is
only insert-once when a unique index makes the second one fail.

**`createIndex` appears in exactly one file in this repository — the provider
one.** The customer app already sends `clientIncidentId`. The client contract is
met; the enforcement is not.

Test with **two genuinely concurrent** requests. A sequential test passes against
the broken code and proves nothing.

### `SC-190` — chat attachment upload accepts no replay key

`uploadAttachment` (`chat/chat.controller.ts:173`) reads exactly
`{file, name, conversationId}`. A customer whose upload commits then times out
retries, and the retry files a **second photo**. Migration `043` gave provider
booking evidence exactly this protection days earlier; `sendChatMessage` next
door already understands `clientMsgId`.

Follow `043`'s shape: a nullable column plus a **partial** unique index
constraining only rows where the key is NOT NULL.

### `SC-036` / `SC-058` / `SC-081` / `SC-104` — booking creation ignores the key it is sent

**The client already sends `X-Idempotency-Key` on booking creation and the
backend never reads it.** The admin path has a full idempotency table; the
customer path has none. A double-submit creates two bookings.

### `SC-194` — the rest of the write surface

**5 of 35** customer mutating operations carry any replay key. Ten unprotected
ones have real duplication consequence: `uploadChatAttachment`,
`createPaymongoSession`, `submitGcashProof`, `addSupportTicketReply`,
`reportChatMessage`, `reportReview`, `addUserAddress`, `getAirconQuote`,
`editReview`, `cancelBooking`.

**Publish one mechanism** — header or body field — and apply it. Two mechanisms
is how this became inconsistent. The naturally idempotent remainder (sign-in,
logout, `markNotificationRead`…) is deliberately excluded: adding keys there is
cost without benefit.

---

## 5. THE CUSTOMER IS NEVER TOLD ANYTHING

| id | finding |
| --- | --- |
| `SC-028` / `SC-050` / `SC-064` / `SC-087` | The client recognises **22 notification types and 9 deep-link targets**; the backend emits **exactly one**. The entire customer notification system has one producer. |
| `SC-041` | Chat messages emit a Socket.IO event but **never an FCM push** — a backgrounded customer never learns a provider replied |
| `SC-042` | Customer cancellation does not notify the assigned provider — who can travel to a job cancelled hours earlier |
| `SC-053` | The PayMongo webhook confirms payment but notifies neither party |
| `SC-034` | `assignNearestWorker` returning `{assigned:false}` is **silently discarded** — the booking is stranded at CONFIRMED with no worker and no notification |
| `SC-035` | `confirmOtp` is non-atomic: the booking is CONFIRMED before assignment, so an assignment failure is reported to the customer as an invalid code |

This cluster is why the app feels dead after booking. It is one backend concern,
not six client bugs.

---

## 6. FLOWS THAT ARE SIMPLY BROKEN

| id | finding |
| --- | --- |
| `SC-044` / `SC-065` | **In-app email verification is permanently broken** — the client posts `{otp}`, the backend requires `{email, otp}` |
| `SC-032` | 'Resend email OTP' sends no request body, so it always returns 400 |
| `SC-031` | 'Resend code' on the booking OTP screen calls a route that does not exist — the OTP step has no recovery path |
| `SC-043` | Editing a saved address is delete-then-recreate; a failure between the two destroys the address |
| `SC-040` | Address save shows "Address saved!" while the coordinate write is fire-and-forget |
| `SC-039` | Address coordinates are client-supplied and written verbatim, then drive service-area eligibility |
| `SC-049` | The bookings list returns guest bookings matched by phone; the detail route refuses them — tapping one dead-ends |
| `SC-119` | Submitting a review overwrites `bookings.status` with `REVIEWED`, which can remove a still-active paid job from the provider |
| `SC-169` | JobOrder submission has **no backend endpoint** at all — the client method is a stub |

---

## 7. DEAD ENDS THE APP CURRENTLY SHOWS

The customer app deliberately shows honest "unavailable" tiles rather than fake
working ones. Each is waiting on a route.

- **`SC-192` — customers cannot export their data; providers can.**
  `POST /provider/privacy/export` exists with no customer equivalent. This is
  what keeps the "Export My Data" tile dead. Apple did not cite it; it is a live
  obligation in several jurisdictions and should not be discovered the way
  account deletion was.
- **`SC-193` — no active-sessions endpoint.** The Security screen's tile is a
  dead end. If sessions are ever listed, **revocation must ship with them** — a
  list you cannot act on is worse than no list.

---

## 8. CONTRACT, PARITY AND INFRASTRUCTURE

- **The customer app has no client manifest.** `contract.ts` records
  `customerMobile` as migrated on **zero** canonical routes while the app calls
  **41**. `providerMobile` shows 32 migrated matching its 32-endpoint manifest
  exactly, which proves the derivation works. Consequence, per
  `scripts/reconcile-client-manifests.ts`'s own docblock: retirement requires
  every caller migrated, so **none of the 145 `ALIAS_TEMPORARILY` routes can be
  retired**. Build it from **referenced** call sites — the client declares 61
  builders and uses 41; deriving from declarations over-reports by a third.
- **`SC-144`** — the REPEAT parity suite covers only provider capabilities. **No
  customer capability has a parity test.**
- **`SC-095`** — the production deploy runs no tests, no typecheck and no
  contract guard; 22 jest suites gate nothing.
- **`SC-100`** — `guard-protected-contracts.mjs` cannot detect removal of any
  route the client actually calls.
- **`SC-094`** — two contract test files are excluded from jest and **pass
  vacuously**.
- **One planned v1 endpoint remains** in the entire surface:
  `GET /api/v1/catalog/services/:serviceId/serviceability`. The client already
  ships the feature against the legacy route and handles it correctly.

### Configuration, carried forward and still open

- **B1 — one whole category cannot be booked anywhere.** Legacy family 67
  (Electrical) has **zero** `service_coverage_geo` rows and `checkCoverageGeo`
  returns `covered: !!match` — absent configuration fails **closed**. Canonical
  service 180 is refused everywhere. **This is a configuration row, not code. If
  it can be fixed in an afternoon, fix it before anything else in §3–§8.**
- **B2** — Massage is Metro Manila only (family 52, one 25 km row). Probably
  intended; nothing tells the customer before they submit.
- **B3** — **MongoDB is an unlisted dependency of booking creation.**
  `createBooking` resolves the address through `getLatLonByLocationId`, which
  reads Mongo and **throws** when the document is missing. `/readyz` lists five
  dependencies and Mongo is not one — a Mongo outage fails every booking while
  readiness reports `ready:true`.
- **B4** — the only branch in production is a sample row, and branch capacity is
  the only path exercising `SLOT_UNAVAILABLE`/`SLOT_FULL`.

---

## 9. THE FULL INDEX — 76 open backend findings

Grouped by the pass that found them. Full text in
`ServanaClientAPP/docs/MASTERLIST_PENDING_ITEMS_SERVANA_CLIENT_APP.md`.

| Pass | Count | ids |
| --- | ---: | --- |
| **STITCH** | 19 | SC-031, 032, 034, 035, 036, 038, 039, 040, 041, 042, 043, 044, 049, 050, 053, 055, 119, 124, 193 |
| **REPEAT** | 19 | SC-077, 078, 079, 080, 081, 083, 084, 086, 087, 088, 089, 091, 139, 140, 141, 144, 189, 190, 194 |
| **ALIGN** | 15 | SC-058, 059, 062, 063, 064, 065, 067, 068, 071, 125, 126, 127, 130, 132, 133 |
| **SWEEP** | 12 | SC-021, 023, 024, 025, 027, 028, 109, 110, 156, 158, 191, 192 |
| **TEST** | 6 | SC-094, 095, 098, 100, 104, 153 |
| **LEAK** | 4 | SC-074, 075, 076, 136 |
| **RELEASE** | 1 | SC-169 |

**Verification status, stated honestly:** 18 P0 claims went through adversarial
verification (17 confirmed, 1 downgraded). **The rest are agent-reported and were
not independently verified.** Re-read the cited files before acting on one. The
items detailed in §1–§4 of this document were re-traced on 2026-08-23.

---

## 10. WORKING RULES

1. **Additive only.** One backend serves five clients. Add fields; never rename
   or remove. Prove it by **diffing captured responses**, not by reasoning.
2. **Trace the operation, not the file.** `findLinkCollision` lives in
   `accountLinkGuard.ts`, not in either file whose name suggests it. Three wrong
   conclusions here have come from filename searches.
3. **Surface parity.** Before closing an item, ask whether the mirror provider
   surface has the same defect — or already has the fix. `SC-189` and `SC-190`
   are both cases where the fix existed and was not carried across.
4. **Run `npm run verify` on a development machine.** The production host has
   **961 MB**; the suite runs `--runInBand` and peaks near **1.25 GB**, and
   verify has aborted there twice with **exit 134**. Swap does not help — it
   raises system memory, not the V8 heap ceiling.
5. **A detached worktree gives a FALSE failure.**
   `tests/parity-registry-hazards.test.js` asserts the Angular sibling repos are
   checked out beside this one: **344/345 in a worktree, 345/345 in the real
   checkout**, same commit.
6. **A push deploys nothing.** Deployment is `scripts/deploy-prod.sh`, run by
   hand on the host, then `scripts/post-deploy-readiness.sh`. There is no CI and
   no workflow may be added back.
7. **Five-step push, every time:** sweep `origin/main` at commit AND tree level →
   test what is upstream → merge → **re-test the merged result** → push straight
   to `main`, then align `dev`. `dev` is not a fast-forward target: merge `main`
   into it.

---

## 11. ORDER OF WORK

| # | Item | Why here |
| --- | --- | --- |
| 1 | **§1.1 Apple sign-in** | Blocks the App Store submission outright |
| 2 | **§1.2 deletion fulfilment** (`SC-191`) | The app is sending real requests now; Apple re-checks |
| 3 | **§2 security** (`SC-074`, `075`, `076`) | A privilege boundary that fails open |
| 4 | **B1** | One configuration row unblocks an entire category |
| 5 | **`SC-024`** | Every customer sees ₱0.00 on every booking |
| 6 | **§4 duplication** (`SC-189`, `190`, `036`) | Two already have the fix next door; port them |
| 7 | **§5 notifications** | One concern behind six symptoms |
| 8 | **§6 broken flows** | Email verification is permanently broken |
| 9 | **§8 contract, manifest, parity tests** | Unblocks alias retirement and stops regression |

---

## 12. ACCEPTANCE

- An Apple sign-in whose email already exists returns a usable bearer token and
  lands on the **existing** account.
- A deletion request demonstrably results in an anonymised account within a
  documented window, financial trail intact.
- Two concurrent identical incident submissions produce **one** incident.
- A replayed attachment upload produces **one** attachment.
- `POST /api/bookings` honours the `X-Idempotency-Key` it is already sent.
- Every duplication-consequential customer write either carries a replay key or
  has a written reason why it does not need one.
- `customerMobile` is derived from a published manifest and reads `migrated` on
  every canonical route it calls.
- **Each closed item states whether the mirror provider surface was checked.**

**Nothing here is closed by reasoning about it.** Each item names the artefact
that proves it: a concurrent test, a captured pair of responses, or a queried row.
