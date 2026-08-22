# SERVANA CUSTOMER APP — BACKEND MASTER COMMAND

| | |
| --- | --- |
| **Repository** | `servana_api` — github.com/PaulEspinas2020/servana_api |
| **Client served** | `ServanaClientAPP`, the customer mobile app (`com.servana.client`) |
| **Issued** | 2026-08-22 |
| **Measured against** | `origin/main` — local `main` is `4a647fd`, **11 commits behind** |
| **Scope** | BACKEND ONLY. The companion front-end programme is `SERVANA_CLIENT_APPSTORE_REMEDIATION_MASTER_COMMAND.md` in the client repo. |
| **Phases** | A ground truth and the record (01–03) · B unblock the App Store rejection (04–06) · C canonical completion (07–10) · D operability and closing (11–12) |

---

## 0. THE SHORT VERSION

Three things are true at once, and holding all three is the point of this
document:

1. **The customer app's wiring is in good shape.** All 41 canonical endpoints it
   actually calls resolve to **live** backend routes. All 63 concrete legacy
   paths it calls are declared in the migration matrix. Zero broken, zero
   pointing at a `planned` route. This was measured, not assumed.
2. **The backend's *record* of that app is empty.** `contract.ts` says the
   customer app is migrated onto **zero** canonical routes. It calls 41. The
   contract is not wrong by a little; it is blank, because the customer app is
   the one client with no manifest.
3. **The most likely cause of the App Store rejection is in this repository** —
   and it is deliberate, documented behaviour, not a bug in the usual sense.

That third point is the one to read first.

---

## 1. THE APPLE SIGN-IN FINDING

The client app was rejected under Guideline 2.1(a): *"The app did not log us in
when using Sign in with Apple."* The client-side investigation cleared the Dart
handler and the iOS entitlement, and left four candidate causes. **This is the
backend one, and it is now traced end to end.**

### 1.1 The mechanism

`POST /api/auth/customer-firebase-login` → `customerFirebaseLogin`
(`services/firebaseFunctions.service.ts:287`):

1. The Firebase ID token is verified and the Firebase user fetched.
2. If the uid has **no row** in `user_credentials` — a *first-sight* uid — the
   route calls `findLinkCollision(uid, email, phone)`
   (`services/accountLinkGuard.ts:62`).
3. `findLinkCollision` returns a hit when **any other uid carries the same
   normalised email** (or the same normalised PH mobile).
4. On a hit the route **refuses**. `auth.controller.ts:302` answers **HTTP 200**
   with `{status:'failed', message}` — deliberately 200, so the shipped app can
   display the message instead of treating it as a session expiry.
5. The client's `AuthTokenExchanger` sees a 200 with an empty `token`, returns
   an error string, and the bloc emits `AuthenticationUnauthenticated`.

**Sign in with Apple always produces a first-sight uid**, because Firebase issues
a new uid for the `apple.com` provider. So step 2 is always entered, and step 3
decides the outcome on email alone.

**Therefore: any customer whose email already exists in `user_credentials` under
a different uid cannot sign in with Apple. Ever.** They are told to use the other
identifier. To an App Store reviewer — who has very likely signed in with Google
or registered with that same address during an earlier review round — that is
precisely *"the app did not log us in."*

### 1.2 Why this is not simply a bug

The refusal exists for a good reason, written into the service: Firebase issues a
uid per identifier, and `upsertFirebaseUser` is `ON CONFLICT (uid)`. Without the
guard, the same person signing in a second way gets a **second, empty account** —
no bookings, no addresses, nothing errored. To that person it reads as data loss.

The merge path exists (`mergePhoneIntoExistingAccount`) but is deliberately not
used here, and the docblock is explicit about why: merging **deletes the incoming
Firebase user and returns a custom token**, which the shipped app cannot exchange
— it uses `data.token` directly as a bearer. Merging would hand the app a token
for a uid that no longer exists. The author refused to trade one silent failure
for another.

So this is a **design gap, not an oversight**: linking-on-sign-in was solved for
`/auth/firebase-login` (whose callers understand `relinked` + `customToken`) and
consciously left unsolved for the customer route.

### 1.3 What that means for the fix

There are exactly two honest ways out, and **one of them is not in this
repository**:

- **Backend (TAB 04):** link the Apple provider to the existing account and
  return a **normal bearer token**, so the installed app needs no new capability.
  This is the only option that fixes already-installed builds.
- **Client:** support `signInWithCustomToken` so the existing merge path can be
  used. That is front-end work and does not help anyone who has already
  installed the app.

