# 9-Command Post-Deployment Audit — RECENT DEPLOYMENT — 2026-07-25 (Session 2)

**Scope:** All changes since session-start HEAD (BE `a727e0b` → `22a8cc5`):
- DRAFT BOOKINGS audit fixes (`26b96e1`): getDraft expiry enforcement, patchDraft status audit
- Admin portal draft fixes (`a12d479`): fallback submit locationId, customerLabel guest fallback
- DRAFT-002 BE (`22a8cc5`): customerName column + storage in patchDraft/listDrafts
- LEAK-M001 BE (`22a8cc5`): raw error suppression in providerController.ts
- Admin portal DRAFT-002 (`5c2f710`): DTO + _buildPatch + _hydrateDraft + customerLabel

---

## SWEEP — Cross-Platform Field Parity

| Check | Result |
|---|---|
| `customerName` field added to `DraftPatchSections`, `AdminBookingDraft` in BE | ✓ |
| `customerName` field in FE `AdminBookingDraft`, `DraftListItem`, `DraftPatch` DTOs | ✓ |
| BE `mapRow()` extracts `customer_name` → `customerName` | ✓ |
| `listDrafts` SELECT includes `customer_name` | ✓ |
| Draft is admin-only — no mobile/provider parity concern for customerName | ✓ |
| `locationId` in fallback submit path uses same NaN guard as `convertDraft` | ✓ Parity |
| providerController error messages — no new field exposed, messages suppressed | ✓ |
| 40 registry groups unchanged | ✓ |

```
SWEEP: PASS — Registry groups: 40 (unchanged), Mobile contracts: 0 touched
```

---

## STITCH — Integration Stabilization

### DRAFT-002 chain
```
Admin selects client on step 2
  → selectedClient.set({ uid, name }) via getCustomer() API
  → _buildPatch() includes patch.customerName = selectedClient().name
  → PATCH /admin/booking-drafts/:id → patchDraft(customerName)
  → UPDATE admin_booking_drafts SET customer_name = $N
  → listDrafts SELECT customer_name → mapRow → customerName
  → DraftsListComponent.customerLabel() uses customerName ✓

Draft resume:
  → _hydrateDraft(draft) reads draft.customerName
  → IF present: sets selectedClient.name = customerName, skips getCustomer() API call
  → IF absent (legacy draft): falls back to getCustomer() API call → UID used as placeholder
```

### Expiry enforcement chain (fixed prior commit)
```
GET /admin/booking-drafts/:id
  → getDraft()
  → if (status IN editing/ready_for_review) AND expires_at < NOW()
      → UPDATE status = 'expired' (non-blocking)
      → throw 410 DRAFT_EXPIRED
  → controller catches → 410 response
  → FE draftLoadError.set(message) → error shown to admin
```

### Fallback submit + locationId chain (fixed prior commit)
```
submit() [no draft]
  → payload.locationId = NaN-guarded addrResolved().servanaLocationId
  → adminCreateBooking({ ..., locationId: N | null })
  → UPDATE bookings SET service_address = JSONB including locationId
```

| Finding | Severity | Status |
|---|---|---|
| customerName stored in draft → skip API call on resume | P2 (DRAFT-002) | ✓ FIXED |
| Expiry enforcement in getDraft | P2 | ✓ FIXED (prior commit) |
| patchDraft audit records actual status | P3 | ✓ FIXED (prior commit) |
| fallback submit missing locationId | P2 | ✓ FIXED (prior commit) |

---

## ALIGN — Cross-Platform Contract Alignment

| Check | Result |
|---|---|
| `customer_name` column added via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — safe to deploy hot | ✓ Additive, idempotent |
| No existing `AdminBookingDraft` response consumers broken — new nullable field | ✓ |
| Mobile contracts unchanged — draft system is admin-only | ✓ |
| providerController error message change: same status codes, different message text | ✓ Backward-compatible (messages are informational, not machine-readable) |
| `locationId` in fallback path: previously absent (undefined), now explicit null or int | ✓ Backend accepts optional field; no behavior change for null |

```
ALIGN: PASS — 0 breaking changes, 0 mobile contract impacts
```

---

## ACTIONS — Prioritized Action Items

| Priority | ID | Title | Status |
|---|---|---|---|
| ~~P2~~ | ~~DRAFT-002~~ | ~~Store customerName in draft DB to avoid extra API call on resume~~ | ✓ FIXED (`22a8cc5`, `5c2f710`) |
| ~~P2~~ | ~~UX-D01~~ | ~~customerLabel shows truncated raw UID for client drafts~~ | ✓ FIXED — now uses stored customerName |
| ~~P2~~ | ~~LEAK-M001~~ | ~~Raw PostgreSQL error.message exposed in providerController.ts 500 catch blocks~~ | ✓ FIXED (`22a8cc5`) |
| ~~P2~~ | ~~STITCH-D01~~ | ~~Fallback submit() path missing locationId~~ | ✓ FIXED (prior commit) |
| ~~P2~~ | ~~LEAK-D01~~ | ~~getDraft does not enforce expires_at~~ | ✓ FIXED (prior commit) |
| ~~P3~~ | ~~AUDIT-D01~~ | ~~patchDraft audit hardcodes 'editing'~~ | ✓ FIXED (prior commit) |
| P2 | AUTH-001 | Firebase token auto-refresh (1-hour expiry) | open |
| P2 | STITCH-001 | successMessage/errorMessage shared mutable objects in user.controller.ts | deferred (pre-existing, low risk) |
| P3 | REPEAT-001 | getPayoutDetail() mock-only — no real endpoint | open |
| P3 | DOCS-001 | /admin/customers/:uid/addresses endpoint missing | deferred |
| P3 | NOTIFY-D01 | No loading state during draft name resolution | deferred (N/A — name now stored, no async resolution needed for new drafts) |

