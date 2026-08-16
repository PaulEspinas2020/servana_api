# Servana auth — the v1 contract

Authentication, registration, recovery, verification and session policy for
`/api/v1/auth/*`. Written by hand because these are decisions; the endpoint list
is generated into [`API_ENDPOINT_REGISTRY.md`](API_ENDPOINT_REGISTRY.md) and
[`openapi.v1.json`](openapi.v1.json) from
[`src/api/v1/contract.ts`](../../src/api/v1/contract.ts).

The general v1 rules — envelope, pagination, parity exemption, versioning —
are in [`API_V1_CONTRACT.md`](API_V1_CONTRACT.md) and are not repeated here.

---

## 1. What was centralised

Four sign-in routes became one. Two registration routes became one. Two
verification-resend routes became one.

| Before | After |
|---|---|
| `POST /api/auth/signin` — email + password | `POST /api/v1/auth/login` |
| `POST /api/auth/admin-signin` — the same, plus a role-1 gate | …with `audience: "admin"` |
| `POST /api/auth/firebase-login` — ID token, provider-shaped | …with `idToken` |
| `POST /api/auth/customer-firebase-login` | **kept** — see §9 |
| `POST /api/auth/signup` — email + password | `POST /api/v1/auth/register` |
| `POST /api/auth/provider/register` — ID token | …with `idToken` |
| `POST /api/auth/resend-email-otp` | `POST /api/v1/auth/resend-verification` with `channel: "otp"` |
| `GET /api/auth/resendverification` | …with `channel: "link"` |

The role gate was the only real difference between the first two, and it is a
property of the **caller**, not the credential. It belongs in a parameter.

## 2. The credential model

An account has an email, a mobile number, or both. Neither is mandatory and
neither implies the other — the states are independent and are already
documented in [`AUTH_STATE_MATRIX.md`](../AUTH_STATE_MATRIX.md).

`login` takes ONE `identifier` field and resolves it:

```jsonc
{ "identifier": "juan@example.com",   "password": "…" }
{ "identifier": "0917 123 4567",       "password": "…" }   // same field
{ "idToken": "…" }                                          // social, phone, existing session
```

Resolution goes through
[`services/identifierResolver.ts`](../../src/services/identifierResolver.ts),
which normalises `0917…`, `+63917…`, `63917…` and `9171234567` to one E.164
form and looks the account up on the indexed `phone_normalized` column.

**That resolver was written for Command 5 and had exactly one caller until now
— account deletion.** Its own docblock says why it exists: *"Sign-in took an
`email` field and looked it up directly, so a provider who registered with a
mobile number had no way in."* Sign-in still did that. `login` is the first
path in the platform that uses it for its stated purpose.

### Mobile + password has a real limit, and it is stated rather than hidden

Firebase is the password authority and its password grant is keyed on **email**.
So mobile + password works when the account also has an email — the number
names the account, and the account's email carries the grant. An account with a
mobile and no email has no password at all, and gets `PASSWORD_NOT_AVAILABLE`
rather than `INVALID_CREDENTIALS`, because telling somebody their password is
wrong when no password can exist sends them round a loop that never ends.

## 3. Audience

`audience` is `admin` | `provider` | `customer` | `any` (default `any`).

Asserted **after** authentication, never before. Refusing an unknown identifier
differently from a known-but-wrong-audience one would turn the admin portal's
login box into an oracle for "is this address an admin". A customer signing in
at the admin portal is told this is not an admin account — true, actionable, and
revealing nothing they had not already proved they own.

Role 4 counts as a provider alongside role 2. A `role === 2` check is the bug
[`servana_role_map`](../../docs/PROVIDER_ACCESS_CONTROL_MATRIX.md) warns about.

## 4. OTP purpose and state

`email_otps` had no purpose column. That is harmless while exactly one thing
writes to it, and stops being harmless the moment a second does: a code mailed
to confirm a password reset would satisfy an unscoped "is there an unused,
unexpired code for this address" read, and a registration screen would accept
it. The same six digits would unlock two decisions.

| Purpose | Meaning | In use |
|---|---|---|
| `REGISTRATION_VERIFICATION` | Prove control of an address at sign-up | **yes** |
| `PASSWORD_RESET` | Prove control before allowing a reset | modelled, not issued |
| `SENSITIVE_CHANGE` | Re-prove before an identifier or payout change | modelled, not issued |

Every read is scoped to one purpose. Values are stored, so they are a contract:
append, never rename.

**States** are derived from `used` and `expires_at`, not stored separately:

| State | Reached when |
|---|---|
| `valid` | unused, unexpired, correct purpose |
| `used` | claimed by the compare-and-swap |
| `expired` | past `expires_at` (10 minutes) |
| `absent` | never issued for this address and purpose |

Consumption is a **compare-and-swap** `UPDATE … WHERE used = FALSE AND
expires_at > NOW() RETURNING id`, so two concurrent verifications of one code
cannot both succeed. A read-then-write would let both through.

