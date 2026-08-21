<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-release-safety-docs.ts, derived from
    src/observability/releaseGate.ts   (the gates)
    src/api/v1/deprecation.ts         (deprecation signalling)
    scripts/lib/migrationSafety.ts    (migration rules)
  Regenerate: npm run safety:docs
-->

# API contract CI

> What CI checks about the contract, and what each failure would mean to a live
> client.

## 1. Drift gates (§148)

Nine generated-documentation checks run in `npm run verify`. Each one
regenerates a document from the code and fails if the committed copy differs, so
a contract change that is not reflected in the published documents cannot merge.

| Check | What it compares |
| --- | --- |
| `api:docs:check` | OpenAPI, endpoint registry and migration matrix against `V1_CONTRACT` |
| `convergence:docs:check` | the canonical call manifest against the MOUNTED router |
| `booking:docs:check` … `review:docs:check` | each domain contract against its policy declaration |
| `safety:docs:check` | this document, the authz matrix and the observability standard |

`convergence:docs:check` is the strongest of these: `manifestDrift()` compares
the manifest against what `register.ts` actually mounts, not against what the
contract claims. An entry documented and not mounted fails.

## 2. Semantic guards

Type-level agreement is not enough — a contract can typecheck and still be
wrong. These assert meaning:

- **route existence** — every implemented entry is driven over a real socket in
  `tests/v1-router.test.ts`; a 401 is never accepted as proof (§143).
- **serialization** — `tests/socket-contract-serialization.test.ts` asserts on
  raw response bytes, so a middleware that adds `level2` to a canonical Service
  fails even though every service-layer test passes.
- **shared domain service** — `tests/cross-platform-convergence.test.ts` compares
  the `domainService` strings behind role-split routes.
- **object ownership** — `tests/route-health-and-authz.test.ts` fails when a new
  object-scoped endpoint appears with no ownership rule.
- **redaction** — `tests/observability-redaction.test.ts` throws realistic
  payloads at the redactor and asserts on what SURVIVED.

## 3. Deprecation (§149)

100 legacy aliases carry deprecation headers today:

```
Deprecation: true
Link: </api/v1/…>; rel="successor-version"
```

Headers only. No status code, body or behaviour changes — five live clients
depend on these paths, and a deprecation notice that alters a response is not a
notice, it is a breakage.

### Why almost nothing carries a Sunset date

A Sunset date the platform cannot keep teaches client teams to ignore the header, and then the one route that really is going away is ignored too.

A `Sunset` header is emitted only when the alias has met every non-traffic
condition, and today that is zero routes. The honest signal is `Deprecation:
true` with a successor link and no date.

### The no-removal rule

A legacy route is never removed while any supported client still calls it, and never on a schedule. Removal requires observed zero traffic for the full window, every caller cell reading migrated, the canonical successor mounted, and a rollback that restores the alias without a data change.

Evidence required:

- `legacy_route_hits_total` reads zero for the window (14d web / 90d any mobile caller)
- `V1_CONTRACT[].callers` shows no `legacy` or `planned` cell for the successor
- the successor entry is `status: implemented`
- the removal is its own commit, so reverting it restores the route and nothing else

Windows: 14 days of observed silence for a
web-only alias, 90 days if any mobile
client is listed — because an unupdated app keeps calling the old path for as
long as it stays installed.

## 4. Migration safety (§147)

Two rules, both enforced by `tests/migration-safety.test.ts`.

**The deploy wrapper owns the transaction.** `run-migrations.ts` wraps each
migration in `BEGIN`/`COMMIT` so the schema change and the `schema_migrations`
ledger row land together. The file's own transaction control is stripped first.

That stripper used to be two regexes anchored to the start and end of the file,
and they matched nothing in **16 of the 36 migrations** — every file opens with a
comment header and most close with a verification note. A surviving `COMMIT;`
commits the wrapper's transaction mid-migration, so the ledger insert lands
outside any transaction and the wrapper's own COMMIT fails.

The fix is in the stripper, not the files: twenty migrations are applied in
production and the runner refuses a checksum change, so editing them would break
the deploy permanently. The checksum is taken from the RAW file, so fixing the
stripper moves no checksum.

`stripTransactionControl` masks comments, string literals and `$$` bodies
before it looks, so PL/pgSQL `BEGIN … END` inside a `DO` block survives —
eleven migrations would otherwise become syntax errors.

**Created objects are owned by an approved role.** Required from migration
29 onward; approved roles: `admin`.

Earlier migrations are advisory rather than blocking, because they are applied
and frozen — a blocking finding on one would be an instruction to break the
deploy. The live remedy is `npm run check:db-ownership`, which reads the actual
catalog.

The rule exists because of a specific outage: 29 of 116 tables were owned by
`postgres` rather than `admin` after migrations were applied by hand, the app
had no privileges on them, and provider document upload returned a bare 500 for
every provider until somebody read the catalog.

## 5. The gates

| | Gate | Command |
| --- | --- | --- |
| **blocking** | Source and tests typecheck | `npm run typecheck && npm run typecheck:tests` |
| **blocking** | Mobile-authoritative routes still exist | `npm run guard:protected-contracts` |
| **blocking** | Router, OpenAPI, docs and manifest agree | `npm run api:docs:check && npm run convergence:docs:check` |
| **blocking** | Every object-scoped endpoint has an ownership rule | `npx jest tests/route-health-and-authz.test.ts` |
| **blocking** | The redactor drops anything unclassified | `npx jest tests/observability-redaction.test.ts` |
| **blocking** | Migrations are transaction-safe and owned | `npx jest tests/migration-safety.test.ts` |
| **blocking** | The wire format is the declared format | `npx jest tests/socket-contract-serialization.test.ts` |
| **blocking** | The whole suite passes | `npm run test:ci` |
| **blocking** | The production build succeeds | `npm run build` |
| advisory | No capability has forked its domain service | `npx jest tests/cross-platform-convergence.test.ts` |
| advisory | Every superseded route is being counted | `npx jest tests/cross-platform-convergence.test.ts` |
| advisory | Generated documentation is current | `npm run verify` |

9 of 12 block a deploy. That list is
deliberately short: a gate that blocks for something a human would wave through
teaches people to wave things through, and then the gate that mattered gets
waved through too.
