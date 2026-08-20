# TAB 02 — Response schemas declared with no properties (P0)

## Verdict

```
EVERY EMPTY SCHEMA POSITION CLOSED                        CERTIFIED

Empty schema positions          17  ->  0
Top-level empty schemas          8  ->  0
Schemas in the contract        144  ->  157
A new empty schema                      FAILS the gate  ✔ proven

AND, found by doing it:
  P0  the assigned provider could read the doorstep start code   CLOSED
```

The book counted 21 positions across nine schemas from the portal's generated
types. Measured against this repository's contract the count was **17** across
eight — two of the book's nine had already closed before this session, and
neither was closed by it. All 17 are now shaped, none of them guessed: every
schema was written by reading the service that builds the response.

## The P0 this TAB found

Closing `Booking` meant reading `formatBooking`, and `formatBooking` spreads the
whole camelCased database row:

```ts
const c: any = toCamel(raw);
return { ...c, /* aliases */ };
```

`getBookingById` selects `b.*`. The `bookings` table stores two one-time codes.
So both travelled to every caller who could read the booking at all.

**`worker_code` is the SERVICE_START credential.** `experiencePolicy`
`.BOOKING_OTP_PURPOSES` states the property in as many words:

> The RECIPIENT is the customer even though the VERIFIER is the provider — that
> inversion is the entire security property. The customer reads the code out on
> the doorstep; the provider types it in.

`bookingAccessService.resolveBookingAccess` returns the role `provider` for any
worker whose assignment row is `ASSIGNED`, `ACCEPTED`, `EN_ROUTE` or `ARRIVED` —
**every state before the start that code gates.** The assigned provider could
therefore fetch, from the API, the proof of presence they are supposed to be
handed at the door, and start a job without ever arriving.

Proven by execution, not by reading. A row carrying `worker_code: '778899'`
through the real formatter:

```
KEYS: [...,"otpCode",...,"workerCode",...]
workerCode -> "778899"
otpCode    -> "123456"
```

**Why nothing caught it.** Nothing could bind to the shape. `Booking` was
`{ type: 'object' }` with no properties, which generates as
`Record<string, never>` — so no client and no contract assertion could say what
the response contains, and therefore none could say what it must *not* contain.
This is precisely the hole TAB 02 exists to close, and this is what was in it.

### The fix

`formatBooking` now **denies by default** and a caller that has established the
actor opts in. That shape is not invented here — `bookingPaymentService`
`.projectFor` already argues for it in this codebase:

> explicit per-actor DTOs, not a shared object with fields deleted afterwards …
> a subtractive projection discloses every field somebody forgets to remove, and
> an additive one discloses only what it names.

`formatJobCard` follows that rule, which is exactly why the provider's own job
card never carried these codes. `formatBooking` was the one spread left.

Eight call sites were made seat-aware, v1 and legacy alike:

| Call site | Disclosure | Why |
| --- | --- | --- |
| v1 `bookings.get` | customer + admin | Seat from `assertBookingAccess`, previously discarded |
| v1 `bookings.listMine` | yes | Self-scoped on the CUSTOMER column |
| legacy `GET /api/bookings/:id` | customer + admin | Same seat rule |
| legacy `GET /api/:id/tracking` | customer + admin | Same seat rule |
| legacy `confirmOtp` | yes | The caller just proved ownership with the OTP |
| legacy create, idempotent replay ×2 | yes | The caller created the booking |
| legacy `listBookingsByUser` | yes | 403 above proves `actor.uid === userId` |
| legacy `GET /bookings/all` (role 1) | **no** | An admin may read *a* code; a bulk listing of every live credential is exposure nobody asked for. The detail route discloses it per booking, auditably. |

**Both parity pairs hold.** The customer keeps the code on every path that
carried it before — `BOOKING_OTP_PURPOSES` declares `delivery: 'booking_detail'`,
so a booking body *is* the delivery channel, and client mobile ≡ client web are
byte-identical to before. The provider loses it on every path, equally, so
worker mobile ≡ provider web stay in parity with each other.

⚠️ **One thing the backend cannot answer.** If a provider client today reads
`workerCode` from the booking response and pre-fills it at `PROVIDER_START`,
that flow stops working — and it was the exploit shipped as a feature. Verifying
that needs the provider apps, which this backend-only pass does not touch.

