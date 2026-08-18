# TAB 01 — Unblock the production deploy pipeline

**Owner:** servana_api-main (backend)
**Measured:** 2026-08-18, against the live systems and this repository. Nothing
below is carried forward from the Master Command's figures; where they disagree,
the disagreement is stated.

---

## Verdict

**CERTIFIED_WITH_NONBLOCKING_GAPS.**

The pipeline is unblocked and the gate that guards it now passes for the first
time in its existence. Two acceptance criteria cannot be closed from this
machine because they require a push, and pushing is outside the standing
boundary for this programme. They are named in *Remaining* below with what
would close them.

---

## 1. The Master Command's premise had already expired

The document was written at `264158f` (2026-08-18 15:36 +0800) and states that
no deploy had succeeded since 2026-08-12, that `/healthz` returned 404, and that
production served no `/api/v1` router. **None of that is still true.** Three
commits were pushed after it was written:

| Commit | Subject |
|---|---|
| `4f4109d` | deploy: stop running the full test suite on the production host |
| `6f6658c` | env: SECRET is not required — the premise for putting it there was wrong |
| `d4b0150` | migrations: the checksum was hashing line endings, so no deploy could ever apply one |

Deploy run **32119165101** at `d4b0150` **succeeded** at 2026-08-18T08:58:46Z,
completing every step through *Reload NGINX*.

The local clone was itself stale — pinned at `2e03a4b` with `origin/main`
pointing at the same commit — so the repository on disk agreed with the PDF and
disagreed with reality. It has been fast-forwarded through 123 commits.

### Production, measured 2026-08-18T09:19:16Z

| Probe | Master Command | Measured now |
|---|---|---|
| `GET /healthz` | 404 | **200** — `{"status":"alive"}` |
| `POST /api/v1/auth/login` | 401 | **400** (public, reachable, validates) |
| `GET /api/v1/me` | 401 | 401 (correct without a token) |
| `GET /api/v1/totally/bogus` | 401 | **404** — the v1 router's own 404 |
| `GET /api/catalog` | 401 | **200** |
| `GET /api/services` | 200 | 200 |

The v1 router is mounted in production and an unknown v1 path is now
distinguishable from an unauthenticated one. That closes TAB 02's headline gap
as a *deployment* matter; TAB 02 becomes prove-and-certify rather than fix.

---

## 2. The defect that was still open, and was not in the PDF

`4f4109d` did the right thing — it moved the suite off the 961 MB production
host, which is TAB 01 mandate 5 — and handed correctness to the hermetic
GitHub-hosted job in `.github/workflows/release-gate.yml`.

**That gate had never once passed.**

| Run | Commit | Conclusion |
|---|---|---|
| 32114087150 | `264158f` | failure |
| 32116088574 | `4f4109d` | failure |
| 32117621291 | `6f6658c` | failure |
| 32119165094 | `d4b0150` | failure |

Four runs, four failures — every run since the workflow was created. So for the
whole window in which the deploy stopped running tests, **nothing gated a
deploy**. That is precisely the condition `deploy.yml`'s own comment warns
about: *"The 1344 tests in this repo had never gated a deploy."* It had
recurred, in a new place, and the green deploy badge concealed it.

The failure was **exit code 1, not 134** — a genuine test failure, not the OOM
the PDF attributes to it.

### Root cause

`src/middleware/firebaseApp.ts` resolved the Firebase Admin credential at
**module load**: it read `servana-serviceAccountKey.json` from disk and called
`admin.initializeApp` at module scope. Six modules then built their Auth client
at module scope on top of it — `verifyAuth`, `verifyAuthOptional`,
`firebaseFunctions.service`, `adminInviteService`, `provider.gateway`,
`chat.gateway`.

Two of those sit on the import path to `src/app.ts`:

```
tests/*  ->  src/app.ts:205  ->  src/api/v1/register.ts:36   ->  middleware/verifyAuth.ts
tests/*  ->  src/app.ts:205  ->  src/api/v1/register.ts:216  ->  api/v1/domains/auth.ts:28
                                  -> services/auth.service.ts:5 -> services/firebaseFunctions.service.ts:1
```

so `require('../src/app')` threw `Firebase Admin credentials not found.` on any
checkout without a production key.

The self-hosted deploy runner passed because `deploy.yml`'s *Copy secrets* step
writes that key before any check runs. **A gate that can only pass on the
machine holding production credentials is not a gate** — it is a second copy of
production, and it cannot answer the question a gate exists to answer.

