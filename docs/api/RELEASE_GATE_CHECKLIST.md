<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-release-safety-docs.ts, derived from
    src/observability/releaseGate.ts  (the gates and prohibitions)
  Regenerate: npm run safety:docs
-->

# Release gate checklist

> Every line is a command somebody can run. `tests/release-gate.test.ts`
> asserts each named script exists, because a gate whose command was renamed is
> a gate that silently stopped being checked.

## 1. Blocking — the deploy does not go out

- [ ] **Source and tests typecheck**
      `npm run typecheck && npm run typecheck:tests`
      _A failure means:_ The build does not compile. Nothing else in this list is meaningful.

- [ ] **Mobile-authoritative routes still exist**
      `npm run guard:protected-contracts`
      _A failure means:_ A route a shipped Flutter build calls has been renamed or removed. The installed base cannot be corrected for weeks.

- [ ] **Router, OpenAPI, docs and manifest agree**
      `npm run api:docs:check && npm run convergence:docs:check`
      _A failure means:_ The published contract is not what the server serves. A client generated from it ships calls that 404.

- [ ] **Every object-scoped endpoint has an ownership rule**
      `npx jest tests/route-health-and-authz.test.ts`
      _A failure means:_ An endpoint addresses somebody's booking with no ownership check. A booking carries an address and a time when a person will be at home.

- [ ] **The redactor drops anything unclassified**
      `npx jest tests/observability-redaction.test.ts`
      _A failure means:_ A token, an OTP or an address is reaching the log aggregator, where it has a retention period and a wider audience than the database.

- [ ] **Migrations are transaction-safe and owned**
      `npx jest tests/migration-safety.test.ts`
      _A failure means:_ A migration can commit the deploy wrapper's transaction mid-run, leaving the schema changed and the ledger empty.

- [ ] **The wire format is the declared format**
      `npx jest tests/socket-contract-serialization.test.ts`
      _A failure means:_ A middleware is mutating a canonical response. This is how a Service came back claiming its own name as its subcategory.

- [ ] **The whole suite passes**
      `npm run test:ci`
      _A failure means:_ Something is broken that a narrower gate did not look at.

- [ ] **The production build succeeds**
      `npm run build`
      _A failure means:_ The artifact cannot be produced.

## 2. Advisory — record the result, use judgement

- [ ] No capability has forked its domain service — `npx jest tests/cross-platform-convergence.test.ts`
      _A role-specific route has grown its own business rules. Nothing breaks today; the two copies diverge later._

- [ ] Every superseded route is being counted — `npx jest tests/cross-platform-convergence.test.ts`
      _An alias could be retired on a guess rather than on a measurement._

- [ ] Generated documentation is current — `npm run verify`
      _A client team is reading a stale matrix. It misleads before it breaks anything._

## 3. Prohibitions

Not automatable. These are decisions a human makes, so they are listed rather
than checked, and each names the evidence that would justify an exception.

- **No legacy route is removed in the same release that migrates a client onto its successor.**
  None. Removal is always its own release, so reverting it restores the route and nothing else. See DEPRECATION_SCHEDULE.md.

- **No migration is applied by hand.**
  None. Hand-applied migrations as `postgres` are what left 29 of 116 tables unusable by the app role. Use `npm run migrations:apply` with MIGRATION_REMOTE_ACK.

- **No smoke run uses a personal credential or writes to a live record.**
  None. See CREDENTIAL_RULES in api/v1/routeHealth.ts.

- **No response shape on a legacy route changes while any client still calls it.**
  An ADDITIVE field is permitted. A removal, a rename or a type change is not, whatever the field looks like from the server.

## 4. After the deploy

1. Watch `[servana-metrics] http_requests_total` for a 5xx share above the
   pre-deploy baseline. Group by `route` — one route is this release, every
   route is the database or the process.
2. Watch `auth_failures_total` grouped by `client`. A spike on ONE client
   version is a bad release; a spike across clients is not about you.
3. Confirm `legacy_route_hits_total` has not moved for a route that was reading
   zero. A route waking up means a client rolled back — do NOT retire that alias.
4. Do not run a production smoke against live records. The plan
   (`npm run smoke:plan`) probes GET endpoints only, with seeded least-privilege
   accounts, and treats a 401 as a FAILURE rather than as proof.

## 5. What this checklist cannot tell you

Every gate here runs against this repository. None of them observes production,
because nothing in this repository is permitted to reach it.

So a green checklist means the artifact is internally consistent, contract-true
and safe to deploy — not that the deploy succeeded. The first four minutes after
a release are the checklist above, and they are somebody watching, not a script.
