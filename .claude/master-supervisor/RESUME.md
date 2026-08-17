# RESUME — Servana API MASTER COMMAND (12 TABs)

Repo state at handoff: branch `main`, HEAD `66d14b2`, working tree **clean**,
**82 commits unpushed**, nothing deployed.

Read this, then `MEMORY.md`, `state.json`, `DECISIONS.md`, and
`docs/PRODUCTION_READINESS.md`. Everything below was measured, not remembered.

---

## 1. Prove the baseline before changing anything

```
npm run verify              expect PASS — 264 suites, 5754 tests
npm run db:verify:embedded  expect PASS — 121 restored + 6 applied = 128 tables
npm run ddl:inventory       expect 154 unmanaged, 112 objects  (exits 1 BY DESIGN)
npm run authz:legacy        expect 615 routes, 0 loosenings
npm run release:summary     writes reports/release-summary.json
```

`db:verify` and `ddl:inventory` exit non-zero deliberately. They are not part of
`npm run verify` and must not be added to it.

---

## 2. TAB status

| TAB | Priority | State |
| --- | --- | --- |
| 01 Establish the release gate | P0 | **Done** except the concurrency suite |
| 02 Migrations the sole schema authority | P0 | Measured + budgeted. **The work itself remains** |
| 03 Atomic startup lifecycle | P0 | Done except tests needing a real boot |
| 04 Centralize authorization policy | P0 | Rules derived, parity gated, audit wired |
| 05 Converge clients onto v1 | P1 | Not started — 0 of 108 migrated |
| 06 Booking transitions the only write path | P0 | Not started (largely done by the previous command's TAB 04) |
| 07 Harden money movement | P0 | Not started |
| 08 Schedulers safe under scale | P1 | Not started |
| 09 Unify errors/logging/observability | P1 | Partly pre-existing |
| 10 Remove query amplification | P1 | Not started |
| 11 Data ownership / cross-store | P1 | Not started |
| 12 Security + dependency hygiene | P1 | Credential removed from build; 0 high CVEs |

---

## 3. The next action

**TAB 02's real work: move 154 runtime DDL statements into migrations.**

The acceptance criterion is the API starting with **DDL privileges revoked**, so
every statement has to move first. This is the multi-week core of the command
and the thing everything else waits on.

Per object, never as a sweep:

1. `npm run ddl:inventory` names the object and its call site.
2. Write a migration whose `CREATE TABLE IF NOT EXISTS` matches what runtime
   builds — production already HAS the object, so the migration must be a no-op
   there.
3. Verify the structural fingerprint against `scripts/baseline/000-baseline.sql`.
4. Only then delete the runtime call.
5. Lower the budget in `tests/runtime-ddl-budget.test.ts`. It may fall, never
   rise, and it fails if it drifts more than 5 above the real count.

Five of these were already moved this way — the module-scope bootstraps in
`providerActivationService`, `providerOperationalAvailabilityService`,
`accountDeletion.routes`, `customerSupport.routes` and
`customerReviewController` — see `src/startup.ts` for the pattern.

---

## 4. Blocked on the human — say so early

1. **One real boot.** Nobody has started the actual server since `app.ts`
   startup was rewritten: 14 fire-and-forget bootstraps became a 19-dependency
   graph awaited before `listen`, plus `/healthz`, `/readyz` and SIGTERM
   draining. Verified as far as tests allow; not against reality.
2. **The deploy decision.** A push to `main` **IS** the deploy. It also
   conflicts with the standing local-only rule, and 0 of 108 endpoints have
   migrated, so that rule is unsatisfied.
3. **`race go`.** A disposable `servana_race_test` database on the Linode host
   unblocks `tests/booking-postgres-races.test.ts`, which currently reports
   `BLOCKED_BY_TEST_DATABASE`. Measured as safe: the harness caps at 8
   connections and 2 concurrent transactions; the server is idle with 481 MB
   free. PGlite CANNOT substitute — single-connection, so no lock contention and
   no `40P01`.

---

## 5. Working rules that were earned the hard way

- **Mutation-test every gate, and confirm the mutation landed.** Six checks in
  the last session passed while broken; three were hunting that exact class.
- **Grep counts are not findings.** Four false leads, each dissolved on reading
  the code. `isDisputeCategory` looked unused and is called next door;
  `ADDITIONAL_WORK_CAPTURED` looked producerless and is emitted by a ternary.
- **Never let observability change a decision.** The authz audit threw inside a
  denial branch and turned a 403 into a bypass in a test.
- **Prefer the Edit tool to shell heredocs for code.** Heredocs mangled
  backslashes repeatedly — including writing real CR/LF into a JS regex, which
  stopped five suites parsing and dropped 586 tests with nothing red.
- **`\b` in a template literal is a backspace.** Use `String.raw`.
- **Do not read credential contents** to establish a finding; presence and
  permissions suffice.

---

## 6. Production state

The database is **ahead of** the deployed code, deliberately.

```
servana.schema_migrations   36 rows   (30 marked + 6 applied 2026-08-16)
servana tables             128
not owned by admin           0
servana-prod              online, 0 restarts through the change
```

Production has the schema for the finance ledger, outbox, account settings and
support cases — and not the code that writes to them. Harmless until v1 traffic
exists, but not a steady state.
