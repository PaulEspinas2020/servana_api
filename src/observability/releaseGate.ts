/**
 * The release gate (§151): what blocks a deploy, and what merely warns.
 *
 * ## Why this is a module and not a wiki page
 *
 * A checklist nobody executes is a checklist that is complete on every release.
 * Each gate below names the command that decides it, so
 * `scripts/generate-release-safety-docs.ts` can print a checklist whose every
 * line is a thing somebody can run, and `tests/release-gate.test.ts` can assert
 * that the command exists in `package.json`.
 *
 * A gate whose command has been renamed is a gate that silently stops being
 * checked, which is the specific way this kind of document rots.
 *
 * ## Blocking versus advisory
 *
 * `BLOCKING` means the deploy does not go out. That list is deliberately short:
 * a gate that blocks for something a human would wave through teaches people to
 * wave things through, and then the gate that mattered gets waved through too.
 *
 * Everything about CORRECTNESS of the contract, AUTHORIZATION, and MIGRATION
 * SAFETY blocks. Everything about coverage, documentation freshness and
 * telemetry is advisory, because none of it can break a live client on its own.
 */

export type GateSeverity = 'BLOCKING' | 'ADVISORY';

export interface ReleaseGate {
  key: string;
  title: string;
  severity: GateSeverity;
  /** The npm script that decides it. Asserted to exist. */
  command: string;
  /** What a failure means in terms of live clients. */
  failureMeans: string;
}

export const RELEASE_GATES: readonly ReleaseGate[] = Object.freeze([
  {
    key: 'typecheck',
    title: 'Source and tests typecheck',
    severity: 'BLOCKING',
    command: 'npm run typecheck && npm run typecheck:tests',
    failureMeans: 'The build does not compile. Nothing else in this list is meaningful.',
  },
  {
    key: 'protected-contracts',
    title: 'Mobile-authoritative routes still exist',
    severity: 'BLOCKING',
    command: 'npm run guard:protected-contracts',
    failureMeans:
      'A route a shipped Flutter build calls has been renamed or removed. The installed base ' +
      'cannot be corrected for weeks.',
  },
  {
    key: 'contract-drift',
    title: 'Router, OpenAPI, docs and manifest agree',
    severity: 'BLOCKING',
    command: 'npm run api:docs:check && npm run convergence:docs:check',
    failureMeans:
      'The published contract is not what the server serves. A client generated from it ships ' +
      'calls that 404.',
  },
  {
    key: 'authorization',
    title: 'Every object-scoped endpoint has an ownership rule',
    severity: 'BLOCKING',
    command: 'npx jest tests/route-health-and-authz.test.ts',
    failureMeans:
      'An endpoint addresses somebody\'s booking with no ownership check. A booking carries an ' +
      'address and a time when a person will be at home.',
  },
  {
    key: 'no-secrets-in-logs',
    title: 'The redactor drops anything unclassified',
    severity: 'BLOCKING',
    command: 'npx jest tests/observability-redaction.test.ts',
    failureMeans:
      'A token, an OTP or an address is reaching the log aggregator, where it has a retention ' +
      'period and a wider audience than the database.',
  },
  {
    key: 'migration-safety',
    title: 'Migrations are transaction-safe and owned',
    severity: 'BLOCKING',
    command: 'npx jest tests/migration-safety.test.ts',
    failureMeans:
      'A migration can commit the deploy wrapper\'s transaction mid-run, leaving the schema ' +
      'changed and the ledger empty.',
  },
  {
    key: 'socket-contract',
    title: 'The wire format is the declared format',
    severity: 'BLOCKING',
    command: 'npx jest tests/socket-contract-serialization.test.ts',
    failureMeans:
      'A middleware is mutating a canonical response. This is how a Service came back claiming ' +
      'its own name as its subcategory.',
  },
  {
    key: 'full-suite',
    title: 'The whole suite passes',
    severity: 'BLOCKING',
    command: 'npm run test:ci',
    failureMeans: 'Something is broken that a narrower gate did not look at.',
  },
  {
    key: 'build',
    title: 'The production build succeeds',
    severity: 'BLOCKING',
    command: 'npm run build',
    failureMeans: 'The artifact cannot be produced.',
  },
  {
    key: 'convergence',
    title: 'No capability has forked its domain service',
    severity: 'ADVISORY',
    command: 'npx jest tests/cross-platform-convergence.test.ts',
    failureMeans:
      'A role-specific route has grown its own business rules. Nothing breaks today; the two ' +
      'copies diverge later.',
  },
  {
    key: 'legacy-telemetry',
    title: 'Every superseded route is being counted',
    severity: 'ADVISORY',
    command: 'npx jest tests/cross-platform-convergence.test.ts',
    failureMeans: 'An alias could be retired on a guess rather than on a measurement.',
  },
  {
    key: 'docs-fresh',
    title: 'Generated documentation is current',
    severity: 'ADVISORY',
    command: 'npm run verify',
    failureMeans: 'A client team is reading a stale matrix. It misleads before it breaks anything.',
  },
]);

export const BLOCKING_GATES = Object.freeze(
  RELEASE_GATES.filter((g) => g.severity === 'BLOCKING'),
);

/**
 * Things a release must NOT do, stated so a checklist can carry them.
 *
 * These are not automatable — they are decisions a human makes — so they are
 * listed rather than checked, and each names the evidence that would justify
 * the exception.
 */
export const RELEASE_PROHIBITIONS: readonly { rule: string; exception: string }[] = Object.freeze([
  {
    rule: 'No legacy route is removed in the same release that migrates a client onto its successor.',
    exception:
      'None. Removal is always its own release, so reverting it restores the route and nothing ' +
      'else. See DEPRECATION_SCHEDULE.md.',
  },
  {
    rule: 'No migration is applied by hand.',
    exception:
      'None. Hand-applied migrations as `postgres` are what left 29 of 116 tables unusable by ' +
      'the app role. Use `npm run migrations:apply` with MIGRATION_REMOTE_ACK.',
  },
  {
    rule: 'No smoke run uses a personal credential or writes to a live record.',
    exception: 'None. See CREDENTIAL_RULES in api/v1/routeHealth.ts.',
  },
  {
    rule: 'No response shape on a legacy route changes while any client still calls it.',
    exception:
      'An ADDITIVE field is permitted. A removal, a rename or a type change is not, whatever the ' +
      'field looks like from the server.',
  },
]);
