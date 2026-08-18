# Reassignment visibility — measurement and threat model

**Read-only. No production queries, no behaviour changed, nothing pushed.**
Current behaviour is pinned by `tests/reassignment-visibility-current.test.ts`.

---

## 1. Headline: the contract is mostly already implemented

The privacy-first model — old provider out, new provider in without inheriting
the transcript — is **already the behaviour**. What follows is therefore mostly
verification, one real leak, and the guards needed to make the design hold.

| Requirement | Today |
|---|---|
| Old provider loses live access | ✅ `left_at` set, `can_send=FALSE`, `can_read=FALSE` by default |
| Old provider evicted from realtime | ✅ leaves the room, gets `conversation:access-revoked` |
| Old provider stops being notified | ✅ departed uids subtracted from recipients |
| New provider sees booking facts | ✅ via the `worker_uid` pointer |
| New provider does NOT inherit prior messages | ✅ reads floored at their `joined_at` |
| Customer keeps full history | ✅ untouched |
| Admin keeps full history | ✅ `visibleAfter = null` for admin |
| Handover system event posted | ✅ *"The assigned provider has changed…"* |
| Reason for removal withheld | ✅ the message says nothing about why |
| Historical evidence preserved | ✅ filtering, never deletion |

`retainRead` exists as an opt-in and defaults to **false**, with a source
comment stating that flipping it is a deliberate widening and must be a policy
decision rather than a side effect. That is the right default and the right
framing.

---

## 2. The leak, and it is a fail-open

**Authorization and windowing come from different sources.**

```
access to the conversation   ← booking_workers   (is this provider on the job?)
the message floor            ← chat_participants (when did they join?)
```

`visibleAfter = participant?.joined_at ?? null`, and a null floor means *no
floor*. So a provider authorized by `booking_workers` who has **no
`chat_participants` row** reads the entire transcript — including every message
the previous provider exchanged with the customer.

### How the row goes missing

`handleProviderReassignment` runs in a detached async IIFE with its own catch:

```ts
(async () => {
  try { await handleProviderReassignment(bookingId, from, to); }
  catch (err) { console.error('[reassign] chat membership update failed', bookingId, err); }
})();
```

The reasoning is explicit in the source — chat must not fail a committed
reassignment. That is correct for a **notification** (§45). It is wrong for
**authorization**, and the two have been treated the same.

If it throws, all of this is true at once and nothing retries:

- the old provider keeps `can_read` **and** `can_send`;
- the new provider has no participant row;
- the only trace is a console line;
- the reassignment is committed.

### The compounded scenario

```
1. ADMIN_REASSIGN commits:  A → DECLINED,  B → ASSIGNED
2. handleProviderReassignment throws (schema bootstrap, transient DB error)
3. A keeps can_read/can_send;  B has no chat_participants row
4. B calls GET /conversations/:id/messages — authorized via booking_workers
5. visibleAfter = null  →  B reads A's entire conversation with the customer
```

Both halves of the privacy model fail in the same instant, in the same
direction: **towards more access**.

---

## 3. Threat model

| # | Actor | Capability today | Severity |
|---|---|---|---|
| T1 | New provider B | Reads A's full transcript when the membership update failed | **High** — customer-authored private content to an unintended provider |
| T2 | Departed provider A | Retains read+send when the update failed | **High** — can still message the customer about a job they no longer hold |
| T3 | New provider B | Sees booking-level facts (price, schedule, completion times) from before the handover | Medium — product question, see §4 |
| T4 | Departed provider A | Loses read access to a job they actually performed | Low, but a fairness/dispute problem: A cannot evidence their own work |
| T5 | Any provider | Attachment addressed directly, bypassing the floor | **Not reachable** — attachments hydrate only from already-windowed rows, and no `attachments/:attachmentId` route exists |
| T6 | Departed provider A | Realtime socket keeps delivering | **Not reachable** — evicted synchronously with the membership change |

T1 and T2 share a single root cause. Fixing the fail-open closes both.

---

## 4. The one genuine product question

