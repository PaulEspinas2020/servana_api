# MASTER TODO — MANUAL TASKS

> **Purpose.** Everything the Admin Portal Production Launch Master Command V1
> requires that **cannot be executed from this environment**, and therefore needs
> a human with credentials, network authorisation, or a repository that is not on
> this machine.
>
> **Rule of this file.** An item lands here only when it is genuinely
> unexecutable locally. Work that *could* be done locally is done locally, not
> deferred into this list. Each item names why it is blocked and what evidence
> closes it — a task without a closing condition is a wish.
>
> **Status legend:** `OPEN` · `DONE` · `SUPERSEDED`

Last updated: 2026-08-18 (TAB 06)

---

## Blocking reasons, defined once

| Code | Meaning |
| --- | --- |
| `PROD-ACCESS` | Requires reading or writing the running production system. This session is not authorised for production access. |
| `REMOTE-OP` | Requires a push, merge, deploy, or GitHub API write. Explicitly outside the standing boundary. |
| `NO-REPO` | Requires a repository not present on this machine (`servana_adminportal`, Customer Mobile, Provider Mobile, Customer Web, Provider Web). |
| `NO-TOOL` | Requires a binary this machine does not have (`gh`, `psql`, `actionlint`). |
| `NO-CRED` | Requires a credential this environment must not hold. |
| `HUMAN-JUDGEMENT` | Requires a decision only a person with operational authority can make. |

---

## TAB 00 — Ground truth

| # | Task | Why blocked | Closes when |
| --- | --- | --- | --- |
| 00.1 | Re-run `gh run list --repo PaulEspinas2020/servana_api --limit 8` and confirm deploy run `32119165101` succeeded | `NO-TOOL`, `REMOTE-OP` | Run list captured showing the deploy success and the release-gate failure on the same commit |
| 00.2 | Probe production: `/api/v1/catalog` → 200, `/api/v1/bookings` → 401, `/zzz-nope` → 404, `/healthz` → 200 | `PROD-ACCESS` | Four status codes captured and pasted into `docs/LAUNCH_BASELINE.md` §4 |
| 00.3 | Clone `servana_adminportal` onto this machine (or grant access) so TABs 02, 07, 12, 15 and the portal half of 08–11, 13–16 can execute | `NO-REPO` | `servana_adminportal` present, `npm ci && npm run verify:release` green from a clean clone |
| 00.4 | Clone the four client repos (Customer Mobile, Provider Mobile, Customer Web, Provider Web) so §4 additive-compatibility can be **proven by reading** rather than reasoned | `NO-REPO` | All four present and greppable for the routes each TAB touches |
| 00.5 | Provide a real PostgreSQL (or `psql` + a scratch database) so `npm run db:verify` non-embedded, ownership checks and the `fresh` CI job can run as the runtime role | `NO-TOOL`, `NO-CRED` | `npm run db:verify` executes and reports; ownership separation observable |

## TAB 01 — Money authorization

| # | Task | Why blocked | Closes when |
| --- | --- | --- | --- |
| 01.1 | Before enforcing `payouts.*` on the disbursement routes, query which admins currently hold those grants and confirm the operations team is covered — **grant first, enforce second** | `PROD-ACCESS` | Grant list captured; ops coverage confirmed by a named person |
| 01.2 | Confirm the true caller count of `/api/admin/disbursements/*` across all six consumers by **reading the repositories** | `NO-REPO` | Each of the six repos grepped; caller count recorded per repo |
| 01.3 | Confirm zero traffic on `/api/admin/disbursements/*` from legacy route telemetry before any deletion — "unreachable" is not "deletable" | `PROD-ACCESS` | A full business week of telemetry showing observed silence |
| 01.4 | Grant `payouts.trigger_due_run` to the operators who legitimately run the due-payout batch. It is now enforced and was previously enforced by nothing, so **only Super Admins can run the batch until this is done** | `PROD-ACCESS`, `HUMAN-JUDGEMENT` | Named operators hold the grant; a non-super admin completes one batch run |
| 01.5 | Confirm no client depends on the legacy retry being SYNCHRONOUS. It now queues (row → `PENDING`, hourly job releases), matching the finance surface the portal already uses | `NO-REPO` | The five consumer repos grepped for `/admin/disbursements/:id/retry` |

## TAB 03 — Delivery pipeline

| # | Task | Why blocked | Closes when |
| --- | --- | --- | --- |
| 03.1 | Demonstrate the gate blocks the deploy: push a commit with a deliberately failing test and observe `release-gate = FAILURE`, `deploy = SKIPPED` | `REMOTE-OP` | The run pair is captured — asserted is not demonstrated |
| 03.2 | Create the GitHub `production` environment with a required reviewer and bind the deploy job to it | `REMOTE-OP`, `HUMAN-JUDGEMENT` | Environment exists; a deployment record is produced |
| 03.3 | Protect `main`: require the release gate as a status check, forbid force-push, require branch up to date | `REMOTE-OP` | Branch protection visible in repo settings |
| 03.4 | Agree and document the break-glass path around the required reviewer **before** switching it on | `HUMAN-JUDGEMENT` | Break-glass procedure written into the TAB 16 runbook and acknowledged |
| 03.5 | **Rehearse the automatic rollback on the production host.** It is written against the deploy shape `deploy.yml` describes and has never been executed. A rollback nobody has run is a hypothesis | `PROD-ACCESS` | One deliberate failed-probe deploy that restores the previous build and recovers `/healthz` |
| 03.6 | Confirm `/home/github-runner/releases` is writable by the runner user and survives between runs, or the rollback snapshot silently does nothing | `PROD-ACCESS` | Directory exists after a deploy and contains `previous/` |
| 03.7 | Confirm GitHub-hosted runners are available to this repo for the `release-gate` job (it runs `ubuntu-latest`; the deploy runs self-hosted) | `REMOTE-OP` | One green `release-gate` job in a run graph alongside `deploy` |

