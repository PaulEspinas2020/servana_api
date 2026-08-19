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

Last updated: 2026-08-18 (TAB 16 — terminal)

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

## TAB 08 — refund lifecycle

| # | Task | Why blocked | Closes when |
| --- | --- | --- | --- |
| 08.1 | Prove no client relied on the v1 admin refund path completing in one call. Measured locally: `refundBookingPayment` has one caller, the portal uses the legacy finance surface, and mobile calls it as a customer — but §4 demands proof by READING the four client repos | `NO-REPO` | Four repos grepped for `/v1/bookings/*/refunds` |
| 08.2 | **Build the refund review lifecycle.** The design is recorded in `docs/audits/TAB08_REFUND_LIFECYCLE.md` §4.1: five transitions, five permissions, approver ≠ requester in the executor, server-enforced `requires`, immutable audit per transition, idempotency keys | `HUMAN-JUDGEMENT` | Lifecycle built and mutation-verified; refunds migratable |
| 08.3 | Decide the `trigger` mapping. Its seven values have no legacy equivalent — legacy `reason` is free text. Derive it (lossy) or require it only on new cases. Lossiness on a money record is a decision, not a default | `HUMAN-JUDGEMENT` | Decision recorded with its rationale |
| 08.4 | Confirm no in-flight refund depended on the removed one-shot path at deploy time | `PROD-ACCESS` | Open refund reviews inspected before and after |
| 08.5 | Re-rate F-11. On the evidence it is a live P0, not a P1: the bypass is reachable in production today | `HUMAN-JUDGEMENT` | Severity re-recorded in the findings register |

## TAB 09 — admin surface coverage

| # | Task | Why blocked | Closes when |
| --- | --- | --- | --- |
| 09.1 | Build the support-case workflow UI: state transitions with reason capture, appeal decisions, and attachment preview using the same signed-URL treatment provider documents get | `NO-REPO` | Three screens shipped; the three routes have callers |
| 09.2 | Confirm every `RETIRE` and `CONVERGE` with legacy telemetry showing observed silence. "Unreachable from the portal" is not "deletable" — the portal is one of six consumers | `PROD-ACCESS` | A full business week of per-endpoint counts |
| 09.3 | Extend `smoke:admin` with the portal-side half of the coverage assertion: every portal call resolves to a live route | `NO-REPO` | Assertion runs in CI and has been seen red |
| 09.4 | Execute the CONVERGE deletions once 09.2 confirms silence — `/admin/workers/:uid/archive` (weaker door than `/admin/users/:uid/archive`), `/admin/provider/reconciliation`, and the four disbursement routes | `PROD-ACCESS`, `HUMAN-JUDGEMENT` | Surfaces removed behind deprecation headers and a sunset window |
| 09.5 | Surface `eligibility-preview` and `evaluate-booking` inside the assignment flow, or retire them. They are decision-support calls with no decision screen | `NO-REPO` | Either wired into the assignment view or retired with telemetry |

## TAB 10 — RBAC end to end

| # | Task | Why blocked | Closes when |
| --- | --- | --- | --- |
| 10.1 | Negative test per permission: a token holding everything EXCEPT X must receive 403 from every route requiring X. Positive-only tests cannot detect a guard that never runs | `NO-CRED` | A real scoped identity exists; every permission has a 403 test; suite mutation-verified |
| 10.2 | Verify the portal's permission-driven navigation matches the server's answer | `NO-REPO` | Navigation compared against `/admin/me/permissions` for a scoped admin |
| 10.3 | Confirm a hidden button is never the only control — call each guarded route directly with a deliberately under-permissioned token and require 403 (§12) | `PROD-ACCESS`, `NO-CRED` | Direct calls refused for every dangerous capability |
| 10.4 | Sweep all 250 admin routes for internal cross-user scoping (§11). Two notification routes were verified actor-scoped in TAB 10; the rest are unchecked | `HUMAN-JUDGEMENT` | Each route's query confirmed scoped, or refused as a leak |
| 10.5 | Delete the two KNOWN DEFECT exceptions once TAB 09's telemetry gate confirms silence — `workers/:uid/archive` and `provider/reconciliation`. Both are duplicates that are also the weaker door | `PROD-ACCESS` | Routes removed; exception list drops to six |

## TAB 11 — contract testing

| # | Task | Why blocked | Closes when |
| --- | --- | --- | --- |
| 11.1 | Provision `ADMIN_API_BASE_URL` and a dedicated CI admin identity with a scoped, rotatable credential. It must be a real Firebase identity with a KNOWN permission set — **not** a super admin, or permission failures are bypassed rather than observed | `NO-CRED` | `smoke:contracts` executes instead of reporting `NOT_AVAILABLE` |
| 11.2 | Run `smoke:contracts` against a non-production environment on every push, and against production read-only on a schedule | `NO-REPO`, `NO-CRED` | Green runs in CI on both cadences |
| 11.3 | **Demonstrate the loop closed:** change one backend response key deliberately and watch the PORTAL build fail. This is the proof; the backend-side generatability gate is only half | `NO-REPO` | A red portal build traced to a backend shape change |
| 11.4 | Generate the portal's DTOs from `docs/api/openapi.v1.json` and wire the generation into its `verify:release`, so drift fails at build time in whichever repo drifted | `NO-REPO` | Portal DTOs generated from the document, not hand-written |

