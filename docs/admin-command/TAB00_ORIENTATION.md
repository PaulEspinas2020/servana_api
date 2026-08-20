# TAB 00 — Orientation: what was re-measured, and why the book's numbers moved

## Verdict

```
BACKEND ADMIN API MASTER COMMAND — BASELINE ESTABLISHED
```

The incoming book (`SERVANA_BACKEND_ADMIN_API_MASTER_COMMAND`, measured
2026-08-20 from `servana_adminportal@5f8046a`) was measured against contract
`sha256:9a9131bcaa1b90dc`. **This repository's contract is not that document.**

```
CONTRACT THE BOOK MEASURED     sha256:9a9131bcaa1b90dc
CONTRACT IN THIS REPO AT HEAD  sha256:cacc2bd1e768b18c
```

Every figure below was therefore re-derived from `docs/api/openapi.v1.json` at
HEAD rather than copied from the book. Where the two disagree, the disagreement
is recorded, because a number carried forward unchecked is the exact failure the
book itself warns about (TAB 08: the pin went stale twice in one session).

## The single most important correction

The book states the portal reaches **51+** admin endpoints and calls that a
floor. Measured from *this* side — the routers themselves, not a client's call
sites — the legacy admin surface is:

```
/api/admin/* routes actually mounted     251
/api/v1/admin/* operations in contract     6
```

**251, not 51.** The book's floor was a floor on what one client could be seen
to call. It is not the size of the job. TAB 01 is therefore roughly five times
the work the book estimated, and its acceptance criterion ("at least 51") would
have certified a surface that is 80% undocumented.

## Re-measured baseline

| Measurement | Book | This repo at HEAD | Command |
| --- | --- | --- | --- |
| Contract paths | 93 | **94** | `node -e` over `openapi.v1.json` |
| Contract operations | — | **113** | same |
| Contract schemas | 140 | **144** | same |
| `/api/v1/admin/*` paths | 6 | **6** | same |
| Legacy `/api/admin/*` mounted | 51+ (floor) | **251** | scan of `src/routes/*.ts` |
| Top-level empty schemas | 9 | **8** | walker over `components.schemas` |
| All empty-object positions | 21 (generated) | **17** (source) | recursive walker |
| `format: date-time` fields | 62 | **60** | recursive walker |
| — of those stating the UTC rule | 1 | **1** | `/UTC designator/` on description |

Two book figures resolved themselves before this session began:
`CatalogServiceDetail` has since gained properties via `allOf`, and
`BookingTracking` / `BookingDispute` likewise. That is why 9 became 8 and 21
became 17. **Neither was fixed by this session** — they were already closed.

## The six admin operations the contract does declare

```
GET  /api/v1/admin/bookings
GET  /api/v1/admin/bookings/{bookingId}/assignment-candidates
POST /api/v1/admin/bookings/{bookingId}/assign
POST /api/v1/admin/bookings/{bookingId}/reassign
POST /api/v1/admin/refunds/{refundId}/mark-failed
GET  /api/v1/admin/finance/reconciliation
```

The last two are newer than the book and are not in its list.

## What generates what — the constraint every later TAB works under

`docs/api/openapi.v1.json` is **generated**, not authored:

```
src/api/v1/contract.ts   ─┬─> register.ts          mounts the routers
                          ├─> openapi.ts           generates the OpenAPI document
                          ├─> generate-api-docs.ts writes the registries
                          └─> tests/v1-contract.test.ts asserts all four agree
```

So no TAB in this programme edits `openapi.v1.json`. Schema work lands in
`src/api/v1/openapi.ts` (the `SCHEMAS` map) and endpoint work in
`src/api/v1/contract.ts`; `npm run api:docs` rewrites the JSON and
`npm run api:docs:check` fails the gate if it drifts. This is a strictly better
position than the book assumed, and it is why "document the surface" is a
mechanical, testable job here rather than a hand-maintained one.

## The eight empty schemas, as they read in source today

All eight are explicitly marked `PLANNED` in `src/api/v1/openapi.ts` — they are
placeholders written deliberately, not omissions:

```
Booking                    'A booking as produced by bookingService.formatBooking.'
JobCard                    (empty object)
EarningsSummary            'PLANNED — owned by the provider-earnings domain command.'
AdminBookingList           'PLANNED — owned by the admin-bookings domain command.'
AssignmentCandidatePool    'PLANNED'
AdminAssignRequest         'PLANNED — providerUid and an optional reason.'
AdminReassignRequest       'PLANNED — providerUid and a REQUIRED reason; the override is audited.'
AdminBookingActionResult   'PLANNED — the canonical booking projection after the transition.'
```

The descriptions already name the real shape in prose. TAB 02's job is to move
that prose into `properties`, where a client can bind to it.

## How every figure here can be re-run

```bash
# contract counts, admin paths, empty schema positions, timestamp coverage
node -e "const d=require('./docs/api/openapi.v1.json'); ..."   # see TAB bodies
# legacy admin route count
node -e "scan src/routes/*.ts for router.<verb>('/admin...')"
# the gate
npm run verify
```

## Baseline gate

Recorded separately in `TAB00_GATE_BASELINE.md` once the run completes. Nothing
in this TAB changed a line of shipping code.

---
Servana Backend — Admin API Master Command · TAB 00 · measured against
`servana_api@7653082`, contract `sha256:cacc2bd1e768b18c`
