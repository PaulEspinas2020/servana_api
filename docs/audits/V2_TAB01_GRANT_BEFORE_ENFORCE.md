# V2 TAB 01 — the money fixes landed, and exactly one grant stands before release

> **P0.** Verified 2026-08-19 against `origin/main` at `0492e4c`.
> Closes the local half of F-01 and F-11.

---

## 1. The V2 headline is out of date, in the good direction

The book opens with *"5 of 6 findings still live in production, 0 backend fixes
deployed"*. Re-measured in a detached worktree at `origin/main`, **all five are
now fixed on the mainline**:

| Finding | On `origin/main` |
| --- | --- |
| F-01 disbursement routes carry a named permission | **YES** |
| F-01 `payouts.trigger_due_run` wired to the batch trigger | **YES** |
| F-06 `helmet` present | **YES** |
| F-07 admin rate limiting mounted | **YES** |
| F-11 v1 refund money-path removed | **YES** |

**Landed is not released.** The tip carries `[skip ci]`, so `deploy.yml` has not
run; production still serves the pre-fix build. Releasing is a deliberate
`workflow_dispatch`, which is the correct separation.

### 1.1 A measurement trap worth recording

The first pass reported F-11 as **STILL PRESENT**, because `grep -c forceRefund`
matched the docblock that *explains the removal*. Stripping comments first:

```
mentions of forceRefund in PROSE : 1
calls to forceRefund in CODE     : 0
imports refund.service in CODE   : False
admin branch                     : if (input.actor === 'customer' || input.actor === 'admin')
```

Same class as the TAB 02 checker that flagged the HTML comment documenting a
deleted `<script>` tag. **A file that explains a removal contains the thing it
removed**, and any grep-based verification of a deletion has to account for that
or it will report the fix as absent.

## 2. Grant before you enforce — the list, derived rather than guessed

Computed by diffing the permission demanded per route between `d4b0150` (the
last pre-fix production commit) and `origin/main`:

```
routes demanding a permission —  before: 158   after: 162
```

**Four routes newly demand a permission, all four previously unguarded:**

| Permission | Route | New to the estate? |
| --- | --- | --- |
| `payouts.view` | `GET /admin/disbursements` | no — already demanded by `/admin/finance/payouts` |
| `payouts.details.view` | `GET /admin/disbursements/booking/:bookingId` | no — already demanded by the finance detail route |
| `payouts.retry_failed` | `POST /admin/disbursements/:id/retry` | no — already demanded by the finance retry route |
| **`payouts.trigger_due_run`** | **`POST /admin/disbursements/trigger`** | **YES — zero routes demanded it at `d4b0150`** |

### 2.1 So the provisioning task is one line, not four

Three of the four are already in use on the finance payout surface, which means
**anyone who can operate the finance payout screens today already holds them**.
Enforcing them on the disbursement twin takes nothing away from anybody.

`payouts.trigger_due_run` is different: it has existed in the catalogue —
`action_type: 'system'`, `risk_level: 'critical'`, `is_dangerous: true` — and
**no route has ever consulted it**, so nobody has ever needed to hold it.

> **Before releasing: grant `payouts.trigger_due_run` to whoever runs the
> due-payout batch.**

### 2.2 Exposure if that is skipped

Bounded and recoverable. Only `POST /api/admin/disbursements/trigger` begins
refusing, and only for non-super-admins — **super admins bypass
`requirePermission` entirely**, so the batch stays reachable. The scheduler is
unaffected: it calls `processPendingDisbursements` directly on its hourly cron
and never passes through a route.

The reversal is a **grant**, never a redeploy that removes the guard.

## 3. Two behaviour changes to announce before release, not after

Neither is a defect and both surprise somebody if unannounced:

1. **Admin payout retry now QUEUES.** It sets the row `PENDING` and the hourly
   job releases it, instead of POSTing to PayMongo inside the request. That is
   already what the portal experiences, because the portal calls the finance
   surface — this converges the odd one out onto the path that honours holds and
   the `PAYOUT_MAX_RETRIES` cap.
2. **The v1 refund endpoint no longer completes a refund for an admin actor.**
   It opens a review. Operations already use `/api/admin/finance/refunds/*`, so
   no workflow changes — but nobody should learn this from a support ticket.

## 4. What remains, and who owns it

| Step | Owner | Why not here |
| --- | --- | --- |
| Grant `payouts.trigger_due_run` | operator with permission admin | production write |
| Release via `workflow_dispatch` on `deploy.yml` | owner | deliberate production release |
| Verify 403 from production for an under-permissioned admin | owner | production access |
| Confirm the audit record names the actor on one real retry | owner | production data |
| Announce the two behaviour changes to operations | owner | — |

**The acceptance criterion this TAB cannot meet locally** is the one that
matters: *no route reaches a payout or a PayMongo refund without a named
permission — **verified against production**, not against the test suite.* The
suite proves the code; only production proves the deploy.
