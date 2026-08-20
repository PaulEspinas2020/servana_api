# TAB 11 — Closing gate: what the backend did, measured

## Verdict

```
SERVANA BACKEND — ADMIN API MASTER COMMAND

  TABs 00-10 complete                          11 of 11
  Blocking asks closed                          8 of 10
  Asks answered "already true", proven          2 of 10
  P0 defects found that the book could not see  3, all fixed
  Gate                                          328 suites, 6807 tests, exit 0

  VERDICT: CERTIFIED_WITH_NAMED_GAPS
```

Every gap is named below with what remains and why it could not be closed here.
Nothing was pushed, deployed, or run against production.

## The ledger, against the book's own closing table

| TAB | Ask | Pri | Status |
| --- | --- | --- | --- |
| 01 | Document the admin surface | P0 | ✅ **251** operations, gated. The book asked for 51 |
| 02 | Schema the empty responses | P0 | ✅ 17 → **0**, ceiling of zero |
| 03 | UTC designator on every timestamp | P0 | ✅ **a P0 defect found and fixed**; 63/63 state the rule |
| 04 | Declare money units; minor-unit twins | P1 | ✅ units 0 → 35/35 · ⚠️ twins 3 → 8, rest ratcheted |
| 05 | `commissionRate` unit | P1 | ✅ FRACTION — the portal was already right |
| 06 | `PageMeta.total` decided | P1 | ✅ number, and a latent `hasMore` bug removed with it |
| 07 | Two type divergences resolved | P1 | ✅ **the contract was the wrong side** on one; the other is two objects, now named apart |
| 08 | Serve the contract with a hash | P2 | ✅ served + digest on every response · ⚠️ needs a deploy |
| 09 | Log sink for the request id | P1 | ✅ **a P0-class defect found and fixed** · ⚠️ unaudited failures still host-only |
| 10 | Confirm the refund amount model | P2 | ✅ partial refunds are BUILT — and two ceilings disagree |

## What the book could not see from outside

Three defects, none of them in the book, all found by doing the work it asked
for.

**1. The assigned provider could read the doorstep start code.** (TAB 02)
`formatBooking` spread the whole database row and `getBookingById` selected
`b.*`, so `worker_code` — the SERVICE_START credential the customer reads out at
the door and the provider types in — travelled to the provider. The policy
module states the property in as many words: *"the RECIPIENT is the customer
even though the VERIFIER is the provider — that inversion is the entire security
property."* The proof of presence was obtainable without being present.

Found by closing an empty schema, which is the whole argument of TAB 02: nothing
could bind to `Booking`, so nothing could say what it must not contain.

**2. Every `timestamptz` reached clients in Postgres' native format.** (TAB 03)
`asUtcIso`'s zone guard required four offset digits; Postgres emits two. Every
`accepted_at`, `arrived_at`, `cancelled_at`, `paid_at` fell through and was
returned unconverted — verbatim the string the contract promises clients will
never receive. V8 parses it; JavaScriptCore does not.

Found because a suite written to pin behaviour believed correct failed four of
its cases on the first run.

**3. Every admin error reported a request id that matched no log line.**
(TAB 09) `adminError` minted a fresh `randomUUID()` over the correlation id the
middleware had already set. The log and the audit row carried the real id; the
operator was handed a different number. Across 251 admin operations. TAB 09
calls the id "a token with no lock" — on the admin tree it was a token with a
lock that could never open.

## Where the book's own figures were wrong

Stated plainly, because the book asks for measurement and these were measured.

| Book | Measured here |
| --- | --- |
| "51+ admin endpoints, a floor" | **251** — the floor was on what one client could be *seen* to call |
| 9 empty schemas / 21 positions | 8 / **17** — two had already closed |
| "`numeric` reaches some clients as a string through some drivers" | No parser is registered for OID 1700 — it is **every** driver, always. What varies is whether a **mapper** coerced it, which is knowable per field |
| "no admin money endpoint accepts an operator-entered amount" | `openRefundReview` does, and bounds it |
| `commissionRate` ambiguous "at exactly 1" as an edge case | `1` is a **live value** — every INTERNAL_FIXER booking |
| `ProviderTimeOff.id` — "one of the two sides is wrong" | The **contract** was; the portal needs no change |
| `MessageReport` — "two different objects under one name" | Correct, and neither side is wrong: two endpoints on two trees |

