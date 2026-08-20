# TAB 16 — Launch certification: the go/no-go

> **TERMINAL.** Depends on every preceding TAB. Issued 2026-08-18 against
> `servana_api` at `f624631`, working tree clean, 38 commits ahead of
> `origin/main` (`d4b0150`).

---

## VERDICT

### Backend (`servana_api`): **CERTIFIED_WITH_NONBLOCKING_GAPS**

Every backend TAB in the book is closed. All four backend gates pass. The gaps
that remain are environmental — production access and credentials this
environment must not hold — and each is named, owned and dated in
`docs/MASTER_TODO_MANUAL_TASKS.md`.

### Launch as a whole: **NOT_CERTIFIED**

Not a close call, and not a matter of outstanding polish. **Four TABs could not
be executed at all**, two of them P0, because `servana_adminportal` is not on
this machine. The launch gate requires every row green with evidence; four rows
have no evidence of any kind.

Most concretely: **TAB 02 is a live P0 and remains open.** The admin portal that
approves refunds and releases payouts serves **no CSP and no
`X-Frame-Options`** on any real page — they are declared under
`for = "/*.html"`, which never matches a SPA navigation. It is framable by any
origin today. Certifying a launch with that open would be certifying the
document rather than the system.

---

## 1. The launch gate

| TAB | Condition | Verdict | Evidence |
| --- | --- | --- | --- |
| 00 | Ground truth re-baselined; trees clean | ✅ **GREEN** | `docs/LAUNCH_BASELINE.md`; three gates green at a clean tree |
| 01 | No unpermissioned or unaudited path to money | ✅ **GREEN** | `tests/authz-parity.test.ts`, mutation-verified twice |
| 02 | Security headers served on `/` and deep links | ⛔ **NOT RUN** | Portal repo absent. **Live P0.** |
| 03 | A failing gate produces a skipped deploy | 🟡 **PARTIAL** | Dependency exists and is asserted by 17 tests; the *demonstrated run pair* needs a push |
| 04 | Schema workflow executes; 132 tables converge | 🟡 **PARTIAL** | Parse fault fixed, convergence asserted; the workflow has still never *run* |
| 05 | API security headers + admin rate limits live | 🟡 **PARTIAL** | Both implemented and tested over a real socket; neither observed in production |
| 06 | v1 admin domain covers waves 1–3 with permissions | 🟡 **WAVE 1 ONLY** | Wave 1 complete and permission-enforced at import; waves 2–3 deliberately not started |
| 07 | Migrated endpoints verified live; allowlist governs | ⛔ **NOT RUN** | Portal repo absent. **P0.** |
| 08 | Refund lifecycle preserves separation of duties | 🟡 **PARTIAL** | The live bypass is closed; **the lifecycle is not built** |
| 09 | All 13 orphans classified and actioned | 🟡 **CLASSIFIED** | All 13 classified with reasons and gated; actions need telemetry |
| 10 | Every permission has a negative test | 🟡 **PARTIAL** | Structural half complete (0 unexplained routes); behavioural 403 tests need a scoped identity |
| 11 | `smoke:contracts` runs and blocks deploy | 🟡 **BACKEND HALF** | Document proven generatable-from; the portal never generates from it |
| 12 | Zero high CVEs; supported Angular major | ⛔ **NOT RUN** | Portal repo absent |
| 13 | Trace correlation proven; SLOs and alerts live | 🟡 **EMITTED, NOT CONSUMED** | Signals exist including the v1-mismatch counter; nothing aggregates or alerts |
| 14 | Budgets fail the build; no INNER JOIN defects | 🟡 **BACKEND HALF** | All three defect classes audited clean and gated; budgets are portal-side |
| 15 | WCAG 2.2 AA; four workflows keyboard-only | ⛔ **NOT RUN** | Portal repo absent |

**Green: 2. Partial: 10. Not run: 4.**

## 2. Final certification commands, executed

```
npm run verify              PASS exit 0 — 295 suites, 6219 tests
npm run db:verify:embedded  PASS exit 0 — 121 restored + 8 applied = 132 tables
npm run schema:authority    PASS exit 0 — UNMANAGED 0
npm run authz:legacy        PASS exit 0 — 615 legacy routes, 0 v1 loosenings
```

Portal (`npm ci && npm run verify:release && npm run smoke:contracts`) and the
post-deploy production probes were **not run** — no repository, no production
authorisation.

## 3. What this programme actually found

Four of the findings were not in the book at the severity the code warranted.
Recording them together because they are one shape, not four incidents:

| Finding | Severity as recorded | As measured |
| --- | --- | --- |
| **F-01** `/admin/disbursements/*` | P0 | Confirmed — and the legacy retry was also **uncapped** and **synchronous**, so the weaker-guarded path was the *more powerful* one |
| **F-11** v1 refund | P1 | **P0.** `auth: 'authenticated'`, no permission, and for an admin actor it called PayMongo directly — bypassing a four-step gate whose approval step is `risk_level: critical`. **Live in production.** |
| `PATCH /admin/workers/:uid/archive` | not recorded | Duplicate of `/admin/users/:uid/archive`; demands no named permission where its twin demands `users.archive` |
| `GET /admin/provider/reconciliation` | P2 (orphan) | Also the weaker door — overlaps a permissioned v1 endpoint |

