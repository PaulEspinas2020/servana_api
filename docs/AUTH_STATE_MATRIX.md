# Auth state matrix

**Command 5 §9 deliverable.** Identifier states, and what each gates.

## Identifier states

Per identifier, independently. Email and mobile do not share a state.

| State | Meaning | How it is stored |
|---|---|---|
| `missing` | No identifier of this kind | column is NULL |
| `pending` | Present, not yet verified | value set, `is_*_verified = false` |
| `verified` | Confirmed by the owner | `is_*_verified = true` |
| `unparseable` | Present but has no normalized form | raw column set, normalized NULL |

**`unparseable` is not a failure of verification — it is a failure of storage.**
A legacy row whose phone number does not parse has no normalized form, so it
cannot be used to sign in and cannot collide with anything. It is a gap, not a
conflict, and `audit-identifier-conflicts.ts` reports the two separately.

**Missing verification data never implies verification.** `is_mobile_verified`
is `NOT NULL DEFAULT false`, so a row that predates the column reads as
unverified rather than as verified-by-omission (§31).

## What each capability requires

| Capability | Requires | Why |
|---|---|---|
| Sign in | a resolvable identifier + credential | **Not** verification. Locking someone out of an account they can prove they own, because they never clicked a link, is a support ticket rather than security. |
| Basic portal / app access | sign-in + `account_status` in (`active`, `approved`) | `requireActiveProvider` |
| Accept / start / complete a booking | the above | operational; suspension blocks it |
| Read own earnings | the above | |
| **Request a payout** | the above **+ a verified identifier** | money leaving the platform is the one place an unverified contact is not good enough |
| **Password recovery** | a **verified** identifier | §1. An unverified identifier would let someone claim an account they merely typed. |
| Link a second identifier | recent authentication + verification of the new one | §13 |
| Change an identifier | recent authentication + verification of the new one; the old stays active until then | §14 |

**Both identifiers are never required.** §9 forbids demanding both without a
documented business reason, and there is none: a provider with a verified mobile
and no email is fully operable.

## Account states

Distinct from identifier states, and both must pass.

| `account_status` | Sign in | Operate | Recover |
|---|---|---|---|
| `active` / `approved` | yes | yes | yes |
| `pending` / `under_review` | yes | **no** | yes |
| `suspended` | yes | **no** | yes |
| `rejected` | yes | **no** | yes |
| archived / disabled | **no** | no | support only |

A suspended provider can still sign in and recover. They need to see *why* they
were suspended and upload what fixes it; locking them out makes suspension
unrecoverable and buys nothing — their operational routes are already blocked by
`requireActiveProvider`.

## Transitions

```
missing ──add identifier──► pending ──verify──► verified
                              │                    │
                              │                    ├──change──► pending (new)
                              │                    │            old stays verified
                              └──expire/resend────┘             until the new one lands
```

**The old identifier is not removed until the new one is verified** (§14).
Removing it first creates a window in which the account has no verified
identifier and therefore no recovery path — which is how an account becomes
unrecoverable through an ordinary change of phone number.

## Not yet implemented

- OTP expiry, single-use and attempt limits for **mobile** (§11). Firebase Phone
  Auth provides these; nothing in this backend duplicates or overrides them.
- Identifier linking and change flows (§13, §14).
- `AUTH_*` error codes (§22) are defined in
  `SERVANA_PROVIDER_ERROR_CODES.md` but not yet emitted by the auth routes.
