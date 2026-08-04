# Auth identifier migration plan

**Command 5 §16 deliverable.**

## Context

The platform is **not live to the public** and holds no real bookings. Every
step below is cheap now and expensive later — a normalization backfill against
live accounts needs a window where two spellings coexist and every reader
handles both.

## Order

### 1. Audit first — BLOCKING

```
npx ts-node scripts/audit-identifier-conflicts.ts
```

Read-only. Exits non-zero on conflict so a deploy step can gate on it.

Reports two different things, deliberately:

- **Conflicts** — two accounts sharing a normalized identifier. The unique
  indexes will **fail** until these are resolved. Each is a decision about who
  owns a person's history; resolve with evidence, through support, not by
  script.
- **Gaps** — rows whose email or phone does not parse and therefore has no
  normalized form. Not conflicts. They cannot collide with anything; they simply
  cannot be used to sign in until corrected.

### 2. Deploy the columns

`ensureIdentityColumns` adds `email_normalized`, `phone_normalized`,
`is_mobile_verified` — additive, nullable, `is_mobile_verified` defaulting
false. Non-unique lookup indexes are created first, so sign-in works before
uniqueness is enforced.

The unique indexes are attempted and, on failure, **reported with a duplicate
count and no personal data** rather than swallowed. A failure here is the audit
in step 1 having been skipped.

### 3. Backfill

Existing rows have raw values and no normalized form until they next sign in.
`upsertFirebaseUser` derives them on every write, so the population is
self-healing for active accounts — but a dormant account stays unfindable by
identifier sign-in until someone signs in with it, which they cannot do without
it being findable.

**A one-shot backfill is therefore required**, not optional. It is deterministic:
run the same `normalizeEmail` / `toE164PhMobile` used everywhere else, write
only where the result is non-null, never overwrite an existing normalized value.

Rows that do not parse stay NULL and appear in the audit as gaps.

### 4. Then, and only then

Wire sign-in to `resolveIdentifier`, and recovery after it.

## Rules

- **Never merge automatically.** Ambiguous ownership is quarantined.
- **Never delete.** A duplicate is evidence, not garbage.
- **Preserve uids.** Bookings, earnings and payouts follow the uid, not the
  identifier. Changing an email must not change an account.
- **Backfill only where deterministic.** A number that does not parse is left
  alone and reported.
- **Report redacted.** Masked identifiers, truncated uids — enough to size and
  locate the problem without publishing a list of addresses into a ticket.

## Rollback

The columns are additive and nothing reads them until sign-in is wired, so steps
2 and 3 roll back by dropping two indexes and ignoring three columns. Step 4 is
the first irreversible one, which is why it is last.
