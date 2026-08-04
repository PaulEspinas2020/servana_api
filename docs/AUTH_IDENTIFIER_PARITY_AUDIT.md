# Auth identifier parity — audit

**Command 5 §2 deliverable.** What exists, what does not, and what was built.

## Headline: mobile authentication never existed

This is not a parity mismatch to align. It is a capability that was never built.

| Evidence | Finding |
|---|---|
| `auth.controller.ts` | **zero** occurrences of "phone" or "mobile" |
| Auth routes | every OTP route is `verify-email-otp` / `resend-email-otp` |
| `signin(email, password)` | email only |
| `forgot-password` | email only |
| SMS provider | **none** — SendGrid for email, nothing for SMS |

So §1's premise — *"a provider who registers using a mobile number must be able
to sign in and recover using that mobile number"* — describes something that has
never worked, for anyone.

## Three findings that made it achievable

**1. The backend already handles phone identities.** `firebaseAuthLogin` reads
`firebaseUser.phoneNumber || null` and passes it through. `upsertFirebaseUser`
accepts email *and* phone as nullable, keyed on `uid`, with
`ON CONFLICT DO UPDATE SET email = COALESCE(EXCLUDED.email, ...)` — **that is
already account linking.** Email-only, phone-only and both are all supported at
the data layer today.

**2. Firebase Phone Auth needs no SMS gateway.** Firebase handles delivery,
generation and verification. The provider portal already carried the stubs:
`provider-firebase.service.ts:71-88` imports `RecaptchaVerifier` and
`signInWithPhoneNumber`, with a facade comment reading *"To enable: wire Firebase
phone auth."* **Now enabled on the project.**

**3. The platform already solved phone normalization — for guests.**
`guest_customers` carries `phone_normalized` with a `UNIQUE` index, precisely so
two spellings of one number cannot become two guest records.
`user_credentials` carried a raw `phone_number` with no normalized form and no
constraint. Same database, same problem, protection applied only to the records
that **cannot** sign in.

## Defects found

### The existing normalizer cannot fail

`normalizePhilippinePhone` ends with
`return raw.startsWith('+') ? raw : '+' + cleaned` — so `"notaphone"` normalises
to `"+notaphone"`.

Defensible for a guest contact number an admin heard on a call. Fatal for an
identifier, and not because it is untidy: **a normalizer that always succeeds
produces a distinct output for every malformed spelling, so a uniqueness index
over it cannot catch duplicates.** Two typos of one number become two accounts —
the exact failure §15 exists to prevent.

Replaced by `toE164PhMobile`, which returns null. The lenient helper now
delegates and applies its fallback explicitly, so there is one rule and one
documented place it is relaxed.

### Two tests asserted the implementation, not the behaviour

`admin-create-booking.test.js` checked for the literal source text
`startsWith('09') && cleaned.length === 11`. A pure refactor broke them while
the behaviour was unchanged. Rewritten to assert behaviour.

## What was built

| Change | Commit |
|---|---|
| Strict normalization + 31 fixtures | `dbd621e` |
| `email_normalized` / `phone_normalized` / `is_mobile_verified` + unique indexes | `f97fc0d` |
| Unified identifier resolution (§7, §8, §19) | `b5ad6b9` |
| Conflict audit script (§16) | `a7388d2` |

**Email normalization** lower-cases the local part as a stated policy. RFC 5321
permits case-sensitive local parts; no provider Servana's users plausibly hold
behaves that way, and the alternative is `Juan@gmail.com` and `juan@gmail.com`
becoming two accounts. It does **not** strip periods or `+tags` — those are
Gmail-specific and applying them platform-wide collapses distinct addresses
everywhere else.

## Still missing

| Gap | Status |
|---|---|
| Sign-in not yet wired to the resolver | `b5ad6b9` is unwired by design; wiring is its own change |
| Recovery still email-only | Needs the resolver plus a phone recovery path |
| No phone verification state machine | `is_mobile_verified` exists and defaults false |
| Client phone auth | Neither client implements it |
| Identifier linking / change flows | §13, §14 unbuilt |

## Blocking

**Run `scripts/audit-identifier-conflicts.ts` before the unique indexes go
live.** If two accounts already share a normalized identifier the index will not
create — and that is information wanted *now*, while it is a handful of rows,
not after mobile sign-in ships and a provider signs into someone else's account.