**Do not close this by telling reviewers to use a different Apple ID.** It would
pass review and leave every real customer with a pre-existing email unable to use
the button the App Store requires the app to offer.

---

## 2. MEASURED GROUND TRUTH

Measured 2026-08-22 against `origin/main`. Local `main` (`4a647fd`) is **11
commits behind** and was not used for any figure below.

### 2.1 The canonical surface

| Measure | Value |
| --- | --- |
| Live `/api/v1` endpoints | **114** |
| Planned (documented, **not mounted**, returns 404) | **1** — `GET /api/v1/catalog/services/:serviceId/serviceability` |
| Routes mounted outside `/api/v1` | **519** |
| `ALIAS_TEMPORARILY` (canonical successor exists, kept until callers migrate) | 145 |
| `CANONICALIZE` (should become canonical, no successor built) | 11 |
| `ROLE_SPECIFIC` | 13 · `RETIRE` 1 · `KEEP` 349 |

### 2.2 What the customer app actually calls

| Measure | Value |
| --- | --- |
| Canonical endpoint builders **declared** in the client | 61 |
| Canonical builders **actually referenced** | **41** |
| Declared but never referenced — dead declarations | **20** |
| Client canonical calls resolving to a **live** backend route | **41 of 41** |
| Client canonical calls hitting a `planned` route | **0** |
| Concrete legacy paths the client calls | 63 (+9 built from a leading variable, unresolvable statically) |
| Concrete legacy paths **absent** from the migration matrix | **0** |

Two conclusions follow, and they point in opposite directions:

- **The wiring is sound.** Nothing the customer app calls is missing or planned.
- **A manifest must be built from *references*, not declarations.** Building it
  from the 61 declared builders would over-report adoption by 20 — the same
  over-counting that has already produced one wrong adoption figure in this
  programme.

### 2.3 The record gap

| Client | Manifest | `migrated` rows in `contract.ts` |
| --- | --- | --- |
| `providerWeb` | ✅ 41 endpoints | 115 references |
| `providerMobile` | ✅ 32 endpoints | **32 migrated** — exactly its manifest |
| **`customerMobile`** | ❌ **none** | **0 migrated** (40 `legacy`, 35 `planned`) |
| `customerWeb` | ❌ none | — |

`providerMobile` proves the derivation works: 32 manifest endpoints, 32 migrated
rows. The customer app calls 41 canonical endpoints and is recorded as having
migrated to **none of them**.

This is not cosmetic. `scripts/reconcile-client-manifests.ts` states the
consequence in its own docblock: alias retirement requires **every** client the
matrix lists to read `migrated`. With the customer app blank, **none of the 145
`ALIAS_TEMPORARILY` routes can ever be retired** — the backend is holding open a
legacy surface on behalf of a client that has already moved.

> **Stale comment to fix while here.** That same docblock says *"Customer Web,
> Provider Mobile, Customer Mobile and Admin Web have none yet."* Provider Mobile
> now has one. A generated-document programme cannot afford a stale claim in the
> generator.

### 2.4 Deploy — the standing blocker

- **There is no CI.** `.github/` holds **zero** files.
- **A push to `main` deploys nothing.** `scripts/deploy-prod.sh` is run **by a
  human, on the production host**. The old `deploy.yml` was moved into it
  verbatim; the header says so explicitly so nobody pushes expecting production
  to move.
- **The full gate cannot run on that host.** `npm run verify` died **twice with
  exit 134** (SIGABRT — the V8 heap giving out) on a box with **961 MB of RAM**;
  the suites run `--runInBand` and accumulate in one process. **Adding swap did
  not help** — swap raises system memory, not the heap ceiling.
- `scripts/post-deploy-readiness.sh` exists because a deploy previously reported
  success while production served 500s on every catalog read (2026-08-19).

**Nothing in this programme can be verified in production until a deploy
happens.** That is why TAB 01 is a deploy and not a code change.

### 2.5 Account deletion — recorded, but is it fulfilled?

The client's App Store rejection under 5.1.1(v) is answered on the backend by
routes that already exist:

| Endpoint | Auth | Source |
| --- | --- | --- |
| `POST /api/account/deletion-request` | public, rate-limited | `routes/accountDeletion.routes.ts:29` |
| `POST /api/account/deletion-request/me` | `verifyAuth` | `routes/accountDeletion.routes.ts:30` |
| `GET /account-deletion` | public HTML page | `app.ts:397` |