## TAB 13 — observability

| # | Task | Why blocked | Closes when |
| --- | --- | --- | --- |
| 13.1 | Ship the structured log lines somewhere that aggregates and can alert. They are emitted and nothing collects them | `PROD-ACCESS` | Lines queryable by request id, actor and route |
| 13.2 | Frontend error reporting carrying the same `X-Request-Id`, so a portal exception and its server log join on one key | `NO-REPO` | A portal error carries the id the API stamped |
| 13.3 | **Prove correlation end to end**: trigger a portal error, take the surfaced request id, find the matching server log line. If you cannot, the loop is not closed | `NO-REPO`, `PROD-ACCESS` | One demonstrated trace, id quoted |
| 13.4 | Define and measure SLOs BEFORE launch — admin API availability, p95 on dashboard and bookings list, error rate on money mutations. Set an error budget and agree what breaching it means | `PROD-ACCESS`, `HUMAN-JUDGEMENT` | SLOs measured from real traffic, not invented fixtures |
| 13.5 | Wire the five declared `ALERTS` to a pager, including the new `v1-contract-mismatch` | `PROD-ACCESS` | Alerts fire; each has an owner |
| 13.6 | Dashboard the legacy-vs-v1 traffic split — it is the instrument that says when a legacy route is safe to retire (TABs 07/09) | `PROD-ACCESS` | Split visible per endpoint |
| 13.7 | External uptime monitoring on both origins, including a check that TAB 02's security headers are still present | `PROD-ACCESS` | Monitor live; header regression pages somebody |

## TAB 14 — performance

| # | Task | Why blocked | Closes when |
| --- | --- | --- | --- |
| 14.1 | Set Angular bundle budgets that **fail** the build rather than warn. A warning in a log nobody reads is not a budget | `NO-REPO` | `build:prod` errors when a budget is exceeded |
| 14.2 | Confirm every feature area is lazily routed — watch for the eager-plus-lazy conflict that silently ships a module eagerly | `NO-REPO` | Route-level bundle report shows no eager feature module |
| 14.3 | Verify cache headers on live hashed assets (`main.*.js`, `chunk-*.js`, `styles.*.css`). TAB 02 proved the `/*.html` rule never fires; the asset rules need the same live check rather than trust in the config | `NO-REPO`, `PROD-ACCESS` | `curl -I` on each asset class shows the intended `Cache-Control` |
| 14.4 | `EXPLAIN ANALYZE` every admin list query against production-shaped data. The queries are correct; whether they are fast is unmeasured, and 111 local bookings is not a scale problem | `PROD-ACCESS` | Plans captured per list endpoint |
| 14.5 | Add indexes for the admin list and search paths, chosen from 14.4's plans. Build them concurrently to avoid locking | `PROD-ACCESS` | Indexes added; plans re-run showing the improvement |
| 14.6 | Set a p95 latency budget per admin screen and hold TAB 13's SLOs to it | `PROD-ACCESS`, `HUMAN-JUDGEMENT` | Budgets agreed and measured |

## TAB 16 — Certification & runbook

| # | Task | Why blocked | Closes when |
| --- | --- | --- | --- |
| 16.1 | Verify database backups actually **restore** — a backup nobody has restored is a hypothesis. Record RPO/RTO and last successful restore date | `PROD-ACCESS` | A restore completed and dated |
| 16.6 | **DO THIS FIRST.** Close TAB 02: the portal serves no CSP and no `X-Frame-Options` on any real page — declared under `for = "/*.html"`, which never matches a SPA navigation. A live P0 on the surface that approves refunds and releases payouts, and it is hours of work | `NO-REPO` | `curl -I` on `/` and a deep link both return CSP, `frame-ancestors 'none'` and `X-Frame-Options` |
| 16.7 | Get `servana_adminportal` onto a machine with this book. Four TABs are unexecutable without it (02, 07, 12, 15) and eight more are half-done | `NO-REPO` | Repo present; `npm ci && npm run verify:release` green from a clean clone |
| 16.8 | Re-run the certification once 16.6 and 16.7 are done. The verdict is NOT_CERTIFIED and cannot change while four launch-gate rows have no evidence of any kind | `HUMAN-JUDGEMENT` | Every launch-gate row green, or explicitly accepted with a named owner |
| 16.2 | Verify the IAM deletion of the two Firebase Admin keys still in git history. They were rotated; the deletion is **unverified** | `PROD-ACCESS`, `NO-CRED` | IAM confirms the old keys no longer exist |
| 16.3 | Document which of the **two env files on the production host** is authoritative for which variable — `pm2 env` does not show them, and this has caused a P0 before | `PROD-ACCESS` | Environment inventory written into the runbook |
| 16.4 | Provision `ADMIN_API_BASE_URL` and a scoped, rotatable CI admin identity (a real Firebase identity, **not** a super admin) for `smoke:contracts` | `NO-CRED` | `smoke:contracts` executes rather than reporting `NOT_AVAILABLE` |
| 16.5 | Give the explicit, reaffirmed go for any deploy. A push to `main` IS the deploy and prior authorisation does not carry forward | `HUMAN-JUDGEMENT` | Explicit per-occasion authorisation recorded |

