# Servana API — the v1 contract

The rules every `/api/v1` endpoint obeys. Written by hand because these are
decisions; the endpoint list itself is generated — see
[`API_ENDPOINT_REGISTRY.md`](API_ENDPOINT_REGISTRY.md) and
[`openapi.v1.json`](openapi.v1.json).

**Source of truth:** [`src/api/v1/contract.ts`](../../src/api/v1/contract.ts).
The router, the OpenAPI document, the registry and the migration matrix are all
derived from that one array.

The prose in this file is hand-written; every **countable** claim in it is not.
Sections marked with `<!-- BEGIN GENERATED: ... -->` are rewritten by
`npm run api:docs` and checked by `npm run api:docs:check`, because this
document twice shipped a number that was true when written and false a command
later — "six planned entries", naming two that had been live for months. The
reasons stay hand-written. The counts are derived.

---

## 1. The namespace

`/api/v1/*`, mounted **first** in `src/app.ts`, before every legacy router.

Two segments, so it cannot be caught by `GET /api/:id`, the single-segment
wildcard at the API root that made `GET /api/catalog` unreachable. Mounting
first means that stays true even if a future legacy route is broader still, and
`tests/route-shadowing.test.ts` fails the build if anything eclipses anything.

The v1 router ends in **its own 404**. Outside v1, an unknown one-segment GET is
a booking lookup and answers 401 or 400, so route existence is not observable
from the outside. Inside v1, a path that does not exist says so.

## 2. The envelope

```jsonc
// 2xx
{ "data": <T>, "meta": { ... } }        // meta present only when there is any

// 4xx / 5xx
{ "error": { "code": "...", "message": "...", "details": ..., "requestId": "..." } }
```

`X-Request-Id` is returned as a header on every v1 response, carrying the same
value as `error.requestId`. It is the correlation id `app.ts` already stamps on
every request.

**There is no `status` or `success` field.** The HTTP status already says
whether it worked. A second, independently-settable signal is how
`{ "success": true }` ends up on a 500.

**This is a third envelope and that is deliberate.** The backend already ships
two — `{ status: 'success', data }` from `helpers/status.ts` and
`{ success, message, data }` from `utils/apiResponse.ts` — and both are
protected contracts: ServanaClient casts `error` to `String`, ServanaWorker
reads `message ?? error`. Neither can change and neither can be extended without
ambiguity for the clients already reading it. v1 has no installed readers, which
is the only moment a third shape is free.

## 3. Errors

A closed enum. Clients branch on `code`; `message` is copy and may be reworded
without a client release. The full list is in
[`src/api/v1/errors.ts`](../../src/api/v1/errors.ts) and in the OpenAPI `Error`
schema.

Codes are **append-only**. Renaming one breaks every client that branches on it,
so it is treated exactly like renaming a route (§4).

**A raw exception can never reach a client.** `sendCaught()` is the only catch
site: an `ApiError` is a failure somebody deliberately made visible, and
anything else becomes `INTERNAL` with the real exception logged server-side
against the request id. §21 enforced by the type system rather than by review.

One code maps to exactly one HTTP status. Two codes may share a status —
`BOOKING_NOT_FOUND` and `NOTIFICATION_NOT_FOUND` are both 404 — because the
client branches on the code.

## 4. Authorization

Declared on the contract entry as `auth`, and the composition layer derives the
middleware chain from it. An endpoint cannot be documented as authenticated and
mounted as public: `tests/v1-router.test.ts` drives every entry in every mode.

| `auth` | Chain |
|---|---|
| `public` | none |
| `authenticated` | `verifyAuth` |
| `provider` | `verifyAuth` → `requireProviderRole` (roles 2 **and 4**) |
| `admin` | `verifyAuth` → `verifyRoles([1])` |

`verifyAuth` checks signature **and revocation**, so a token issued before a
session revocation is rejected with `TOKEN_REVOKED` rather than honoured until
expiry.

**Identity always comes from the token.** No v1 endpoint takes an actor uid from
a path, query or body. `/api/users/:userId/bookings` and
`/api/workers/:workerId/job-cards` both take it from the path and then check it
against the token — the parameter is decoration, and it has already produced one
real BOLA. `/api/v1/bookings` and `/api/v1/provider/jobs` offer no way to name
another person.

## 5. Pagination

One convention: `?limit=` and `?offset=`, clamped at the boundary, never NaN,
never negative. Per-endpoint maxima, because a catalog page and an audit page
have different sane ceilings.

```jsonc
"meta": { "page": { "limit": 20, "offset": 0, "total": 137, "hasMore": true } }
```