**The class:** *when a capability grows a second surface, the newer one is
written without the guard, because the guard is remembered as belonging to the
original.* `tests/authz-parity.test.ts` is the standing detector.

A fifth, from TAB 05: **`POST /admin/admin-users/bootstrap-super-admin`** grants
super admin to its first caller and was on the *ordinary* rate-limit tier,
because its path is `/api/admin/admin-users` and the sensitive prefix list said
`/api/admin/users`. Found by a coverage test, not by reading.

## 4. Runbook

### 4.1 Deploy and rollback

**Backend.** A push to `main` **is** the deploy: a self-hosted runner on the
production host runs the release gate (TAB 03), builds, applies migrations, then
restarts PM2 (`servana-prod`) and reloads nginx. Since TAB 03 the deploy job
carries `needs: [release-gate]`, so a red gate leaves it **skipped**.

*Rollback:* the deploy snapshots the running `dist/` to
`/home/github-runner/releases/previous` **before** building, probes `127.0.0.1`
after restarting, and restores the snapshot if the probe fails — then re-probes,
and **still exits 1**, because a recovered incident is not a successful deploy.

⚠️ **The rollback has never been executed.** It is written against the deploy
shape `deploy.yml` describes. Rehearse it before relying on it — manual task
03.5.

⚠️ **The rollback restores the BUILD only. Applied migrations stay applied.**
Survivable because migrations run before the restart and are additive by policy,
so the previous build tolerates the newer schema. A migration that is *not*
backward-tolerable is a two-deploy change and no workflow file can enforce it.

**Portal.** A push is a Netlify build; rollback is an instant redeploy of the
previous build.

### 4.2 Break-glass

TAB 03 adds `environment: production`. The **required reviewer is not yet
configured**, and it must not be until a break-glass path is agreed — it is the
only change in this programme that can block an emergency fix. Manual task 03.4.

### 4.3 Database recovery

**A backup nobody has restored is a hypothesis.** No restore has been performed
or verified from this environment. RPO/RTO and the last successful restore date
are unrecorded. Manual task 16.1.

### 4.4 Credential rotation

Two Firebase Admin keys remain **in git history**. They were rotated; the IAM
deletion is **unverified**. Manual task 16.2. The CI admin identity from TAB 11
does not exist yet and needs a rotation schedule when it does.

### 4.5 Incident response — first actions for the failure modes this book found

| Symptom | First action |
| --- | --- |
| Payout batch misfire | `payouts.trigger_due_run` is now required. Check the audit record — every run names its actor, on both paths. |
| Spike in `/api/v1` 404s | **Not a broken route.** Compare the deployed commit against the client build; group `contract_mismatch_total` by `client` to see which is ahead. Fix is a deploy or rollback. |
| Auth failure spike | Group `auth_failures_total` by client. One client version is a bad release; many is credential stuffing. |
| Deploy shipped past a red gate | Should now be impossible — `needs: [release-gate]`. If it recurs, `tests/deploy-gating.test.ts` has been bypassed or the workflow edited. |
| Admin locked out after a permission change | The reversal is a **grant, never a redeploy that removes the guard**. |

### 4.6 Environment inventory

**Two env files exist on the production host and `pm2 env` does not show them.**
This has caused a P0 before. Which file is authoritative for which variable is
**undocumented** — manual task 16.3.

### 4.7 Cross-platform impact register

§4 requires additive-ness be proven **by reading** the five consumer
repositories. **None of them is on this machine**, so no change in this
programme has been proven additive by the standard the rule demands.

What *can* be said: no route was removed or renamed; every legacy route remains
mounted; response shapes were deliberately left unchanged where a client might
parse them (TAB 01 reads, TAB 08 customer path). Two behaviour changes are
stated rather than buried:

1. **Admin payout retry now queues** instead of releasing synchronously — the
   behaviour the portal already had.
2. **The v1 refund endpoint no longer completes a refund for an admin actor** —
   it opens a review. Measured: one caller, and the portal uses the legacy
   finance surface.

Both need confirming against the client repos — manual tasks 01.5 and 08.1.

## 5. Standing constraint, reaffirmed

**Nothing was pushed. Nothing was deployed. No production read or write. No
credential touched.** 38 commits are local. A push to `main` is a production
deploy and requires an explicit, reaffirmed go for each occasion; a prior
authorisation does not carry forward.

## 6. The three things to do first

1. **Close TAB 02.** The portal serves no CSP and no `X-Frame-Options` on any
   real page. It is a live P0 on the surface that approves refunds and releases
   payouts, and it is hours of work — move the headers into the `for = "/*"`
   block that already applies.
2. **Get `servana_adminportal` onto a machine with this book.** Four TABs are
   unexecutable without it and eight more are half-done.
3. **Rehearse the rollback and demonstrate the skipped deploy** (03.1, 03.5).
   The delivery pipeline is repaired but unproven, and it is the mechanism every
   other fix reaches production through.

---

*Verdict: backend **CERTIFIED_WITH_NONBLOCKING_GAPS**; launch **NOT_CERTIFIED**.
65 gaps named, owned and dated in `docs/MASTER_TODO_MANUAL_TASKS.md`. A gap
without an owner is an incident with a delay.*
