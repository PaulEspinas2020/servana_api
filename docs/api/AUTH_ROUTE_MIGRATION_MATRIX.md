# Auth route migration matrix

Every auth-shaped route the app mounts, classified, with its canonical
successor and the caller matrix across all five clients.

The machine-generated matrix in
[`LEGACY_ENDPOINT_MIGRATION_MATRIX.md`](LEGACY_ENDPOINT_MIGRATION_MATRIX.md) is
derived from `src/api/v1/contract.ts` and covers every route the app mounts.

<!-- BEGIN GENERATED: legacy-route-total -->
It classifies the **519 routes** mounted outside `/api/v1`, alongside the **115 canonical** ones.
<!-- END GENERATED: legacy-route-total -->

This file is the auth slice with the reasoning attached, and
`tests/v1-auth-contract.test.ts` asserts that every route listed here is claimed
by a canonical successor in the contract.

Caller legend: ✅ migrated · ⏳ still on the legacy route · · planned · — n/a

---

## Sign-in

| Legacy | Disposition | Canonical | Cust Mob | Cust Web | Prov Mob | Prov Web | Admin |
|---|---|---|---|---|---|---|---|
| `POST /api/auth/signin` | `ALIAS_TEMPORARILY` | `POST /api/v1/auth/login` | ⏳ | ⏳ | ⏳ | ⏳ | · |
| `POST /api/auth/admin-signin` | `ALIAS_TEMPORARILY` | …`audience: "admin"` | — | — | — | — | ⏳ |
| `POST /api/auth/firebase-login` | `ALIAS_TEMPORARILY` | …`idToken` | ⏳ | ⏳ | ⏳ | ⏳ | · |
| `POST /api/auth/customer-firebase-login` | **`ROLE_SPECIFIC`** | — | ⏳ | ⏳ | — | — | — |

**All four call one of two functions**: `authService.loggedInUser` for a
password, `firebaseFunctions.firebaseAuthLogin` for a token. v1 calls the same
two. That is asserted, not described — `tests/v1-auth-contract.test.ts` checks
the arguments `loginWithPassword` passes.

`customer-firebase-login` stays. Its collision contract is a 200 carrying
`status: "failed"` and no token, because the installed customer app throws on
any non-2xx before reading the body and fires `onUnauthorized` on 401. Either
would show "session expired" to somebody with no session. Changing it is a
client release.

## Registration

| Legacy | Disposition | Canonical | Cust Mob | Cust Web | Prov Mob | Prov Web | Admin |
|---|---|---|---|---|---|---|---|
| `POST /api/auth/signup` | `ALIAS_TEMPORARILY` | `POST /api/v1/auth/register` | ⏳ | · | ⏳ | ⏳ | — |
| `POST /api/auth/provider/register` | `ALIAS_TEMPORARILY` | …`idToken` | — | — | ⏳ | ⏳ | — |
| `POST /api/auth/add-employees` | **`ROLE_SPECIFIC`** | — | — | — | — | — | ⏳ |

`add-employees` is account **provisioning**: an admin creates provider accounts
with generated temporary passwords, and the response is a partial-success shape
(`total` / `created` / `failed` / per-row results). Different actor, different
credential origin, different contract.

## Session lifecycle

| Legacy | Disposition | Canonical | Cust Mob | Cust Web | Prov Mob | Prov Web | Admin |
|---|---|---|---|---|---|---|---|
| `POST /api/auth/refresh` | `ALIAS_TEMPORARILY` | `POST /api/v1/auth/refresh` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| `POST /api/auth/logout` | `ALIAS_TEMPORARILY` | `POST /api/v1/auth/logout` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| `GET /api/auth/me` | `ALIAS_TEMPORARILY` | `GET /api/v1/me` | · | · | · | ⏳ | · |
| `POST /api/provider/security/sessions/revoke-all` | `KEEP` | — | — | — | — | ⏳ | — |

`/api/auth/me` belongs to the **identity** entry, not to an auth one — two
canonical successors for one legacy route is the ambiguity the matrix exists to
remove, and a test asserts it is claimed exactly once.

`revoke-all` is a provider self-service security control with its own UI and
audit expectations. It calls the same `authSessionService` and is not a
duplicate of logout: logout ends a session, this is a deliberate security
action.

## Recovery

| Legacy | Disposition | Canonical | Cust Mob | Cust Web | Prov Mob | Prov Web | Admin |
|---|---|---|---|---|---|---|---|
| `POST /api/auth/forgot-password` | `ALIAS_TEMPORARILY` | `POST /api/v1/auth/forgot-password` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| `POST /api/auth/reset-password` | `ALIAS_TEMPORARILY` | `POST /api/v1/auth/reset-password` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |

**Both inherit the session revocation added in this command**, because it lives
in `authService.resetPassword` rather than in either handler. A client on the
legacy path gets the fix without changing anything.

## Verification

| Legacy | Disposition | Canonical | Cust Mob | Cust Web | Prov Mob | Prov Web | Admin |
|---|---|---|---|---|---|---|---|
| `POST /api/auth/verify-email-otp` | `ALIAS_TEMPORARILY` | `POST /api/v1/auth/verify-email` | ⏳ | · | ⏳ | · | — |
| `POST /api/auth/resend-email-otp` | `ALIAS_TEMPORARILY` | `POST /api/v1/auth/resend-verification` `channel: "otp"` | ⏳ | · | ⏳ | ⏳ | — |
| `GET /api/auth/resendverification` | `ALIAS_TEMPORARILY` | …`channel: "link"` | ⏳ | · | ⏳ | ⏳ | — |
| — | new | `POST /api/v1/auth/verify-mobile` | · | · | · | · | — |

`GET /api/auth/resendverification` is a **GET that sends an email** — a read
path that writes and mails. The v1 form is a POST. The legacy one stays because
it is what both mobile clients call today.

`verify-mobile` has no legacy equivalent. Mobile numbers reach
`is_mobile_verified` today only as a side effect of signing in with a phone
credential (`identityVerificationSync.recordProvenIdentifiers`, called from
three places inside `firebaseFunctions`). There was no way to verify a number
deliberately.

## Retirement order

Ordered by correction cost, matching
[`CROSS_CLIENT_MIGRATION_PLAN.md`](CROSS_CLIENT_MIGRATION_PLAN.md).

1. **`/api/auth/admin-signin`** — one caller, and the admin portal deploys from
   git on every push. 14 zero-traffic days.
2. **`/api/auth/me`** — Provider Web only. 14 days.
3. **The Provider Web half of login / refresh / logout** — same client, same
   deploy shape.
4. **Customer Web** — not yet deployed, so it should adopt v1 as its only
   contract rather than migrating onto it.
5. **Both mobile clients** — 90 zero-traffic days each. An unupdated app keeps
   calling the old path for as long as it stays installed, and no server-side
   measurement of the current build sees that.

**Nothing may be retired yet.** Traffic counting for these routes starts at the
first deploy; today every number is zero because nothing is serving, which is
not the same as nobody calling.

Measure with `pm2 logs servana-prod | grep -E 'legacy-contract|auth-telemetry'`.