`total: null` means the count is not cheaply knowable; use `hasMore`.

Three v1 lists — `/bookings`, `/provider/jobs` and `/notifications` — currently
page **in the API layer** over a service that returns the whole set. That bounds
the response, not the query. It is an honest improvement on the legacy routes,
which bound neither, and it is recorded as follow-up work for the bookings,
provider-jobs and notifications domain commands rather than hidden.
`/reviews/providers/:providerUid` pages in the query, which is where the other
three should end up.

## 6. Idempotency

Every entry declares `idempotent: true|false`. A GET is idempotent by
definition; a mutation must say so explicitly.

Two kinds of mutation live here now. The **naturally idempotent** ones — a
full-replace PUT, a mark-read that reaches the same end state on a repeat —
declare `idempotent: true` and need no key. The **booking lifecycle actions**
declare `idempotent: false`, and every one of them names in `replayGuard` what
bounds a replay: an `Idempotency-Key` returns the original result, and without
one the state machine refuses the second attempt because the booking is no
longer in the state the transition requires. `tests/v1-contract.test.ts` asserts
that no non-idempotent endpoint has ever been added without that field, and that
an idempotent one does not claim a guard it does not need.

Sending one: `Idempotency-Key`, 8–128 characters of `A-Za-z0-9_.:-`.
`readIdempotencyKey()` validates the **shape** and rejects a malformed key with
`IDEMPOTENCY_KEY_INVALID` — silently ignoring a bad key is worse than rejecting
it, because the caller believes it is protected against a retry and is not.
Storing and replaying results stays per-domain; `services/bookingIdempotency.ts`
already does it for bookings and a new mutation reuses that rather than
reinventing it.

## 7. No global field rewriting

`/api/v1` is exempt from `parityMiddleware` and `requestParityMiddleware`.

Those middlewares add cross-platform aliases to every response and every body.
On the legacy tree they are load-bearing — five clients spell the same concept
five ways. On v1 they would be a contradiction: an endpoint that publishes an
explicit DTO and a generated OpenAPI document cannot also have keys invented at
the boundary.

This is not hypothetical. Parity maps `name` → `level2`, and on the admin
catalog it made a canonical Service come back claiming its own name as its
Subcategory — a defect a production smoke found and no unit test could.

Pinned by `tests/v1-parity-exemption.test.ts`, which also fails if either
middleware is ever mounted unconditionally.

## 8. One domain service behind every path

Every contract entry names the service it delegates to, and the v1 handler is
thin enough that the naming is checkable by reading it.

Where a legacy route and its v1 successor coexist, they call the **same**
function. `/api/auth/me` was refactored in this command to call
`identityService.getIdentity`, the function `/api/v1/me` calls, so the two
cannot drift — only the envelope differs.

A role-specific route is allowed only when the authorization, action or payload
genuinely differ, and the contract has to say why — the reason below is the
`note` on the legacy mapping, not a second account of it written here.

<!-- BEGIN GENERATED: v1-role-specific -->
**13** today.

