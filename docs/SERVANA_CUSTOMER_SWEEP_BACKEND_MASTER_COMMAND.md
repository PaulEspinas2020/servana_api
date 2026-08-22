# SERVANA CUSTOMER APP — BACKEND WORK ORDER FROM THE 2026-08-23 SWEEP

| | |
| --- | --- |
| **For** | the backend developer on `servana_api` |
| **Repository** | `servana_api` — github.com/PaulEspinas2020/servana_api |
| **Issued** | 2026-08-23 |
| **Measured against** | `origin/main` at `0d5c735` · client `ServanaClientAPP` at `95b7e52` |
| **Source** | a SWEEP + STITCH + LEAK + REPEAT + TEST pass over the customer mobile app |
| **Companion** | `SERVANA_CLIENT_APP_BACKEND_MASTER_COMMAND.md` — the 12-TAB programme. This is **additional** to it, not a replacement. |
| **Phases** | A duplication and replay (S1–S3) · B the dead ends (S4–S6) · C closing (S7) |

---

## 0. READ THIS FIRST

The customer app was swept end to end. Everything fixable in Flutter **has been
fixed and shipped** — an account-switch data leak, a dead-end Delete Account
tile, and five administrative endpoints that had no business being in a customer
binary. What is left is this document: **seven items that only the backend can
close.**

Two of them are the same defect wearing different clothes, and that is the
thread worth pulling:

> **A fix was applied to the provider surface and not to the customer surface
> that mirrors it.** Twice.

`providerSafetyService.ts` carries a long, correct docblock explaining why a
`findOne`-then-`insertOne` cannot be idempotent under retry, and it was fixed
with an atomic upsert plus a UNIQUE index. `customerSupportService.ts` — same
operation, same lossy mobile link, same `clientIncidentId` — **still does
`findOne` then `insertOne`.** Migration `043` gave provider booking evidence a
replay key so a retried upload is not a second photo; **customer chat attachments
accept no replay key at all.**

The standing surface-parity rule says provider and customer are each one product.
These two items are what it looks like when that rule is not applied to a fix.

---

## 1. PRIORITY S1 — Customer safety incidents can still duplicate

**Severity: high.** This is a safety surface and the client is already doing its
half.

### What is true today

`POST /api/support/safety/incidents` (`src/routes/customerSupport.routes.ts`) →
`customerSupportService.ts`:

```
// Idempotent: same customer + clientIncidentId
const existing = await col.findOne({ uid, clientIncidentId });
if (existing) return { duplicate: true, ... };
...
await col.insertOne({ ..., clientIncidentId });
```

The customer app **already sends `clientIncidentId`** on every submission
(`servana_api_client.dart`, `submitSafetyIncident`). So the client contract is
met; the enforcement is not.

### Why the comment is wrong

The word "Idempotent" above that block is a claim, not a mechanism. Two
concurrent retries — the *normal* case on the link a person reports an incident
from — can both pass the `findOne` and both `insertOne`.

This repository already contains the definitive analysis of this exact bug, in
`providerSafetyService.ts`. It names both halves of the fix and says both are
required:

1. `findOneAndUpdate` with `$setOnInsert` and `upsert: true` — atomic for a
   single document, which collapses the ordinary sequential retry.
2. A **UNIQUE index on `(uid, clientIncidentId)`** — because a MongoDB upsert is
   only insert-once when a unique index makes the second one fail. Catch the
   duplicate-key error and return the original.

### The measurement that makes this actionable

`createIndex` appears in **exactly one file** in the whole repository:
`src/services/providerSafetyService.ts`. The provider collection got its index.
**The customer collection has none.**

### Do

1. Port the provider fix to `customerSupportService.ts` — both halves.
2. Create the UNIQUE index on the customer incidents collection.
3. Decide what a duplicate should RETURN to a customer, and write it down. The
   provider docblock notes the two callers legitimately want different answers;
   the customer app treats `{duplicate: true}` as success today, so keep that
   shape.
4. Test with two genuinely concurrent requests, not two sequential ones. A
   sequential test passes against the broken code and proves nothing.

**Certify when** two concurrent identical submissions produce exactly one
incident, proven by a test that fails against the current implementation.

---

## 2. PRIORITY S2 — Chat attachments have no replay key

**Severity: high.** Migration `043` fixed this for provider evidence three days
ago. The customer equivalent was not touched.

### What is true today

`uploadAttachment` (`src/chat/chat.controller.ts:173`) reads exactly:

```
const { file, name, conversationId } = req.body ?? {};
```

