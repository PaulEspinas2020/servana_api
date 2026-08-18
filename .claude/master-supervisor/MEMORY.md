# MASTER SUPERVISOR — MEMORY CHECKPOINT

Compact recovery state. Not a transcript.

**Rewritten 2026-08-18 at TAB 00.** The previous contents described the 15-TAB
Backend Centralization book, on a Windows machine, with a local PostgreSQL 16 on
`PATH`. All three are wrong now. Reconciled rather than appended to, because a
memory file read as current is more dangerous than no memory file.

## Master Command — current

**SERVANA · MASTER COMMAND · V1 — Admin Portal → Backend Production Launch.**
17 TABs (00–16), measured 2026-08-18 against the running production system.
Supersedes the 12-TAB Backend Centralization book and the 15-TAB book before it.

Execution order: **00 is a hard gate** → 01–05 launch-blocking, parallelisable →
06–08 integration core, strictly sequential → 09–15 hardening, parallelisable →
16 certifies, terminal.

Authority page: **`docs/LAUNCH_BASELINE.md`**. Manual queue:
**`docs/MASTER_TODO_MANUAL_TASKS.md`**. Live state: **`state.json`** beside this
file.

## The one fact that reframes everything

The blocker every prior session recorded — *deploy failed on a JS-heap OOM,
production still runs `2e03a4b`, production mounts no `/api/v1`* — **is gone.**
Production runs `d4b0150`; 98 of 98 probeable v1 routes answer; an unknown path
404s, so routing precedes auth.

What replaced it is smaller and sharper: **the v1 surface has 1 admin-authenticated
route out of 105.** v1 was built for the client apps. The admin portal cannot
migrate onto a surface that does not model its domain. The integration gap is a
*missing domain*, not a deploy. TAB 06 builds it; TAB 07 cuts the portal over.

## Repository & environment — corrected

`/Users/user/servana_api` on **macOS**. Node v24.19.0, npm 11.17.0.

**Absent and load-bearing:** `gh`, `psql`, `actionlint`, `.env`,
`servana-serviceAccountKey.json`, **`servana_adminportal`**, and all four client
repos. PGlite is the only database engine reachable. Production access is **not
authorised** for this session.

Critical paths:

```
src/api/v1/contract.ts              ONE contract array — every v1 endpoint
src/api/v1/register.ts              the only v1 mount point; throws on an
                                    implemented entry with no handler
src/routes/disbursement.routes.ts   ← TAB 01: FOUR routes, no requirePermission
src/routes/adminFinance.routes.ts   ← the same capability, correctly guarded
src/services/booking/               transitionExecutor — ONE executor
scripts/migrations/                 38 files, 001..037
scripts/baseline/000-baseline.sql   CAPTURED production schema — 121 tables
scripts/jest-heap-guard.js          the permanent heap bound (TAB 01 of the
                                    provider-web book); peak 1101.7/4288 MB
```

## Gates — all green on this machine, 2026-08-18

- `npm run verify` — **PASS exit 0, 276 suites, 5935 tests, 0 failures.**
  (The book expects 265/~5769; the book's figure is stale, not the run.)
- `npm run db:verify:embedded` — **PASS, 132 tables** (121 restored + 8 applied).
- `npm run schema:authority` — **PASS exit 0, UNMANAGED 0.**

Not runnable here: `db:verify` (non-embedded), `gh run list`, every production
probe. All queued in the manual register.

## Git / working tree

Branch `main`. `HEAD` = `0aaf89f`. `origin/main` = `d4b0150`. **2 commits ahead,
working tree CLEAN.** Nothing pushed. Nothing deployed. No production read or
write this session.

## Standing constraints

- A push to `main` **IS** the production deploy — self-hosted runner, migrations,
  PM2 restart, no staging hop. Local-only until an explicit, reaffirmed
  per-occasion go. Prior authorisation does not carry forward.
- §4 Additive Compatibility: additive-ness is proven by **reading** the five
  other consumer repositories, never by reasoning. Those repos are absent, so
  every such proof is currently a manual task, not an assumed pass.
- Never claim a test passed unless it was executed.
- Reading source is never sufficient evidence in this book.
