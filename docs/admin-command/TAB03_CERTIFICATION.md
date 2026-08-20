# TAB 03 — Guarantee a UTC designator on every timestamp (P0)

## Verdict

```
THE GUARANTEE NOW HOLDS                                   CERTIFIED

Every timestamptz reaching a client        WAS Postgres native  ->  NOW ISO 8601 Z
date-time fields stating the rule                        1 / 62 ->  62 / 62
A test that fails if it regresses                        none   ->  17 assertions
The one remaining bypass class                           detected and gated
```

## The correction this TAB begins with

TAB 02 of this programme recorded that TAB 03 was *"largely pre-closed"* because
`src/db/dbQuery.ts` routes every timestamp through `asUtcIso`, which ends in
`Date.toISOString()`.

**That was wrong.** The parser was installed. The guarantee was not delivered.

It was found the only way it could be: this suite was written to pin behaviour
believed to be correct, and **four of its cases failed on the first run**.

## The defect

`asUtcIso` decided whether a value already carried a zone with:

```js
const hasZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(value);
```

Four offset digits, minimum. **Postgres emits two.** With the session pinned to
UTC, a `timestamptz` renders as:

```
2026-08-11 11:03:23.421016+00
```

So `hasZone` was `false`. The function took the naive branch, appended `Z` to a
string that already carried an offset — `…+00Z` — which `new Date()` refuses,
and the NaN guard at the end handed back **the original string, untouched**.

Measured, not reasoned:

```
"2026-08-11 11:03:23.421016+00"     hasZone=false  => "2026-08-11 11:03:23.421016+00"
"2026-08-11 11:03:23.421016+08"     hasZone=false  => "2026-08-11 11:03:23.421016+08"
"2026-08-11 11:03:23.421016+00:00"  hasZone=true   => "2026-08-11T11:03:23.421Z"
"2026-08-11 11:03:23.421016"        hasZone=false  => "2026-08-11T11:03:23.421Z"
```

The naive branch always worked. **Only the type that actually carries a zone was
broken** — which is the harder one to notice, because it is the one that looks
like it cannot be.

Every `accepted_at`, `arrived_at`, `cancelled_at`, `confirmed_at`, `paid_at` and
`refunded_at` in this system reached clients in Postgres' native format. That is
verbatim the string the contract's one documented timestamp field promises
clients they will never receive:

> ISO 8601 with a UTC designator. Never Postgres' native
> `2026-08-11 11:03:23.421016+00`.

### Why nothing looked broken

V8 parses that form. `new Date('2026-08-11 11:03:23.421016+00')` yields the
correct instant through V8's **legacy, non-ISO** path. It is not ISO 8601 — a
space separator instead of `T`, and a bare `±hh` offset — and JavaScriptCore
does not accept it. The same booking is an Invalid Date on iOS Safari and fine
in Chrome, which is a defect that reaches a customer as "the app shows nothing"
and reaches an engineer as "cannot reproduce".

### The fix

Widen the offset **before** testing for a zone:

```js
const withT   = value.replace(' ', 'T');
const widened = withT.replace(/([+-]\d{2})$/, '$1:00');
const hasZone = /(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(widened);
```

Order matters and is commented in the source: testing first and widening after
would take the naive branch for exactly the inputs this exists to fix.

A bare `±hh` offset is valid ISO 8601 but is **not** in the ECMAScript Date Time
String grammar, which requires `±hh:mm` — so `new Date('…T…+00')` is Invalid
Date even though the string is legal ISO. That is the specific trap.

## The book's four asks

| Ask | Status |
| --- | --- |
| 1. Audit every timestamp-bearing field | ✅ 62 `format: date-time` positions enumerated from the generated document |
| 2. Make it a serialisation-level guarantee | ✅ it already was one place — and that place was broken. Now fixed and proven |
| 3. Add a test that would fail | ✅ 17 assertions, and it **did** fail — that is how the defect was found |
| 4. State the rule on every timestamp field, not one | ✅ 1 / 62 → **62 / 62** |

### Ask 4, done in the generator rather than 62 times

