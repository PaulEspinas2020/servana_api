# TAB 06 — Unblock the push path and end the shared-tree collisions

**Status:** local scope COMPLETE · **Date:** 2026-08-19

Two of the five items are code and are done. Three need a credential or a
repository setting and are not this programme's to change.

---

## 1. The suite-count ratchet — FIXED

`tests/suite-inventory.test.ts` pinned an **exact** suite count. That works for
one writer and fails for two: incrementing a shared counter is not commutative,
so two agents each adding a suite from the same base both compute `base + 1`,
and whichever lands second is wrong — red on a tree where nothing is missing.

It happened repeatedly on 2026-08-19, and the comment now replaced recorded an
earlier instance at the `origin/main` merge, where two branches held 295 and 278
and **both were correct for themselves**.

A red gate everybody has learned to fix by editing the number is not a gate. It
is a chore that trains people to change the assertion.

**Now a floor.** The purpose was never the exact number — it was noticing a
suite that *disappears*, and a deletion drops below a floor exactly as it broke
a pin. Addition is the only direction two writers collide on, and a floor
tolerates it.

Proven in both directions rather than argued:

| change | before | after |
| --- | --- | --- |
| a suite is deleted | red | **red** ✅ |
| another agent adds a suite | **red (false)** | **green** ✅ |

A swap — one removed, one added — keeps the count level and passes. It did under
the exact pin too; the named-fixture assertion is what guards the suites that
matter most.

---

## 2. Sharing one working tree — the practice that must stop

Three false measurements in a single session, each costing real time:

| # | what was measured | why it was wrong |
| --- | --- | --- |
| 1 | `deploy-gating.test.ts` red, 3 tests | the other session had `deploy.yml` open mid-edit |
| 2 | suite totals moved 6,223 → 6,226 → 6,223 between runs | files appearing and vanishing under the runner |
| 3 | 4 suites red before a push | `docs/api/*` mid-regeneration by the other session |

In every case the **committed** tree was green. The shared directory was
reporting the union of two half-finished states, which is a state neither agent
was ever in.

### The fix

Each agent gets its own worktree off the same repository:

```bash
git worktree add ../servana_api-agent-a main
git worktree add ../servana_api-agent-b main
```

They share history and objects — commits are visible to both immediately — and
neither can see the other's uncommitted edits. That is precisely the property
that was missing.

**Verification, whichever way this is resolved:** run any suite that decides
something from a detached worktree at a known commit, never from the shared
directory:

```bash
git worktree add --detach /tmp/verify HEAD
```

This programme used that technique for every result it reported after the first
false reading, which is why its numbers held.

---

## 3. The credential — NOT actionable here

Both repositories reject `git push` when the push's resulting tree differs under
`.github/workflows/`:

```
refusing to allow a Personal Access Token to create or update workflow
`.github/workflows/…` without `workflow` scope
```

Worth separating from the other constraint, because conflating them wastes an
afternoon:

| restriction | governs |
| --- | --- |
| PAT lacks `workflow` scope | whether you may **modify** a workflow file |
| Actions credit exhausted | whether a workflow **runs** |

`[skip ci]` addresses the second only. The client push succeeded because
nothing there asserts on `flutter-ci.yml`; the backend needed the parallel
session to land its workflow changes first, after which matching `origin/main`
became a no-op.

**Fix:** `workflow` scope on the token, or an SSH remote, which is not subject
to the rule:

```bash
git remote set-url origin git@github.com:PaulEspinas2020/servana_api.git
```

## 4. Branch protection — NOT actionable here

A repository setting. The current instruction is explicitly to push straight to
`main` without review, so this is recorded as a deliberate position rather than
a gap: with no review gate, the **pre-push hook is the only thing standing
between a working tree and production**, since `deploy.yml` deploys on push.

That raises the stakes on the hook's reliability — see below.

---

## Carried to TAB 04: the pre-push hook is not reliable

`npm run verify` **segfaulted** (SIGSEGV, exit 139) during a push on
2026-08-19, while `npm run test:ci` passed standalone three times in a row.

The hook is now the only gate before a production deploy. A gate that fails
intermittently gets bypassed with `--no-verify`, and the first time that happens
it will be during an incident, in a hurry, by somebody who has learned the
failure is usually spurious.
