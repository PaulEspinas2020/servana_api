# V2 TAB 03 — the gate, re-scoped, restored, and re-suspended

> **SUPERSEDED IN PART, 2026-08-19.** §6 asked the owner two questions. They
> answered directly — *"WE RAN OUT OF CREDIT ACTIONS SO DON'T PUSH WITH CI FROM
> NOW ON"* — so the wiring is **suspended again** and the automatic triggers are
> removed. The analysis below is left intact rather than rewritten, because the
> useful part is not its conclusion but its shape: a public fact about GitHub's
> pricing cannot settle a private fact about an account's state, and this record
> treated the two as the same kind of claim. The owner reads the billing page;
> the API does not.

> **P0.** Implemented 2026-08-19 against `servana_api` at `932aedc`.
> Closes F-03 — but **not** by the route the book prescribed.

---

## 1. The book's instruction would have bricked the pipeline

V2 TAB 03 says: make `deploy` depend on the gate. Between the book being written
and being run, `origin/main 463f963` made `release-gate.yml`
`workflow_dispatch:`-only, on the recorded premise that **the repo's GitHub
Actions credit is exhausted and is not being topped up** (owner decision,
2026-08-19).

The gate job is `runs-on: ubuntu-latest`. With no credit, `needs: [release-gate]`
stops meaning *"wait for the gate"* and starts meaning **"never deploy again"** —
it queues a GitHub-hosted job that cannot start, leaving `deploy` permanently
SKIPPED. Every push to `main` is the production deploy, so the merged pipeline
would have deployed nothing at all.

Executing the book literally was therefore not an option. Re-scoping it was.

## 2. The premise was re-measured, and it does not apply to this repository

| Question | Evidence |
| --- | --- |
| Is `servana_api` public? | `GET api.github.com/repos/PaulEspinas2020/servana_api` → `"private": false, "visibility": "public"` |
| Are standard runners free in public repos? | GitHub billing docs, verbatim: *"The use of standard GitHub-hosted runners is free … In public repositories."* |
| Is `ubuntu-latest` a standard runner? | Yes — larger and GPU runners are the billed classes. |

**So every job in `release-gate.yml` costs this repository nothing.** If credit is
genuinely exhausted somewhere in the account, it is being consumed by *private*
repositories; a public repo can neither contribute to that total nor be starved
by it.

## 3. The alternative was considered and rejected on evidence

Moving the gate to the self-hosted runner would also be free. It was rejected for
two independent reasons, either sufficient:

1. **It would not complete.** The self-hosted runner *is* the production host —
   **961 MB of RAM**, on which `npm run verify` has already died **twice with
   exit 134** (SIGABRT: the V8 heap gave out). The suite's measured peak is
   **~1.1 GB**. That is not a tuning problem.
2. **It defeats the purpose.** A gate exists to stop bad code *reaching* the
   host. A gate that runs *on* the host has already lost.

## 4. What changed

| Change | File |
| --- | --- |
| `push` + `pull_request` triggers restored above `workflow_dispatch` | `release-gate.yml` |
| Full evidence chain recorded **in the file**, not only in a commit | `release-gate.yml` |
| `release-gate` job un-commented; `needs: [release-gate]` restored | `deploy.yml` |
| Assertions re-pointed from the suspended state to the restored one | `tests/deploy-gating.test.ts` |

**The pre-push hook stays.** It is defence in depth, it costs nothing, and it
catches a fault *before it leaves the machine* — earlier than any CI can. It is
explicitly not a replacement: it is per-clone (`core.hooksPath`) and bypassable
with `--no-verify`, and the file says so.

## 5. Gates

```
npm run verify                     PASS exit 0 — 297 suites, 6252 tests
npm run authz:legacy               PASS exit 0
tests/deploy-gating.test.ts        20 tests
YAML                               both workflows parse; deploy needs: [release-gate]
```

**Mutation-verified:**

```
MUTATION  comment out needs: [release-gate]        → 1 failed (F-03 returns)
MUTATION  make the gate workflow_dispatch-only     → 1 failed (a gate nobody runs)
```

The reader that counts jobs was itself validated against the suspended state,
where it correctly reported **one** job; it now reports **two**. A parser that
counted commented jobs would have been wrong in exactly one of those states.

## 6. ⚠ This reverses a recorded owner decision

Stated plainly rather than buried. The suspension was deliberate, documented and
carefully reversible — nothing about it was careless. What it rests on is a
premise that measurement contradicts **for this repository**.

**It needs the owner's confirmation before it takes effect**, which it cannot do
from a local commit in any case: nothing has been pushed. If the owner has
information this analysis lacks — Actions disabled account-wide, an
organisation-level policy, a billing state not visible from the public API — then
the suspension was right and the correct move is to re-suspend and record *that*
reason instead, because the one currently recorded is not it.

Two questions settle it:

1. Does the Actions tab on this repository still run workflows at all?
2. Was the observed exhaustion on a **private** repository in the same account?

## 7. What could NOT be done here

| Book step | State | Why |
| --- | --- | --- |
| Demonstrate a failing gate produces a SKIPPED deploy | **NOT DONE** | Requires a push; a push to `main` is the production deploy and is outside the standing boundary. |
| GitHub `production` environment + required reviewer | **NOT DONE** | Repository settings, and the reviewer must not precede an agreed break-glass path. |
| Protect `main` | **NOT DONE** | Repository settings. |
| Rehearse the rollback | **NOT DONE** | Written, never executed. **A rollback nobody has run is a hypothesis.** |