**But `recordDeletionRequest` only INSERTs a `pending` row** into
`account_deletion_requests` (`services/accountDeletionService.ts:67, :95`). The
docblock describes the intended design — anonymise the identity columns, keep the
financial trail, because a hard `DELETE` would throw a foreign-key violation the
moment an account has history — **and a targeted search across `src/` and
`scripts/` found no code that performs that anonymisation.**

Stated precisely, because it decides TAB 05: *a request is recorded; no
fulfilment mechanism was found.* Confirm before building — an out-of-band job or
a manual runbook would change the shape of the work, not the fact that Apple
expects deletion to actually occur.

---

## 3. BOUNDARIES AND WORKING RULES

1. **Backend only.** The customer app is not modified by this programme. Reading
   it to establish call-site truth is required — every manifest entry cites a
   `file:line` in the client repo.
2. **Trace the operation, not the file.** Standing rule for this repo: three
   wrong conclusions have come from filename searches. Follow route registration
   to the handler to the service, every time. `findLinkCollision` lives in
   `accountLinkGuard.ts`, not in either file whose name suggests it.
3. **Additive only.** One backend serves five clients. Add fields; never rename
   or remove. Prove it by diffing captured responses, not by reasoning.
4. **Auto-advance** on evidence-backed completion, with a distinct
   100%-completion report before any next-TAB reporting.
5. **Push after every completed TAB**, five-step procedure (§5). A push is safe
   here — it deploys nothing — but it is also therefore **not** a deploy.
6. **Manual-only items** are raised as `B-1 … B-6` (§4).

---

## 4. THE TAB SEQUENCE

### PHASE A — GROUND TRUTH AND THE RECORD

---

#### TAB 01 — Deploy, and prove production came back

**Goal.** Close M2. Until this runs, every production claim in this programme is
unverified.

**Do.**
1. Merge `origin/main` locally and run the **full** `npm run verify` **on a
   development machine** — not the 961 MB production host, where it aborts.
2. Run `scripts/deploy-prod.sh` on the host, per its header.
3. Run `scripts/post-deploy-readiness.sh` and capture the output. A deploy that
   ends at `pm2 start` has proven nothing.
4. Capture, before and after: catalog reads, `customer-firebase-login`, and one
   authenticated customer read. Diff them — additive-only, per §3.3.

**Certify when.** Production serves the deployed commit, readiness passes, and
the before/after capture shows no removed or renamed field.

**Trap.** A green local gate says nothing about the host. The 2026-08-19 outage
had a *consistent repository* and a drifted production database.

---

#### TAB 02 — Publish the `customerMobile` manifest

**Goal.** Make the contract tell the truth about the customer app.

**Do.**
1. Build `src/api/v1/client-manifests/customerMobile.canonical-calls.json` in the
   established shape — `{client, endpoints:[{method, path, cites:["file:line"]}]}`.
2. Derive it from the **41 referenced** builders, **not** the 61 declared ones.
   Every entry cites a real call site in `ServanaClientAPP`.
3. Run `npm run clients:reconcile` and let it write the derived state. Hand-edit
   nothing in `contract.ts`.
4. Confirm `npm run clients:reconcile:check` is green, so drift becomes a red
   build.
5. Fix the stale docblock in `scripts/reconcile-client-manifests.ts` (§2.3).

**Certify when.** `customerMobile` reads `migrated` on 41 routes, derived and
re-derivable, and the check gate passes.

**Trap.** The 20 dead declarations are the trap. A manifest built from the file's
`static String` list is wrong by a third and will read as *more* complete than
reality — the failure mode this repo has already had once.

---

#### TAB 03 — Report which aliases the customer app now releases

**Goal.** Convert TAB 02 into the retirement decision it unlocks.

**Do.**
1. With `customerMobile` populated, re-run the retirement criteria across the
   145 `ALIAS_TEMPORARILY` routes.
2. Produce the list of aliases now held open **only** by clients other than the
   customer app, and those now fully released.
3. Cross-check against legacy telemetry: **zero traffic is a precondition, not a
   substitute** for the matrix.
4. **Retire nothing in this TAB.** Report only.

**Certify when.** The list exists with per-route evidence and named remaining
blockers.

---

### PHASE B — UNBLOCK THE APP STORE REJECTION

---

#### TAB 04 — Apple sign-in must not refuse a returning email

**Goal.** Close §1. **The highest-value TAB in this programme.**

**Do.**
1. Reproduce first, in a test: a Firebase uid for `apple.com` whose email matches
   an existing `user_credentials` row must currently produce
   `{status:'failed'}` with no token. If that test does not fail today, the
   analysis in §1 is wrong and everything below is void.
