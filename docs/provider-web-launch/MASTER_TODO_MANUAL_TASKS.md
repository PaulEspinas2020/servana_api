# MASTER TODO — MANUAL TASKS ONLY

Items on this list **cannot be completed by the autonomous TAB work**. Each one
needs a human with an access, a credential, or an authority that the programme
boundary deliberately withholds: no push, no merge, no deploy, no production
mutation, no credential change.

Nothing here is a code task. Anything that *could* be done locally has been done
locally and is not listed.

Status legend: `OPEN` · `BLOCKING LAUNCH` · `DONE`

---

## From TAB 01 — deploy pipeline

| # | Task | Why it is manual | Status |
|---|---|---|---|
| M-01 | **Push `fca1ed1` + `0aaf89f` to `main`** and confirm `release-gate` goes green in CI. | A push to `main` is a production deploy in this repository. The fix is verified locally by running the exact command the gate runs (`npm run verify`, exit 0, 276 suites / 5,935 tests) but CI cannot be observed green without the push. | OPEN — BLOCKING LAUNCH |
| M-02 | **Confirm three consecutive green deploys** without a memory flag change (TAB 01 acceptance 4). | Requires three pushes. | OPEN |
| M-03 | **Wire deploy-outcome alerting to a channel a human reads** — both repositories. Needs a webhook URL and a *named* recipient. | Needs a credential and an owner. An alert with no named human is not an alert. **This is the single change that would have caught the six-day stall on the day it began.** | OPEN — BLOCKING LAUNCH |
| M-04 | **Take a database backup before the first deploy** that carries the undeployed commits. | Production data operation. | OPEN |
| M-05 | Decide and record whether migration **037** (drops 39 constraints) is authorised, per-deploy, with a backup. Never as a standing `SERVANA_APPLY_DESTRUCTIVE`. | Destructive production migration; requires an explicit human decision. | OPEN |
| M-06 | **Fix or remove `fresh-db.yml`** — failing on every recent push (run 32120080957 at `d4b0150`). | Owned by TAB 16, but a permanently red check trains everyone to ignore red checks, which is exactly how release-gate stayed red for four runs unnoticed. | OPEN |

## Access the programme is blocked on

| # | Task | Why it is manual | Status |
|---|---|---|---|
| ~~M-07~~ | ~~**Supply the provider portal repository.**~~ `PaulEspinas2020/servana_service-provider` returns **404** from the GitHub API and is not on this machine. Need the correct URL, or a local clone. | Eleven TABs are owned by ServanaWorkerWeb and cannot start without it: **03, 05, 07, 08, 09, 10, 12, 13, 14, 15, 18, 19**. `/Users/user/ServanaClientAPP` is `Upupapp/ServanaClientAPP` — a different repository, not a substitute. | **DONE 2026-08-18** — repo is PRIVATE (hence the API 404); cloned to `/Users/user/ServanaWorkerWeb` @ `e57259d` |
| M-08 | **Provision a dedicated production provider account** for certification, isolated from real customer bookings, with a documented reset procedure (TAB 12 mandate 1). Provide credentials or a token. | Needs a real account and production credentials. Without it the authenticated half of every smoke — 26 provider-scoped v1 endpoints — cannot be exercised. | OPEN — BLOCKING TAB 02 (partial) + TAB 12 |
| M-09 | Confirm whether these repositories should be **public**. `servana_api` is public today. | Owner decision. | OPEN |

---

## How to use this file

Add a row when a TAB reaches an item it cannot close from this machine. Do not
add code work here — if it can be done locally, it gets done locally instead.
Each row names the *blocking authority*, not just the task, so the right person
can pick it up without re-deriving why it is stuck.

## From TAB 05 — auth migration (added 2026-08-18)

