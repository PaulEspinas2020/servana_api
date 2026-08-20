# Production readiness — what stands between here and operational

> Evidence, not estimate. Every number below was measured in this repository on
> 2026-08-18; the method is named beside each one so it can be re-run.

## The headline

**CORRECTED 2026-08-18 (TAB 00 of the Admin Portal Production Launch Master
Command V1).** This document previously read "built and gated, and neither
deployed nor adopted", and recorded `origin/main = 2e03a4b`. Both statements
were true when written and are false now. They are corrected here rather than
appended to, because a stale headline is read as the answer and an appended
correction is read as a footnote.

The v1 backend is **deployed. It is not yet adopted.**

```
backend implementation      COMPLETE   95 canonical endpoints from ONE contract
local verification          GREEN      276 suites, 5935 tests, exit 0 (2026-08-18)
startup                     BOOTED     binds, resolves the graph, /readyz 503 when degraded
production deployment       DEPLOYED   d4b0150 — deploy run 32119165101, 2026-08-18T09:09:15Z
v1 surface in production    MOUNTED    98/98 probeable routes answer, 0x 404
client adoption             ZERO       615 legacy routes mounted, 0 of 108 migrated
admin domain of v1          1 OF 105   the integration gap is a MISSING DOMAIN, not a deploy
production smoke            NEVER RUN  tooling delivered, never executed
```

The line to hold on to is now the second-to-last. The blocker recorded in every
prior session — "the deploy failed, production serves no `/api/v1`" — is gone.
What replaced it is a smaller and more precise problem: the v1 layer was built
for the client applications, so of its 105 routes exactly **one** is
admin-authenticated. The admin portal cannot migrate onto a surface that does
not model its domain. See `docs/LAUNCH_BASELINE.md`.

### How this correction was evidenced

Stated plainly, because this document's own rule is that the method is named
beside the number:

- **Locally verified, by this session.** `origin/main` in this clone resolves to
  `d4b0150`, and `d4b0150` is an ancestor of `HEAD` — so the commit the book
  names as deployed is a real, pushed commit in this history, not a claim.
  `npm run verify`, `npm run db:verify:embedded` and `npm run schema:authority`
  were executed here and are green.
- **Taken from the Master Command V1 evidence base, NOT re-probed here.** The
  deploy-run id, the timestamp, and the 98/98 route probe. This session holds no
  authorisation for production access, so it did not re-run those probes. They
  are recorded as measured-by-the-book and are listed for re-execution in
  `docs/MASTER_TODO_MANUAL_TASKS.md`.

Every certification in `docs/` remains a statement about **this repository**,
proven against tests and an in-process PostgreSQL — with the single exception of
the deploy facts above, which are statements about the running system on the
authority named beside them.

---

## 1. The cutover, as measured on 2026-08-18

### 1.0 There is no "legacy backend" to replace

Worth stating first, because it changes the shape of the job. The legacy API and
the v1 API are **one repository, one branch, one process**. `/api/v1` was built
ADDITIVELY alongside 615 mounted legacy routes, deliberately, because zero of 108
client endpoints have migrated.

So this is not an overwrite of one system by another. It is a **deploy of 109
commits** to the same service. Nothing gets replaced; new routes appear beside
the old ones, and the old ones keep serving until clients move.

Corollary, and it is load-bearing: **do not remove legacy routes as part of this.**
Both command books state it as a STOP condition — never remove or reshape a
legacy endpoint while an installed client still calls it. Every installed client
still calls them.

### 1.1 DONE — the production migration ledger exists

`servana.schema_migrations` was created on 2026-08-16 with 30 rows marked, and
030-035 were then applied. Production is at 128 tables. This section previously
described that as blocking; it is complete.

### 1.2 DONE — 030-035 are applied

Applied and verified 2026-08-16: 36 ledger rows, 128 tables, 0 objects not owned
by `admin`, `servana-prod` 0 restarts.

### 1.3 The database is AHEAD of the deployed code

Production ran migrations 030-035 while still serving the code from `2e03a4b`
(2026-08-11). That is the safe direction — additive schema the old code simply
does not use — but it means the deploy is closing a gap, not opening one.

### 1.4 ⛔ Do NOT overwrite the database

`scripts/baseline/000-baseline.sql` is **schema-only**: 0 `INSERT`, 0 `COPY`.
Restoring it over production would produce a correct, empty schema and destroy
every row — 109 real bookings, every user credential, every payment record.

It is also unnecessary. Every pending migration is additive:

    036   4 CREATE TABLE IF NOT EXISTS, 2 CREATE INDEX IF NOT EXISTS,
          1 ADD COLUMN IF NOT EXISTS block, 4 OWNER TO admin.
          Zero destructive statements.
    037   drops 39 redundant constraints. Marked SERVANA:DESTRUCTIVE, and the
          runner refuses it unless SERVANA_APPLY_DESTRUCTIVE names it.

The baseline's role is to build a FRESH database and to serve as the schema
authority the repository checks itself against. It is not a restore artefact for
a live system.

### 1.5 Migrations now run through the repository's own runner

`deploy.yml` previously walked `scripts/migrations/*.sql` in a bash loop and
tracked what it had applied with `.done` marker FILES on the runner host — a
SECOND ledger, which had already diverged from the database one (030-035 were
applied by hand through the table, so the host has no markers and the loop would
have re-run all six).

It now calls `npm run migrations:apply`, which brings what the loop lacked:
advisory locking so two deploys cannot migrate concurrently, sha256 refusal if an
applied migration's content changed, and one transaction per migration with the
ledger insert inside it.