`buildOpenApiDocument` now appends the rule to every `format: date-time`
description. A hand-maintained copy of one sentence is a hand-maintained
opportunity for sixty-two of them to disagree; a field added tomorrow inherits
it without anybody remembering to.

`format: date` is deliberately **not** stamped. A calendar date has no zone and
must not claim one — the same reason OID 1082 is left unparsed.

**One hazard, guarded and pinned.** `SCHEMAS` is a module-level singleton, so
stamping the rule into it directly would make the second call see the sentence
the first one wrote and append it again. That is not hypothetical:
`npm run verify` runs `api:docs:check` in a process that has already imported
the module, and the document would grow a duplicated sentence per generation
with no source change to explain it. The builder deep-clones first, and a test
asserts two calls in one process produce identical output.

## The remaining bypass class, measured and gated

The type parsers key on the **column's OID**. A value that leaves Postgres as
`text` never reaches them. `to_jsonb(row) ->> 'col'` does exactly that. Run
against PGlite:

```
accepted_at                     -> 2026-08-11T03:03:23.421Z        (JS Date, parsed)
to_jsonb(bw) ->> 'accepted_at'  -> "2026-08-11T11:03:23.421016"    (string, NAIVE)
```

Eight such extractions exist in this repository — four in
`providerController.ts`, four in `bookingService.ts` — and **all eight are
safe**, because every column they name is `timestamp with time zone`, which
jsonb renders with an explicit offset, and the session zone is pinned to UTC.

That is a property of *which columns were chosen*, not of the technique. Point
the same expression at a `timestamp without time zone` column and it emits a
naive string with the gate green.

So the gate does not ban the technique. It reads `scripts/baseline/000-baseline.sql`
for each column's declared type and fails only on the combination that is
actually unsafe — and it asserts the pattern still occurs at all, so a rewrite
that changes the syntax fails loudly instead of passing on zero matches.

## What was examined and found correct

- **`to_char(start_time, 'HH24:MI')`** in `providerAvailabilityEngine` — a
  time-of-day string, not a timestamp. Correct.
- **`to_char(a.schedule AT TIME ZONE $5, 'YYYY-MM-DD')`** — a deliberate LOCAL
  date for availability windows. A local date is the right answer there and
  attaching a designator would be wrong.
- **`schedule::text::timestamptz`** casts — these cast *back* to a timestamp
  type, so the OID parser still applies.
- **`DATE_OID` left unparsed** — correct, and now asserted.

## Negative control

```
Restore the old four-digit zone guard
  → 5 tests fail, including BOTH day-boundary cases:
      "normalises an offset-bearing timestamp to Z rather than passing it through"
      "converts a non-UTC offset to the same instant in Z"
      "holds at 00:30 Manila, where Manila and UTC are on DIFFERENT DATES"
      "holds at 23:45 Manila, the other side of the same boundary"
      "is independent of the process timezone"
Restore the fix → 17 passed, 17 total
```

The two instants are pinned at 00:30 and 23:45 Manila deliberately — the hours
where Manila and UTC fall on **different dates**. A case at midday passes while
merely agreeing with the runner's clock, which is not the same as being right.

## Known limit, stated rather than hidden

Sub-millisecond precision is lost: `.421016` becomes `.421`. That is inherent to
`Date.toISOString()` and was already true for every `timestamp without time
zone` column, which took the working branch. The fix makes `timestamptz` behave
like `timestamp` rather than introducing a new loss. Nothing in this system
reasons about microseconds; if something ever does, it needs a different
representation than a JS Date.

## Deliverables

| File | What changed |
| --- | --- |
| `src/db/dbQuery.ts` | `asUtcIso` widens a two-digit offset before testing for a zone; exported so a test can prove it |
| `src/api/v1/openapi.ts` | `stateTheUtcRule` stamps the rule on all 62 timestamp fields; document deep-cloned first |
| `tests/utc-designator.test.ts` | 17 assertions: the guarantee, the OID registrations, the bypass detector, rule coverage, idempotence |

---
Servana Backend — Admin API Master Command · TAB 03
