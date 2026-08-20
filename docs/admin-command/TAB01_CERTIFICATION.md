# TAB 01 — The admin API is not in the contract (P0)

## Verdict

```
ADMIN SURFACE PUBLISHED AND GATED       CERTIFIED_WITH_AUTHORING_BACKLOG

251 operations documented                    was 6
Guard + permission derived per operation     251 / 251
Response envelope derived per operation      251 / 251, 0 unknown
Payload schemas authored                     15 / 251, ratcheted
An admin route added without docs            FAILS the gate  ✔ proven
```

The book asks for "at least 51 and rising toward the true total". The true total
is **251**, and all 251 are now in a machine-readable contract with a gate behind
them. Payload schemas are authored for 15; the rest publish their envelope,
guard, permission and parity status with the payload declared `UNSPECIFIED`.

## What the book got wrong, and why it matters

| | Book | Measured here |
| --- | --- | --- |
| Admin operations | "51+, a floor" | **251** |
| — with a named permission | not measured | 234 |
| — `requireSuperAdmin` | not measured | 9 |
| — role 1, no named permission | not measured | 6 |
| — chain proves only "signed in" | not measured | 2, both handler-guarded |

The book's floor was measured from the admin portal's call sites, seventeen of
which it could not statically resolve. That is a floor on **what one client
could be seen to call** — a different quantity from the size of the surface. Its
acceptance criterion of "at least 51" would have certified a surface that is 80%
undocumented, with the gate green.

## The design decision, and the evidence for it

**The admin surface is NOT documented inside `openapi.v1.json`.** It gets its own
generated document, `docs/api/openapi.admin.json`.

That is not a preference. `src/app.ts` runs `parityMiddleware` over everything
except six prefixes — `/api/v1`, `/api/admin/catalog`, `/api/catalog`,
`/healthz`, `/readyz`, `/health`. **231 of the 251 admin operations are
rewritten on the way out**, gaining alias keys (`first_name`, `providerUid`,
`level2`, `photoURL`, and some forty more) that no schema declares.

`openapi.v1.json` says of itself:

> Routes under /api/v1 are exempt from the cross-platform field-parity
> middleware that rewrites every other response, so the shapes below are exactly
> what the wire carries.

Folding 231 rewritten operations into that document makes that sentence false
for the majority of it, and five clients generate code from it. app.ts had
already written down the principle, in the comment justifying the v1 exemption:

> a middleware that adds keys to every response makes that document false the
> moment it runs … Explicit DTOs and global field rewriting are two answers to
> the same question, and only one of them can be true.

The admin document therefore states `x-parity-rewritten` per operation. A client
generating from it knows the declared shape is a **subset** of the wire — true
and useful. A client generating from a merged v1 document would believe it was
the whole shape — neither.

## Two findings the book could not see from outside

**1. There are two success envelopes on one surface.**

```
status-success   239   { status: 'success', data: … }
success-flag      11   { success: true, … }    ← a BOOLEAN flag
non-json           1   text/csv
```

A client that unwraps `body.data` reads `undefined` from all eleven. Worse,
three of them do not use `data` as the payload key at all:

```
GET  /api/admin/disbursements                → { success: true, disbursements: [...] }
GET  /api/admin/disbursements/booking/:id    → { success: true, disbursement: {...} }
PATCH /api/admin/workers/:uid/archive        → { success: true, worker: {...}, message }
```

Nothing anywhere said so before this document. Documented as it stands, per the
book's own instruction — renaming belongs in a change somebody can review, not
in a documentation pass.

**2. One entity, two shapes, on two routes.**

`GET /api/admin/communications/reports` returns camelCase through a mapper.
`PATCH …/reports/:reportId` returns `rows[0]` — the **raw `UPDATE … RETURNING *`
row, snake_case, no mapper**. Same entity, two shapes. And
`listMessageReports` wraps its query in `try { … } catch { return [] }`, so a
database error is indistinguishable from "no reports": an empty moderation queue
is not evidence the queue is clear. Both are now stated in the document.