`OTP_INVALID` covers wrong, unknown, already used and never issued —
deliberately one outcome. `OTP_EXPIRED` is reported separately only when a code
for this address and purpose demonstrably existed and its window passed: that is
information the legitimate holder needs and an attacker cannot obtain without
already holding a valid code.

The column is created by
[`026-otp-purpose.sql`](../../scripts/migrations/026-otp-purpose.sql) **and** by
a memoised, awaited ensure inside the service. Both are `IF NOT EXISTS`. The
belt and braces is deliberate: a migration alone means the code can ship before
the column exists, which is a rename that is not atomic with its deploy — the
failure that took production down once already.

## 5. Session and token policy

| | |
|---|---|
| Session credential | Firebase ID token, **one hour** |
| Renewal | `POST /api/v1/auth/refresh` with the refresh token |
| Refresh token | Long-lived. Secure device storage — never a log, never a query string |
| Revocation granularity | **All sessions for the account.** Firebase has no per-session revocation |
| Effective when | The **next request**, not the next refresh |

That last row is only true because
[`services/tokenRevocation.ts`](../../src/services/tokenRevocation.ts) compares
`auth_time` against a cached `tokensValidAfterTime` on every authenticated
request. Without it, `revokeRefreshTokens` would leave already-issued ID tokens
working for up to an hour — on exactly the device somebody is trying to remove.

### Sessions end when

- **Logout** — `POST /api/v1/auth/logout`. Revokes and clears the FCM token, so
  a signed-out device also stops receiving push.
- **Password reset** — **new in this command.** `authService.resetPassword` did
  not revoke anything. Firebase's `confirmPasswordReset` is widely believed to
  revoke refresh tokens and may well do so, but that was never verified against
  this project's configuration, and a password reset is the one action somebody
  takes when they think another person is in their account. An inherited
  assumption is the wrong control there. It is now explicit, idempotent, and it
  lives in the **service**, so the legacy route inherits it too.
- **Provider password change** and **sign out all devices** — already did.

All of them go through
[`services/authSessionService.ts`](../../src/services/authSessionService.ts), so
the side-effect set is decided once rather than per call site.

## 6. Error catalog

Clients branch on `code`. `message` is copy and may be reworded without a client
release.

| Code | HTTP | Means | What the client should do |
|---|---|---|---|
| `INVALID_CREDENTIALS` | 401 | Identifier or password did not match | Let them retry |
| `ACCOUNT_UNVERIFIED` | **403** | Credential was **correct**; identifier unverified | Send to verification, **not** to login |
| `ACCOUNT_DISABLED` | 403 | Account may not sign in at all | Contact support |
| `AUDIENCE_MISMATCH` | 403 | Right credential, wrong surface | Say which app to use |
| `ACCOUNT_LINK_REQUIRED` | 409 | Identifier belongs to an account reachable another way | Name the other identifier |
| `PASSWORD_NOT_AVAILABLE` | 409 | Account signs in with a code, not a password | Offer the code path |
| `OTP_INVALID` | 400 | Wrong, unknown, spent or never issued | Let them retype |
| `OTP_EXPIRED` | 410 | A real code, past its window | Offer resend |
| `RESET_TOKEN_INVALID` | 400 | Reset link malformed, spent or expired | Offer a new link |
| `REFRESH_TOKEN_INVALID` | 401 | Not exchangeable | Re-authenticate |
| `REFRESH_UNAVAILABLE` | 502 | Google unreachable | Retry with backoff |
| `WEAK_PASSWORD` | 400 | Below policy | Show the policy |
| `REGISTRATION_REJECTED` | 400 | Could not register | Generic — see below |
| `RATE_LIMITED` | 429 | Too many attempts | Back off |

`ACCOUNT_UNVERIFIED` being 403 rather than 401 is the distinction that matters
most in this table. The credential was correct. Routing it to a login screen
makes people retype a password that was never the problem.

`REGISTRATION_REJECTED` deliberately does not say why. "That email is taken" is
the same membership check as "that email is not registered", by another route.

These mirror [`src/errors/authErrors.ts`](../../src/errors/authErrors.ts), which
the legacy routes emit and clients already branch on.
`tests/v1-auth-contract.test.ts` asserts the shared codes carry the same HTTP
status in both catalogues — one vocabulary that is slightly off-spec beats two
that are each half-right.

## 7. Enumeration

Three endpoints answer identically whether or not an account exists:
`forgot-password`, `resend-verification`, and `login` for the not-found case.

`forgot-password` returns the same body **even when delivery throws**. A 500 on
one address and a 200 on another is an oracle that does not need to read
English. `tests/v1-auth-security.test.ts` asserts byte equality across a real
address, an unknown one, a mobile number and a mailer failure.

## 8. Rate limiting

