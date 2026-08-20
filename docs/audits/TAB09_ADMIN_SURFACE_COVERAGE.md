# TAB 09 — thirteen admin capabilities with no way in

> **Closes F-12 (P2) for the backend half.** Implemented 2026-08-18 against
> `servana_api` at `4335378`.

---

## 1. All thirteen re-measured, none taken on trust

Every route the book enumerated was checked against the current tree. All
thirteen still exist. Three had moved paths since the book was written and were
found under their real signatures rather than reported missing:

| Book path | Actual |
| --- | --- |
| `…/attachments/:attachmentId/preview` | `/api/admin/support/cases/:caseId/attachments/:attachmentId/preview` |
| `…/eligibility-preview` | `/api/admin/providers/:uid/eligibility-preview` |
| `…/evaluate-booking` | `/api/admin/provider-availability/evaluate-booking` |

## 2. The classification, with a reason each

The book's central warning is that these are **two defect classes needing
opposite fixes**, and that building a UI for a duplicate entrenches it
permanently. The manifest records which is which.

| Disposition | Count | Routes |
| --- | --- | --- |
| **CONVERGE** | 6 | the four disbursement routes, `provider/reconciliation`, `workers/:uid/archive` |
| **BUILD** | 5 | three support-case routes, `eligibility-preview`, `evaluate-booking` |
| **RETIRE** (proposal) | 1 | `provider-catalog/offerings` |
| **KEEP** | 1 | `support/cases/sla-sweep` — resolved here, see §3 |

Two of the CONVERGE entries are worth calling out because they are the same
defect this book has now found three times:

- **`PATCH /api/admin/workers/:uid/archive`** duplicates
  `/api/admin/users/:uid/archive`, which the portal calls and which demands
  `users.archive`. The duplicate demands **no named permission at all** beyond
  role 1. So the redundant surface is also the weaker door — structurally F-01
  and F-11 again.
- **`GET /api/admin/provider/reconciliation`** overlaps the v1 reconciliation
  endpoint the portal *does* call, which is permissioned and on the contract.

## 3. The SLA sweep: a cron, and the reasoning is in what it does

`POST /api/admin/support/cases/sla-sweep` had a permission, no caller and **no
schedule**. The book asks whether it is a cron or a button. It is a cron:

1. **An SLA breach is created by the passage of time.** Nothing an operator does
   causes it and nothing they do reveals it. A control that only fires when
   somebody remembers to press it is not an SLA control, it is a report.
2. **The sweep writes a provider-visible event** — *"Review target delayed"*.
   That is a commitment to the provider about their own case. Delivering it when
   an admin happens to click means the provider learns of the delay at a moment
   unrelated to the delay.
3. **It raises priority NORMAL → HIGH**, which is how a breached case reaches
   the top of a queue. Left unswept, the case that most needs attention is the
   one least likely to get it.

Added as `support-sla-sweep`, every 15 minutes, **through the same
`withJobLease` every other job uses** so two replicas cannot double-sweep.

**Duplicate-safe by construction, not by luck:** the UPDATE carries
`AND escalation_state <> 'SLA_BREACHED'` and only RETURNS rows it actually
moved, so the event insert and the realtime emit are driven by the transition
rather than by the query. A second pass writes nothing. That is what makes it
safe to schedule *and* safe to trigger manually at the same moment.

The manual route **stays**. It is permissioned and genuinely useful after an
incident. Scheduled by default, triggerable on demand, one function either way
(§9). The cron passes `SLA_SWEEP_SYSTEM_ACTOR` rather than an admin uid — the
event row already records `actor_type: 'SYSTEM'`, and naming the job means an
operator reading a case timeline can tell a sweep from a person.

## 4. What stops the list regrowing

`tests/admin-surface-coverage.test.ts` (61 assertions) enforces:

- every classification names a route that **still exists** — a disposition that
  outlives its route is a decision about nothing, and it makes the list look
  longer than the problem;
- every one of the book's thirteen is still present **and classified** — none
  left undecided, the TAB's first acceptance criterion;
- every `CONVERGE` **names the surface that survives** — "converge" without
  saying onto what is two surfaces and an opinion;
- every `RETIRE` reads as a **proposal pending telemetry**;
- reasons are substantive, not labels;
- the SLA sweep is scheduled, leased, and states its duplicate effect.

**Mutation-verified:** dropping a classification fails 1; renaming the scheduled
job fails 2.

## 5. What this deliberately does NOT claim

**"Unreachable from the portal" is not "deletable".** The portal is one of six
consumers and the other five are not on this machine. Every `RETIRE` here is a
**proposal** that legacy telemetry must confirm. The manifest records a decision
and its reason; only telemetry records the fact.

The book's coverage assertion is two-directional — every admin route has a
portal caller, *and* every portal call resolves to a live route. The second half
needs `servana_adminportal`. It is a manual task, not a silent omission.

## 6. Gates

```
tests/admin-surface-coverage.test.ts    61 tests
tests/scheduler-job-lease.test.ts       14 tests (job count 6 → 7, declared)
```

### 6.1 The full suite is RED, and not from this work

`npm run test:ci` reports **8 failures**, every one of them named *"claims no
migrated client"* / *"no client has migrated"*. They are caused by an
**uncommitted change to `src/api/v1/contract.ts` made by a second workstream
running in this repository**, which flips `providerWeb` callers from `'legacy'`
to `'migrated'`:

```
-    callers: { …, providerWeb: 'legacy', … }
+    callers: { …, providerWeb: 'migrated', … }
```

Those tests exist to assert that no client has migrated. That workstream's
change makes the claim false, and its own commit will carry the updated
assertions.

Stated rather than worked around. The one failure that **was** mine —
`scheduler-job-lease` declaring six jobs when there are now seven — is fixed
here, and that ratchet firing is the correct behaviour: a job that runs on
production without anybody asking has to appear in a diff.

## 7. What could NOT be done here

| Book step | State | Why |
| --- | --- | --- |
| Build the support-case workflow UI | **NOT DONE** | `NO-REPO` — portal. Manual task 09.1. |
| Confirm each RETIRE with telemetry showing zero traffic | **NOT DONE** | `PROD-ACCESS`. Manual task 09.2. |
| Extend `smoke:admin` with the portal-side coverage assertion | **NOT DONE** | `NO-REPO`. Manual task 09.3. |
| Execute the CONVERGE deletions | **NOT DONE** | Deliberate: a deletion needs the telemetry above first, and the deprecation headers are blocked on TAB 06 wave 3. Manual task 09.4. |
