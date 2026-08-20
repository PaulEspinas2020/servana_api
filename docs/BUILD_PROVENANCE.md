# Build provenance: what is closed, and what a deploy still has to do

**Measured 20 August 2026**, in response to TAB 04.

```
BUILD_NAMES_ITSELF: PARTIAL (build gate landed and proven; production stamp awaits a deploy)
```

## The finding is stale, and the real cause is narrower

The Master Command says:

> The endpoint is fine. **The deploy is not writing the file it reads.**

Re-measured, that is no longer true:

| | Measured 20 Aug 2026 |
|---|---|
| `npm run build` stamps `dist/BUILD_INFO.json` | **yes** — since `8781cf6` |
| `origin/main`'s `package.json` carries that build script | **yes** |
| the deploy runs `npm run build` | **yes** — `scripts/deploy-prod.sh` |
| production `GET /api/v1/health` | `available: false`, all fields null |
| production `GET /health` | 404 |

So the deploy *would* stamp. The reason production cannot name itself is narrower:
**`8781cf6` was pushed with `[skip ci]`, so it never triggered a deploy.** Production is
serving an artefact built before the stamper existed.

**That part is fixed by a deploy, not by code.** It is named here rather than worked around —
and with CI gone, "a deploy" means someone running `scripts/deploy-prod.sh` on the box.
Re-measured 2026-08-20: `GET /api/v1/health` still answers `available: false`, so it has not
happened yet.

## What was genuinely missing, and is now present

The stamper deliberately never fails — *"a build that dies because git was unavailable takes
down a deploy"* — and that reasoning is right. But it leaves nothing asserting the stamp was
actually produced. `scripts/verify-build-info.mjs` draws the line the stamper deliberately
does not:

| Condition | Result |
|---|---|
| file absent | **fatal always** — the stamper writes it unconditionally, so absence means the step never ran |
| not valid JSON | **fatal always** |
| a contract field missing | **fatal always** — it would project to `null` and read as "no stamp" rather than "bad stamp" |
| `commit` null | **fatal in CI/production**, a warning locally |
| stamp ≠ `GITHUB_SHA` | **fatal** — the artefact is not built from the commit being deployed |

### Why it lives in `npm run build`

Originally because `.github/workflows/deploy.yml` could not be changed with this repository's
credentials — the PAT lacked the `workflow` scope — so a gate placed in the build was the only
one that could reach production. That constraint is gone with the workflows themselves, but
the placement outlived its reason and is still right: every path that produces a `dist/` runs
`npm run build`, so the check cannot be skipped by deploying some other way.

One thing the removal did change. `verify-build-info.mjs` is STRICT under `CI`,
`GITHUB_ACTIONS`, `NODE_ENV=production` or `--strict`, and the first two are never set now.
`scripts/deploy-prod.sh` therefore passes `--strict` itself. Without it, a build unable to name
its own commit would have started reaching production silently — the exact failure this gate
exists to prevent, reintroduced by deleting CI rather than by any code change.

## `/health` at the root

It answered 404, and that 404 produced a wrong finding: a hand-over read it as *"the
build-provenance endpoint is not deployed"* when provenance was answering at `/api/v1/health`
the whole time. It was also an operational hazard by itself — uptime checkers and load
balancers default to `/health`, so one left on its defaults reports this service down while it
serves perfectly.

The root now answers **liveness**, plus the addresses of the other three:

```json
{ "status": "alive", "liveness": "/healthz", "readiness": "/readyz", "provenance": "/api/v1/health" }
```

Provenance stays at `/api/v1/health` alone. It is declared in `V1_CONTRACT`, shaped by the
`BuildInfo` schema, generated into the docs and covered by the v1 gates; a duplicate outside
that namespace would be contract-governed data with none of the machinery that keeps it honest.

## The post-deploy probe — written, proven, NOT WIRED

`scripts/post-deploy-readiness.sh` now asserts provenance after readiness passes:

- `available: false` → **fail.** The running build cannot name itself.
- served commit ≠ `EXPECTED_COMMIT`/`GITHUB_SHA` → **fail.** The restart did not take and the
  previous build is still answering, while every earlier step reported success.
- `PROVENANCE_ONLY=1` runs the check alone — for an operator asking "what is serving right
  now?" during an incident, which is exactly when readiness is the thing failing.

Demonstrated against a real local server serving the real `dist/`:

```
correct commit   -> provenance ok — serving 4bf9c54…                       exit 0
wrong commit     -> DEPLOY FAILED PROVENANCE — serving the wrong commit    exit 1
stamp removed    -> DEPLOY FAILED PROVENANCE — available=False             exit 1
```

**It is not wired into the live workflow, and nothing in this repository can wire it**, because
a post-restart step must live in `deploy.yml`. `tests/build-provenance.test.ts` asserts that
absence as a known state, so landing the parked workflow turns that test red and it gets
deleted — which is the correct outcome.

## What still has to happen, and by whom

1. **A deploy** — production stamps itself the moment one runs from `origin/main`. Until then
   `/api/v1/health` keeps answering `available: false` however green this repository is.
2. **A PAT with the `workflow` scope**, to land `docs/pending-workflow/deploy.yml` — which
   carries the post-deploy probe *and* TAB 05's rollback. Both are blocked on the same
   credential.

Neither is a code change, and neither is inside the local-only boundary this work runs under.
