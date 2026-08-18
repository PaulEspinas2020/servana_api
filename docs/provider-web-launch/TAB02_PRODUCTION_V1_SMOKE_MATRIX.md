# TAB 02 — Close the v1 gap between the live portal and the live API

**Owner:** servana_api-main + ServanaWorkerWeb
**Measured:** 2026-08-18, against `https://api.servana.com.ph`, unauthenticated,
read-only. Gated by TAB 01, which is closed.

---

## Verdict

**CERTIFIED_WITH_NONBLOCKING_GAPS.**

The gap this TAB exists to close **is closed**: all 105 implemented v1 endpoints
are mounted and reachable in production with their declared auth mode, and all 4
planned entries are correctly absent. The smoke is scripted, repeatable and
exits non-zero on any regression.

Two things remain. The authenticated half needs a production provider account
that does not exist yet, and the portal-side confirmation needs the portal
repository, which is not available. Both are recorded as manual tasks.

---

## 1. The gap the Master Command describes no longer exists

The PDF states that production answers `POST /api/v1/auth/login` — declared
`public` — with `401 UNAUTHENTICATED`, byte-identical to its answer for a bogus
path, because the deployed commit `2e03a4b` had no `src/api` directory at all.

That was true when written and is not true now. Deploy run **32119165101**
(commit `d4b0150`, 2026-08-18T08:58:46Z) shipped the v1 router. See
`TAB01_DEPLOY_PIPELINE_RESTORED.md`.

| Probe | PDF | Measured 2026-08-18T09:19Z |
|---|---|---|
| `POST /api/v1/auth/login` | 401 | **400** — reached its validator |
| `GET /api/v1/totally/bogus` | 401 | **404** — the v1 router's own catch-all |
| `GET /api/catalog` | 401 | **200** |
| `GET /healthz` | 404 | **200** |

`/api/catalog` answering 200 resolves mandate 7 outright: it was not a separate
nginx or middleware defect, it was the same missing deploy.

---

## 2. The expected delta, written down before probing (mandate 2)

Derived from `src/api/v1/contract.ts`, not from the PDF:

| Measure | Value |
|---|---|
| Contract entries | **109** |
| `status: 'implemented'` | **105** |
| `status: 'planned'` | **4** |
| Auth modes (all entries) | 58 authenticated · 26 provider · 20 public · 5 admin |
| Auth modes (implemented) | 58 authenticated · 26 provider · 20 public · 1 admin |
| Methods (implemented) | 54 GET · 37 POST · 8 PATCH · 5 DELETE · 1 PUT |

Every figure matches the Master Command's stated delta. The 5 admin entries
split 1 implemented / 4 planned — the four planned are the admin booking
assignment endpoints.

---

## 3. The smoke, and what it asserts (mandate 5)

`scripts/smoke-production-v1.ts`. For all 109 contract entries, unauthenticated:

- `implemented` must be **MOUNTED** — the router must not answer with its own
  catch-all;
- `planned` must be **ABSENT**;
- `public` must not require a token — anything except 401/403;
- every other auth mode must return **401** without one.

### Mounted and not-mounted are both 404

`src/api/v1/register.ts` ends the router in its own 404, whose message is
`No v1 endpoint for <METHOD> <path>`. A mounted route saying "no such id" is
also a 404. Only that string separates them, so the script keys on it rather
than on the status code. Verified against production:

```
GET /api/v1/totally/bogus            -> {"error":{"code":"NOT_FOUND","message":"No v1 endpoint for GET /api/v1/totally/bogus",...}}
GET /api/v1/catalog/categories/xyz   -> {"error":{"code":"VALIDATION_FAILED","message":"categoryId must be a positive integer.",...}}
```

### Safety, because this runs against production

- No credential is ever sent, so no authenticated mutation can occur.
- Non-GET requests carry an **empty body**, so a public mutation such as
  `POST /auth/register` is refused at validation. A 400 proves the route is
  mounted and reached its handler, which is the entire question.
- `/auth/forgot-password` and `/auth/resend-verification` are why the empty body
  is non-negotiable: with a real address they would send mail to a real person.

---

## 4. Result

```
109 contract entries probed
109 PASS / 0 FAIL
0 implemented entries NOT mounted in production
```

| Group | Count | Observed |
|---|---|---|
| Public, implemented | 20 | 15 → **200**, 5 → **400** (empty-body validation) |
| Non-public, implemented | 85 | 85 → **401 UNAUTHENTICATED** |
| Planned | 4 | 4 → **404**, correctly absent |

The four planned entries confirmed absent: `GET /admin/bookings`,
`GET /admin/bookings/:bookingId/assignment-candidates`,
`POST /admin/bookings/:bookingId/assign`,
`POST /admin/bookings/:bookingId/reassign`.

