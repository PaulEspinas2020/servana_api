# Launch Baseline — Admin Portal Production Launch Master Command V1

> **TAB 00 deliverable.** Every later TAB cites this page. It records what was
> measured, by whom, and — just as load-bearing — what was NOT measured here and
> why. A baseline that blurs those two is the stale authority TAB 00 exists to
> destroy.

**Established:** 2026-08-18
**Book:** SERVANA · MASTER COMMAND · V1 — Admin Portal → Backend Production Launch (17 TABs)
**Supersedes as ground truth:** the 12-TAB Backend Centralization state recorded in
`.claude/master-supervisor/state.json` before this date, and the pre-correction
headline of `docs/PRODUCTION_READINESS.md`.

---

## 1. Commit identity

| Fact | Value | How established |
| --- | --- | --- |
| Backend `HEAD` (local) | `0aaf89f` | `git log -1` in this working tree |
| Backend `origin/main` | `d4b0150` | `git rev-parse origin/main` — local ref, no network |
| Local commits ahead of origin | **2** (`0aaf89f`, `fca1ed1`) | `git rev-list --count origin/main..HEAD` |
| Backend deployed commit | `d4b0150` | Master Command V1 evidence base — deploy run `32119165101`, success, 2m44s, 2026-08-18T09:09:15Z |
| Backend working tree | **CLEAN** — 0 modified, 0 untracked | `git status --short` returns empty |
| Un-migrated SQL on disk | **NONE** | The three `.sql` files outside `scripts/migrations/` are all git-tracked and all legitimate: `scripts/baseline/000-baseline.sql` (schema authority), `scripts/baseline/bootstrap-fixtures.sql`, `scripts/diagnose-fallback-addresses.sql` (diagnostic). `ledger-repair.sql`, present when the book was measured, is **gone**. |
| Admin portal repo | **NOT PRESENT ON THIS MACHINE** | `ls /Users/user` — no `servana_adminportal`. See §5. |

The book's measured backend was `d4b0150` with three stray files
(`M package.json`, `?? ledger-repair.sql`, `?? scripts/verify-v1-mounted.ts`).
None of those three remain. The tree moved forward under TAB 00 rather than
being frozen at the book's snapshot, which is the correct direction: the book
measures a moment, the baseline records the moment work resumed.

## 2. Backend gates — executed in this session, on this machine

| Gate | Result | Detail |
| --- | --- | --- |
| `npm run verify` | **PASS, exit 0** | 276 suites, 5935 tests, 0 failures, 9.7s. Includes typecheck, `security:secrets`, `typecheck:tests`, `guard:protected-contracts` and ten doc-drift checks. |
| `npm run db:verify:embedded` | **PASS** | 121 tables restored from baseline + 8 pending migrations applied on top = **132 tables**. Version mark idempotent. Migrations leaking transaction control: 0. Baseline sanitisation problems: 0. Unmet requirements: 0. |
| `npm run schema:authority` | **PASS, exit 0** | **UNMANAGED 0.** Missing declared columns 0. Known and carried: 1 interpolated column (`booking_escalations.${column}`, `experienceStore.ts:156`), 1 interpolated index name (`financeLedger.ts:144`), 1 contested object (`user_profile`, definition production satisfies). |

**Correction to the book.** TAB 00 states `npm run verify` should show "265
suites, ~5769 tests". Measured here: **276 suites, 5935 tests**. The repository
gained suites between the book's measurement and this run. The gate is green;
the expected figure in the book is stale, not the run.

**Heap guard is live.** `test:ci` now runs with `--logHeapUsage` and
`scripts/jest-heap-guard.js`. Peak this run: **1101.7 MB of a 4288 MB limit,
74.3% headroom** against a 70% threshold. The single largest retainer is
`tests/app-import-is-inert.test.ts` at +413.5 MB — it requires the whole
application module graph by design, and now calls `jest.resetModules()` so the
remaining 275 suites do not inherit it. This is what makes the 961 MB
self-hosted runner survivable.

## 3. The three facts this baseline exists to fix

1. **The blocker in every prior session is gone.** Production runs `d4b0150`
   and mounts `/api/v1`. An unknown path returns 404, not 401 — so routing runs
   before auth and the deployed build genuinely serves v1. Corroborated locally:
   `origin/main` IS `d4b0150`.
2. **The portal is hard-wired not to use it.** `V1_MIGRATION_ENABLED = false` is
   a module constant, not an environment key. Two endpoints would become
   eligible if flipped. The backend exposes **1 admin-authenticated route out of
   105** — the admin domain of v1 does not exist yet. **That is the integration
   gap.** (TAB 06 builds it; TAB 07 cuts over.)
3. **Two controls are configured and provably not in force.** The portal's CSP /
   `X-Frame-Options` / `Permissions-Policy` are scoped to `for = "/*.html"` and
   never fire on a real navigation; `deploy.yml` has no `needs:` on the release
   gate, and the gate failed on the very commit that shipped.

## 4. What this session did NOT measure, and why

This session holds **no authorisation for production access**. The following are
recorded on the book's authority and are queued for a human in
`docs/MASTER_TODO_MANUAL_TASKS.md`. None of them is asserted here as
independently re-verified:

- `gh run list` — the `gh` CLI is not installed on this machine, and the call is
  a remote GitHub API read regardless.
- `curl https://api.servana.com.ph/api/v1/catalog` → 200, `/api/v1/bookings` →
  401, `/zzz-nope` → 404, `/healthz` → 200.
- `curl -sI https://admin.servana.com.ph/` header measurement (F-02).
- `npm run db:verify` (non-embedded) and any migration plan/apply against a real
  PostgreSQL: **no `psql` on this machine and no `.env`** — the repo carries no
  credentials, which is correct.

## 5. Environmental gap — the admin portal repository is absent

`servana_adminportal` is **not on this machine**. Of the 17 TABs:

| Scope | TABs | Executable here |
| --- | --- | --- |
| `servana_api` only | 01, 03, 04, 05, 06 | **Yes** |
| `servana_adminportal` only | 02, 07, 12, 15 | **No** — repo absent |
| Both repos | 00, 08, 09, 10, 11, 13, 14, 16 | **Backend half only** |

Backend-half work proceeds. Portal-half work is recorded, specified and queued
rather than silently skipped — a TAB is never reported complete on the strength
of the half that happened to be reachable.

## 6. Standing constraints reaffirmed

- **No push, no deploy, no remote operation, no production write, no credential
  change.** Local commits are permitted and are the only mutation this book
  performs on the estate.
- A push to `servana_api` `main` IS a production deploy. It requires an
  explicit, reaffirmed go for each occasion; a prior authorisation does not
  carry forward.
- All 63 Servana Standing Hard Rules apply, §4 Additive Compatibility foremost:
  no change is proven additive by reasoning, only by reading the five other
  consumer repositories — four of which are also absent from this machine and
  are therefore a recorded manual task, not an assumed pass.

---

*TAB 00 verdict: **CERTIFIED_WITH_NONBLOCKING_GAPS**. Backend ground truth
re-baselined, tree clean, three gates green. Gaps are environmental — production
probes and the portal repository — and every one is named, owned and queued.*
