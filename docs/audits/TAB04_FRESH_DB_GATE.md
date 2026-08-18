# TAB 04 — repairing the schema gate that had never executed

> **Closes F-05 (P1).** Implemented 2026-08-18 against `servana_api` at `c2c73d2`.

---

## 1. Root cause, found and verified against the primary source

`.github/workflows/fresh-db.yml` failed at startup on every push — 0s duration,
no log, *"This run likely failed because of a workflow file issue."*

The file is **valid YAML**. It parses cleanly, which is why "check the syntax"
never found anything. The fault was one line:

```yaml
  fresh:
    if: hashFiles('scripts/baseline/000-baseline.sql') != ''   # line 86
```

**`hashFiles` is not available in a job-level `if`.** GitHub's Actions context
reference lists `jobs.<job_id>.if` as accepting the contexts `github, needs,
vars, inputs` and the functions `always, cancelled, success, failure`.
`hashFiles` appears only under `jobs.<job_id>.steps.if` — it hashes files in the
runner workspace, and no workspace exists when job conditions are evaluated.

An unrecognised function in a job condition fails the workflow at **parse time**,
before a runner is assigned. There is no log because nothing ever started.

> Verified against
> `https://docs.github.com/en/actions/reference/workflows-and-actions/contexts`
> rather than inferred from the symptom. The book's own rule — research the
> primary source before acting — is what separated this from the three other
> plausible-looking candidates.

### 1.1 Why this mattered more than an ordinary red build

The workflow was not failing loudly; it was **absent while appearing in the
checks list**. Its three jobs are the zero-to-current database guarantee, and
`fresh` is the only one that can catch an ownership defect — PGlite runs as a
single bundled superuser, so role separation is invisible to `embedded`.
Ownership is precisely the defect that once left **29 of 116 production tables
unusable** by the application. Migrations 036 and 037 reached production while
the only job that could have caught that class had never run.

## 2. Two recorded facts that were stale, both checked rather than trusted

**The `static` job is not red-by-design any more.** The header comment said
"this job is RED until a baseline is captured", and `state.json` recorded
`db:verify` as exiting *non-zero by design*. Measured directly:

```
npm run db:verify             exit 0   RESULT: PASS
npm run db:verify:embedded    exit 0   132 tables
```

Exit codes were read **directly, not through a pipe** — the book warns that
piping to `tail` has previously reported success over a red run in this
repository, and that warning applies equally to reading a stale note as to
reading a stale log. The comment is corrected; a comment describing a green job
as red-by-design is worse than none, because the next person to see it fail will
assume it always does.

**The second replay already exists.** The header claims the `fresh` job "replays
them a second time to prove replayability", and step 5 of the TAB asks for it to
be added. It is already implemented inside `scripts/verify-fresh-db.ts` (§159),
and it correctly *excludes* the baseline — a `pg_dump` artifact is not idempotent
and is not supposed to be. Nothing was added; the comment now says where it
lives so the next reader does not add a duplicate.

## 3. What was changed

| Change | File | Why |
| --- | --- | --- |
| Deleted the job-level `if: hashFiles(...)` | `fresh-db.yml` | The parse-time fault. **Deleted, not moved to a step** — see D1. |
| Corrected the `static` red-by-design comment | `fresh-db.yml` | It is green; the note was stale. |
| Documented where the §159 second replay lives | `fresh-db.yml` | Stops the next reader adding a second one. |
| `EXPECTED_TABLE_COUNT = 132`, **asserted** | `scripts/verify-fresh-db.ts` | See D2. |
| `scripts/lib/workflowFile.ts` | new | One reader for workflow files, shared with TAB 03's test. |
| `tests/workflow-startup-validity.test.ts` | new | Closes the class: no job-level condition may use a step-only function. |

## 4. Decisions taken autonomously

**D1 — delete the condition rather than move it to a step.** The obvious repair
is `steps.if: hashFiles(...)`, which is valid. But the condition meant *"skip
this job until a baseline is captured"*, and `scripts/baseline/000-baseline.sql`
is now the declared schema authority. Moving the guard would faithfully preserve
the skipping that the baseline's existence made unnecessary — repairing the
mechanism while keeping the outcome nobody wants.

**D2 — assert the table count, do not merely print it.** Both the embedded and
live paths reported a final count and neither checked it. A count that is printed
and unchecked is a number somebody reads once: a migration that quietly created
one table fewer produced a green gate and an accurate-looking log. The number is
**written down rather than derived**, because deriving it from the migrations
would compare the chain against itself and pass by construction. 132 is what
production reached after 036/037 and what `db:verify:embedded` independently
reaches from baseline + pending. Raising it is the expected case when adding a
table; a *drop* is the one to stop and think about.

**D3 — one workflow reader, not two.** TAB 03's test had already grown a job
parser. Rather than write a second one, it moved to `scripts/lib/workflowFile.ts`
and both tests import it. Two readers of one file format is exactly the duplicate
reality §9 is about, and this repository has been bitten by two ledgers for one
question before.

**D4 — the detector distinguishes job-level from step-level `if`.** A blanket
"no `hashFiles` in workflows" rule would ban a legitimate cache-key step, and a
gate that forbids correct code gets switched off. The reader matches on the job
key's own indentation, and a positive control asserts a step-level `hashFiles` is
**not** reported.

## 5. Gates

```
npm run db:verify             PASS exit 0     static replay, no engine
npm run db:verify:embedded    PASS exit 0     132 tables, converged
tests/workflow-startup-validity.test.ts        9 tests
tests/deploy-gating.test.ts                   17 tests, now on the shared reader
```

**Mutation-verified — both new gates watched failing:**

```
MUTATION  declare EXPECTED_TABLE_COUNT = 133 when a fresh DB reaches 132
          → "DIVERGENCE: a fresh database reaches 132 … declare 133"
          → EMBEDDED RESULT: FAIL, exit 1

MUTATION  reintroduce `if: hashFiles(...)` on the fresh job — the exact line
          that stopped this workflow from ever running
          → 2 failed, 7 passed
```

Both reverted; all green, and `fresh-db.yml` re-validated as parseable YAML with
its three jobs intact.

## 6. What could NOT be done here

| Book step | State | Why |
| --- | --- | --- |
| `actionlint .github/workflows/fresh-db.yml` | **NOT RUN** | `actionlint` is not installed on this machine. The fault it would have caught was found by reading GitHub's context reference and is now asserted by a test that runs in `verify` — which `actionlint` would not have done, since it is not in CI either. Manual task 04.2. |
| `gh workflow run fresh-db.yml` and watch a real run | **NOT RUN** | `gh` absent; remote operation. Manual task 04.1. |
| Confirm the `fresh` job is green on a real engine | **NOT RUN** | Needs a PostgreSQL service container in CI. The convergence assertion added here runs in the embedded path locally; the **ownership** assertion still only executes in `fresh`, which has still never run. Manual task 04.1. |
| Make the job a required status check | **NOT RUN** | Repository settings. Manual task 04.3 — and **not before three consecutive green runs**, or it becomes the cosmetic blocker TAB 03 describes. |

**The honest headline: the parse fault is fixed and the workflow can now start.
Whether its three jobs are GREEN is still unknown**, because they have never
executed. `static` and `embedded` pass locally, which is good evidence for two of
the three. `fresh` — the ownership job, the one that matters most — remains
unverified.