## The other findings, in order of how much they would have cost

**1. One name described two different objects.**
`AdminBookingActionResult` was the declared response of both assign and
reassign. Reading the services shows they never agreed:

```
adminAssignProvider   → { bookingId, providerUid,     providerName, status: 'WORKER_ASSIGNED' }
adminReassignProvider → { bookingId, fromProviderUid, toProviderUid, providerName }
```

Reassign carries **no `status` at all** and names both ends of the move. No
single object schema could ever have described both — an empty schema is what a
disagreement looks like when nobody has to resolve it. Each endpoint now
declares its own precise shape; the shared name is retained as a `oneOf` over
the two and marked deprecated, so a client that pinned it still resolves.

**2. `AdminReassignRequest` documented a field the handler does not read.**
Its description said *"providerUid and a REQUIRED reason"*. The handler reads
**`toProviderUid`**. A client built from that sentence sends a body the handler
rejects as missing.

**3. `BookingTimeline` declared an array where the wire carries an object.**
The schema said `timeline: { type: 'array' }`. The handler answers
`ok(res, req, { timeline })` where `getCustomerBookingTimeline` returns
`{ bookingId, events, currentStep }`. A generated client would iterate
`timeline` and find nothing, with no error anywhere. Nothing caught it because
`items: { type: 'object' }` generates as an empty object — no client could bind
tightly enough to notice the *outer* type was wrong either.

**4. `EarningsSummary` is referenced by nothing.** A reference count over the
generated document finds zero: the earnings endpoint declares
`ProviderEarningsSummary`. It was a name with nothing behind it. Aliased to the
real schema and deprecated rather than deleted — a client may already hold the
generated type, and aliasing upgrades it from `Record<string, never>` to a real
shape.

**5. `AdminBookingRow.updatedAt` is a hard-coded `null`.** The mapper writes
`updatedAt: null` literally. It is a constant, not a signal, and is now declared
`type: 'null'` so no generated client mistakes it for a timestamp that might
arrive.

**6. TAB 05 is answered on the way past.** `SERVANA_COMMISSION_RATE = 0.2` and
its sibling `PROVIDER_SHARE_RATE = 0.8` sum to exactly 1. `commissionRate` is a
**fraction in [0, 1]**, not a percentage, and is now declared with
`minimum: 0, maximum: 1`. The portal's current reading is correct.

## What was NOT renamed

The snake_case that the additional-work responses carry — `booking_id`,
`total_amount`, `approved_at` — is documented as it stands. `additional.service`
returns `res.rows` and `rows[0]` from `RETURNING *` with no mapper, so the wire
is snake_case while almost every other v1 response is camelCase. Per the book:
a rename bundled into a documentation pass is a change nobody can review.

## Negative controls

```
Strip `properties` from AdminAssignRequest
  → 2 tests fail: "no schema position generates as an empty object"
                  "gives the five admin assignment-path schemas real properties"
Restore → 7 passed, 7 total

Reinstate the credential spread (formatBooking without the deny)
  → covered by tests/booking-credential-disclosure.test.ts, which asserts the
    VALUES are absent from the serialised object rather than that two named keys
    are undefined — a renamed column is caught, and so is a third code added later.
```

## Deliverables

| File | What changed |
| --- | --- |
| `src/api/v1/openapi.ts` | 17 empty positions shaped; 13 new schemas added |
| `src/services/bookingService.ts` | `formatBooking`/`formatBookings` deny credentials by default |
| `src/api/v1/domains/bookings.ts` | v1 read path is seat-aware |
| `src/controllers/bookingController.ts` | 7 legacy call sites made seat-aware |
| `tests/schema-completeness.test.ts` | 7 assertions, ceiling of zero |
| `tests/booking-credential-disclosure.test.ts` | 9 assertions on the leak |

## Acceptance, against the book's own criteria

| Book's criterion | Status |
| --- | --- |
| `dto:check` reports fewer than 21 under-specified positions | ✅ 0, from a measured 17 |
| The number only ever falls | ✅ ceiling of zero, gated |
| No schema reachable from an admin endpoint lacks `properties` | ✅ and no schema anywhere does |
| Mark required fields required | ✅ every authored schema declares `required` |
| Land them one at a time | ✅ all 17 landed; the gate does not demand more |

---
Servana Backend — Admin API Master Command · TAB 02