| Role-specific route | Nearest canonical | Why it is not the same endpoint |
|---|---|---|
| `GET /api/user/profile` | `/api/v1/me` | Not a duplicate: returns the CUSTOMER profile aggregate (addresses, preferences), not the identity record. Retained; a v1 successor belongs in the customer-profile domain command, not here. |
| `GET /api/provider/bookings/:bookingId/timeline` | `/api/v1/bookings/:bookingId/timeline` | Genuinely role-specific: the shared builder is written from the provider's seat, where "YOU" means the provider. Same domain service, different voicing. Documented rather than merged. |
| `GET /api/user/:userId/addresses` | `/api/v1/customer/addresses` | The provider portal reading a booking customer's address. A genuinely different authorization question - it is answered from the booking relationship, not from ownership - and it stays on its own route rather than becoming a uid parameter here. |
| `GET /api/provider/profile-center` | `/api/v1/provider/profile` | The compliance view: revision history, review state, field-level edit affordances. A genuinely different question, and it already reads the same field registry this entry projects from. |
| `POST /api/support/tickets` | `/api/v1/bookings/:bookingId/support-cases` | The general customer contact surface. It carries no bookingId, so a quality complaint raised through it arrives with no way to see which visit it is about. Kept for contact that is genuinely not about a booking. |
| `POST /api/auth/add-employees` | `/api/v1/auth/register` | Admin bulk-creates provider accounts with generated temporary passwords. Genuinely different: a different actor, a different credential origin, and a partial-success response shape. Retained; it is account PROVISIONING, not registration. |
| `POST /api/auth/customer-firebase-login` | `/api/v1/auth/login` | NOT collapsed. Its link-collision contract is a 200 carrying `status: "failed"` and no token, because the installed customer app throws on any non-2xx before reading the body and fires onUnauthorized on 401 — either would show "session expired" to somebody who has no session yet. Changing that shape is a client release, so it stays until the customer app migrates. |
| `GET /api/admin/communications/conversations` | `/api/v1/conversations` | The admin oversight list carries a named permission and a booking filter, and joins moderation state this route has no business publishing to a customer. Same tables, same conversation ids; a genuinely different question. |
| `GET /api/admin/communications/conversations/:id` | `/api/v1/conversations/:conversationId` | The admin detail view, permissioned, and carrying report and moderation state. Different fields, different authorization, same conversation id. |
| `GET /api/admin/communications/conversations/:id/messages` | `/api/v1/conversations/:conversationId/messages` | The permissioned admin transcript. It reads the whole thread by design — the audit trail is the point — where this route applies the caller's own read floor. |
| `POST /api/admin/communications/conversations/:id/messages` | `/api/v1/conversations/:conversationId/messages` | The admin send. Permissioned and audited, and it already delegates to `chat.service.sendMessage`, so an admin message obeys the same idempotency, validation and attachment rules as anyone else's. |
| `GET /api/provider/bookings/:bookingId/dispute-status` | `/api/v1/bookings/:bookingId/disputes` | Provider-facing eligibility summary, shipped as "entry point only; opening is later". It reads the same table and the same categories. It stays because it answers "may I open one" for a live client that has no other way to ask. |
| `GET /api/admin/finance/ledger/booking/:bookingId` | `/api/v1/bookings/:bookingId/payment` | The admin revenue-recognition view over finance_ledger_entries. It answers a different question (what was recognised, when, by whom) and carries its own permission. Both now read the same underlying capture events. |
<!-- END GENERATED: v1-role-specific -->

Note what is *not* on that list: none of these is a second business truth. Each
reaches the same domain service as its canonical neighbour; what differs is the
actor, the payload shape a shipped client can survive, or whose seat the text is
written from.

## 9. Versioning and change policy

**Additive inside v1.** New optional response fields and new endpoints are
fine. Removing a field, renaming one, changing a type, changing a status code
or changing an error code is a **v2** change.

**Never touched:** legacy paths, payloads, envelopes, IDs, statuses, event
names or FCM fields. v1 is a new surface beside them, not a rewrite of them
(§4, §5, §63).

## 10. Adding an endpoint

1. Add the entry to `V1_CONTRACT`.
2. Add the handler to the domain module, exported under the same `id`.
3. Add its response DTO to `SCHEMAS` in `openapi.ts`.
4. Add a live request case to `tests/v1-router.test.ts`.
5. `npm run api:docs`.

Steps 1–2 are enforced at **import time**: `buildV1Router` throws if an
implemented entry has no handler, if a handler has no entry, if a *planned*
entry has a handler, or if two entries claim the same method and path. A
half-wired endpoint fails the build rather than shipping as a 404 nobody
notices. Step 4 is enforced by a test that compares the case list to the
contract. Step 5 is enforced by `npm run api:docs:check`, which is part of
`npm run verify`.

## 11. `status: 'planned'`

A planned entry is **documented and not mounted**, and returns 404. It exists so
the migration matrix can name the canonical successor of a legacy route before
that successor is built — which is what makes the matrix useful to a client team
planning its own release.

Each names the legacy route it will replace and why it was not adapted here.
`tests/v1-router.test.ts` asserts every one of them 404s, so "planned" cannot
quietly become "half-built".

<!-- BEGIN GENERATED: v1-planned -->
**1 planned entry today**, against 115 implemented.

| Path | Domain | Successor to | Why it is not built here |
|---|---|---|---|
| `/api/v1/catalog/services/:serviceId/serviceability` | catalog | `GET /api/catalog/services/:serviceId/serviceability` | The verdict createBooking would reach, offered before the journey rather than at the end of it: today a customer picks an address, a date and a payment method and only then learns "Service not available in your area." It resolves the service family with the statement createBooking uses, so the pre-check cannot promise a booking the server will refuse. It answers a verdict and never the coverage discs or the legacy id, which catalogPublicService withholds deliberately (§11, §58). |
<!-- END GENERATED: v1-planned -->

The count moves as domain commands land — `/auth/refresh` and `/search` were
planned when this section was first written and are live now. It is generated
from `V1_CONTRACT` for that reason: a hand-kept list of what does not exist yet
is the first thing in an API document to become false.