2. Link the Apple provider to the existing account and return a **normal bearer
   token** in the shape the installed app already reads (`data.token`). Do not
   return a custom token — the shipped app cannot exchange one, which is the
   documented reason the merge path was refused here.
3. Preserve the duplicate-account guard that motivated the refusal. Linking must
   attach to the existing account, never create a second one.
4. Treat Apple **private relay** addresses as real, deliverable emails.
5. Keep the 200-with-message shape for cases that still legitimately refuse.
6. Decide and document what happens when the existing account is archived or
   disabled — that is a different refusal and must stay one.

**Certify when.** An Apple-provider sign-in whose email already exists returns a
usable bearer token and lands on the **existing** account with its bookings
intact; the duplicate-account guard still fires where it should; both are pinned
by tests.

**Trap.** This route is what the **live, installed** app calls. Anything
requiring a new client capability fixes nobody who has already installed it.

---

#### TAB 05 — Make account deletion actually delete

**Goal.** Give the client's 5.1.1(v) flow something real behind it.

**Do.**
1. **First, settle §2.5:** does anything today fulfil a `pending` request? Search
   the DB for processed rows and ask the owner. Record the answer.
2. If nothing does, implement fulfilment to the design the service already
   describes: anonymise identity columns, retain the financial trail, never hard
   `DELETE` an account with history.
3. Define and document the window between request and fulfilment, and make it
   short enough to defend to a reviewer.
4. Ensure a deleted account cannot be signed back into, and that its tokens and
   FCM registrations are revoked.
5. Keep duplicate requests collapsing safely — the unique partial index on
   `(identifier) WHERE status='pending'` already does this; prove it still holds.
6. Confirm `GET /account-deletion` states what is deleted and what is retained,
   and why.

**Certify when.** A request made through `POST /api/account/deletion-request/me`
demonstrably results in an anonymised account within the documented window, with
the financial trail intact, proven end to end.

**Trap.** "Recorded as pending" is not deletion. If fulfilment is a human
runbook, that is a **manual item with an owner and an SLA** (`B-4`), not a closed
TAB — and it must never require the *customer* to contact support, which Apple
forbids.

---

#### TAB 06 — Auth failures the client can actually present

**Goal.** Stop legitimate refusals from reading as silence.

**Do.**
1. Inventory every failure shape `customer-firebase-login` can return — 200
   `{status:'failed'}`, 401, 403 — and what the installed client does with each.
   A 401 fires `onUnauthorized` and shows "session expired" to somebody who has
   no session yet.
2. Ensure every user-actionable refusal uses the shape the app can display, and
   that its `message` names the next step.
3. Make misconfiguration diagnosable: if the Apple provider is disabled or the
   token is rejected upstream, the response must say so distinguishably rather
   than collapsing into a generic failure.

**Certify when.** Each failure mode is pinned by a test asserting both status and
body shape, and the client's behaviour for each is written down.

---

### PHASE C — CANONICAL COMPLETION FOR THE CUSTOMER APP

---

#### TAB 07 — Build the one planned endpoint the customer app needs

**Goal.** `GET /api/v1/catalog/services/:serviceId/serviceability` is the single
`planned` entry in the whole v1 surface, and the customer app has already shipped
the feature against the **legacy** route.

**Do.**
1. Implement it to the documented `CatalogServiceability` response.
2. Match the legacy route's semantics exactly — the client already relies on
   `{serviceable, reason, defaulted}` and treats an **absent** `serviceable` as
   *not* serviceable. Preserve that.
3. Prove equivalence by running both routes over the same inputs and diffing.
4. Update the contract; the client's migration is its own work.

**Certify when.** The endpoint is live, the registry shows zero `planned`
entries, and legacy/canonical answers are proven identical.

---

#### TAB 08 — Customer-surface contract tests

**Goal.** Make the customer app's 41 canonical calls a thing the backend cannot
break silently.

**Do.**
1. A test that fails when any manifest endpoint stops being `implemented`.
2. Response-shape assertions for the customer-critical reads: catalog, bookings,
   conversations, reviews, profile.
3. Pin the auth envelope for the customer surface — a revoked session escaping
   untranslated has happened before on this programme.

**Certify when.** Each test is proven to fail when its defect is reintroduced.

---

#### TAB 09 — Legacy telemetry for the customer surface

**Goal.** Replace opinion with traffic on the 63 legacy paths.

**Do.**
1. Confirm `legacyRouteTelemetry` covers all 63 and records caller identity.
2. Report observed traffic per route over a stated window.
3. Separate "no traffic because nobody calls it" from "no traffic because nobody
   uses that feature yet" — they justify very different decisions.

