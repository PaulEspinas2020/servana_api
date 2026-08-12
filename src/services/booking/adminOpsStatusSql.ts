/**
 * The admin list's state derivation, in SQL — generated from ONE declaration.
 *
 * ## Why this file exists
 *
 * TAB 04 reduced booking state derivations from two to one. That count was
 * wrong: a THIRD lived in a query string. The admin booking list computes an
 * `ops_status` column in SQL, because the status filter and the `COUNT` have to
 * apply to the filtered set at the database level — a derivation done in
 * TypeScript after the fact would paginate the wrong rows. That requirement is
 * real, so the SQL cannot simply be deleted.
 *
 * What it could not stay is INDEPENDENT. Measured over the full cross-product of
 * legacy statuses, the old expression disagreed with `deriveCanonicalState` on
 * **107 of 440 combinations**. The same booking reported one state in the list
 * and another on its own detail page. The worst class was also the most
 * operationally damaging: a booking whose provider had DECLINED still showed as
 * `assigned`, so the queue that most needs an operator's attention was the one
 * hidden from it.
 *
 * ## How the two are kept from disagreeing again
 *
 * Both the SQL text and a JavaScript reference evaluator are generated from the
 * SAME ordered branch list below. Each branch carries its predicate twice, side
 * by side, so an edit that changes one and not the other is visible in the diff
 * rather than buried in a template literal a hundred lines from its test.
 *
 * `tests/admin-ops-status-sql.test.ts` then diffs the evaluator against
 * `deriveCanonicalState` over the whole cross-product and fails on any
 * disagreement. So the guarantee is: evaluator ≡ canonical, by test; SQL ≡
 * evaluator, by construction.
 *
 * ## What is NOT proven here
 *
 * That PostgreSQL evaluates the emitted SQL exactly as the evaluator does. That
 * needs a real server with the production schema — the same thing blocking the
 * concurrency suite (see `docs/TAB04_OPEN_GAPS.md`). The branch predicates are
 * deliberately confined to `IN`, `=`, `IS NULL` and `OR` over text columns,
 * where the two languages' semantics are not in question, and NULL handling is
 * made explicit rather than left to three-valued logic. It is stated as a
 * limit rather than glossed.
 */

import type { LegacyOperationsStatus } from './projections';

/** The inputs a branch may test. `workerUid` is already NULL-normalised. */
export interface OpsStatusInput {
  bookingStatus: string | null;
  workerStatus: string | null;
  workerUid: string | null;
  hasUnresolvedEscalation: boolean;
}

interface Branch {
  /** SQL predicate. Placeholders are substituted by `adminOpsStatusSql`. */
  sql: string;
  /** The same predicate in JavaScript. */
  js: (i: OpsStatusInput) => boolean;
  /** Constant result, or a second decision for the one branch that needs it. */
  then: LegacyOperationsStatus | ((i: OpsStatusInput) => LegacyOperationsStatus);
  why?: string;
}

const upper = (v: string | null): string | null => (v === null ? null : v.toUpperCase());

/**
 * Ordered exactly as `deriveCanonicalState` orders its checks. The order is
 * load-bearing: an escalation outranks a terminal state, and a closed
 * assignment must be tested BEFORE `bookings.status` is consulted.
 */
const BRANCHES: Branch[] = [
  {
    sql: `EXISTS (SELECT 1 FROM {schema}.booking_escalations esc
                   WHERE esc.booking_id = {b}.id AND esc.resolved_at IS NULL)`,
    js: (i) => i.hasUnresolvedEscalation,
    then: 'disputed',
    why: 'An open escalation outranks everything, including a terminal state.',
  },
  {
    sql: `{b}.status IN ('CANCELLED','CANCELED')`,
    js: (i) => ['CANCELLED', 'CANCELED'].includes(upper(i.bookingStatus) ?? ''),
    then: 'cancelled',
  },
  {
    sql: `{b}.status = 'EXPIRED'`,
    js: (i) => upper(i.bookingStatus) === 'EXPIRED',
    then: 'cancelled',
    why: 'EXPIRED is canonically its own state; Admin has no badge for it, so it '
      + 'reports as cancelled. Previously it fell through to `new`, which put dead '
      + 'bookings at the TOP of the intake queue.',
  },
  {
    sql: `{b}.status IN ('REFUNDED','FAILED')`,
    js: (i) => ['REFUNDED', 'FAILED'].includes(upper(i.bookingStatus) ?? ''),
    then: 'cancelled',
  },
  {
    sql: `{b}.status = 'COMPLETED' OR {w}.worker_status = 'COMPLETED'`,
    js: (i) => upper(i.bookingStatus) === 'COMPLETED' || upper(i.workerStatus) === 'COMPLETED',
    then: 'completed',
  },
  {
    sql: `{w}.worker_status = 'IN_PROGRESS'`,
    js: (i) => upper(i.workerStatus) === 'IN_PROGRESS',
    then: 'in_progress',
  },
  {
    sql: `{w}.worker_status IN ('ARRIVED','EN_ROUTE','ACCEPTED')`,
    js: (i) => ['ARRIVED', 'EN_ROUTE', 'ACCEPTED'].includes(upper(i.workerStatus) ?? ''),
    then: 'accepted',
    why: 'THE COLLAPSE, and the reason this whole exercise exists. Admin\'s legacy '
      + 'union has no en_route or arrived, so all three report as accepted. The '
      + 'portal reads canonicalState for the real answer. Previously EN_ROUTE and '
      + 'ARRIVED matched no branch at all and fell through to `assigned` — so the '
      + 'list and the detail page disagreed about the same booking.',
  },
  {
    sql: `{w}.worker_status IN ('DECLINED','REASSIGNED','CANCELLED','CANCELED')`,
    js: (i) => ['DECLINED', 'REASSIGNED', 'CANCELLED', 'CANCELED'].includes(upper(i.workerStatus) ?? ''),
    then: 'awaiting_assignment',
    why: 'An assignment that ENDED is not an assignment. `declineJob` does not '
      + 'rewrite bookings.status, so these rows sat in the list labelled Assigned '
      + 'with nobody on them. Must be tested before bookings.status is consulted.',
  },
  {
    sql: `{w}.worker_status = 'ASSIGNED'`,
    js: (i) => upper(i.workerStatus) === 'ASSIGNED',
    then: 'assigned',
  },
  {
    sql: `{b}.status = 'WORKER_ASSIGNED'`,
    js: (i) => upper(i.bookingStatus) === 'WORKER_ASSIGNED',
    then: (i) => (i.workerUid === null ? 'awaiting_assignment' : 'assigned'),
    why: 'WORKER_ASSIGNED with nobody assigned. SQL always reads the column, so '
      + 'this is always the "looked and found nothing" case.',
  },
  {
    sql: `{b}.status = 'PENDING_OTP'`,
    js: (i) => upper(i.bookingStatus) === 'PENDING_OTP',
    then: 'new',
  },
  {
    sql: `{b}.status IN ('CONFIRMED','PAID')`,
    js: (i) => ['CONFIRMED', 'PAID'].includes(upper(i.bookingStatus) ?? ''),
    then: (i) => (i.workerUid === null ? 'awaiting_assignment' : 'assigned'),
  },
];

