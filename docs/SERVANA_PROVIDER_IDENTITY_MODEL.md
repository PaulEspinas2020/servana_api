# Servana provider identity model

**Command 3 §4 deliverable.** Describes what the code does today, and what is
canonical going forward. Every claim is source-cited and was verified by an
independent skeptic pass before being written here.

## The short version

**There is one provider identity: the Firebase uid.** There is no second id, no
translation table, and no lookup. `user_credentials.uid` holds the Firebase uid
and is the conflict target of the upsert — it *is* the primary key.

Everything else in this document exists because the naming does not say so.

## What `req.user` actually contains

`req.user` is the raw `firebase-admin` `DecodedIdToken`, assigned verbatim by
`middleware/verifyAuth.ts`. Nothing is added to it: no database row, no role, no
account id.

In practice the backend reads exactly one field off it — `.uid` — plus `.name`
and `.email` inside `requirePermission`, for audit display only.

Two consequences that matter:

- **There is no `role` on `req.user`.** Role is *always* a second database
  round-trip: `verifyRoles.ts` runs
  `SELECT "role" FROM user_credentials WHERE uid = $1`. No Firebase custom
  claims are set anywhere in the backend — `setCustomUserClaims` has zero
  occurrences in `src/`.
- **The dev bypass produces a different shape.** In the `TEMP_ID` branch
  `req.user` is a hand-made `{ uid }` with no `email`, no `exp` and no Firebase
  claims. Any code that reads another field off `req.user` works in production
  and crashes under the bypass, or vice versa.

## Canonical names

| Concept | Canonical | Reality |
|---|---|---|
| Provider identity | `providerUid` | the Firebase uid |
| Customer identity | `customerUid` | the Firebase uid |
| Guest customer | `guestCustomerId` | separate; never placed in `customerUid` |
| Admin actor on a mutation | `adminActorUid` | the Firebase uid |

Wire aliases in current use for the provider: `workerUid`, `worker_uid`,
`provider_uid`, `uid`. These are genuinely the same value.

### `technicianId` / `technicianUid` / `technician_id` do not exist

Zero occurrences across all four repositories. The word "technician" survives
only in two places:

- backend **file** names — `technicianController.ts`, `technicianService.ts`,
  `technician.routes.ts` — whose routes are all `/api/workers/*`; and
- customer-app UI copy.

**This corrects the standing platform rule**, which lists `technicianUid` as a
canonical alias for provider identity. It is not in the parity registry and
appears in no source file in any repository. Treating it as an alias implies a
translation that does not exist, and would have anyone implementing against this
spec looking for a mapping layer that was never written.

### `getWorkerByUid` is not a translation

`technicianService.getWorkerByUid(uid)` reads like an id lookup. It is not. It
is a profile fan-out that filters every child table on the *same* Firebase uid.
No `worker_id`, `provider_id`, `technician_id`, `employee_id` or
`service_provider_profile_id` column exists anywhere in the backend.

## Rules

1. **Derive provider identity server-side, from the token. Never from the
   request.** A client cannot be permitted to name the provider it is acting as.
2. **Do not require a provider id in a request body or path** when it can be
   derived from the token. The `/api/worker/*` and `/api/provider/*` families
   already follow this; the legacy `/api/workers/*` family does not, which is
   why it is being retired (see `WORKER_ROUTE_MIGRATION.md`).
3. **A supplied identity that disagrees with the token is ignored, not
   honoured.** `actingWorkerUid` (`technicianController.ts:510`) already does
   this: it returns `fromToken ?? null` and logs the mismatch without either
   value, so the log carries no PII. That is the pattern.
4. **Role requires a database read.** There is no shortcut; do not assume a
   claim.
5. **Fail closed when identity or ownership is ambiguous.**

## What this model does not yet answer

- **Branch / membership identity was not resolved.** Branch ids appear on
  bookings and in the catalog, but no provider-to-branch membership model was
  traced end to end. Anything written here about it would be invention.
- **`PARITY_REGISTRY` has two groups that both claim `workerUid` and
  `providerUid`** — one keyed `id` (contextual), one keyed as provider identity.
  A skeptic refuted the initial "clean alias story" on exactly this point. Until
  the duplication is resolved, the registry cannot be treated as the single
  authority for alias resolution.
