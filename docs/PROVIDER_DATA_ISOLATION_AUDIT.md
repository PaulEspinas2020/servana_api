# Provider data isolation audit

**Command 4 §2 deliverable.** What was found, what was fixed, and what was
checked and found clean. Every claim is source-cited.

Scope: backend `servana_api`, `ServanaWorker`, `ServanaClient`,
`servana_service-provider`, `servana_adminportal`.

## Headline

**One P0 existed and is closed.** It was not a new discovery — it was the
already-documented legacy `/api/workers/*` family, and Command 4's contribution
was establishing that nothing still called it and then deleting it.

**No cross-provider leak was found in the authenticated surface.** Three
findings in the clients were real but narrower: a stale response that could
write across accounts, a store with no session guard, and residual image bytes.

## P0 — CLOSED

### 24 unauthenticated routes serving provider and customer data

`technician.routes.ts` carried 24 routes with **no authentication**, taking
their subject from the URL. Anyone knowing a provider uid could:

- follow their live position (`GET /workers/location/:uid`)
- read, upload and delete their compliance documents
- rewrite their availability, time-off and service area
- toggle them online or offline
- drive their onboarding and submit them for review

**Fixed:** deleted (`27b105b`). The file now holds 22 routes and **zero**
reachable without a credential — asserted by two tests via
`tests/helpers/routeAuth.js`.

**Why it could be deleted rather than deprecated:** every route had an
authenticated successor, and no client called any of them —
ServanaWorker (`b94f7a1`), ServanaClient (`f23ae5e`, `aaac06b`), the provider
portal (42 API paths, none legacy), admin and customer-web (no references). The
platform is not live, so there was no old-version tail to wait out.

## Findings in the clients

| # | Finding | Severity | Fix |
|---|---|---|---|
| 1 | Profile hydration wrote across accounts | **high** | `9f300ee` |
| 2 | `EarningsStore` had no stale-response guard | **high** | `d7782c7` |
| 3 | Decoded images survived sign-out | medium | `9f300ee` |
| 4 | Push token stayed bound to the previous provider | medium | `fc9df50` |

### 1. Profile hydration wrote across accounts

`_hydrateFromServer` captured the worker uid before its `await` and never
re-checked it. On resolution it calls `_maybeUpdateSession`, which merges the
response into the session identity **and persists it**.

Provider A opens their profile, signs out, B signs in on the same device, A's
response lands — A's name and email are written into B's stored session, and
survive a restart.

Guarded at the call site and inside the writing function, because it is also
reachable from the save path.

### 2. `EarningsStore` had no stale-response guard

A late response could populate a new provider's session with the previous
provider's earnings. `JobCardsStore` has had this guard since Command 1; the
store added for the money work did not — which is the wrong way round, since
§11 makes financial isolation release-blocking.

Identity captured before the await and compared after, plus a request counter.
`clearProviderData` bumps the counter so an in-flight request cannot repopulate
a store that was just emptied.

### 3. Decoded images survived sign-out

Provider A's profile photo is keyed on a per-provider URL, so B never *sees*
it — but the bytes stayed resident in `imageCache` on a shared device.

### 4. Push token stayed bound to the previous provider

`saveProviderFcmToken` bound the token to the caller without releasing it from
whoever held it, so a push meant for A could reach a handset B is now carrying.
The token is now released before it is claimed, and
`DELETE /api/provider/fcm-token` releases it on sign-out.

Not a live leak: the worker app has no FCM wiring at all. Built before the
client that needs it, because the shared-device case is the one that otherwise
gets discovered in production.

## Checked and clean — no finding

Recorded explicitly, because "we looked and it was fine" is a result.

| Area | Verdict |
|---|---|
| **Chat / conversations** | Every one of the 9 routes checks participation. `getConversation`, `closeConversation` and `getBookingConversation` all call `resolveAccessForConversation`/`resolveAccessForBooking` and 403 **before** the service is touched. §9 satisfied. |
| **Authenticated path-id routes** | All 33 traced. 12 enforce ownership in SQL, 9 are chat (above), the rest are the legacy family or non-provider data. No IDOR. |
| **Money endpoints** | `getDashboard`, `getEarnings`, `getEarningsSummary`, `getEarningById` all derive uid from the token and scope the query to it. |
| **Logging** | The API interceptor prints *structure*: strings become `String(<len>)` and never their contents, with a sensitive-key list on top. Two independent layers. Now covered by 12 fixtures (`55f5a84`). |
| **Analytics identity** | §16 requires resetting it. `setUserId`/`setUserProperty` appear **nowhere** — there is nothing to reset. |
| **Backend request logging** | No `console.log` carries a request body. |
| **Token logging** | No token is printed anywhere in any client. |
| **`verifyOwnership`** | Correct and fails closed: `req.user.uid !== req.params.uid` → 403. |

## Method — and three ways it went wrong

Three detectors written for this audit each produced a wrong answer before
being corrected. Recorded because the failure mode is the interesting part.

1. **A route-auth detector searched each line for the literal `verifyAuth`.**
   Six admin routes are guarded by `...adminOnly`, a spread of
   `[verifyAuth, verifyRoles([0,1])]`. They were reported bare and **deleted**.
   The existing suite caught it; restored within the minute.
2. **The second version missed multi-line declarations**, where `router.get(`
   sits alone and the middleware follows below.
3. **An ownership tracer reported all 9 chat routes as unproven**, because it
   followed service bodies and chat guards in its controllers. Nearly a false
   critical.

All three now live in `tests/helpers/routeAuth.js`, which resolves middleware
aliases, parses whole declarations by matching parentheses, and carries **8
fixtures covering what it must accept and what it must still reject** — a
`publicOnly` spread has to stay flagged, or alias resolution becomes a way to
smuggle an unauthenticated route past the check.

**The rule this produced:** a detector that decides what is safe to delete gets
fixtures before it is trusted, in both directions.

## Deferred

| Item | Reason | Mitigation |
|---|---|---|
| `availableActions` (§8) | Not implemented; clients infer from status | SQL guards mean this is a UX defect, not a security hole |
| Idempotency keys (§18) | Not implemented | Lifecycle guards make replays no-ops, but they return a failure |
| Error-envelope migration (§15 of C3) | ~494 sites | Additive `error.code` planned; rate-limit shape already fixed |
| FCM client wiring | Not built | Backend ownership rules are in place ahead of it |