## TAB 04 — CI integrity

| # | Task | Why blocked | Closes when |
| --- | --- | --- | --- |
| 04.1 | Trigger `fresh-db.yml` on GitHub and confirm it produces a real run with real logs, not a 0s startup failure. **The `fresh` job — the only one that can catch an ownership defect — has still never executed** | `REMOTE-OP` | A run with logs; each job green or documented red-by-design; ownership assertion observed passing on a real engine |
| 04.2 | Install `actionlint` and add it to CI, so a workflow parse fault is caught by a linter rather than by noticing an absent check | `NO-TOOL` | `actionlint` runs over `.github/workflows/` in the release gate |
| 04.3 | Make `fresh-db.yml` a required status check feeding the deploy gate — **but not before three consecutive green runs**, or it becomes the cosmetic blocker TAB 03 describes | `REMOTE-OP` | Required check configured after three green runs |

## TAB 05 — API security baseline

| # | Task | Why blocked | Closes when |
| --- | --- | --- | --- |
| 05.1 | Confirm nginx neither strips nor duplicates the new security headers, and align `client_max_body_size` with the Express 10mb limit | `PROD-ACCESS` | Live header capture + nginx config reviewed |
| 05.2 | Set admin rate limits from **measured p99 admin traffic**, ship log-only for one business day, then enforce | `PROD-ACCESS` | p99 figures recorded; log-only soak completed |
| 05.3 | Verify the provider-document and catalog-banner flows still fetch from all five consumers now that `Cross-Origin-Resource-Policy` is served. helmet's default (`same-origin`) would break them; it is set to `cross-origin` deliberately, and that decision needs confirming against real clients | `NO-REPO`, `PROD-ACCESS` | One document and one banner fetched cross-origin from each consumer |
| 05.4 | Deploy with `ADMIN_RATE_LIMIT_LOG_ONLY=true` FIRST and collect a business day of counts before enforcing. The tier values are starting points from the shape of the work, not measured traffic | `PROD-ACCESS`, `HUMAN-JUDGEMENT` | A day of log-only counts; limits re-derived from p99; flag removed |
| 05.5 | Decide whether HSTS `preload` is wanted. It is deliberately NOT set — preload is close to a one-way door and belongs to whoever owns the domain | `HUMAN-JUDGEMENT` | An explicit decision recorded either way |

## TAB 06 — v1 admin domain

| # | Task | Why blocked | Closes when |
| --- | --- | --- | --- |
| 06.1 | Probe the four new v1 admin booking routes on production after deploy: 401 unauthenticated, 200 authorized, 403 for an admin lacking the named permission | `PROD-ACCESS` | Three status codes captured per route |
| 06.2 | Grant/confirm `bookings.view`, `bookings.assign_provider` and `bookings.reassign_provider` are held by the operators who use those screens, before the portal cuts over in TAB 07 | `PROD-ACCESS` | Grant list captured |
| 06.3 | Build wave 2 (provider operations) and wave 3 (finance). Wave 3 is now unblocked by TAB 01 and additionally carries TAB 01's deferred `Deprecation`/`Sunset` headers for `/api/admin/disbursements/*` | `HUMAN-JUDGEMENT` | Waves specified, sized and scheduled |

## TAB 16 — Certification & runbook

| # | Task | Why blocked | Closes when |
| --- | --- | --- | --- |
| 16.1 | Verify database backups actually **restore** — a backup nobody has restored is a hypothesis. Record RPO/RTO and last successful restore date | `PROD-ACCESS` | A restore completed and dated |
| 16.2 | Verify the IAM deletion of the two Firebase Admin keys still in git history. They were rotated; the deletion is **unverified** | `PROD-ACCESS`, `NO-CRED` | IAM confirms the old keys no longer exist |
| 16.3 | Document which of the **two env files on the production host** is authoritative for which variable — `pm2 env` does not show them, and this has caused a P0 before | `PROD-ACCESS` | Environment inventory written into the runbook |
| 16.4 | Provision `ADMIN_API_BASE_URL` and a scoped, rotatable CI admin identity (a real Firebase identity, **not** a super admin) for `smoke:contracts` | `NO-CRED` | `smoke:contracts` executes rather than reporting `NOT_AVAILABLE` |
| 16.5 | Give the explicit, reaffirmed go for any deploy. A push to `main` IS the deploy and prior authorisation does not carry forward | `HUMAN-JUDGEMENT` | Explicit per-occasion authorisation recorded |

---

## Closed

*(none yet)*
