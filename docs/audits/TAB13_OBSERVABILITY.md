# TAB 13 — knowing the portal is broken before an operator says so

> Implemented 2026-08-18 against `servana_api` at `290be15`.

---

## 1. Most of this TAB was already built

Measured before writing anything. The book's own instruction for this TAB is
*"build on it, do not replace it"*, and the honest finding is that the backend
half was largely done by earlier work:

| Book requirement | State |
| --- | --- |
| Structured JSON logs — request id, actor uid, actor role, route, status, latency, outcome | **DONE** — `src/observability/requestLog.ts` |
| Never log tokens, passwords, documents, receipts (§15) | **DONE** — deny-by-default allow-list in `observabilityPolicy.ts`, asserted by `tests/observability-redaction.test.ts` (29 tests) |
| `/healthz` meaningful | **DONE** — liveness, and 503 while draining |
| A readiness probe checking real dependencies | **DONE** — `/readyz` with `readinessSnapshot()`, asserted by `tests/health-probe-parity.test.ts` |
| Request correlation end to end | **DONE** — `X-Request-Id` on every route, not only v1 |
| Metrics with bounded cardinality and a stated reason each | **DONE** — `METRICS` / `ALERTS` in `observabilityPolicy.ts` |

Reporting that as "TAB 13 complete" would have been the easy move and the wrong
one, so what follows is the one gap that was real.

## 2. The gap: the alert the book asks for had no signal to alert on

> *Alert on symptoms an operator would notice: … and — specific to this system —
> a spike in 404s on `/api/v1`, which is the signature of a portal deployed
> against a backend that has not shipped. That exact mismatch has occurred here
> before.*

An alert is a query over a signal, and **the signal did not exist**. Every 404
landed in `http_requests_total` labelled `statusClass: '4xx'`, indistinguishable
from a mistyped URL. *Nothing to alert on is not the same as nothing happening.*

### 2.1 Why a namespaced 404 is a different event

An ordinary 404 is a client asking for something that **never existed**. A 404
on `/api/v1` is a client asking for something that was **promised** — it holds a
contract naming the route, and the running build does not serve it.

Same status code, opposite operator response: **no route needs fixing; a build
needs deploying or rolling back.** Production has already produced this exact
confusion once, answering 401 to every path including unknown ones, and it
reached operators as *"the API is down"* rather than as a version mismatch.

## 3. What was added

**`contract_mismatch_total`** — a counter labelled `namespace`, `client`,
`method`:

- **`namespace`** so v1 can be separated from everything else. Without it the
  metric answers *"some 404s happened"*, which `http_requests_total` already
  said.
- **`client`** so an operator can see *which build is ahead* — the single most
  useful fact during this incident shape.
- **Legacy is excluded deliberately.** The legacy tree has 615 routes and no
  published contract, so a 404 there carries none of this meaning and would only
  add noise to the one signal that has any.

**Alert `v1-contract-mismatch`** (P1), whose `firstAction` says plainly that
this is a deploy problem and not a code problem — because the wrong first action
here costs the most time: somebody reads "404" and starts hunting a broken route
that is working perfectly.

Emitted inside the same guarded block as every other metric, so a logging bug
stays a missing line rather than becoming an outage.

**Mutation-verified:** allowing the legacy tree to fire the signal — which would
flood it with ordinary 404s until nobody trusted it — fails the gate.

## 4. Gates

```
npm run verify   PASS exit 0 — 294 suites, 6207 tests
tests/contract-mismatch-signal.test.ts   9 tests
tests/observability-redaction.test.ts   29 tests (pre-existing, re-run green)
tests/health-probe-parity.test.ts        7 tests (pre-existing, re-run green)
```

`docs/api/OBSERVABILITY_STANDARD.md` regenerates from the policy, so the metric
and its alert are documented by the same object that declares them.

## 5. What could NOT be done here

Everything remaining needs production traffic, an aggregation backend, or the
portal — none of which exist on this machine:

| Book step | State | Why |
| --- | --- | --- |
| Ship logs to something that aggregates and alerts | **NOT DONE** | The lines are structured and emitted; nothing collects them. Manual task 13.1. |
| Frontend error reporting carrying the same request id | **NOT DONE** | `NO-REPO`. Manual task 13.2. |
| **Prove correlation end to end** — trigger a portal error, take the surfaced request id, find the matching server log line | **NOT DONE** | Needs both halves running. This is the book's acceptance criterion and it is the one that proves the loop is closed. Manual task 13.3. |
| Define and measure SLOs before launch | **NOT DONE** | Needs production traffic. Setting numbers from invented fixtures would be worse than none. Manual task 13.4. |
| Wire alerts to a pager | **NOT DONE** | `ALERTS` declares five specs; nothing evaluates them. Manual task 13.5. |
| Dashboard the legacy-vs-v1 traffic split | **NOT DONE** | Needs the telemetry sink from 13.1. Manual task 13.6. |
| External uptime monitoring, including asserting TAB 02's headers stay present | **NOT DONE** | Needs an external service. Manual task 13.7. |

**The honest headline:** the backend now *emits* what an operator would need,
including the one signal specific to this system's known failure. **Nothing
consumes any of it.** Declaring a metric is not observability; it is the
precondition for it.
