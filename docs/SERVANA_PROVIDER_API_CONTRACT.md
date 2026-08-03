# Servana provider API contract

**Command 3 §2, §5, §16, §17 deliverable.** The rules a provider-facing endpoint
must follow, and the canonical shapes clients code against.

Companion documents:
`SERVANA_PROVIDER_API_SPEC.yaml` · `SERVANA_PROVIDER_IDENTITY_MODEL.md` ·
`SERVANA_PROVIDER_STATUS_MATRIX.md` · `SERVANA_PROVIDER_ACTION_MATRIX.md` ·
`SERVANA_PROVIDER_ERROR_CODES.md` · `SERVANA_PROVIDER_MIGRATION_PLAN.md` ·
`SERVANA_PROVIDER_ENDPOINT_INVENTORY.md`

## §2 — Who owns what

| Concern | Canonical owner | Not owned by |
|---|---|---|
| Status values | the database column | any frontend constant |
| Status transitions | the SQL guard | any client state machine |
| Provider identity | the Firebase token | any request field |
| Money | `revenueSplit.ts`, and `disbursements` rows | any client arithmetic |
| Available actions | the backend (§8) | any status-to-button map |
| Error meaning | `error.code` | HTTP status alone, and never message text |
| Labels, colour, motion, haptics | the frontend | the backend |

The frontend owns **presentation only**. The moment a client computes a business
value, the platform has two answers to one question — which is how the earnings
screen came to show providers 125% of their actual pay.

## §5 — The provider booking DTO

`formatJobCard` (`providerController.ts:1995`) is the canonical provider view.

```jsonc
{
  "bookingId": 1234,
  "status": "WORKER_ASSIGNED",     // bookings.status — see the status matrix
  "workerStatus": "ASSIGNED",      // booking_workers.status — the PROVIDER's state
  "scheduleAt": "2026-08-12T09:00:00.000Z",
  "customer":  { "uid": "...", "name": "Ana Cruz", "phone": "+639..." },
  "address":   { "addressOne": "...", "addressTwo": "...", "city": "...",
                 "zipCode": "...", "country": "PH", "label": "Home" },
  "service":   { "name": "Deep clean", "type": "cleaning" },
  "addOns":    [ /* pricing_breakdown */ ],
  "assignedAt": "...", "startedAt": "...", "completedAt": "..."
}
```

**Two status fields, and they mean different things.** `status` is the booking;
`workerStatus` is this provider's assignment. A client showing "in progress" must
read `workerStatus` — `bookings.status` is never written `IN_PROGRESS`.

### PII

`customer.name`, `customer.phone` and the full `address` are personal data,
released to a provider because they cannot do the job without them. Therefore:

- **List endpoints must not carry them beyond what the list renders.**
- **Never log them.** Not in analytics, crash reports, or request logs.
- The legacy `/api/workers/:id/job-cards` served all of this **with no
  authentication at all** — that is the single worst consequence of the legacy
  family and the reason it is being deleted rather than merely deprecated.

### Fields that do not exist

Do not add these to a client model; the backend has no counterpart and never
returns them: `tax`, `vat`, `tip`, `deduction`, `withholding`, `platformFee` as a
distinct concept, `disputeStatus`, `pausedAt`, `enRouteAt`, `arrivedAt`,
`rescheduleHistory`.

`instructions` is a special case: the **legacy** job-card emitted it, the
canonical `formatJobCard` does not. No client ever read it. Do not reintroduce it
into a client model expecting data.

## §13 — Money

**All revenue splits 80% provider / 20% Servana. No exceptions** — base price,
transport fee, and paid additional work alike.

- The only definition is `services/revenueSplit.ts`. A test walks `src/` and
  fails if a literal rate reappears.
- The provider share is derived by **subtraction**, so the two shares always sum
  to the total exactly.
- Currency is **PHP**, always returned explicitly. Amounts are decimal PHP, not
  minor units, and are `NUMERIC` in Postgres — round once, at the split.
- **Clients must never compute earnings.** `GET /api/provider/earnings/summary`
  is authoritative. The share depends on the disbursement row, which no job-card
  field exposes.
- `bookingAmount` is the customer's gross. `providerShareAmount` is the
  provider's. Never label the former as earnings.
- **Absent money renders as an em dash, never as ₱0.00.** Zero is a real amount;
  showing it for "not loaded" or "failed" is a lie about someone's pay.

## §16 — Lists

There is **no single pagination contract today**, and this is aspirational rather
than descriptive. Only chat messages return a continuation signal
(`nextCursor`, `chat.service.ts:219`); **no provider-facing list returns a
total.** Most return a bare array.

Going forward:

- **Cursor pagination** for feeds that change (jobs, messages, notifications):
  `?limit=&cursor=` → `{ items: [], nextCursor: string | null }`.
- `nextCursor: null` means the end. Absence of the field means the endpoint is
  not yet migrated — treat as a single page.
- **Sorting is server-side and named** (`?sort=scheduleAt&order=desc`). Never
  sort a paginated list client-side; it reorders one page.

## §17 — Dates, times, currency

- **Every timestamp is ISO 8601 with an explicit offset.** A client must never
  guess whether a value is UTC.
- Operations are **Asia/Manila**. Day boundaries — "today's jobs", "this week's
  earnings" — are Manila days, and the backend computes them. A client
  bucketing by local device time gets a different answer for a provider whose
  phone is on another timezone.
- **Never send a localised date string to the API.** `startDate`/`endDate` are
  ISO.
- Date-only values (availability, leave) are `YYYY-MM-DD` and carry no zone.

⚠ **A verified caveat.** A skeptic refuted the claim that the backend guarantees
timezone-correct timestamps: the `pg` Pool is built with no `types`, no
`setTypeParser` and no session `TimeZone`, so the observed behaviour is
**environment-dependent and client-driven, not an enforced guarantee.** The rules
above are the target. Do not assume they hold on an arbitrary deployment until
the Pool is pinned.

## §18 / §19 — Idempotency and staleness

Not implemented. The four lifecycle transitions are idempotent *in effect*
because each carries a `WHERE status = <expected>` guard, so a replay changes
nothing — but it returns a **failure**, so a retry after a timeout looks like an
error even though the first call succeeded. Correct behaviour needs an
idempotency key and is not built.

Until then, clients must disable a control while its mutation is in flight, and
refetch on resume rather than trusting a screen that may be minutes stale.