## Findings the backend surfaced that nobody had asked about

- **Two success envelopes on one admin surface** — 239 `{status:'success',data}`
  against 11 `{success:true,…}`, three of which do not use `data` as the payload
  key at all. A client unwrapping `body.data` reads `undefined`. (TAB 01)
- **One entity, two shapes, two routes** — the moderation list returns camelCase
  through a mapper; the PATCH on the same entity returns the raw snake_case row.
  And `listMessageReports` swallows query errors into `[]`, so an empty
  moderation queue is not evidence the queue is clear. (TAB 01)
- **Two refund ceilings that disagree** — the disclosed one is booking-level and
  includes paid additional work; the enforced one is payment-level and does not.
  Bounding a UI with the disclosed figure, as the book proposes, would let an
  operator enter a number the same system then refuses. (TAB 10)
- **Two units for one split** — `commissionRate` is a fraction and
  `providerSharePercent` a percent, and a shipped client already got it wrong by
  a hundredfold. (TAB 05)

## The gates that caught this work, and were right

Four times, an existing gate refused a change of mine. None was weakened.

```
revenue-split          a cautionary numeral inside a schema description read as
                       a hardcoded rate. Rewritten in words — a detector that
                       learns to ignore a numeral ignores the next real one.

v1-router              a bare OpenAPI document broke the "every entry answers
                       { data }" invariant across 95 endpoints. The invariant
                       won; the endpoint is enveloped.

§137 convergence       a new endpoint claimed by no capability, and a capability
                       naming a module none of its endpoints reach.

authz-negative         148 assertions turned from 403 to 0 because a helper on
                       the FAILURE path could throw. A formatter that runs while
                       building an error must not be able to fail.
```

And three of my own detectors were too narrow, each found by a negative control
rather than by review:

- a `null` check pinned to one spelling walked past `(total as number|null) === null`
- a mount-order check matched the **global** `cors` and reported a gap that did not exist
- an envelope reader counted `res.status(500).json({status:'failed'})` as a competing success shape, fabricating 37 warnings

## What is NOT closed

**1. 236 admin payload schemas are unauthored.** They publish their envelope,
guard, permission and parity status with the payload declared `UNSPECIFIED`. A
guessed schema is worse than an absent one: absent says "nobody wrote this
down", wrong says "this is the shape" and a client generates types from it. The
count is ratcheted so each one landed is permanent.

**2. ~20 money fields have no minor-unit twin.** Earnings summary,
reconciliation totals, catalog prices. Each needs its own service touched and
its own runtime assertion; landing them blind is how an additive change becomes
a regression. Their unit and currency **are** declared, which is the half that
lets a client stop guessing.

**3. A queryable sink for unaudited failures.** A 500 on a read or a timeout
exists only as a console line on PM2's stdout file — greppable with a shell, not
queryable, and it rotates. Infrastructure, not code. Audited actions **are**
queryable through the API today.

**4. The contract endpoint needs a deploy.** `smoke:contracts` should keep
printing NOT VERIFIED until production runs a build containing it. Deploying is
outside this programme's boundary.

**5. The two refund ceilings are documented, not unified.** Making them one
number decides what a refund *is* — against a booking, or a payment — with real
consequences either way, on a path where being wrong moves money.

## Verification

```
npm run verify              328 suites, 6807 tests, exit 0, 0 FAIL lines
TZ=UTC npm run test:ci      recorded in TAB11_GATE_EVIDENCE.md
TZ=America/New_York         47 timestamp/money/pagination assertions pass
```

Every gate result in this programme was read from the jest summary, never from
an exit code alone — this repository has previously reported exit 0 over a red
suite through a pipe.

Every new gate was watched failing before it was trusted. Where a negative
control passed, the detector was hardened until it failed, and that is recorded
in the TAB it happened in rather than tidied away.

## Boundary

```
Commits (local)        13, on main
Pushed                 nothing
Deployed               nothing
Production touched     nothing
Other agent's work     3 files left untouched; one stale assertion repaired in
                       its own commit, with the evidence for whose it was
```

---
Servana Backend — Admin API Master Command · TAB 11 of 11 · measured against
`servana_api@main`