**Certify when.** Every one of the 63 has a traffic number and a stated window.

---

#### TAB 10 — Retire what the customer app has genuinely released

**Goal.** Convert TAB 03 and TAB 09 into deletions.

**Do.**
1. Retire only routes meeting **all** criteria: canonical successor live, every
   caller `migrated`, zero traffic over the stated window.
2. One route per commit, each naming its evidence.
3. Re-run the full gate after each.

**Certify when.** Retired routes are gone, the matrix reflects it, and no client
regressed. **Retiring nothing is an acceptable outcome** if the criteria are not
met — say so with evidence.

---

### PHASE D — OPERABILITY AND CLOSING

---

#### TAB 11 — Make the gate runnable where the deploy happens

**Goal.** Address the structural problem behind §2.4.

**Do.**
1. Decide, with the owner, between: raising host memory, sharding the suite so it
   does not accumulate in one heap, or formally accepting that the full gate runs
   only on a development machine and the host runs the cheap checks.
2. Whichever is chosen, write it into `docs/DEPLOY_AND_GATE_POLICY.md` so the
   next person does not rediscover exit 134.
3. Verify `scripts/jest-heap-guard.js` still fails at 70% of the limit — it is
   what converts the next 100 MB of growth into a red run rather than a silent
   deploy stall.

**Certify when.** The policy states where each gate runs and why, and the heap
guard is proven to fire.

---

#### TAB 12 — Closing verdict

**Do.**
1. Re-measure everything in §2. Numbers move; a Master Command that is not
   re-measured becomes the stale document it was written to replace.
2. State per rejection point what the backend now guarantees: 2.1(a) via TAB 04,
   5.1.1(v) via TAB 05.
3. Full `npm run verify` on a machine that can run it; deploy; readiness.
4. Write `CERTIFIED` or `NOT_CERTIFIED` with reasons, and list every open manual
   item with an owner.

**Certify when.** The verdict is written and every claim in it traces to a
captured artefact.

---

## 5. THE PUSH PROCEDURE — AFTER EVERY COMPLETED TAB

1. **Sweep `origin/main` fully** — all refs and tags, compared at commit **and
   tree** level. Local `main` is currently **11 behind**; this is not a formality
   here.
2. **Identify what exists upstream that local lacks, and test it.**
3. **Merge locally.**
4. **Test again on the merged result** — `npm run verify`, on a machine with the
   memory to finish it.
5. **Push straight to `main`.** No PR. Then align `dev`.

If the remote is strictly behind, say so and fast-forward; never stage a merge
with an empty other side.

**A push here deploys nothing.** `[skip ci]` is meaningless in this repo — there
are no workflows to skip — and **no workflow may be added back**: the stored PAT
lacks the `workflow` scope, and Actions credit is gone permanently. Deployment is
TAB 01's human step, on the host.

---

## 6. MANUAL-ONLY ITEMS

| # | Item | Owner | Blocks |
| --- | --- | --- | --- |
| **B-1** | Run `scripts/deploy-prod.sh` on the production host | host operator | TAB 01, and every production claim after it |
| **B-2** | Confirm the Apple provider is enabled in Firebase for `servana-59bee` | Firebase admin | TAB 04 verification |
| **B-3** | Decide the deletion fulfilment window and who is accountable for it | owner | TAB 05 |
| **B-4** | If fulfilment is a human runbook, name the owner and the SLA | owner | TAB 05 |
| **B-5** | Decide the gate-vs-host memory question in TAB 11 | owner | TAB 11 |
| **B-6** | Confirm whether any `pending` deletion request has ever been fulfilled | owner / DBA | TAB 05 scope |

---

## 7. WHAT THIS PROGRAMME DOES NOT COVER

- **Provider-side work.** The 11 upstream commits are provider, support, safety
  and evidence work. Untouched here.
- **The client app's own fixes.** Injectable `FirebaseAuth`, the deletion UI, the
  iPad work — all front-end, all in the companion command.
- **The admin portal and both web portals.** They share this backend; the
  additive-only rule in §3.3 is what protects them.

---

## 8. ACCEPTANCE

This programme is complete when:

- Sign in with Apple succeeds for a customer whose email already exists, landing
  on the **existing** account, without the installed app needing a new
  capability.
- An account-deletion request demonstrably results in an anonymised account
  within a documented window.
- `customerMobile` is derived from a published manifest and reads `migrated` on
  every canonical route it calls.
- Production runs the deployed commit and readiness passes.
- The closing verdict is written, with every open manual item named and owned.

**One backend serves five clients. Nothing here may be closed by a change that
renames or removes a field the other four read.**
