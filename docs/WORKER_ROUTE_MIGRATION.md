# Legacy `/api/workers/*` → authenticated successor routes

`src/routes/technician.routes.ts` carries **36 routes with no authentication**.
The file says so itself:

```js
// Public mobile routes — do NOT add auth (mobile app sends workerUid/workerCode as query params, not JWT)
```

They take their subject from the URL or query string, so today an unauthenticated
caller can read any provider's job cards — which carry the customer's name, phone
number and home address — follow any provider's live position, accept or complete
any booking on any provider's behalf, and toggle any provider online or offline.

**They cannot simply be given `verifyAuth`.** The live ServanaWorker app depends
on the current behaviour, so flipping them breaks a protected client and forces a
release (§2, §63). This is the migration instead.

---

## Status

**Most of the successor surface already exists.** `provider.routes.ts` holds 82
routes, all authenticated, and its `/worker/*` family is self-scoped — the
provider is taken from the token, never from the path. The gap was smaller than
it first appeared; two routes were genuinely missing and have been added.

| | count |
| --- | ---: |
| Legacy unauthenticated routes | 36 |
| Already have an authenticated successor | 30 |
| Successor added here | 2 |
| Deliberately not replaced (see below) | 4 |

---

## Migration map

### Already available — the app can move today

| Legacy (no auth) | Authenticated successor |
| --- | --- |
| `GET /workers/:workerId/job-cards` | `GET /worker/job-cards` |
| `PUT /workers/bookings/:id/accept` | `PUT /worker/bookings/:bookingId/accept` |
| `PUT /workers/bookings/:id/start` | `PUT /worker/bookings/:bookingId/start` |
| `PUT /workers/bookings/:id/complete` | `PUT /worker/bookings/:bookingId/complete` |
| `PUT /workers/bookings/:id/decline` | `PUT /worker/bookings/:bookingId/decline` |
| `GET /workers/:uid/availability` | `GET /worker/availability` |
| `PUT /workers/:uid/availability` | `PUT /worker/availability` |
| `GET /workers/:uid/time-off` | `GET /worker/time-off` |
| `POST /workers/:uid/time-off` | `POST /worker/time-off` |
| `DELETE /workers/:uid/time-off/:id` | `DELETE /worker/time-off/:id` |
| `GET /workers/:uid/service-area` | `GET /worker/service-area` |
| `PUT /workers/:uid/service-area` | `PUT /worker/service-area` |
| `GET /workers/:uid/services` | `GET /worker/services` |
| `POST /workers/:uid/services` | `POST /worker/services` |
| `DELETE /workers/:uid/services/:serviceId` | `DELETE /worker/services/:serviceId` |
| `GET /workers/:uid/requirements` | `GET /worker/requirements` |
| `POST /workers/:uid/requirements` | `POST /worker/requirements/upload` |
| `DELETE /workers/:uid/requirements/:id` | `DELETE /worker/requirements/:id` |
| `GET /workers/:uid/onboarding` | `GET /worker/onboarding` |
| `POST /workers/:uid/onboarding/step` | `POST /worker/onboarding/step` |
| `POST /workers/:uid/onboarding/submit` | `POST /worker/onboarding/submit` |
| `POST /workers/:uid/profile/photo` | `POST /worker/profile/photo` |
| `POST /workers/location` | `POST /worker/location` |
| `GET /workers/:uid/dashboard` | `GET /provider/dashboard` |
| `GET /workers/:uid/online-status` | `GET /provider/location/status` |
| `POST /workers/:uid/go-online` | `POST /provider/location/go-online` |
| `POST /workers/:uid/go-offline` | `POST /provider/location/go-offline` |
| `GET /workers/:uid/review-status` | `GET /providers/me/review-status` |
| `POST /workers/:uid/submit-for-review` | `POST /providers/me/submit-for-review` |
| `GET /workers/:uid` | `GET /provider/profile` (self) |

### Added by this change

| Legacy (no auth) | Successor | Note |
| --- | --- | --- |
| `GET /workers/:workerId/schedule` | `GET /worker/schedule` | Self-scoped. No subject in the path. |
| `GET /workers/location/:uid` | `GET /booking/:bookingId/provider-location` | **Re-framed.** See below. |

#### Why the location route changed shape

The customer app genuinely needs live tracking, so "deny customers" was not an
available answer. But `GET /workers/location/:uid` lets the caller name *any*
provider, which is the whole problem.

The successor asks a different question: *where is the provider on **my**
booking?* Entitlement is decided by `assertBookingAccess`, and there is no way to
phrase a request for an arbitrary provider's whereabouts. It also distinguishes
"no provider assigned yet" from "assigned but no position reported", so the
client can say something truthful instead of showing an empty map.

### Deliberately not replaced

| Legacy | Why |
| --- | --- |
| `GET /workers/all` | Directory listing of every provider. No legitimate mobile caller; admin has `GET /admin/providers` (authenticated, permission-gated). Should be deleted, not replaced. |
| `GET /workers/role/:role` | Same. Both mobile apps declare a call to it; neither reaches it from any screen. |
| `GET /workers/available` | Provider matching is a backend concern (§29 — eligibility is backend-calculated and lists are filtered server-side). A client should never ask this. |
| `GET /services/:serviceId/workers` | Same reasoning. |

Confirm these are genuinely uncalled in production before deletion — the client
declarations exist even though no screen reaches them.

---

## Retirement sequence

1. **Now** — successors exist and are authenticated. Nothing removed. *(done)*
2. **Next** — point ServanaWorker at the `/worker/*` family. It already attaches
   `Authorization: Bearer` on every request via its Dio interceptor, so this is a
   URL change, not an auth change. Point ServanaClient's tracking at
   `GET /booking/:bookingId/provider-location`. Both need a release.
3. **Then** — add request logging to the legacy routes and watch for a full
   release cycle plus a margin for users who do not update. Do not skip this:
   old app versions live in the field for months.
4. **When traffic reaches zero** — delete the legacy block from
   `technician.routes.ts` and the four directory routes above.

Until step 4, the exposure is live. The successors reduce it for updated clients;
they do not close it. **Anyone can still call the legacy routes.**

## Interim hardening worth considering

If step 2 cannot happen soon, these reduce blast radius without breaking clients:

- Rate-limit the legacy family per IP. It does not stop a targeted attacker but
  makes bulk enumeration of job cards expensive.
- Strip customer phone and full address from the legacy `job-cards` response,
  keeping them in the authenticated `/worker/job-cards`. This *is* a payload
  change to a protected client (§4), so it needs checking against the app's
  parser first — ServanaWorker reads `address.addressOne`, `address.city` and
  `customer.phone`.
- Log every legacy call with the claimed `workerUid` and the source IP, so the
  scale of any existing abuse is measurable rather than assumed.
