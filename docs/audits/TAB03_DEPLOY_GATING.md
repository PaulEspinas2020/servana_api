# TAB 03 — making the release gate actually gate the release

> **Closes F-03 (P0).** Implemented 2026-08-18 against `servana_api` at `74fe5d5`.

---

## 1. The defect

`deploy.yml` and `release-gate.yml` both declared `on: push: branches: [main]`,
as two **independent** workflows. Two workflows on one trigger run in parallel
and cannot express a dependency between them, so on commit `d4b0150`:

```
release-gate   run 32119165094   FAILURE
deploy         run 32119165101   SUCCESS   ← shipped to production anyway
```

The gate was red and the commit shipped. Nothing in the pipeline objected,
because nothing in the pipeline was capable of objecting.

### 1.1 The gate's own failure was cosmetic, and that is the danger

`reports/release-summary.json` was never written, so `upload-artifact` with
`if-no-files-found: error` failed the job. The visible cause of death became
"no artifact" rather than whatever actually stopped the run.

A gate that fails for uninteresting reasons trains everyone to ignore it — and
then it fails for a real reason and is ignored too. Fixing the dependency
without fixing this would have produced a *blocking* gate that cries wolf, which
is worse than a non-blocking one: it gets deleted rather than debugged.

### 1.2 The deeper issue, unchanged by this TAB

A push to `main` **is** the production deploy. A self-hosted runner on the
production host applies migrations and restarts PM2. There is no staging hop.
This TAB puts a gate in front of that; it does not change what a push means.

## 2. What was changed

| Change | File | Why |
| --- | --- | --- |
| `workflow_call:` trigger added | `release-gate.yml` | A workflow can only be depended on if it can be *called*. |
| `release-gate` job that `uses: ./.github/workflows/release-gate.yml` | `deploy.yml` | The gate becomes a job in the same run graph. |
| `needs: [release-gate]` on `deploy` | `deploy.yml` | **The fix.** A failed gate now leaves the deploy SKIPPED. |
| `environment: production` | `deploy.yml` | Produces a deployment record. The *required reviewer* is repository configuration, not repository content — see §4. |
| Summary fallback step, `if: always()`, before the upload | `release-gate.yml` | The artifact step can no longer be the cause of failure, while `if-no-files-found: error` is retained — a missing artifact now means the fallback itself broke, which is worth failing on. |
| Snapshot the running build before `npm run build` | `deploy.yml` | Rollback needs something to roll back *to*, and the build overwrites `dist/` in place. |
| `dist/BUILD_INFO.json` stamped with `$GITHUB_SHA` | `deploy.yml` | Proves which commit is serving — see D2. |
| Post-deploy probe | `deploy.yml` | A deploy that reports success while the process crash-loops is a deploy that lied. |
| Automatic rollback on probe failure | `deploy.yml` | Restores the previous build rather than leaving production half-shipped. |
| `tests/deploy-gating.test.ts` | new | 17 assertions, mutation-verified. |

## 3. Decisions taken autonomously

**D1 — a reusable workflow, not a duplicated job.** The alternative is copying
the gate's steps into `deploy.yml`, which creates two definitions of "releasable"
that disagree the first time one is edited (§9). `workflow_call` keeps one
definition and one place to change it.

**D2 — prove the running commit with a build stamp, not a `/version` endpoint.**
The book asks the post-deploy step to assert the running commit. There is no
version endpoint and there should not be one: a build SHA on a public endpoint
is free reconnaissance for anyone matching a deployment against a published CVE,
and least-disclosure says do not add it merely to make CI's life easier.
Stamping `dist/BUILD_INFO.json` answers the same question from the host, reading
the very `dist/` that PM2 is running. Nothing is published.

**D3 — probe `127.0.0.1`, never the public origin.** The job runs *on* the
production host. Probing `https://api.servana.com.ph` would test DNS, the CDN
and nginx as well, so a green probe could mean a cached response and a red one
could mean a proxy hiccup. Neither answers "did the process I just restarted come
back". The public origin is the right target for external uptime monitoring
(TAB 13), and the wrong one here.

**D4 — a rollback still fails the run.** The step exits 1 after a successful
restore. A recovered incident is not a successful deploy, and a green tick would
hide it from exactly the person who needs to know it happened.

**D5 — the probe retries, bounded.** PM2 has just restarted; asserting
immediately races the process and calls the race a failure. Twenty attempts at
three seconds, then fail. An unbounded wait would hang the job instead of
reporting.

**D6 — the unknown-path assertion is kept even though it looks redundant.**
`GET /zzz-nonexistent-path` must return 404. Production once answered **401 to
every path including nonexistent ones**, which proved auth was running before
routing and that the deployed build did not serve v1 at all. A 404 there is the
cheapest available proof that the router is the thing answering.

## 4. The rollback boundary — stated, because pretending is worse

**The rollback restores the BUILD only. Applied migrations stay applied.**

Migrations run before the restart and are additive by policy, so the previous
build tolerates the newer schema — which is precisely why that ordering was
chosen. A migration that is *not* backward-tolerable must not ship in the same
deploy as the code that needs it; that is a two-deploy change, and no workflow
file can enforce it. The deploy log says so explicitly in a final step rather
than leaving it to be discovered during an incident.

## 5. What could NOT be done here

| Book step | State | Why |
| --- | --- | --- |
| Demonstrate a failing gate produces a SKIPPED deploy | **NOT DONE** | Requires a push, and a push to `main` IS the production deploy. Manual task 03.1. |
| GitHub `production` environment with a required reviewer | **HALF DONE** | The job is bound to the environment (repository content). Creating it and adding the reviewer is repository *settings*. Manual task 03.2. |
| Protect `main` — required status check, no force-push | **NOT DONE** | Repository settings. Manual task 03.3. |
| Rehearse the rollback on the host | **NOT DONE** | Written against the deploy shape this file describes and **never executed**. Manual task 03.5. |
| Agree the break-glass path before the reviewer is switched on | **NOT DONE** | A required reviewer is the only change here that can block an emergency fix. Manual task 03.4. |

## 6. The gate: `tests/deploy-gating.test.ts`

17 assertions read out of the workflow files themselves. The book's proof is a
demonstrated run pair; that proof cannot be produced without push authorisation,
so this asserts the structural property the demonstration would exercise. **They
are complements.** A demonstration proves it worked once; this proves it has not
been quietly removed since, which is the failure mode that actually recurs.

The load-bearing assertion is not "the deploy job has `needs:`" but **"every job
that runs on the production host is gated"** — a future job added to the
self-hosted runner without `needs:` is F-03 arriving through a different door,
and it fails this test on the commit that adds it.

No YAML parser is used. `js-yaml` is present only as a transitive dependency,
and a gate whose correctness rests on an undeclared package has a silent expiry
date. The reader answers four structural questions and says so.

**Mutation-verified — watched failing against real files:**

```
MUTATION 1  comment out `needs: [release-gate]`   (recreates F-03 exactly)
            → 2 failed, 15 passed

MUTATION 2  move the summary fallback AFTER the upload step
            → 2 failed, 15 passed
```

Both reverted; 17/17 green, and both workflows re-validated as parseable YAML.