| # | Task | Why it is manual | Status |
|---|---|---|---|
| M-10 | **Certify the migrated logout against production** — sign in, sign out, confirm the session is revoked and `POST /api/v1/auth/logout` answers 200 with `{sessionsRevoked, pushCleared}`. | Needs a real provider account (M-08) and a deploy. The migration is verified locally (5,793 tests) and by reading both handlers; it is not verified against the running server. | OPEN |
| M-11 | **The remaining eight auth routes cannot be migrated responsibly yet**: forgot/reset password, resend verification (x2), verify-email-otp, register (x2), sign-in, firebase-login. TAB 05 mandate 5 requires certifying each with a REAL sign-in against production across five credential scenarios — correct credentials, wrong password, unverified email, deactivated account, and a customer credential refused at the provider portal. | None is possible without M-08. The Master Command deferred this work twice for the same reason, and migrating sign-in blind is the one change that can lock every provider out of the product. | OPEN — BLOCKED ON M-08 |
| M-12 | **Observe canonical traffic for a full day before deleting any legacy auth call site.** The guardrail is explicit that removal is a separate commit, after real traffic. | Requires a deploy and a day of production telemetry. | OPEN |

## From TAB 06 — availability and capacity (added 2026-08-18)

| # | Task | Why it is manual | Status |
|---|---|---|---|
| M-13 | **Verify `maxJobs` survives a web schedule save, with a real account on both platforms** — set a capacity on mobile, save the schedule on web, confirm the capacity is still there. This is the command's own acceptance criterion for mandate 1. | Needs a real provider account on both clients (M-08). The fix is proven locally by tests that drive the real controller, and mutation-proven; it is not proven against a live pair of devices. | OPEN |
| M-14 | **Tell the Provider Mobile team that `expectedVersion` semantics changed shape.** 0 now means "absent" rather than "enforce version 0". Mobile omits the field, so nothing breaks — but the rule is now written down and both clients should implement it deliberately rather than by accident. | Needs an owner in another repository. | OPEN |
| M-15 | **Answer the availability GRAIN question in writing before any client migration** (mandate 3). The portal's weekly shape must be mapped onto the v1 one-slot-per-day model, including what happens to a provider's already-stored availability at cutover — a silent reshape is a data migration and needs a backfill plan. | A product and data decision with a reversible-backfill requirement, not a code change. The guardrail forbids migrating availability before it is answered. | OPEN — BLOCKS TAB 06 mandates 4-5 |

## From TAB 07 — documents and notifications (added 2026-08-18)

| # | Task | Why it is manual | Status |
|---|---|---|---|
| M-16 | **Certify the document lifecycle end to end with a real provider account and a real file** — upload, list, preview, delete, re-upload. The migration is verified locally (5,793 tests) but a document upload touches private storage and a scanner, neither of which is exercised by a unit suite. | Needs M-08 and a real file. | OPEN |
| M-17 | **Confirm production's document scanner configuration before certifying upload.** `deploy.yml` falls back to the built-in scanner with a `::warning::` when no managed scanner is configured, so uploads today are scanned by the fallback. | Infrastructure configuration. TAB 17 also carries it; recorded here because the guardrail makes it a precondition for certifying upload at all. | OPEN |
| M-18 | **File the mobile document-status defect with the Provider Mobile team**, with the backend SQL as evidence: the completeness check accepts `approved` / `accepted` / `verified` and the column has **no CHECK constraint**, while mobile parses into a closed enum knowing only `verified` — so a complete document reads as unavailable and invites a re-upload. Ask the backend to either constrain the column or publish the closed vocabulary. | Another repository, another team, and a contract decision. An open varchar three clients each interpret differently is a contract gap, not a client bug. | OPEN |
| M-19 | **Resolve the shared path name between two different capabilities.** `GET /api/provider/documents` (uploaded files, with `availableActions`) and `GET /api/v1/provider/documents` (requirement checklist from a spec catalog) answer different questions through two different `listDocuments` implementations. The registry treats the second as the successor of the first, which it is not. | A contract decision spanning TAB 04's registry and TAB 08's one-path-per-truth review. Deleting either surface loses real fields. | OPEN |

## From TAB 08 — one path per truth (added 2026-08-18)

| # | Task | Why it is manual | Status |
|---|---|---|---|
| M-20 | **Decide what happens to `getCanonicalProfile()`** — it calls `GET /api/v1/provider/profile` and has zero callers anywhere, while `getProfile()` calls the legacy route and feeds the session bootstrap. Either migrate the live reader (and delete the dead method) or delete the dead method and record that profile stays legacy. | Migrating the live one changes the SESSION BOOTSTRAP path, which mandate 5 of TAB 05 says must be certified against a real sign-in. Deleting the canonical one is a decision to stay legacy, which belongs to whoever owns the migration schedule. Not a change to make silently either way. | OPEN — needs M-08 to migrate, or an owner's decision to drop |