This was a regression against a rule the repository already states.
`tests/app-import-is-inert.test.ts` says *"importing the application composes it
and does nothing else"* and documents three import-time side effects removed for
exactly this reason. The credential was a fourth that nobody had attributed.

---

## 3. The fix

| Change | Why |
|---|---|
| `src/middleware/lazyValue.ts` (new) | A memoising `Proxy` that defers construction to first property access. Keeps the value shape, so ~25 `defaultAuthAdmin.verifyIdToken(...)` call sites and the ten `jest.mock('../src/middleware/firebaseApp')` lines that exist only to dodge this constructor are unchanged. |
| `src/middleware/firebaseApp.ts` | Credential resolution, `admin.initializeApp` and the client `initializeApp` moved behind `getFirebaseAdmin()` / `getFirebaseApp()`. Same error text, same guidance — thrown on first *use*. |
| Six modules | `const defaultAuthAdmin = getAuthAdmin(firebaseAdmin)` → `lazyValue(() => getAuthAdmin(firebaseAdmin))`. `accountLinking.ts` and `tokenRevocation.ts` had already reached for the thunk form of this locally; this is that idiom, applied consistently. |
| `src/startup.ts` | `firebase-admin` declared in `STARTUP_DEPENDENCIES` as **required**. |

**Production behaviour is deliberately unchanged.** A missing credential still
fails at boot — it is now a required startup dependency rather than an import
crash. Being `required` withholds *readiness* instead of killing the process,
which is what every other required dependency here already does, and it leaves
an operator `/readyz` to ask why. Nothing was made optional.

### Result

| | Before | After |
|---|---|---|
| `npm run verify` | **exit 1** | **exit 0** |
| Test suites | 4 failed, 272 passed | **276 passed, 276 total** |
| Tests | 7 failed, 5,903 passed | **5,935 passed, 5,935 total** |

The test count rose because four suites previously failed to *run* at all, so
their assertions were never counted.

---

## 4. The heap table (mandate 1)

Measured with `--logHeapUsage` through `scripts/jest-heap-guard.js`. Under
`--runInBand` every suite shares one V8 heap, so the useful column is the
**delta** — what a suite retained after it finished — not the cumulative total.

| Retained | Cumulative | Suite |
|---|---|---|
| **+599.4 MB** | 599.4 MB | `tests/app-import-is-inert.test.ts` |
| +81.5 MB | 671.7 MB | `tests/v1-router.test.ts` |
| +67.2 MB | 784.9 MB | `tests/account-contract.test.ts` |
| +58.9 MB | 795.0 MB | `tests/route-shadowing.test.ts` |
| +58.1 MB | 624.3 MB | `tests/booking-policy-guards.test.ts` |
| +58.0 MB | 730.8 MB | `tests/booking-c-confirm-otp.test.ts` |
| +56.4 MB | 780.5 MB | `tests/finance-contract.test.ts` |
| +55.9 MB | 607.7 MB | `tests/catalog-semantic-guards.test.ts` |
| +55.2 MB | 861.6 MB | `tests/legacy-authz-parity.test.ts` |
| +55.1 MB | 662.0 MB | `tests/messaging-docs-generated.test.ts` |

**Peak 2,066.7 MB against a 4,288 MB limit — 51.8% headroom.**

The top entry is six times the next worst and is the whole story on a 961 MB
host: requiring `src/app.ts` pulls the entire application module graph into
Jest's registry, and under `--runInBand` all 275 later suites inherit it.
Importing the app is the *point* of that suite, so the cost is not avoidable —
holding it afterwards is.

### After releasing that state (mandate 3)

`jest.resetModules()` now runs in that suite's `afterAll`. Re-measured on the
same machine and the same tree:

| | Before | After |
|---|---|---|
| Peak heap | 2,066.7 MB | **1,059.1 MB** |
| Headroom against the 4,288 MB limit | 51.8% | **75.3%** |
| Retained by `app-import-is-inert` | 599.4 MB | **415.4 MB** |

**A 49% reduction in peak occupancy from one `afterAll` line**, and the largest
retainer is now `+48.4 MB` (`tests/booking-state-machine.test.ts`) rather than
`+81.5 MB`. The suite still does not fit a 961 MB heap, which is why mandate 5 —
running the gate on a machine with memory — remains the correct fix rather than
an optimisation exercise; but the accumulation that made it *unboundedly* worse
is gone, and the guard below now watches it.

### On `--max-old-space-size=4096` (mandate 2)