**Acceptance criterion 1 is met**: all 105 implemented endpoints reachable with
the declared auth mode, all 4 planned return 404. **Zero 401s on paths the
contract marks public**, which is the criterion that failed before the deploy.

---

## 5. The defect the smoke found

Mandate 3 requires that every non-public endpoint "return 401 with a **code from
the v1 error vocabulary**". Measured: **85 of 85** answered

```json
{"status":"failed","code":"UNAUTHENTICATED","message":"Authentication is required"}
```

which is the **legacy** envelope. `src/api/v1/envelope.ts:7` declares the v1
failure shape as `{ error: { code, message, requestId } }`. So the v1 router
violated its own published contract on every authenticated route — not some of
them, all of them — and `src/api/v1/routeHealth.ts`'s own definition of a
well-formed v1 error (`code` and `requestId` both strings) was unsatisfiable for
a 401.

Confirmed in source, not inferred: `register.ts` builds its auth chain from the
legacy `verifyAuth`, `requireProviderRole` and `verifyRoles`, and
`verifyAuth.ts:18` writes the legacy shape.

### Why it matters, and to whom

The provider portal classifies failures on `error.code`. With the legacy shape
there is no `error` object at all, so **every** 401 reads to the client as "no
v1 error code present" — precisely the ambiguous case TAB 03 must tell apart
from a genuinely expired session. Fixing the portal first would have had it look
for a field the server never sends. There is also no `requestId` on a 401, so
TAB 11's goal of one identifier joining a client error to its server log line
fails exactly where auth problems are debugged.

### The fix

`v1AuthEnvelope` in `register.ts` wraps the real chain and rewrites only the
failure body. Verification itself is untouched — re-implementing it for v1 would
create a second answer to "is this token good" and the two would drift. The
legacy tree (520 routes, five clients) is unaffected, so this is additive per the
standing rule.

Code mapping, with nothing discarded:

| Emitted by middleware | v1 code | Note |
|---|---|---|
| `UNAUTHENTICATED` | `UNAUTHENTICATED` | |
| `TOKEN_EXPIRED` | `TOKEN_EXPIRED` | |
| `TOKEN_REVOKED` | `TOKEN_REVOKED` | |
| `INVALID_TOKEN` | `UNAUTHENTICATED` | original preserved in `details.reason` |
| `FORBIDDEN_ROLE` | `ROLE_REQUIRED` | original preserved in `details.reason` |

`INVALID_TOKEN` is **named by TAB 03** as a code the portal acts on, but it is
absent from `V1_ERROR_STATUS`. Adding it is a contract change and belongs to
TAB 04; it is recorded here rather than decided silently.

### Watched to fail first

`tests/v1-auth-envelope.test.ts` asserts the **shape**, not the status — a test
that only checked for 401 is what let this ship. It caught a real bug in the
wrapper's first draft: swallowing the inner middleware's returned promise hung
`tests/authz-matrix-behaviour.test.ts`, which drives the chain directly.

---

## 6. Acceptance criteria

| Criterion | State |
|---|---|
| All 105 implemented endpoints reachable with declared auth; 4 planned 404 | **MET** — 109/109 PASS |
| Zero 401s for paths the contract marks public | **MET** — 20/20 public reachable |
| Smoke scripted and runnable as a deploy step | **MET** — `scripts/smoke-production-v1.ts`, exits non-zero on failure |
| `GET /api/v1/me` with a valid provider token returns the identity envelope | **NOT MET — needs a provider account** (M-08) |
| A provider signs in on the portal and the jobs list renders from `/api/v1/provider/jobs` | **NOT MET — needs the portal repo and an account** (M-07, M-08) |
| Smoke wired into the deploy workflow | **NOT MET — needs a push** (M-01) |

### Guardrails honoured

- The portal was **not** reverted to legacy paths.
- Backend and portal were not deployed in the same window — nothing was deployed
  at all.
- No push. The backend push *is* the deploy, and it stays a human decision.

---

## Remaining — recorded in `MASTER_TODO_MANUAL_TASKS.md`

- **M-08** — a dedicated production provider account. Without it the
  authenticated matrix (26 provider-scoped endpoints, latency and envelope
  shape per mandate 4) cannot be exercised. It is absent rather than stubbed.
- **M-07** — the portal repository, for the browser-network-panel confirmation.
- **M-01** — wiring the smoke as the final deploy step requires a push.

---

## Evidence index

- `scripts/smoke-production-v1.ts` — run 2026-08-18, 109 entries, 109 PASS.
- Contract counts from `src/api/v1/contract.ts`: 109 / 105 / 4.
- Local gate: `npm run verify` green with the envelope fix and its new suite.