## The bug this TAB found in the guard reading — and why it is recorded

A first version of the reader classified guards by `requirePermission` alone and
reported **17 admin operations as unguarded**, eleven of them under
`/api/admin/admin-users/*` — the routes that create admins and grant
permissions.

That reading was wrong twice over:

1. Those eleven carry `requireSuperAdmin`, which is **stricter** than any named
   permission. The detector had no word for it, and a gate with no word for a
   guard reports its absence.
2. A second defect made it worse. `localChainConsts` matched
   `\[([^\]]*)\]`, which stops at the `]` inside
   `verifyRoles([1])` — so `const adminOnly = [verifyAuth, verifyRoles([1]),
   adminRateLimit]` resolved to a truncated chain that no longer matched the
   role-1 test. **Four role-1 routes, including the admin notification list,
   were classified as reachable by any signed-in customer.** They are not.

`POST /api/admin/admin-users/bootstrap-super-admin` genuinely has no role gate,
and that is correct: the first Super Admin cannot already be an admin. The
service is fail-closed — one transaction behind `pg_advisory_xact_lock`, refuses
when any super-admin row exists regardless of status, requires the caller to
already be an admin when `admin_users` is non-empty, and audits denials. Reading
the handler settled what reading the chain could not.

Every one of these is now a negative fixture in `tests/admin-surface.test.ts`.

## Deliverables

| File | What it is |
| --- | --- |
| `scripts/lib/adminSurface.ts` | Derives all 251 operations: guard, permission, envelope, payload keys, parity, source |
| `src/api/admin/adminResponses.ts` | Authored payload schemas, each naming the service it was read from |
| `scripts/generate-admin-api-docs.ts` | Generates the document and the registry; `--check` fails on drift |
| `docs/api/openapi.admin.json` | 220 paths, 251 operations, OpenAPI 3.1 |
| `docs/api/ADMIN_SURFACE_REGISTRY.md` | The same, readable, ordered by blast radius |
| `tests/admin-surface.test.ts` | 22 assertions: ratchets, pins, and the reader's own fixtures |

`npm run admin:docs:check` is wired into `npm run verify`, next to
`api:docs:check`.

## Negative controls — the gate was watched failing

A green new gate proves nothing until it goes red on purpose.

```
1. Remove one authored schema
   → 2 tests fail (the ratchet, and the key-exists check)

2. Add `router.get('/admin/notifications/negative-control', ...adminOnly, …)`
   → tests/admin-surface.test.ts   ● has committed documents that match the generator
   → npm run admin:docs:check      docs/api/openapi.admin.json  STALE
                                   docs/api/ADMIN_SURFACE_REGISTRY.md  STALE

3. Restore both → 22 passed, 22 total
```

## What is deliberately NOT done

- **244 payload schemas are unauthored.** They publish as `UNSPECIFIED`. A
  guessed schema is worse than an absent one: absent says "nobody wrote this
  down", wrong says "this is the shape" and a client generates types from it.
  The ratchet makes each one landed a permanent gain.
- **Nothing was renamed.** The book is explicit: "Do not renumber or restructure
  while documenting. A rename bundled into the documentation pass is a change
  nobody can review." The two-envelope split and the snake_case PATCH are
  documented as they stand.
- **`x-callers` names `adminWeb` on every operation**, as the book asks. This is
  the one claim in the document not derived from this repository — it comes from
  the book's own measurement. The true caller set for 251 routes cannot be
  established from the backend alone.

## Acceptance, against the book's own criteria

| Book's criterion | Status |
| --- | --- |
| Every endpoint the portal calls has a path entry | ✅ all 251 admin operations, a superset of the portal's 51 |
| Request and response schema | ⚠️ response envelope 251/251; payload 15/251, ratcheted |
| Count at least 51 and rising | ✅ 251 |
| Each carries `x-callers` naming `adminWeb` | ✅ |

---
Servana Backend — Admin API Master Command · TAB 01