Not a defect, needs a decision: **should the new provider see booking facts
predating the handover, and should the old provider retain read-only access to
the job they worked?**

Provider reads key on `bookings.worker_uid` — the *current* pointer — so today
the answer is "yes" and "no" respectively. The stated contract says the new
provider "sees the booking facts required to perform the job", which the
pointer model satisfies, but it is broader than strictly required: it includes
the pre-handover price and timeline.

T4 is the sharper edge. A provider who worked a job for two hours before being
reassigned away can no longer see it, which matters when they are disputing pay
or a rating. `retainRead: true` exists for exactly this and is currently unused.

---

## 5. Enforceable contract options

### Option A — derive the floor from the assignment, not the participant row
Compute `visibleAfter` from `booking_workers.assigned_at` for the acting
provider, falling back to the participant row. Authorization and windowing then
come from the **same source**, so they cannot disagree.

*Closes T1 completely, including when the membership update failed. Does not
close T2.*

### Option B — fail closed on a missing participant row
A non-admin with no participant row gets **no messages** rather than all of
them.

*Closes T1. Risks hiding a conversation from a legitimately-admitted provider
whose row was never created — turning a privacy bug into an availability bug.
Safer combined with A, which supplies a floor rather than a refusal.*

### Option C — make membership part of the transaction
Move the participant update inside `ADMIN_REASSIGN` so it commits or rolls back
with the assignment.

*Closes T1 and T2 at the root. Costs: chat schema bootstrap inside the booking
transaction, and a chat failure would now refuse a reassignment an admin has
requested — the exact coupling the fire-and-forget was avoiding.*

### Option D — reconcile asynchronously
Keep it out of the transaction, but make failure durable: a retry queue or a
periodic reconciler that re-derives participants from `booking_workers`.

*Closes T1 and T2 eventually rather than immediately. Leaves a window whose
length is the reconciler's period.*

**Recommendation: A + D.** A makes the leak unreachable regardless of whether
the membership update ran, because the floor stops depending on it. D repairs
`can_read`/`can_send` for the departed provider without putting chat inside the
booking transaction. B is a reasonable belt-and-braces addition once A supplies
the floor. C is the most correct in principle and the most likely to cause an
outage in practice — a reassignment refused because a chat table was slow is a
worse day than a stale participant row.

---

## 6. Migration and backfill implications

- **No schema change** is required for A. `booking_workers.assigned_at` already
  exists and is populated.
- **No backfill of messages.** Filtering, never deletion — historical evidence
  stays intact for customer, admin and support, which is both the stated
  requirement and what any dispute needs.
- **Existing rows may be inconsistent already.** Any reassignment whose
  membership update failed since the feature shipped has left a stale
  participant row. A reconciler (D) would fix those on first pass; A makes them
  harmless for reads immediately.
- **`retainRead` is currently unused.** If T4 is decided in the provider's
  favour, that is the switch, and it needs no new mechanism.
- **Watch the `COMPLETED` case.** `ACTIVE_WORKER_STATUSES` includes
  `COMPLETED`, so a provider who finished a job stays an active chat member. If
  the floor moves to `assigned_at` (A), that behaviour is unchanged — worth
  stating so it is not mistaken for a regression.

---

## 7. Minimum guards, whichever option is taken

1. **Authorization and windowing must share a source.** A test asserting the
   floor is derived from the same table that grants access.
2. **No null floor for a non-admin.** Assert that only the admin branch can
   produce an unbounded read.
3. **Membership failure must be observable.** A `console.error` is not
   observability; failure needs a counter or an alertable event, or T2 persists
   silently until a customer reports it.
4. **`retainRead` stays opt-in.** A test pinning the default to false, so
   widening stays a decision.
5. **The handover message stays reason-free.** Already asserted.
6. **Realtime eviction stays synchronous** with the membership change.

---

## 8. Status

```
MEASURED            yes — current behaviour pinned by 14 tests
CONTRACT CHANGED    no  — nothing implemented, per instruction
LEAK FOUND          T1/T2, one shared root cause: the fail-open
DECISION NEEDED     §4 (booking-fact visibility, T4) and §5 (option choice)
```
