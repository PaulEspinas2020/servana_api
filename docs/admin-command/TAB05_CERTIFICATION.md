# TAB 05 — `commissionRate` has no documented unit (P1)

## Verdict

```
THE UNIT IS DOCUMENTED, AND THE ANSWER IS "FRACTION"          CERTIFIED

commissionRate                    undocumented -> FRACTION in [0, 1]
providerSharePercent              undocumented -> PERCENT in [0, 100]
ProfileCompletion.percent         undocumented -> PERCENT in [0, 100]
Rate fields stating unit + range        0 / 3  ->  3 / 3
A rate shipped without a unit                   FAILS the gate  ✔ proven

THE PORTAL'S CURRENT READING IS CORRECT. No front-end change is needed.
```

## The answer, and what settles it

`services/revenueSplit.ts`:

```ts
export const SERVANA_COMMISSION_RATE = 0.2;
export const PROVIDER_SHARE_RATE     = 0.8;
```

**The two sum to exactly 1.** That is not a convention anybody has to agree to —
it is arithmetic. Two numbers that sum to 1 are fractions; two that sum to 100
are percentages. `commissionRate` is a **fraction**.

The book offers the backend a choice: *"If it is a fraction, say so and the
portal is already correct. If it is a percentage, the portal's current reading
is wrong by a factor of 100."* It is a fraction. **The portal is already
correct, and nothing needs to land on the front end.**

## The finding the book called an edge case, and it is not

The book describes the portal's old heuristic as *"ambiguous at exactly 1 — is
that 100% or 1%?"* and treats that as a theoretical corner.

It is a **live value**. `financePolicy.splitFor`:

```ts
commissionRate: PROVIDER_ECONOMIC_MODELS[model].earnsJobShare
  ? SERVANA_COMMISSION_RATE   // 0.2
  : 1                         // INTERNAL_FIXER
```

Every `INTERNAL_FIXER` booking carries `commissionRate: 1`, because such a
provider earns no job share and Servana retains the whole gross. So the API
really does emit the one value a magnitude heuristic cannot read.

Read as a fraction, `1` is 100% — which is exactly what an internal fixer means.
Read by magnitude, it is unanswerable. The contract now names this value and
what it means, so nobody rediscovers it. Asserted:

```
splitFor('INTERNAL_FIXER', 1000)
  -> commissionRate 1, providerPayable 0, servanaRevenue 1000
```

## The bigger hazard the book could not see

The same API carries a **second representation of the same split**, in the
opposite unit:

| Field | Unit | Range |
| --- | --- | --- |
| `BookingPayment.servana.commissionRate` | FRACTION | 0 – 1 |
| `ProviderEarningsTransactions.items.providerSharePercent` | PERCENT | 0 – 100 |

One split, two representations, a hundredfold apart, and **neither name said
which was which**. `providerSharePercent` was declared as a bare integer whose
whole description read "0 for an INTERNAL_FIXER." — nothing about percent,
nothing about range.

**This has already gone wrong in a shipped client.** `providerController`
records it in its own comment: Provider Web held its own constant named
`PROVIDER_SHARE_PERCENT` containing a **fraction**, against a backend constant
of the same name holding **eighty**.

The book warns the portal's reading *could* be wrong by a factor of 100. A
client already was.

Both fields now state their unit, their range, and each other — a reader of one
is told the other exists and differs.

## An existing gate caught this work, and was right to

`tests/revenue-split.test.ts` forbids any live source file from hardcoding the
rate, so it has exactly one definition. The first draft of the
`providerSharePercent` description **quoted the Provider Web bug verbatim**,
numeral included — and the detector flagged it.

It could not distinguish a cautionary example from a live hardcode, and it
should not try to: a detector that learns to ignore a numeral inside a string is
a detector that ignores the next real one. The description was rewritten in
words instead, and the gate went green without being weakened.

## What this TAB did NOT need to do

**Nothing was changed about the rate itself.** The value, the split, the
arithmetic and the constants are all correct and already have one definition.
This TAB is documentation plus a gate, which is what the book asked for.

**The front end needs no coordinated change.** The book's second branch — *"the
portal's current reading is wrong by a factor of 100 and must be corrected in
the same change"* — does not apply.

## The gate

`tests/rate-units.test.ts`, 11 assertions:

- the two constants sum to exactly 1, and each is ≤ 1
- `PROVIDER_SHARE_PERCENT === Math.round(PROVIDER_SHARE_RATE * 100)` — the two
  representations may coexist but may not disagree
- `commissionRate` is the commission fraction for an external provider and
  exactly `1` for an internal fixer, and never leaves `[0, 1]`
- the split always adds back to the gross, across both models and four grosses
  including `0.07`
- every rate-shaped field in the contract has an explicit `minimum` and `maximum`
- every rate-shaped field says **FRACTION** or **PERCENT** in words, because the
  name cannot be trusted to — `PROVIDER_SHARE_PERCENT` held a fraction in a client
- the detector finds the three real fields, so it cannot pass on zero matches

## Negative control

```
Remove minimum/maximum from providerSharePercent
  -> 2 tests fail: "gives every rate field an explicit minimum and maximum"
                   "declares providerSharePercent as a percent bounded by a hundred"
Restore -> 11 passed, 11 total
```

## Acceptance, against the book's own criteria

| Book's criterion | Status |
| --- | --- |
| Document the unit in the OpenAPI schema | ✅ FRACTION, stated — the portal is therefore already correct |
| Tell the front end if it is a percentage so it lands together | ✅ not needed; no front-end change follows |
| Give the field a range (`0 ≤ rate ≤ 1`) | ✅ `minimum: 0, maximum: 1`, so the portal's out-of-range marker is now a contract violation rather than a guess |
| Closes with TAB 02 — schema the `servana` object | ✅ done in TAB 02; the field is generated, bound and type-checked |

---
Servana Backend — Admin API Master Command · TAB 05
