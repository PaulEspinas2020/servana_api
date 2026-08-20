# TAB 00 — Baseline gate, before any change in this programme

Run at the start of the Backend Admin API Master Command, on a clean tree at
`servana_api@7653082`.

```
npm run verify

Test Suites: 315 passed, 315 total
Tests:       6608 passed, 6608 total
Snapshots:   0 total
Time:        75.246 s
EXIT=0
FAIL lines:  0
```

## Why the exit code alone was not accepted as evidence

A previous session in this repository recorded `npm run verify | tee` reporting
exit 0 over a run with a red suite — the pipeline's exit status is `tee`'s, not
the gate's. This run therefore wrote `EXIT=$?` to the log on its own line, with
no pipe in the chain, and the jest summary was read directly. Both agree.

Every later TAB in this programme re-runs this gate and compares against these
exact numbers. A suite count that FALLS is a regression even if the run is
green — a deleted suite and a passing suite look identical in an exit code.

## Environment note, not a defect

The run reports unset `DB_USER`, `DB_HOST`, `DB_DATABASE`, `DB_PASSWORD` and a
degraded feature list. That is expected for a local gate: the suites that need a
real database use PGlite, and the env warning is `validateEnv` doing its job.
It is `fatal in production` and advisory here.

---
Servana Backend — Admin API Master Command · TAB 00