⚠ **Read the plan output before the first deploy on this path.** The step runs
`npm run migrations:plan` first and prints exactly what it will apply. If the
database ledger is missing anything the marker files recorded, that is where it
shows.

### 1.6 Ordering, which is still load-bearing

    checkout → secrets → npm ci → VERIFY → build → PLAN → MIGRATE → restart PM2

A failing test touches nothing. A failing migration stops short of the restart,
so the old code keeps serving. This order was got wrong once before — migrations
used to run before Node was installed.

### 1.7 The deploy happened. The standing local-only rule still governs what comes next.

**CORRECTED 2026-08-18.** This section previously read "109 commits are
unpushed". That is no longer the state: `d4b0150` was pushed and deployed, and
this clone now carries **2 local commits ahead of `origin/main`** —

    0aaf89f  gate(heap): bound the suite's heap permanently, and stop the leak
    fca1ed1  fix(gate): the release gate could never pass, because importing the
             app needed a production key

A push to `main` IS the deploy — a self-hosted runner on the production host
applies migrations and restarts PM2, with no staging hop and no human approval
in between. That fact is unchanged and is exactly why the standing rule stands:
everything remains local until an explicit, reaffirmed go is given for each
occasion. A prior authorisation does not carry forward.

What HAS changed is the reason. It is no longer "no client has migrated, so
there is nothing to deploy for". It is now that the two commits above are CI
repairs whose value is realised on the next deploy, whenever that is
authorised — and that the deploy pipeline they repair is itself a P0 finding
(F-03: `deploy.yml` has no `needs:` on the release gate, so a red gate shipped
`d4b0150` anyway). Fixing the gate before using it is the correct order.

## 2. What "operational" additionally requires

Deploying the backend is necessary and nowhere near sufficient. The Master
Command's goal is that five clients call the same canonical endpoints.

| Gap | State | Why it matters |
| --- | --- | --- |
| **Client migration** | 0 of 108 endpoints | The actual goal. Until a client calls v1, convergence is proven possible, not achieved. |
| **Legacy retirement** | 114 mappings live | Cannot begin: retirement is telemetry-gated and no v1 traffic exists to measure. |
| **Production smoke** | never executed | The suite and least-privilege credential strategy exist. The run needs credentials this environment must not hold. |
| **Ownership on a real engine** | unverified | PGlite runs as one superuser. The `fresh` CI job covers it and has never been observed running. |
| **Legacy telemetry** | no data | Deprecation schedule is written against traffic that does not exist yet. |

Migration order is already decided and is cost-based rather than arbitrary —
admin first (minutes to correct), then provider web, customer web, then the two
mobile clients last, because an installed build keeps calling whatever it knows
for as long as the customer leaves the app installed.

---

## 3. Risks found while preparing this

**A fail-soft money path.** Covered in §1.2. Worth restating as a standing
concern rather than a deploy step: a ledger write that logs and continues will
also hide a permissions problem, a full disk, or a constraint violation. It is
the right behaviour for not breaking a booking, and the wrong behaviour for
noticing. Reconciliation is the compensating control and it has never run
against production.

**Runtime DDL.** `chat.repository.ts` alters a table at runtime. It works, and
it requires the app role to retain ALTER on that table forever. It is also
invisible to the migration ledger, so the schema has a source of truth the
ledger does not know about.

**Deploy-time secret handling.** `deploy.yml` copies `.env` from the runner host
and, when no managed document scanner is configured, appends
`ALLOW_BASELINE_DOCUMENT_SCAN=true` so uploads fall back to the built-in
scanner. That is a deliberate, commented decision — but it means production
document scanning is currently the built-in signature scanner, not a managed
one. Worth a conscious re-confirmation before scale.

**An intermittent test.** `OTP semantics › a rotation restores the budget`
failed twice in one session and passed in isolation and on re-run. Characterised
as `--runInBand` order-sensitivity; **not root-caused.** It is the one open
question in the suite.

---

## 4. Ready, pending authorisation

Everything below is prepared and verified locally. None of it has been executed.

```
1  mark the ledger        DONE 2026-08-16   30 rows, owner admin
2  apply 030–035          DONE 2026-08-16   6 migrations, 121 -> 128 tables
2b apply 036 + 037        DONE 2026-08-18   132 tables, ledger 38
3  push / deploy          DONE 2026-08-18   d4b0150 via run 32119165101 — CORRECTED,
                                            this line previously read PENDING
3b redeploy the 2 CI fixes PENDING          0aaf89f, fca1ed1 — local only
4  production smoke       PENDING           needs credentials
5  migrate client 1       PENDING           admin web — BLOCKED on the v1 admin
                                            domain existing at all (1 of 105 routes)
```

Steps 1 and 2 were executed under explicit authorisation and verified:
36 ledger rows, 128 tables, **0 tables not owned by `admin`**, and
`servana-prod` online through the change with **0 restarts**.

The PGlite rehearsal predicted 121 -> 128 and production landed on exactly 128,
which is the strongest evidence so far that the fresh-DB gate models the real
thing.

Steps 3–5 remain production actions. Step 3 additionally conflicts with the
standing local-only rule.

**Rollback:** `docs/database/DATABASE_BASELINE_CAPTURE.md` §7–§8 covers restore
and rollback. The six migrations are additive, so the rollback for step 2 is
dropping the six new tables and the one added column — no data loss, because
nothing writes to them until v1 traffic exists.

---

## 5. What this document does not cover

- Load, capacity or performance under real traffic. Nothing here was measured
  against production volume.
- The eight unswept TABs (02, 03, 05, 06, 08, 10, 11, 12) for the
  self-validating-check failure class that three of six swept tabs carried.
- Client-side readiness. This is a backend view; the Flutter and Angular
  repositories have their own state.