/**
 * The fallback. An unrecognised status is intake, not an error — and reporting
 * it as needing a provider puts it in front of an admin instead of hiding it
 * among genuinely new bookings.
 */
const FALLBACK: LegacyOperationsStatus = 'awaiting_assignment';

/**
 * The reference evaluator. Same branches, same order, in JavaScript.
 *
 * This is what the equivalence test measures against `deriveCanonicalState`.
 */
export function evaluateAdminOpsStatus(input: OpsStatusInput): LegacyOperationsStatus {
  for (const branch of BRANCHES) {
    if (branch.js(input)) {
      return typeof branch.then === 'function' ? branch.then(input) : branch.then;
    }
  }
  return FALLBACK;
}

/**
 * `worker_uid` is normalised to NULL on BOTH paths.
 *
 * An empty string is not a provider. The old SQL tested `worker_uid = ''`
 * explicitly in one branch and ignored it in another, so `''` produced
 * different answers depending on which branch a row reached.
 */
export const normaliseProviderUid = (uid: string | null | undefined): string | null => {
  const trimmed = (uid ?? '').trim();
  return trimmed === '' ? null : trimmed;
};

export interface OpsStatusSqlOptions {
  /**
   * `db.schema` is `process.env.SCHEMA`, so it is `string | undefined` — and
   * every other query in `adminBookingService` interpolates it directly, which
   * renders the literal text `undefined` when it is unset. The type matches
   * that reality rather than casting it away: narrowing to `string` here would
   * only move a platform-wide configuration fault behind a cast at the one
   * call site that noticed it.
   */
  schema: string | undefined;
  /** Alias of the bookings table in the surrounding query. */
  bookingAlias: string;
  /** Alias of the latest-assignment join, exposing `worker_status`. */
  assignmentAlias: string;
}

/**
 * Emits the `CASE` expression. Generated from `BRANCHES`, never hand-written.
 */
export function adminOpsStatusSql(opts: OpsStatusSqlOptions): string {
  const uid = `NULLIF(TRIM(COALESCE(${opts.bookingAlias}.worker_uid, '')), '')`;
  const fill = (s: string) => s
    .replace(/\{schema\}/g, String(opts.schema))
    .replace(/\{b\}/g, opts.bookingAlias)
    .replace(/\{w\}/g, opts.assignmentAlias);

  const lines = BRANCHES.map((branch) => {
    const predicate = fill(branch.sql);
    if (typeof branch.then === 'function') {
      // The only shape needing a nested decision: assigned iff a provider is on it.
      const whenNull = branch.then({
        bookingStatus: null, workerStatus: null, workerUid: null, hasUnresolvedEscalation: false,
      });
      const whenSet = branch.then({
        bookingStatus: null, workerStatus: null, workerUid: 'x', hasUnresolvedEscalation: false,
      });
      return `          WHEN ${predicate}\n`
        + `            THEN CASE WHEN ${uid} IS NULL THEN '${whenNull}' ELSE '${whenSet}' END`;
    }
    return `          WHEN ${predicate}\n            THEN '${branch.then}'`;
  });

  return `        CASE\n${lines.join('\n')}\n          ELSE '${FALLBACK}'\n        END`;
}

/** Exposed so a test can assert the SQL and the evaluator cover the same branches. */
export const OPS_STATUS_BRANCH_COUNT = BRANCHES.length;

/** Every value the expression can produce. Used to pin the filter's domain. */
export const OPS_STATUS_VALUES: readonly LegacyOperationsStatus[] = [
  ...new Set<LegacyOperationsStatus>([
    ...BRANCHES.flatMap((b) => (typeof b.then === 'function'
      ? ([
        b.then({ bookingStatus: null, workerStatus: null, workerUid: null, hasUnresolvedEscalation: false }),
        b.then({ bookingStatus: null, workerStatus: null, workerUid: 'x', hasUnresolvedEscalation: false }),
      ])
      : [b.then])),
    FALLBACK,
  ]),
];