No `clientMsgId`, no `clientRequestId`, no idempotency header. A customer whose
upload commits and then times out — the ordinary case on mobile — retries, and
the retry files a **second photo** into the conversation.

The pattern is already solved next door: `sendChatMessage` carries `clientMsgId`
and the chat module understands it. Only the attachment path does not.

### Do

1. Accept a client-supplied replay key on the attachment upload, following the
   shape `043` established for booking evidence: a nullable column plus a
   **partial** unique index constraining only rows where the key is NOT NULL, so
   no legacy row is indexed for nothing.
2. Return the original attachment on a replayed key rather than an error.
3. Tell the client team the field name and whether it goes in the body or a
   header — the app cannot send it until this exists, and sending a key the
   server ignores is theatre.

**Certify when** the same upload submitted twice with one key yields one
attachment and two identical successful responses.

---

## 3. PRIORITY S3 — The rest of the customer write surface

**Severity: medium.** Measured, not guessed: **5 of 35** mutating customer
operations carry any replay key.

| Protected today | `createBooking` · `sendChatMessage` · `createSupportTicket` · `createReview` · `submitSafetyIncident`\* |
| --- | --- |

\* sends a key the server does not enforce — see S1.

**Unprotected, and a duplicate has a real consequence:**

| Operation | What a duplicate does |
| --- | --- |
| `uploadChatAttachment` | second photo in the conversation (S2) |
| `createPaymongoSession` | second payment session |
| `submitGcashProof` | second proof against one booking |
| `addSupportTicketReply` | the same reply posted twice |
| `reportChatMessage` / `reportReview` | the same report filed twice |
| `addUserAddress` | duplicate saved address |
| `getAirconQuote` | duplicate quote records |
| `editReview` | last-write-wins; lowest risk of this set |
| `cancelBooking` | usually converges, but confirm it is not an error the second time |

The remainder of the 35 — sign-in, logout, `markNotificationRead`,
`forgotPassword` and friends — are naturally idempotent or harmless, and are
**deliberately not listed**. Do not add keys to those; it is cost without
benefit.

### Do

1. Decide one mechanism for the whole customer surface and publish it: a header
   (`X-Idempotency-Key`, which `createBooking` already uses) or a body field.
   Two mechanisms is how this became inconsistent in the first place.
2. Apply it to the table above, highest-consequence first: payments, then
   attachments, then reports and replies.
3. Publish the field in the contract so the client can adopt it in one pass
   rather than one endpoint at a time.

---

## 4. PRIORITY S4 — Deletion requests are recorded and (apparently) never fulfilled

**Severity: high, and newly urgent.**

`recordDeletionRequest` / `recordDeletionRequestForUid`
(`src/services/accountDeletionService.ts:67, :95`) perform an `INSERT` into
`account_deletion_requests` with status `pending`. The docblock describes the
intended design — anonymise the identity columns, keep the financial trail,
because a hard `DELETE` throws a foreign-key violation the moment an account has
history. **A targeted search across `src/` and `scripts/` found no code that
performs that anonymisation.**

Stated precisely because it decides the work: *a request is recorded; no
fulfilment mechanism was found.* Confirm before building — an out-of-band job or
a manual runbook would change the shape, not the obligation.

### Why it is urgent now

**The customer app shipped the deletion flow on 2026-08-23.** Settings →
Privacy & Legal → Delete Account is live and calls
`POST /api/account/deletion-request/me`. Real requests will start arriving. Apple
rejected the previous submission under Guideline 5.1.1(v) and will re-check;
"recorded as pending" is not deletion.

### Do

1. **B-6 first:** query `account_deletion_requests` and establish whether any row
   has ever moved past `pending`. That answer decides everything below.
2. Implement fulfilment to the design already described in the service.
3. Define the window between request and fulfilment, write it down, and make it
   short enough to defend to a reviewer.
4. Ensure a fulfilled account cannot be signed back into, and that its tokens and
   FCM registrations are revoked.
5. Confirm the duplicate collapse still holds — `idx_adr_open_identifier` is
   UNIQUE on `(identifier)` WHERE `status = 'pending'`, which is what makes
   pressing the button twice safe. The app relies on that.

**Certify when** a request made through `/me` demonstrably results in an
anonymised account within the documented window, financial trail intact.

---

## 5. PRIORITY S5 — Customers cannot export their data; providers can

**Severity: medium.** A privacy asymmetry with no stated justification.

`POST /provider/privacy/export` exists (`src/routes/provider.routes.ts:182`,
`verifyAuth` + `requireProviderRole`). **There is no customer equivalent.**