Where a secret is submitted for checking, **two** limiters guard the endpoint
and both must pass. Where only one applies, the declaration says why — the
table below is rendered from
[`rateLimitPolicy.ts`](../../src/api/v1/rateLimitPolicy.ts), which is also what
`register.ts` builds the middleware chain from, so a limiter cannot be
documented and not mounted.

<!-- BEGIN GENERATED: auth-rate-limits -->
**Buckets.** One `express-rate-limit` instance each, so endpoints sharing a bucket share a counter.

| Bucket | Key | Budget | Counts | What it stops |
|---|---|---|---|---|
| `perAccountLogin` | normalised identifier, hashed | 10 / 15 min | failures only | Password guessing against one account. |
| `perAccountRegister` | normalised identifier, hashed | 5 / 1 h | every request | Farming accounts from one address. |
| `perAccountOtp` | normalised identifier, hashed | 8 / 10 min | failures only | Guessing a six-digit code before it expires. |
| `perAccountRecovery` | normalised identifier, hashed | 5 / 1 h | every request | Mail-bombing one address through the reset form. |
| `perIp` | normalised IP | 200 / 15 min | failures only | A cost ceiling on a flood. Loose, because carrier NAT shares it. |

**Per endpoint.** 6 of 9 carry a per-account bucket *and* the per-IP one; the rest say why they do not.

| Endpoint | Buckets | Why no per-account bucket |
|---|---|---|
| `auth.login` | `perAccountLogin` + `perIp` | — |
| `auth.register` | `perAccountRegister` + `perIp` | — |
| `auth.verifyEmail` | `perAccountOtp` + `perIp` | — |
| `auth.forgotPassword` | `perAccountRecovery` + `perIp` | — |
| `auth.resetPassword` | `perAccountRecovery` + `perIp` | — |
| `auth.resendVerification` | `perAccountRecovery` + `perIp` | — |
| `auth.refresh` | `perIp` | The body carries a refresh token and no identifier, so there is nothing to key an account bucket on. Keying on the unverified token's subject would let a caller pick their own counter — the objection `tokenExchangeLimiter` raises, and the one case where it holds. |
| `auth.verifyMobile` | `perIp` | Same shape: the proof is a Firebase ID token, not an identifier. It also runs behind `verifyAuth`, so an anonymous caller never reaches it, and Firebase has already rate limited the SMS OTP that issued the token. |
| `auth.logout` | **none** | Revokes the caller's own sessions behind `verifyAuth`. There is no secret to guess and nothing to enumerate: the worst a flood achieves is logging one account out repeatedly. |
<!-- END GENERATED: auth-rate-limits -->

Keyed on the identifier alone, an attacker spraying one password across
thousands of accounts from one host gets a fresh budget per account and is never
slowed. Keyed on IP alone, one carrier NAT locks out a city — which is not
hypothetical: `tokenExchangeLimiter`'s docblock in `auth.route.ts` documents
Philippine CGNAT doing exactly that, and the existing `signInLimiter` still has
the problem it describes.

Buckets are **hashed**, because rate-limit keys sit in memory and appear in
diagnostics, and an email address is personal data. Normalised **first**, so
changing the case of a letter does not buy a fresh budget.

`skipSuccessfulRequests` on the sign-in limiters: only failures count.

## 9. What is deliberately NOT collapsed

**`POST /api/auth/customer-firebase-login`.** Its link-collision contract is a
**200 carrying `status: "failed"` and no token**. That looks wrong and is not:
the installed customer app throws on any non-2xx before the body is read, and on
401 it fires `onUnauthorized`, which drives a session-expiry redirect. Either
would hide the message and show "session expired" to somebody who has no session
yet. Changing the shape is a client release, so it stays a documented
role-specific alias.

**`POST /api/auth/add-employees`.** Admin bulk-provisioning with generated
temporary passwords: different actor, different credential origin, partial-
success response. It is account *provisioning*, not registration.

**Mobile password recovery.** Requires a verified identifier, and there is no
SMS sender on this platform. Refused rather than half-built — and refused
*silently*, because saying "we cannot text you" reveals which identifier kind an
account holds.

**Server-side SMS OTP.** `verify-mobile` takes a Firebase ID token whose
sign-in provider is `phone`; Firebase only issues one after its own OTP. This
backend does not pretend to verify a number itself.

## 10. Adding an auth endpoint

Same five steps as any v1 endpoint (see `API_V1_CONTRACT.md` §10), plus:

- A non-idempotent entry must name its **`replayGuard`** — what stops a replay
  doing damage. `tests/v1-contract.test.ts` fails without one. Not every
  mutation can be idempotent, but "not idempotent" cannot be the end of the
  sentence.
- Credential endpoints get a per-account **and** a per-IP limiter in
  `V1_MIDDLEWARE`. `tests/v1-auth-contract.test.ts` asserts both are present.
- Every outcome goes through `recordAuthOutcome` so the failure rate stays
  computable by client and version.