---

## NOTIFY — Error + Notification State Review

### customerName hydration
- New drafts: `selectedClient.name` stored → `customerLabel()` shows real name immediately ✓
- Legacy drafts (no customerName): `_hydrateDraft()` still falls back to `getCustomer()` API → name resolves asynchronously ✓
- Draft not found / 410 expired: `draftLoadError` shown with server message ✓

### providerController error messages
Before: raw PG errors like `column "xyz" does not exist` could surface as `message` in 500 responses.
After: pure 500 blocks now return `"Server error"` — no schema information exposed.

UX impact: For job-card operations (accept/decline/start/complete), the FE previously showed raw PG messages on rare DB errors. Now shows "Server error" which is less specific but safer. Intentional trade-off. ✓

```
NOTIFY: PASS — all error paths handled, no silent failures introduced
```

---

## MOBILE VIEW — Mobile Usability Review

All changes are admin-portal and backend-only. No provider portal changes. No mobile layout impact.

```
MOBILE VIEW: PASS — 0 layout changes, admin-only features
```

---

## LEAK — Data Exposure Review

| Threat | Assessment | Risk |
|---|---|---|
| Raw PostgreSQL schema names in 500 responses (providerController) | Removed via "Server error" replacement | ✓ FIXED |
| `customerName` stored in draft — PII concern | customerName is admin-entered display name; only visible to admins | ✓ Acceptable |
| Expired draft accessible via GET (getDraft) | Throws 410 DRAFT_EXPIRED, transitions status | ✓ FIXED (prior) |
| Draft IDOR (cross-admin) | All queries scope `created_by_admin_uid = adminUid` | ✓ No change |
| New `customer_name` column exposed to non-admin callers | Draft routes are all `adminOnly` — no exposure risk | ✓ |

```
LEAK: PASS — 1 new exposure vector closed (LEAK-M001), 0 new exposures introduced
```

---

## REPEAT — Endpoint Equivalence Sweep

### customerName in patchDraft
`DraftPatch.customerName` → sent to `PATCH /admin/booking-drafts/:id` → stored in `customer_name` column. No equivalent mobile endpoint. No duplication risk.

### providerController error message change
Not an endpoint change — behavior-only. All route registrations unchanged.

```
REPEAT: PASS — No new endpoints, mobile contracts unchanged, registry groups: 40
```

---

## TEST — Release Quality Gate

### Backend (1189/1189 passing, up from 1180)

| Test file | New tests | Result |
|---|---|---|
| `admin-create-booking.test.js` | +9 (DRAFT-002: 6 assertions; LEAK-M001: 3 assertions) | ✓ pass |
| All other 20 test files | unchanged | ✓ pass |

### Admin portal (1018/1020 passing, up from 1017, 2 pre-existing skips)

| Test file | New tests | Result |
|---|---|---|
| `drafts-list.component.spec.ts` | +2 (customerName in label, null fallback to UID) | ✓ pass |
| `create-booking.component.spec.ts` | fixture updated (customerName: null in mocks) | ✓ pass |

```
TEST: PASS
BE: 1189/1189 (+9)
Admin: 1018/1020 (+2)
Provider: 465/465 (unchanged)
TS compile errors: 0
New tests this session total: 17 (BE +9, Admin +8)
```

---

## Summary

| Command | Findings | Fixed this session | Previously fixed |
|---|---|---|---|
| SWEEP | All parity checks clean | 0 | 0 |
| STITCH | DRAFT-002 chain verified | DRAFT-002 ✓ | locationId ✓ |
| ALIGN | 0 breaking changes | 0 | 0 |
| ACTIONS | 3 items resolved this session | DRAFT-002, UX-D01, LEAK-M001 | STITCH-D01, LEAK-D01, AUDIT-D01 |
| NOTIFY | All error paths handled | customerName hydration reviewed | 0 |
| MOBILE VIEW | Admin-only | PASS | PASS |
| LEAK | LEAK-M001 closed | ✓ | Expiry enforcement ✓ |
| REPEAT | All endpoints classified | 0 new endpoints | 0 |
| TEST | 17 new tests total this session | +9 BE, +2 Admin | +4 BE, +2 Admin, +4 BE, +2 Admin |

**Deployable: YES.** All P2 deferred items from DRAFT BOOKINGS audit resolved.

BE: `22a8cc5` PUSHED  
Admin: `5c2f710` PUSHED  
Provider: `13f45e7` PUSHED (unchanged)
