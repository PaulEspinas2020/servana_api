# Deploy and gate policy

**Decided 2026-08-19, after an outage caused by the deploy pipeline itself.**

There is no CI. **As of 2026-08-20 there are no workflow files at all** — the
three under `.github/workflows/` and the three parked under
`docs/pending-workflow/` were deleted, along with the tests that policed them.
This is a standing rule across every repository, not a setting on this one:
Actions credit is not being topped up, so "disabled" was replaced with "absent",
which cannot be re-enabled by accident.

Deployment is a direct push to `main` (or `dev`), followed by
`scripts/deploy-prod.sh` run on the box. `npm run verify` runs on a developer
machine, invoked by the `pre-push` hook.

**Note what the change costs: a push no longer deploys anything by itself.**
The push lands the code and the hook gates it; a human then runs the script.

This document exists because three separate gates could not pass on the machine
that now runs them, and because the reason production died was not a code
defect but where and how the pipeline ran.

---

## Push straight to `main`. No pull requests.

**Standing rule, decided 2026-08-19. This is not a preference.**

Work lands by committing locally and pushing `main`. There is no PR step, no
review branch, and no merge queue. A change is ready when `npm run verify` is
green and it is pushed — and on `main` the `pre-push` hook runs that for you,
so the gate is not optional.

Feature branches are for work in progress, never for landing. A branch left to
age stops being a change to `main` and becomes a re-implementation against code
that has moved on. This repository is the proof: `feat/admin-dedup-hardening`
and `feat/catalog-workspace` sit ~600 commits behind, and `main` has since
rewritten the very files they touch 4-14 times over —

| File | `main` since the branch point | branch adds |
| --- | --- | --- |
| `adminProviderController.ts` | 725+/93- | 51+/4- |
| `adminProviderService.ts` | 620+/97- | 50+/9- |
| `providerCatalogService.ts` | **1389+/169-** | 356+/2- |

Their work is genuinely unlanded, but it cannot be merged any more. See
`docs/CATALOG_WORKSPACE_UNLANDED.md`.

The same rule applies to `ServanaClientAPP`; see its
`docs/runbooks/DEPLOY_POLICY.md`.

---

## Why CI was switched off

The `Deploy Servana API (Prod)` workflow ran on a **self-hosted runner
installed on the production box**, with the application executing directly out
of the runner's own scratch directory:

```
/home/github-runner/actions-runner/_work/servana_api/servana_api/dist/app.js
```

Its job order made that fatal:

| Step | Result |
| --- | --- |
| 3. Checkout code | **succeeds — and deletes `dist/`, which production is running from** |
| 8. Typecheck (source and tests) | **fails** |
| 12. Build | skipped — never rebuilds what step 3 deleted |
| 15. Restart PM2 | skipped |

So a failing test destroyed the production build. The process survived anyway,
because a live Node process keeps its code in memory after the files are gone —
which is why the API served for hours on a `dist/` that no longer existed and
then returned **502 on everything, including `/healthz`**, the moment anything
restarted it.

On 2026-08-19 that workflow failed at 10:56, 11:14, 13:58, 14:05 and 14:08.

The failing step was **not** a type error. `typecheck` passes; `typecheck:tests`
exhausts the heap (`exit 134`) on a **961 MB, 1-CPU** server. A memory-heavy
typecheck, running on the production host, in the directory production executes
from, could take the platform down by running out of RAM.

Note these were **self-hosted** runs and consumed no GitHub Actions minutes.
Cost was never the argument. They were stopped because they were destroying
production.

---

## Where production lives now

| Thing | Path |
| --- | --- |
| App directory (PM2 `cwd`) | `/var/www/servana_api` |
| Entry point | `/var/www/servana_api/dist/app.js` — node, fork mode, no args |
| PM2 process | `servana-prod`, port 8000, behind nginx |
| Environment | `/etc/servana_api.env` (`root:root 600`) and the app's own `.env` |
| Host | `192.46.224.126` — **961 MB RAM, 1 CPU** |

Production was moved out of `_work` on 2026-08-19. **Never point it back at a
directory CI can write to.** That single property is what turned a failing test
into a customer-facing outage.

---

## Deploying

```
ssh -n root@192.46.224.126 'cd /var/www/servana_api && git pull && bash scripts/deploy-prod.sh'
```

`scripts/deploy-prod.sh` is the deploy. It carries every step the deleted
workflow carried, in the order that was argued over, plus the three the live
workflow never had:

| Step | Why the order matters |
| --- | --- |
| secrets | copied only if the source exists — it will not clobber a live `.env` |
| `npm ci --include=dev` | typescript and jest are devDependencies |
| typecheck, docs drift, secret scan, protected-contract guard | cheap, host-specific. The full suite deliberately does NOT run here — 961 MB cannot hold it, and that is what killed production |
| `npm run build` + `verify-build-info --strict` | `--strict` explicitly, because no CI variable sets it any more |
| `migrations:plan` then `migrations:apply` | after the build, before the restart. A failing build touches nothing; a failing migration stops short of the restart, so old code keeps serving |
| PM2 stop / delete / start | not `reload` — fork mode makes reload a restart anyway, and cluster mode would double every cron tick |
| post-deploy probe | **new.** The live workflow had none |
| rollback on probe failure, exit 1 | **new.** A recovered incident is not a successful deploy |
| retain the build | **new,** and last: retaining a build the probe rejected would make the next rollback restore it |

