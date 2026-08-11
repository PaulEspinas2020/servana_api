# Servana API — the v1 contract

The rules every `/api/v1` endpoint obeys. Written by hand because these are
decisions; the endpoint list itself is generated — see
[`API_ENDPOINT_REGISTRY.md`](API_ENDPOINT_REGISTRY.md) and
[`openapi.v1.json`](openapi.v1.json).

**Source of truth:** [`src/api/v1/contract.ts`](../../src/api/v1/contract.ts).
The router, the OpenAPI document, the registry and the migration matrix are all
derived from that one array. Nothing in this directory is maintained by hand
except this file.

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

Two v1 lists currently page **in the API layer** over a service that returns the
whole set. That bounds the response, not the query. It is an honest improvement
on the legacy routes, which bound neither, and it is recorded as follow-up work
for the bookings and provider-jobs domain commands rather than hidden.

## 6. Idempotency

Every entry declares `idempotent: true|false`. A GET is idempotent by
definition; a mutation must say so explicitly.

Every mutation shipped in this phase is naturally idempotent — a full-replace
PUT, and a mark-read that reaches the same end state on a repeat. None needs an
`Idempotency-Key`, and `tests/v1-contract.test.ts` asserts that no
non-idempotent endpoint has been added without one.

When one is: send `Idempotency-Key`, 8–128 characters of `A-Za-z0-9_.:-`.
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
genuinely differ, and the matrix has to say why. There are two today:

- `/api/user/profile` — the customer profile aggregate, not the identity record.
- `/api/provider/bookings/:id/timeline` — the same timeline, voiced from the
  provider's seat, where "YOU" means the provider.

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

Six exist today: `/auth/refresh`, `/search`, `/home`, `/conversations`,
`/provider/earnings`, `/admin/bookings`. Each names the domain command that owns
it and why it was not adapted here. `tests/v1-router.test.ts` asserts every one
of them 404s, so "planned" cannot quietly become "half-built".
