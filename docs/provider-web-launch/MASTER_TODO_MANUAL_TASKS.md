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
