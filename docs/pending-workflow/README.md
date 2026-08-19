# Workflow changes held back from `main`

Three workflow files are **in git history but not in the tip of `main`**. They
were reverted at the tip solely so the push could succeed, and the finished
files are here for a one-command restore.

## Why

Two independent restrictions, easily conflated:

| restriction | governs | status |
| --- | --- | --- |
| PAT lacks `workflow` scope | whether you may **modify** `.github/workflows/*` | **blocking the push** |
| Actions credit exhausted | whether a **GitHub-hosted** job can start | separate; self-hosted is unaffected |

GitHub checks the resulting **tree diff** for workflow paths, not whether
intermediate commits touched them — so matching `origin/main` at the tip is what
let 58 commits through. The code landed; this configuration did not.

## What is held back

- **`deploy.yml`** — 203 lines, almost all of it the reasoning for why the
  release gate is *suspended rather than deleted*: `release-gate.yml` is
  `runs-on: ubuntu-latest`, so calling it while credit is exhausted queues a job
  that cannot start, and `needs: [release-gate]` would then leave `deploy`
  SKIPPED — no production deploy at all. Both lines must be restored **together**,
  and only once credit exists.
- **`release-gate.yml`** — keeps the `workflow_call:` trigger the above depends on.
- **`fresh-db.yml`** — the runtime-role `CREATE` grant fix.

`origin/main`'s `deploy.yml` is functionally equivalent today: it deploys on push
to `main` on the self-hosted runner, ungated. Nothing about the running pipeline
changed by holding these back — only the written reasoning is absent, which is
why it is preserved rather than lost.

## The gate did not disappear, it moved

`scripts/hooks/pre-push` runs the full `npm run verify` before a push to `main`
leaves the machine. Weaker in one named way: it passes with credentials present,
where 4 suites fail without them.

## Restoring

```bash
git remote set-url origin git@github.com:PaulEspinas2020/servana_api.git
cp docs/pending-workflow/*.yml .github/workflows/
git add .github/workflows/ && git commit -m "ci: restore the suspended gate wiring [skip ci]"
git push origin main
```

Keep `[skip ci]` until Actions credit is restored.