The customer app's Settings carries a tile reading *"Export My Data — Data export
requires a backend update"*. That tile is honest and was deliberately left alone
by this sweep, because making it look live without a backend would be the same
mistake as the Delete Account dead end App Review rejected.

Apple did not cite this. It is a live obligation in several jurisdictions and it
should not be discovered the way account deletion was.

### Do

1. Decide whether customer export is in scope, and record the decision either way.
2. If yes, mirror the provider route rather than inventing a second shape.
3. Tell the client team, so the tile can be wired in the same pass.

---

## 6. PRIORITY S6 — Active sessions has no endpoint

**Severity: low.** Recorded for completeness.

The Security screen carries *"Active Sessions — Session management requires a
future backend update"*. No session-listing or session-revocation route exists.

This is a genuine dead end, but an **honest** one, and the customer can already
end the session they are holding by signing out. Left as a product decision
rather than a defect. If sessions are ever listed, revocation must come with it —
a list you cannot act on is worse than no list.

---

## 7. S7 — Carry-forward, still open

From the 2026-08-20 sweep, unchanged unless noted:

- **B1 · One service cannot be booked anywhere.** Legacy family 67 (Electrical)
  has zero `service_coverage_geo` rows and `checkCoverageGeo` returns
  `covered: !!match` — absent configuration fails **closed**. Canonical service
  180 "Wiring fuitures" is refused everywhere. That is the whole Home
  Maintenance category.
- **B2 · Massage is Metro Manila only** — family 52's single coverage row is
  25 km around (14.5547, 121.0244). Probably intended; nothing tells the customer
  before they submit.
- **B3 · MongoDB is an unlisted dependency of booking creation.** `createBooking`
  resolves the address through `getLatLonByLocationId`, which reads Mongo and
  **throws** when the document is missing. `/readyz` lists five dependencies and
  Mongo is not one, so a Mongo outage fails every booking while readiness still
  reports `ready:true`.
- **B4 · The only branch in production is a sample row.** Branch capacity is the
  only path that exercises `SLOT_UNAVAILABLE` / `SLOT_FULL`.

And from the companion command, the item that outranks everything here:

- **Sign in with Apple.** `findLinkCollision` refuses any first-sight uid whose
  email already exists, and Apple always produces a first-sight uid — so a
  customer with an existing email can never sign in with Apple. It is the
  leading explanation for the 2.1(a) rejection. See
  `SERVANA_CLIENT_APP_BACKEND_MASTER_COMMAND.md` §1.

---

## 8. WORKING RULES

1. **Additive only.** One backend serves five clients. Add fields; never rename
   or remove. Prove it by diffing captured responses.
2. **Trace the operation, not the file.** `findLinkCollision` lives in
   `accountLinkGuard.ts`, not in either file whose name suggests it. Three wrong
   conclusions in this repo have come from filename searches.
3. **Surface parity.** Before closing any item here, ask whether the mirror
   surface has the same defect. S1 and S2 are both cases where it did.
4. **Run `npm run verify` on a development machine.** The production host has
   961 MB and the suite peaks near 1.25 GB; it has aborted there twice with exit
   134. Swap does not help — it raises system memory, not the heap ceiling.
5. **A push deploys nothing.** Deployment is `scripts/deploy-prod.sh`, run by
   hand on the host, followed by `scripts/post-deploy-readiness.sh`.
6. **Five-step push, after every completed item:** sweep `origin/main` at commit
   AND tree level, test what is there, merge, re-test the merged result, push
   straight to `main`, then align `dev`.

---

## 9. ORDER OF WORK

| # | Item | Why this position |
| --- | --- | --- |
| 1 | **S4** — deletion fulfilment | The app is live and sending requests now |
| 2 | **S1** — customer incident duplicates | Safety surface; the client already sends the key |
| 3 | **S2** — attachment replay key | Solved next door; port it |
| 4 | **S3** — the rest of the write surface | Needs one published mechanism first |
| 5 | **S5** — customer export | Decide scope before building |
| 6 | **S6** — active sessions | Product decision, not a defect |

**B1 sits outside this order.** It is a configuration row, not code, and it
blocks an entire category from being booked. If it can be fixed in an afternoon,
fix it before any of the above.

---

## 10. ACCEPTANCE

- Two concurrent identical incident submissions produce one incident.
- A replayed attachment upload produces one attachment.
- A deletion request demonstrably results in an anonymised account within a
  documented window.
- Every duplication-consequential customer write in §3 either carries a replay
  key or has a written reason why it does not need one.
- Each closed item states whether the mirror provider surface was checked.

**Nothing here is closed by reasoning about it. Each item names the artefact that
proves it: a concurrent test, a captured pair of responses, or a queried row.**
