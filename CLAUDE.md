# servana_api — agent brief

The backend. **One backend serves five clients**: customer mobile, provider
mobile, admin portal, customer web portal, provider web portal.

Read this before changing anything.

---

## The rule that governs every change here

**Additive only.** Add fields; never rename or remove one. Five clients read
these responses and you cannot see four of them from this repository. Prove
compatibility by **diffing captured responses**, not by reasoning about it.

**Trace the operation, not the file.** Three wrong conclusions in this repo have
come from filename searches. Follow route registration → controller → service,
every time. `findLinkCollision` lives in `accountLinkGuard.ts`, not in either
file whose name suggests it.

**Surface parity.** Provider and customer surfaces mirror each other. Two fixes
have already been applied to the provider side and **not** to the customer side
that mirrors it — see S1 and S2 below. Before closing an item, ask whether the
mirror surface has the same defect.

---

## Where the work is written down

| File | What it is |
| --- | --- |
| `docs/SERVANA_CUSTOMER_SWEEP_BACKEND_MASTER_COMMAND.md` | **Work order, 7 items (S1–S7)** from the 2026-08-23 customer-app sweep. Ordered by what blocks what. |
| `docs/SERVANA_CLIENT_APP_BACKEND_MASTER_COMMAND.md` | 12-TAB programme for the customer app: the Apple sign-in trace, the missing `customerMobile` manifest, deploy. |
| `docs/MASTER_TODO_MANUAL_TASKS.md` | Items that cannot be closed by writing code here. |
| `ServanaClientAPP/docs/MASTERLIST_PENDING_ITEMS_SERVANA_CLIENT_APP.md` | The client's finding register. Backend items are marked `Fix in: backend` — **SC-189 to SC-194 are yours**. |

## The items most worth knowing about

- **Sign in with Apple is broken, and it is this repository's doing.**
  `customerFirebaseLogin` → `findLinkCollision` refuses any *first-sight* uid
  whose normalised email already exists, answering 200 `{status:'failed'}` with
  no token. Apple **always** produces a first-sight uid, so any customer with an
  existing email can never sign in with Apple. It is the leading explanation for
  the App Store 2.1(a) rejection. The refusal is deliberate — it stops duplicate
  accounts — and the merge path was consciously not used because it returns a
  **custom token the shipped app cannot exchange**. The fix must link and return
  a **normal bearer token**; anything needing a new client capability helps
  nobody who has already installed the app.
- **Account deletion is recorded and apparently never fulfilled.**
  `recordDeletionRequest` only INSERTs a `pending` row. **The customer app
  shipped its deletion flow on 2026-08-23 and is sending real requests now**, and
  Apple re-checks 5.1.1(v). "Recorded as pending" is not deletion.
- **Customer safety incidents can still duplicate** (S1). `providerSafetyService`
  contains the definitive analysis of why `findOne`-then-`insertOne` is not
  idempotent and was fixed with an atomic upsert **plus a unique index**.
  `customerSupportService` still does `findOne` then `insertOne`. `createIndex`
  appears in **exactly one file in this repository** — the provider one.
- **`uploadAttachment` accepts no replay key** (S2) — `{file, name,
  conversationId}` only — so a retried customer photo files a second one.
  Migration `043` gave provider evidence exactly this protection.
- **The customer app has no client manifest**, so `contract.ts` records it as
  migrated on **zero** canonical routes while it calls 41. That blocks retirement
  of all 145 `ALIAS_TEMPORARILY` routes. Build the manifest from **referenced**
  call sites, not declared ones — the client declares 61 and uses 41.

---

## Deploy, gates, and pushing

**A push deploys nothing.** Deployment is `scripts/deploy-prod.sh`, run **by
hand, on the production host**, followed by `scripts/post-deploy-readiness.sh`.
The old `deploy.yml` was moved into that script verbatim.

**There is no CI and there must not be.** `.github/` holds **zero** files. The
Actions credit will not be topped up, ever. Do not add a workflow — the stored
PAT also lacks the `workflow` scope, so a push that creates one is rejected
outright.

**Run `npm run verify` on a development machine.** The production host has
**961 MB** of RAM; the suite runs `--runInBand` and peaks near **1.25 GB**, and
verify has aborted there twice with **exit 134** (SIGABRT). Swap does not help —
it raises system memory, not the V8 heap ceiling.

**Verifying in a detached worktree gives a FALSE failure.**
`tests/parity-registry-hazards.test.js` asserts the Angular sibling repos are
checked out *beside* the repo. Measured on one commit: **344/345 in a worktree,
345/345 in the real checkout**. Judge that suite in the real checkout before
calling a failure real.

**Pushing — all five steps, every time:** sweep `origin/main` at commit **and
tree** level → test what is upstream → merge → **re-test the merged result** →
push straight to `main`, then align `dev`. If the remote is strictly behind, say
so and fast-forward; never stage a merge with an empty other side.

**`dev` is not a fast-forward target.** It carries only "sync dev to main" merge
commits and **zero unique files**. Align it by merging `main` INTO `dev` — the
shape the last dozen commits there already use — not by force-pushing.

The pre-push hook is branch-aware: full `npm run verify` on `main`,
`verify:quick` elsewhere. Never `--no-verify`.