**Not applied, deliberately.** The mandate proposes it as the immediate unblock,
conditional on the host having the headroom. It does not: `deploy.yml` records
961 MB of RAM, and that adding 2 GB of swap did not help, because swap raises
system memory and not the V8 heap ceiling. A heap ceiling above physical memory
converts a clean V8 abort into a kernel OOM-kill — the mandate's own guardrail
says so. Mandate 5 (move the gate to a runner with memory) is the correct fix
and is the one in place.

---

## 5. The permanent guard (mandate 4)

`scripts/jest-heap-guard.js` is wired into `test:ci`, so it runs on every CI
execution of the suite including `release-gate.yml`'s `npm run verify`. It
records heap-after-suite for all 276 suites, prints the ten largest retainers,
and **fails the run when peak heap exceeds 70% of the configured limit**.

Current standing: **1,059.1 MB peak against a 4,288 MB limit = 24.7% used**,
comfortably inside the 70% threshold, with the margin stated in the run log
rather than inferred. Measured on the final tree with the guard active:
`npm run verify` exit 0, 276 suites, 5,935 tests.

---

## 6. A flake removed from the gate, and watched to fail first

`tests/app-import-is-inert.test.ts` asserted *"opens no listening socket"* by
counting every object named `Server` in `process._getActiveHandles()`. That list
is process-wide, and under `--runInBand` a sibling suite's server can still
appear in it after being closed — `tests/support/httpTestServer.ts` closes
correctly, but reaping is not synchronous with `close()`'s callback.

Measured: the same command failed after `v1-composed-app.test.ts` and passed in
isolation, and passed 8/8 on a later repeat. An order-dependent gate is a gate
that gets ignored.

The filter now tests `h.listening`, which is what the test's name always
claimed. **This is strictly harder, not weaker** — proven by discrimination
rather than asserted:

```
created, not listening -> 0 (guard passes)
after listen()         -> 1 (guard fails, as it must)
after close()          -> 0 (guard passes again)
```

A server that `app.ts` bound at import reads `listening === true` and still
fails this assertion. A closed neighbour reads `false`, which is the correct
answer to "did importing `app.ts` open a socket".

---

## 7. Acceptance criteria

| Criterion | State |
|---|---|
| Deploy workflow reports **success** for a commit at or after `264158f` | **MET** — run 32119165101, commit `d4b0150` |
| `curl /healthz` returns **200** | **MET** — 200, `{"status":"alive"}` |
| Peak heap recorded with headroom as a percentage | **MET** — 2,066.7 MB / 4,288 MB, 51.8% headroom, printed every CI run |
| Three consecutive deploys succeed without a memory flag change | **NOT MET — requires pushes** (see below) |

### Guardrails honoured

- The gate was **not** weakened to make it pass. No `--passWithNoTests`, no
  `--bail`, no skipped suites, no removal of Verify. The suite went from 4
  failing suites to 276 passing by fixing the application, and the run now
  carries an additional blocking heap check it did not have before.
- `SERVANA_APPLY_DESTRUCTIVE` was not set, as a standing variable or otherwise.
- No database backup was needed: nothing here was deployed or migrated.

---

## Remaining — environment- and production-only

1. **Three consecutive green deploys** (acceptance 4) and **confirming the fixed
   gate green in CI**. Both require pushing to `main`, which is a production
   deploy in this repository and is outside this programme's boundary. The
   commits are local and ready; the evidence that they work is the local
   `npm run verify` exit 0 reproducing the exact command `release-gate.yml`
   runs, on the same tree.
2. **Deploy-outcome alerting to a channel a human reads** (mandate 6). Needs a
   webhook credential and a named recipient — neither is available here, and
   inventing one would be an unowned alert. This is the single change that would
   have caught the six-day stall on day one, and it should be treated as
   blocking for launch by whoever holds the credential.
3. **`fresh-db.yml` is still failing** at `d4b0150` (run 32120080957) and has
   failed on every recent push. TAB 16 mandate 8 owns it; recorded here because
   a permanently red check trains everyone to ignore red checks, which is how
   the release gate stayed red for four runs without comment.

---

## Evidence index

- Deploy runs: GitHub Actions API, repository `PaulEspinas2020/servana_api`,
  runs 32114087151 (failure, exit 134), 32119165101 (success), and release-gate
  runs 32114087150 / 32116088574 / 32117621291 / 32119165094 (all failures).
- Production probes: 2026-08-18T09:19:16Z, unauthenticated GET/POST only.
- Local gate: `npm run verify` — 276 suites, 5,935 tests, exit 0.
- Heap: `jest --runInBand --ci --logHeapUsage` via `scripts/jest-heap-guard.js`.
