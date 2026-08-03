# Auth account linking rules

**Command 5 §13, §14, §15 deliverable.**

## The rule

**One person, one account, however many identifiers.** Adding an email to a
mobile-only account, or a mobile to an email-only account, must link — never
create a second provider.

## How linking already works

`upsertFirebaseUser` keys on the **Firebase uid** and merges:

```sql
ON CONFLICT (uid) DO UPDATE SET
  email            = COALESCE(EXCLUDED.email,            user_credentials.email),
  phone_number     = COALESCE(EXCLUDED.phone_number,     user_credentials.phone_number),
  email_normalized = COALESCE(EXCLUDED.email_normalized, user_credentials.email_normalized),
  phone_normalized = COALESCE(EXCLUDED.phone_normalized, user_credentials.phone_normalized)
```

`COALESCE`, not assignment: **signing in with a phone must not erase the email
the account already links.** That already held for the raw columns; the
normalized ones follow the same rule, or the lookup key disagrees with the value
it was derived from.

`role` is deliberately **absent** from that `DO UPDATE SET`. It is written only
on INSERT. That is what stops an invited admin being demoted to provider on
their first sign-in, since `upsertFirebaseUser` defaults `role` to `"2"`.
Pinned by `tests/admin-first-session.test.ts` — adding `role` there looks like
an obvious completeness fix and would demote every admin on their next sign-in.

## Duplicate prevention

| Cause | Prevented by |
|---|---|
| Email casing | `normalizeEmail` lower-cases; unique index on `email_normalized` |
| Email whitespace | trimmed before normalization |
| `09…` vs `+639…` | `toE164PhMobile`; unique index on `phone_normalized` |
| Malformed spellings | strict normalizer **returns null** rather than inventing a distinct value |
| Same person, two Firebase accounts | **not prevented** — see below |

The last one is the honest gap. Firebase treats an email account and a phone
account as separate users with separate uids. If someone registers with email,
then later registers with phone, Firebase issues a second uid and this backend
sees two accounts. Linking them requires `linkWithCredential` on the **client**,
while the user is signed in — which is why linking is a client feature, not a
backend one.

## Conflict handling

When an identifier already belongs to another account:

1. **Do not merge automatically.** Merging decides who owns a person's bookings,
   earnings and payout history. No script has that evidence.
2. **Do not reveal the other account.** The `IDENTIFIER_CONFLICT` message names
   the *role* — which the operator needs in order to act — and nothing that
   identifies the holder.
3. **Quarantine for review.** `audit-identifier-conflicts.ts` reports them,
   redacted, and exits non-zero.

## Provider ↔ admin is refused

Granting admin access to an email that already belongs to a provider is
**refused**, not merged.

`createAdminUser` upserts `user_credentials.role = 1`. Every provider query
scopes on role, so that one statement would destroy their jobs, earnings and
history — with no warning and nothing to undo. The invite raises
`IDENTIFIER_CONFLICT` before the admin record is created.

**Confirmed as the standing rule 2026-08-03.** Dual-role staff would need a
deliberate design; it is not something to arrive at by accident.

## Not yet implemented

`POST /link-identifier` and `POST /change-identifier` (§13, §14). The rules
above are the contract they must satisfy:

- require recent authentication
- normalize, then check the identifier is not linked elsewhere
- keep the previous identifier active until the new one verifies
- audit, and notify the previously verified channel
- never create an account during linking
