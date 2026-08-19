# TAB 02 — Reconcile the diverged backend repository · verification

**Status:** VERIFIED, one commit outstanding · **Date:** 2026-08-19
**Verified at:** `80f2cb7`

---

## The merge was performed by the parallel session

`c971d88 merge origin/main: reconcile 17 upstream commits with 47 local ones`.
This TAB therefore **verifies** rather than performs it — a merge nobody checked
is the same risk as a divergence nobody reconciled.

## Gate results

| Requirement | Result |
| --- | --- |
| One history, zero commits dropped, **proven by hash** | ✅ |
| Both pre-states named and reachable | ✅ tagged |
| Full suite green on the merged tree, **from a clean worktree** | ✅ 297 suites / 6,250 tests, exit 0 |
| `tests/v1-contract.test.ts` — all four contract consumers agree | ✅ 36 passed |
| Written conflict list | ⚠️ not produced by the merging session |
| Fully converged with `origin/main` | ⛔ **1 commit outstanding** |

### Nothing was dropped

Asserted by `git merge-base --is-ancestor`, not by inspection. All six of this
programme's backend commits reachable — `d7a2097`, `086738c`, `fcba273`,
`1c658c8`, `d4410f3`, `80f2cb7` — and every sampled upstream commit likewise:
`44600a6`, `a73b507`, `3ac9548`, `bdbe97f`, `26d31e3`.

### The snapshot tags

The TAB asks for `pre-reconcile-local` and `pre-reconcile-remote` **before**
merging. The merge had already happened, so tagging beforehand was not
available — but its two parents *are* those exact states, so both are now named:

```
pre-reconcile-local   689e7b9   (47 local commits)
pre-reconcile-remote  44600a6   (17 upstream commits)
```

The recoverability the gate exists for is intact; only the ordering differed.

### Why the clean worktree mattered

The shared working directory reported **3 failures** in `deploy-gating.test.ts`
at the same moment. They are not in the committed code — that test reads
`deploy.yml` and `release-gate.yml`, both modified in the tree by the parallel
session while it works. Run from a detached worktree at the same commit, the
suite is **entirely green**.

This is the second time in two days that measuring a shared working tree
produced a false result. It is the argument for TAB 06's per-agent worktrees.

## Outstanding

`82abbd0 db: recapture the baseline from production — 120 tables to 132, 8 pending to 1`
is on `origin/main` and not in the local history. **Landing it is a merge, which
this programme's boundary excludes**, so it is left for the repository owner.

It matters beyond convergence: it is the first accurate picture of production's
schema, captured by `pg_dump --schema-only` over SSH. Two things it settles are
recorded in [TAB01_CATALOG_OUTAGE.md](TAB01_CATALOG_OUTAGE.md).
