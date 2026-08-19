# The deploy typechecks the test suite on a 961 MB host, and it now aborts

`Deploy Servana API (Prod)` failed at run `32245108841` (commit `72a3ac2`,
2026-08-19T10:58Z) with **exit code 134 — SIGABRT**, at:

```yaml
- name: Typecheck (source and tests)
  run: npm run typecheck && npm run typecheck:tests
```

It failed *before* Build, before `Plan pending DB migrations`, before
`Restart PM2`. **Production was never touched** — the running process kept
serving, no migration ran, nothing restarted. The pipeline failed safe, which is
the design working, and is why this is a pipeline defect rather than an
incident.

## Measured, not inferred

Peak resident set size of the two commands, on the committed tree at
`origin/main`:

| command | peak RSS |
| --- | --- |
| `npm run typecheck` (`tsc --noEmit`) | **513 MB** |
| `npm run typecheck:tests` (`tsc -p tsconfig.tests.json`) | **805 MB** |

The deploy host has **961 MB of RAM** and is *simultaneously serving
production* — the API process and PM2 are resident throughout. An 805 MB
compiler on that box does not fit, and 134 is what the abort looks like.

Earlier deploys today succeeded (02:03, 02:18, 02:24, 02:35, 09:33) because the
test surface was smaller. This is not a flake that will pass on retry; the
number only grows, so every future deploy fails from here.

## The fix: stop typechecking on the release host

The step is **redundant**, not merely expensive. `scripts/hooks/pre-push`
already runs the full `npm run verify` — which includes `typecheck` *and*
`typecheck:tests` — against the working tree before any push reaches GitHub, and
that hook is currently the repository's real gate because Actions credit is
exhausted. The deploy host is re-proving, in the worst possible place, something
already proven on a machine with enough memory to prove it.

Replace the step with the build, which the deploy genuinely needs and which
typechecks the source anyway as a side effect:

```yaml
# Typechecking is enforced by scripts/hooks/pre-push, which runs the full
# `npm run verify` (typecheck + typecheck:tests + suite) before a push can
# reach GitHub. Re-running it here cost 805 MB on a 961 MB host that is
# serving production at the same time, and aborted with SIGABRT once the
# test surface grew past the margin. `npm run build` still fails on a type
# error in source, which is what this step is protecting.
- name: Build
  run: npm run build
```

If the belief-in-defence-in-depth wins over the arithmetic, the alternative is
**swap on the host** — 2 GB is ample — and nothing in the workflow changes. What
must not happen is leaving an 805 MB step on a 961 MB box and reading the red as
noise.

## Why this is held here

The PAT cannot push `.github/workflows/*` (see [README.md](README.md)). The
change above is four lines; it is held here rather than applied.

## Unrelated, and NOT fixed by any deploy

Production is separately **degraded** and has been since before this run:

```
GET /readyz -> 503   phase=degraded ready=false live=true
  required admin-permission-seed: failed
    SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string
```

`DB_PASSWORD` is unset or non-string in the running process's environment, so
every catalog and search read returns 500 while `/healthz` stays 200. It is an
**environment fix** — set the secret and restart. A successful deploy would not
have fixed it and would have restarted into the same state.