`SERVANA_APPLY_DESTRUCTIVE=<migration>` in the calling shell authorises one
destructive migration, for one deploy, with a backup taken. Never export it
permanently.

The older two-command form still works for a code-only change:

```
ssh -n root@192.46.224.126 'cd /var/www/servana_api; npm run build'
ssh -n root@192.46.224.126 'pm2 restart servana-prod'
ssh root@192.46.224.126 'pm2 save'
```

Verify:

```
curl -s https://api.servana.com.ph/readyz              # "phase":"ready","ready":true
curl -s https://api.servana.com.ph/api/catalog/summary # 3 / 12 / 95
```

`npm run deploy:verify` and `npm run db:diagnose` are the project's own checks.
`db:diagnose` is read-only and is what identified that `servana.locations` is
read by `adminCreateBookingService.ts:430` but does not exist.

### The `set -a` prefix is no longer required

Older runbooks prefix the restart with:

```
set -a; . /etc/servana_api.env; set +a; pm2 restart servana-prod --update-env
```

That was **load-bearing** until 2026-08-19, because `.env` had never supplied
the database credentials in production: `app.ts` called `dotenv.config()` after
its imports, and `config.ts` — which 53 modules import, and which captures the
credentials into a module-level `const` — guarded its own load with
`if (!process.env.NODE_ENV)`, which is always set in production. The API only
ran because PM2's environment happened to carry the values, and a restart that
lost them took everything down.

`src/env/loadEnv.ts` now loads the file before anything reads it. Keep the
prefix if you like it as a belt; it is no longer the braces.

---

## The gate

`scripts/hooks/pre-push` (via `core.hooksPath = scripts/hooks`) runs
`npm run verify` when pushing `main` and `verify:quick` otherwise. **With CI
off, this is the only gate that exists.**

That raises the stakes on a gate being able to pass where it runs. Three could
not, all of them Linux-only assumptions:

| Gate | Why it failed on Windows | Fix |
| --- | --- | --- |
| `deploy-gating` (now `deploy-is-direct-not-ci`) | Asserted the hook's exec bit via `statSync().mode & 0o111`. NTFS carries no POSIX exec bit, so Node reports `666` and the assertion is unsatisfiable. `ls -la` showing `-rwxr-xr-x` is git emulating its **index**, not the filesystem. | Assert `git ls-files -s` reports `100755` — the mode that actually travels |
| `jest-vacuous-ratchet` | Built keys as `test.path.replace(process.cwd() + '/', '')`. `test.path` uses backslashes; the concatenation appends a forward slash; **the replace matched nothing** and every key stayed absolute, so none aligned with the frozen relative list. It reported *"24 no longer on the list"* when nothing had regressed. | Normalise separators before stripping the root. Now reports *3*, the true number |
| `release-gate-hermeticity` | Correctly caught a new test writing into the repo root | The test moved to `os.tmpdir()` |

**A gate that cannot pass where it is run blocks every push, and the obvious
workaround is `--no-verify` — which removes the gate rather than repairing it.**
If a check starts failing for a reason that is about the machine rather than
the code, fix the check.

### Do not re-freeze the vacuous ratchet to go green

`VACUOUS_FREEZE=1 npm run test:ci` rewrites the frozen list and turns the gate
green in one command. Used to escape a failure, it blesses every current
zero-assertion test as acceptable and launders a real signal. Re-freeze only
when a test legitimately delegates its assertion, and say so in a comment.

---

## What deleting CI actually cost, and who now owns it

Two things ran only in a workflow. Neither is automated any more, so both are
named here rather than left to be discovered.

**The fresh-database `--live` gate.** `fresh-db.yml` ran
`npm run db:verify -- --live` against a real PostgreSQL 16 service container.
`--embedded` is not a substitute: PGlite is a single bundled superuser, so
**ownership and role separation are invisible to it** — and that is the exact
defect that left 29 of 116 tables unusable in production. The mode still exists
and still refuses production and unacknowledged hosts. It is now an operator
step, to be run against a local PostgreSQL before any migration lands:

```
npm run db:verify -- --live        # needs a local PG; refuses prod by design
npm run db:verify:embedded         # runs anywhere; does NOT cover ownership
```

Do not read a green `db:verify:embedded` as covering ownership. It never did.

**The release-gate summary artifact.** `release-gate.yml` retained
`reports/release-summary.json` per run. `npm run release:summary` still writes
it; nothing archives it. If a release needs an auditable record, keep the file.

---

## `typecheck:tests` does not run on the server

It needs more heap than 961 MB allows. It passes on a developer machine and is
part of `verify`, which is where it belongs. Do not add it to anything that
runs on the production host.

---

## Repository note

`Upupapp/servana_api` and `PaulEspinas2020/servana_api` are the **same
repository** — the first is an old URL and GitHub redirects it. Pushing to
either lands in the same place. A clone can look many commits behind simply
because its working branch was never pulled; check before concluding the
remotes have diverged.