## V2 TAB 08 — refund lifecycle

| # | Task | Why blocked | Closes when |
| --- | --- | --- | --- |
| V8.1 | **Announce a behaviour change before the next release.** An admin who OPENS a refund review can no longer approve it — a second admin must. Previously one person could run open → approve → mark-processed alone, because `refunds.approve` *requires* `refunds.review.open`, so the permission closure guaranteed every approver was also a requester. The rule is now a predicate in the write itself, not a hidden button | `HUMAN-JUDGEMENT` | Finance operators told, and a second admin holds `refunds.approve` |
| V8.2 | Decide whether `REFUND_ALLOW_SELF_APPROVAL` should exist in production at all. Default is enforced; the flag lifts the control and every approval taken under it is audited with `selfApprovalAllowedByConfig`. It exists so a refusal nobody anticipated cannot strand a customer's refund out of hours — a redeploy is not an incident response | `HUMAN-JUDGEMENT` | Either the variable is deliberately unset in production, or its use is owned and monitored |
| V8.3 | Grant `refunds.mark_failed` to whoever resolves failed refunds. Without it the new terminal is unreachable, and an approved refund the processor rejected still blocks every retry for that booking | `PROD-ACCESS` | At least one non-super-admin holds it |
| V8.4 | Probe the new canonical route on production after a deploy: 401 unauthenticated, 403 under-permissioned, 200 authorized — `POST /api/v1/admin/refunds/:refundId/mark-failed`. TAB 08's acceptance asks for this per wave and it cannot be done from here | `PROD-ACCESS` | Three probes recorded |

## V2 TAB 09 — portal cutover

| # | Task | Why blocked | Closes when |
| --- | --- | --- | --- |
| V9.1 | **Set `API_KEY` on the production host.** Token refresh answers `502 REFRESH_UNAVAILABLE` for every client — admin portal, both mobile apps, provider web — so no session can be renewed. Users are signed out when their token reaches its hour and nobody reports it as a bug. Measured 2026-08-19 on both `/api/auth/refresh` and `/api/v1/auth/refresh` | `PROD-ACCESS` | Either endpoint returns 401 for a bogus token instead of 502 |
| V9.2 | Ship legacy telemetry to a real sink and collect **a full business week** before flipping any endpoint. Per-endpoint call counts are the precondition for claiming a legacy route is unused — the retirement gate is observed silence, and silence you never counted is not evidence | `PROD-ACCESS`, `NO-CRED` | Seven days of per-endpoint counts available |
| V9.3 | After V9.1 and V9.2, flip `/auth/refresh` and `/auth/logout` — one entry, one deploy, one soak each. NOT done now on evidence: both surfaces currently 502 for the same reason, so migrating would move traffic onto an equally broken path | `PROD-ACCESS`, `HUMAN-JUDGEMENT` | Allowlist names them; live probe shows same data, same authorization, same error contract |
| V9.4 | Redeploy so the v1 error envelope reaches production. `v1AuthEnvelope` landed in `5bf9da5` today; production predates it and still answers v1 auth failures in the legacy `{status,code}` shape. Already fixed in repo — this is deploy latency, not a defect | `PROD-ACCESS` | `POST /api/v1/auth/logout` with no credential returns `{error:{code,requestId}}` |

## V2 TAB 10 — supply chain

| # | Task | Why blocked | Closes when |
| --- | --- | --- | --- |
| V10.1 | Drop `--legacy-peer-deps` from `.github/workflows/admin-ci.yml` (line 28) and raise its `node-version` from `'20'` to `'20.19.5'`. Both are already done in `netlify.toml`, `.nvmrc` and `engines`; the workflow file cannot be pushed with this PAT. Bare `'20'` may resolve below Angular 20's `^20.19` floor | `NO-TOOL` (PAT lacks `workflow` scope) | `admin-ci.yml` runs `npm ci` with no flags on 20.19.5 |
| V10.2 | **Schedule Angular 21 before 2026-10-31.** `latest` is 22.1.2; this repository is on `v20-lts`. Angular ships a major every ~6 months with 6 months active + 12 months LTS, putting 20's end of life at approximately late November 2026. Supported and unvulnerable today, on the last third of its life | `HUMAN-JUDGEMENT` | 21 landed with its own soak, or a dated decision to skip to 22 |
| V10.3 | Confirm the Netlify build picked up `NODE_VERSION = "20.19.5"` and built with no NPM flags. A failed build leaves the previous deploy serving, so a silent failure looks like nothing happening | `PROD-ACCESS` | Netlify deploy log shows 20.19.5 and a clean `npm ci` |
| V10.4 | Soak the Angular 20 upgrade in real use for a week. 1592 tests and a production build passed, but a runtime regression across two majors is exactly what a suite does not catch | `HUMAN-JUDGEMENT` | A week of operator use with no framework-attributable defect |

---

## Closed

*(none yet)*
