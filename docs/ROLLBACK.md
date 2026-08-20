# Rollback: what exists, what it restores, and what it cannot

**Measured 20 August 2026**, in response to TAB 05.

```
ROLLBACK_REHEARSED: PARTIAL — the procedure has been executed and timed locally.
                    NOT rehearsed against production, which needs a deploy.
```

## The measured state

| | |
|---|---|
| rollback references in `.github/workflows/deploy.yml` (the workflow that runs) | **0** |
| rollback references in `docs/pending-workflow/deploy.yml` (parked) | 10 |
| retained previous build on the host | **none** |
| blocker | the PAT lacks the `workflow` scope |

The rollback is **absent from production, not merely unrehearsed.** "Unrehearsed" invites
*"risky, but there if we need it."* There is none.

## What rehearsal found: the parked rollback was inoperative

The parked workflow snapshotted the **running** build after checkout and before `npm run
build` overwrote `dist/`. It could never have worked:

- `dist` is gitignored — `.gitignore:109`
- `actions/checkout@v4` defaults to `clean: true`, which runs `git clean -ffdx`, and `-x`
  removes ignored files. Verified: `git clean -ffdxn -- dist` → **"Would remove dist/"**
- the snapshot step ran at line 169; checkout at line 70

So it would have taken its `::warning::no dist/ to snapshot` branch on **every deploy**, and
the rollback beneath it would have found *"there is NO previous build to restore"* every time
it was ever needed.

**A rollback that reads as present and is absent is worse than a missing one, because nobody
goes looking.** This is what "a rollback that has never been executed is a hypothesis" buys in
practice — not a risky recovery, an absent one.

The parked file is corrected: retention now runs **after the post-deploy probe passes**, so
what is kept is a build known to have served traffic. `tests/rollback-capability.test.ts`
holds the ordering so it cannot quietly revert.

## What now exists, and can land

The automated rollback is blocked on a credential. `scripts/` is not.

| | |
|---|---|
| `scripts/rollback.sh` | restore the previous build, restart, verify, print a duration |
| `scripts/snapshot-build.sh` | retain a **proven** build, prune to `KEEP` |

That changes what is true today: instead of *"there is no rollback"*, there is one an operator
can run by hand during an incident — and one that has actually been executed.

When the workflow lands, its rollback step **calls these** rather than restating them. One
definition, rehearsed, in files that can be tested.

## The rehearsal

Real script, real Node process, real HTTP, substituted process manager:

```
previous build (aaa111) running, healthz 200
  deploy a deliberately BROKEN build (bbb222)   -> healthz 503   (probe fails here)
  scripts/rollback.sh
    currently  bbb222
    restoring  aaa111
    RECOVERED in 1s
    serving    aaa111        <- read from /api/v1/health, i.e. the PROCESS
  healthz 200
```

**The 1s is not the production number.** It is the mechanical time — copy, restart, first
healthy response — for a trivial stand-in app. Production additionally pays PM2 start, Node
boot and the awaited dependency graph. **A production recovery time is still unmeasured, and
no certification of this platform can state one.**

Also rehearsed:

- **nothing to restore** → exits 2, prints *"Do not stop the running process"*, and the
  running process is verified still serving 200. This is the property that matters most:
  discovering there is no snapshot *after* stopping the process turns a bad deploy into an
  outage.
- **`--dry-run`** → reports what it would do, changes nothing.
- **retention with `KEEP=2`** → prunes oldest first, keeps `previous` plus the newest two.
- **a build that cannot name itself** → refused, because restoring onto an unidentifiable
  build leaves you mid-incident unable to say what you rolled back onto.

Rehearsal also found a portability defect that reading would not have: pruning used
`head -n -N`, a GNU extension. macOS rejects it with *"illegal line count"*, the error scrolls
past, and **pruning silently does nothing while the directory grows without bound.** The deploy
host is Linux, so this would have shipped and only ever bitten whoever tried to rehearse it.

## What a rollback does NOT restore

**Applied migrations stay applied.** Migrations run before the restart and are additive by
policy; the previous build tolerates the newer schema, which is why that ordering was chosen.
A migration that is not backward-tolerable must not ship in the same deploy as the code that
needs it — that is a two-deploy change, and no pipeline can enforce it.

**`.env` is untouched.** This is the one that matters most, and it is not hypothetical: when
production returned 500 on every database-backed read for six days, the leading hypothesis was
configuration. **A rollback would not have helped**, and every code-level recovery would have
failed while looking entirely reasonable.

**Uploaded files, external state and anything already sent** — payments, emails, SMS — are
gone forward, not back.

**The first deploy after retention lands has no snapshot and therefore no rollback.** A
known-good build has to be proven once before it can be kept. There is no way around it.

## What is still required, and by whom

1. **A PAT with the `workflow` scope**, to land `docs/pending-workflow/deploy.yml`. The same
   credential blocks TAB 04's post-deploy probe.
2. **One deploy** to establish the first retained build.
3. **A production rehearsal with a measured duration**, written back into this document —
   deploy a deliberately broken build, let the probe fail, watch the rollback restore, record
   the elapsed time.

None of these is a code change, and none is inside the local-only boundary this work runs
under.
