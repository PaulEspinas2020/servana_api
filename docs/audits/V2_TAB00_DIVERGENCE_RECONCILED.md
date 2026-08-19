# V2 TAB 00 — reconcile the divergence

> **GATE.** Verified 2026-08-19 against `servana_api` at `32f80f3`.
> Book: Servana Production Launch Master Command **V2**.

---

## 1. The premise was overtaken by events, one day after it was written

V2 TAB 00 was authored against a measured divergence: `origin/main` 17 ahead,
local 47 ahead, no fast-forward in either direction. By the time it came to be
executed, **the merge had already been performed**:

```
c971d88  merge origin/main: reconcile 17 upstream commits with 47 local ones
git merge-base --is-ancestor origin/main HEAD   →  YES
git rev-list --count HEAD..origin/main          →  0
```

So this TAB became **verification rather than execution**. That is worth
recording rather than quietly re-scoping: a book measures a moment, and this one
went stale in under twenty-four hours. The correct response is to re-measure and
say so, which is the same discipline V1 TAB 00 existed to enforce.

## 2. The three collision points — both sides survived

The book named three files where the workstreams overlapped and warned that a
clean auto-merge was likely while a **semantically** correct one was not. Checked
individually rather than trusted:

| Collision point | Expected | Measured |
| --- | --- | --- |
| `src/api/v1/contract.ts` | this book's `permission` field **and** the other workstream's `migrated` callers | `permission?: string` present; **41** `providerWeb: 'migrated'` markers present; **5** admin entries `implemented` |
| `tests/suite-inventory.test.ts` | the post-merge count on disk, not either input | declared **297**, on disk **297** |
| `package.json` | union of both sides' scripts | **64** scripts |

**Nothing was resolved by `--ours` or `--theirs`.** Both sides are present in
every case, which is the criterion that distinguishes a merge from a choice.

## 3. Gates — from a clean clone, as the criterion requires

```
git clone <local> /tmp/clean-clone
npm ci                       exit 0
npm run verify               PASS   297 suites, 6250 tests
npm run db:verify:embedded   PASS   132 tables
npm run schema:authority     PASS   UNMANAGED 0
npm run authz:legacy         PASS   0 loosenings
```

Run in a fresh clone with no `node_modules`, because a populated one masks a
broken install. The working tree produced identical figures.

## 4. A material change that invalidates part of V2 TAB 03

Found while reconciling the tree, and it is the most important thing in this
record:

> **The repository's GitHub Actions credit is exhausted and is not being topped
> up — owner decision, 2026-08-19.**

`release-gate.yml` is therefore `workflow_dispatch:`-only. The gate job is
`runs-on: ubuntu-latest`, so `needs: [release-gate]` in `deploy.yml` no longer
means *"wait for the gate"* — it means **"never deploy again"**, because the
gate queues a GitHub-hosted job that cannot start.

**V2 TAB 03 is written against a premise that no longer holds.** Its central
instruction — make `deploy` depend on the gate — would brick the pipeline.

### 4.1 What replaced it, and why it is honestly weaker

The wiring is **commented out, not deleted**, and `workflow_call:` is retained,
so restoring it is uncommenting when credit returns. The gate moved to
`scripts/hooks/pre-push`, which runs the full `npm run verify` before a push to
`main` leaves the machine.

Two limitations are stated in the test file rather than implied:

- the hook is **per-clone** (`git config core.hooksPath scripts/hooks`), so a
  fresh clone is ungated until somebody runs that;
- **any hook is bypassable** with `--no-verify`.

The Actions gate had neither weakness. **This is a weaker gate being honestly
labelled, not an equivalent one** — and the assertions were re-pointed rather
than deleted, because an enforcement point that disappears when it becomes
inconvenient was never an enforcement point.

## 5. Acceptance criteria

| Criterion | State |
| --- | --- |
| One tree contains all local and all remote commits; nothing discarded, nothing force-pushed | **MET** — merge commit `c971d88`; `origin/main` is an ancestor |
| Every gate passes from a clean clone, recorded with the SHA | **MET** — `32f80f3`, four gates, 6250 tests |
| Each collision point resolved with a stated reason, not `--ours`/`--theirs` | **MET** — both sides present in all three |
| The other workstream confirmed their commits survived intact | **NOT DONE** — requires a person. Their 17 commits are verifiably present; confirmation is theirs to give. |

## 6. Consequence for the rest of V2

**TAB 03 must be re-scoped before it is run.** Its objective — a gate the deploy
cannot bypass — is currently unattainable through Actions, and the honest
alternatives are: restore credit, self-host the gate runner (the deploy runner
already is self-hosted), or accept the pre-push hook and document that a fresh
clone is ungated.

Recorded here rather than left for whoever opens TAB 03 to rediscover.
