# TAB 04 — Declare the unit of every money field (P1)

## Verdict

```
UNIT AND CURRENCY DECLARED PER FIELD           CERTIFIED_WITH_TWIN_BACKLOG

Money fields stating unit + currency        0 / 35  ->  35 / 35
Canonical money representations             none    ->  3, each naming its unit
Minor-unit twins on the admin payment seat  3       ->  8
A money field shipped without a unit                FAILS the gate  ✔ proven
```

## The book's premise, corrected

The book explains the string case as a driver property:

> Its formatter accepts `number | string`, because `numeric(12,2)` reaches some
> clients as a string through some drivers and **the portal cannot know which
> fields do**.

Measured from this side it is neither a driver property nor unknowable.

`src/db/dbQuery.ts` registers type parsers for OIDs 1114, 1184 and 1082 —
timestamps and dates. It registers **nothing for 1700, `numeric`**. So
node-postgres returns every numeric column as a **string**: always,
deterministically, on every machine, for every driver version.

What decides the wire type is whether a **mapper** coerced it:

```
financePolicy.toCentavos      Number(v ?? 0), rounded to 2dp
catalogPublicService.money    v == null ? null : Number(v)
```

Every canonical v1 finance and catalog response passes through one of those, so
it carries a real `number`. The responses that return a **raw database row** —
`AdminBookingRow`, `AdditionalWorkRequest_Row` — have no mapper and carry the
driver's string.

So it *is* a per-field fact, and the contract can state it. **A client does not
need `number | string` everywhere. It needs it exactly where `MoneyRaw` says.**

## Three representations, declared once

| Schema | Type | What it means |
| --- | --- | --- |
| `MoneyMajor` | `number \| null` | PHP pesos, 2dp. Passed through a coercing mapper. |
| `MoneyMinor` | `integer \| null` | PHP centavos. The representation to compute with. |
| `MoneyRaw` | `number \| string \| null` | Uncoerced. A **string** whenever the column is non-null. |

Three schemas rather than one sentence repeated forty times: a field that
references one of these cannot disagree with the others about what a peso is,
and a field added tomorrow has to choose.

## Ask 1 and ask 3, done in the generator

`buildOpenApiDocument` now appends the unit and currency to every money field's
description — **35 of 35**, from 0. Stamped by the generator for the same reason
the UTC rule is: forty copies of a sentence is forty chances to disagree.

**What counts as money is decided by name, narrowed by type, then narrowed by an
explicit exclusion list** — and each exclusion states why, because a silent one
is how a real amount ends up undocumented:

```
refundReviewId       a key into finance_refund_reviews, not an amount
payoutWindowHours    a duration in hours
payoutStatus         an enum
basePriceSummary     pre-rendered display text, already carrying its own ₱
commissionRate       a FRACTION of gross, not an amount — TAB 05 governs it
```

`commissionRate` is the exclusion that matters. Stamping it "PHP MAJOR units"
would be a confidently wrong statement about the single field TAB 05 exists to
disambiguate, and a test asserts it is *not* stamped.

**The same singleton hazard as TAB 03, guarded and pinned.** `SCHEMAS` is
module-level, so the builder deep-clones before stamping; otherwise the second
call in a process appends the sentence again, and `npm run verify` calls it
twice in one process.

## Ask 2 — minor-unit twins, on the seat that needs them most

The book: *"Provide a minor-unit twin for every money field … That is the change
that lets the portal delete its float path entirely."*

Three existed. The **admin seat** now carries eight:

```
BookingPayment.breakdown.grossMinor              (existed)
BookingPayment.breakdown.basePriceMinor          NEW
BookingPayment.breakdown.additionalWorkMinor     NEW
BookingPayment.refund.refundableMinor            (existed)
BookingPayment.refund.refundedAmountMinor        NEW
BookingPayment.earning.payableMinor              (existed, provider seat)
BookingPayment.provider.payableMinor             NEW
BookingPayment.servana.revenueMinor              NEW
```

Chosen deliberately: this is the seat that reads the reconciliation screen,
which is exactly where a float number of pesos surfaces its drift — small, real,
and extremely expensive to explain.

**Purely additive.** No existing field changed name, type or value, so a client
still reading the float path is unaffected. Asserted, not assumed: a test checks
`gross` is still `1234.57` and `commissionRate` still `0.2` after the change.

Also asserted at **runtime**, not only in the contract — a schema that declares
`payableMinor` while the projection does not emit it is a contract that lies,
and TAB 02 is the whole argument for why that matters. The fixture uses awkward
decimals (`.07`, `.01`) precisely where float drift shows, and pins exact
centavo values so a rounding change is visible:

```
basePriceMinor      100007
refundedAmountMinor  10001
```

The per-actor projection was checked for widening too: `servana` and `provider`
remain **absent** from the provider seat.

## What is deliberately NOT done

**Twins for the remaining ~20 major-unit fields.** `ProviderEarningsSummary`,
`FinanceReconciliation.totals` and the catalog prices still carry only a major
unit. Each needs its own service touched and its own runtime assertion, and
landing them blind is how an additive change becomes a regression. The unit and
currency are now *declared* on every one of them, which is the part that lets a
client stop guessing; the twin is the part that lets it stop computing in
floats. Ratcheted rather than promised.

**Nothing was renamed or retyped.** `AdminBookingRow.quotedPrice` stays
`MoneyRaw` — a string on the wire — rather than being coerced. Coercing it is a
behaviour change to a live response and belongs in a change somebody can review,
not in a unit-declaration pass.

## Negative control

```
Disable the money stamp in buildOpenApiDocument
  → "leaves no money field without its unit and currency" fails
Restore → 16 passed, 16 total
```

## Deliverables

| File | What changed |
| --- | --- |
| `src/api/v1/openapi.ts` | `MoneyMajor`/`MoneyMinor`/`MoneyRaw`; `stateTheMoneyRule` stamps all 35; 5 twins declared |
| `src/services/finance/bookingPaymentService.ts` | Admin projection emits 5 new minor twins |
| `tests/money-units.test.ts` | 16 assertions: declarations, exclusions, idempotence, runtime twins, additivity |

## Acceptance, against the book's own criteria

| Book's criterion | Status |
| --- | --- |
| Every money field declares its JSON type and its unit | ✅ 35 / 35, and the type is now a stated fact rather than a driver guess |
| A minor-unit representation exists for every amount an operator sees | ⚠️ 8 on the admin payment seat; earnings and reconciliation totals ratcheted |
| Name the currency in the schema | ✅ on every money field, and `CURRENCY === 'PHP'` asserted against the contract enum |

---
Servana Backend — Admin API Master Command · TAB 04
