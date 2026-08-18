/**
 * The admin board's state derivation, in SQL — generated from ONE declaration.
 *
 * ## Why this file exists
 *
 * TAB 04 reduced booking state derivations from two to one. That count was
 * wrong: a THIRD lived in a query string. The admin booking list computes its
 * state in SQL, because the status filter and the `COUNT` have to apply to the
 * filtered set at the database level — a derivation done in TypeScript after
 * the fact would paginate the wrong rows. That requirement is real, so the SQL
 * cannot simply be deleted.
 *
 * What it could not stay is INDEPENDENT. Measured over the full cross-product of
 * legacy statuses, the old expression disagreed with `deriveCanonicalState` on
 * **107 of 440 combinations**. The same booking reported one state in the list
 * and another on its own detail page. The worst class was also the most
 * operationally damaging: a booking whose provider had DECLINED still showed as
 * `assigned`, so the queue that most needs an operator's attention was the one
 * hidden from it.
 *
 * ## The branches are CANONICAL, and the legacy value is derived
 *
 * Every branch below yields a `BookingState`. The legacy `operationsStatus` is
 * then produced by running that state through `toAdminProjection`, which is the
 * backend's one declared collapse. Nothing here restates the legacy mapping.
 *
 * That direction matters. The first version of this file mapped branches
 * straight to legacy values, which meant `ARRIVED`, `EN_ROUTE` and `ACCEPTED`
 * shared a single branch — fine for display, useless for filtering, and it
 * would have forced a second hand-written CASE the moment canonical filtering
 * was needed. A fourth source of truth, arriving by exactly the route the third
 * one did.
 *
 * ## What is generated from these branches
 *
 *   adminCanonicalStateSql()   the canonical state, for display and FILTERING
 *   adminOpsStatusSql()        the legacy value, for compatibility
 *   evaluateAdminCanonicalState()  the JS reference the tests measure
 *   evaluateAdminOpsStatus()       the same, collapsed
 *
 * `tests/admin-ops-status-sql.test.ts` diffs the evaluators against
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

import { BOOKING_STATES, type BookingState } from './canonicalState';
import { toAdminProjection, type LegacyOperationsStatus } from './projections';

/** The inputs a branch may test. `workerUid` is already NULL-normalised. */
export interface OpsStatusInput {
  bookingStatus: string | null;
  workerStatus: string | null;
  workerUid: string | null;
  hasUnresolvedEscalation: boolean;
}

interface Branch {
  /** SQL predicate. Placeholders are substituted by the emitters. */
  sql: string;
  /** The same predicate in JavaScript. */
  js: (i: OpsStatusInput) => boolean;
  /** The CANONICAL state this branch means. Legacy is derived from it. */
  state: BookingState | ((i: OpsStatusInput) => BookingState);
  why?: string;
}

const upper = (v: string | null): string | null => (v === null ? null : v.toUpperCase());

/** The one branch shape that needs a second decision: is a provider actually on it? */
const assignedIfProvider = (i: OpsStatusInput): BookingState =>
  (i.workerUid === null ? 'AWAITING_ASSIGNMENT' : 'ASSIGNED');

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
    state: 'DISPUTED',
    why: 'An open escalation outranks everything, including a terminal state.',
  },
  {
    sql: `{b}.status IN ('CANCELLED','CANCELED')`,
    js: (i) => ['CANCELLED', 'CANCELED'].includes(upper(i.bookingStatus) ?? ''),
    state: 'CANCELLED',
  },
  {
    sql: `{b}.status = 'EXPIRED'`,
    js: (i) => upper(i.bookingStatus) === 'EXPIRED',
    state: 'EXPIRED',
    why: 'Canonically its own state. Admin has no badge for it so it DISPLAYS as '
      + 'cancelled, but it stays filterable as itself. Previously it fell through '
      + 'to `new`, which put dead bookings at the TOP of the intake queue.',
  },
  {
    sql: `{b}.status IN ('REFUNDED','FAILED')`,
    js: (i) => ['REFUNDED', 'FAILED'].includes(upper(i.bookingStatus) ?? ''),
    state: 'CANCELLED',
  },
  {
    sql: `{b}.status = 'COMPLETED' OR {w}.worker_status = 'COMPLETED'`,
    js: (i) => upper(i.bookingStatus) === 'COMPLETED' || upper(i.workerStatus) === 'COMPLETED',
    state: 'COMPLETED',
  },
  {
    sql: `{w}.worker_status = 'IN_PROGRESS'`,
    js: (i) => upper(i.workerStatus) === 'IN_PROGRESS',
    state: 'IN_PROGRESS',
  },
  {
    sql: `{w}.worker_status = 'ARRIVED'`,
    js: (i) => upper(i.workerStatus) === 'ARRIVED',
    state: 'ARRIVED',
    why: 'Its own branch, not folded into ACCEPTED. Folding them is what made the '
      + 'state undisplayable AND unfilterable; the legacy collapse now happens '
      + 'once, downstream, where it is declared.',
  },
  {
    sql: `{w}.worker_status = 'EN_ROUTE'`,
    js: (i) => upper(i.workerStatus) === 'EN_ROUTE',
    state: 'EN_ROUTE',
  },
  {
    sql: `{w}.worker_status = 'ACCEPTED'`,
    js: (i) => upper(i.workerStatus) === 'ACCEPTED',
    state: 'ACCEPTED',
  },
  {
    sql: `{w}.worker_status IN ('DECLINED','REASSIGNED','CANCELLED','CANCELED')`,
    js: (i) => ['DECLINED', 'REASSIGNED', 'CANCELLED', 'CANCELED'].includes(upper(i.workerStatus) ?? ''),
    state: 'AWAITING_ASSIGNMENT',
    why: 'An assignment that ENDED is not an assignment. `declineJob` does not '
      + 'rewrite bookings.status, so these rows sat in the list labelled Assigned '
      + 'with nobody on them. Must be tested before bookings.status is consulted.',
  },
  {
    sql: `{w}.worker_status = 'ASSIGNED'`,
    js: (i) => upper(i.workerStatus) === 'ASSIGNED',
    state: 'ASSIGNED',
  },
  {
    sql: `{b}.status = 'WORKER_ASSIGNED'`,
    js: (i) => upper(i.bookingStatus) === 'WORKER_ASSIGNED',
    state: assignedIfProvider,
    why: 'WORKER_ASSIGNED with nobody assigned. SQL always reads the column, so '
      + 'this is always the "looked and found nothing" case.',
  },
  {
    sql: `{b}.status = 'PENDING_OTP'`,
    js: (i) => upper(i.bookingStatus) === 'PENDING_OTP',
    state: 'PENDING_OTP',
  },
  {
    sql: `{b}.status IN ('CONFIRMED','PAID')`,
    js: (i) => ['CONFIRMED', 'PAID'].includes(upper(i.bookingStatus) ?? ''),
    state: assignedIfProvider,
  },
];

/**
 * The fallback. An unrecognised status is intake, not an error — and reporting
 * it as needing a provider puts it in front of an admin instead of hiding it
 * among genuinely new bookings.
 */
const FALLBACK: BookingState = 'AWAITING_ASSIGNMENT';

/** The declared collapse, applied ONCE. Never restated in this file. */
export const legacyOpsFor = (state: BookingState): LegacyOperationsStatus =>
  toAdminProjection(state).operationsStatus;

/**
 * The reference evaluator. Same branches, same order, in JavaScript.
 *
 * This is what the equivalence test measures against `deriveCanonicalState`.
 */
export function evaluateAdminCanonicalState(input: OpsStatusInput): BookingState {
  for (const branch of BRANCHES) {
    if (branch.js(input)) {
      return typeof branch.state === 'function' ? branch.state(input) : branch.state;
    }
  }
  return FALLBACK;
}

/** The same answer, collapsed into Admin's legacy vocabulary. */
export const evaluateAdminOpsStatus = (input: OpsStatusInput): LegacyOperationsStatus =>
  legacyOpsFor(evaluateAdminCanonicalState(input));

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
 * Emits a `CASE`. Both public emitters share this, differing only in how a
 * branch's canonical state is turned into a literal.
 */
function emitCase(opts: OpsStatusSqlOptions, project: (state: BookingState) => string): string {
  const uid = `NULLIF(TRIM(COALESCE(${opts.bookingAlias}.worker_uid, '')), '')`;
  const fill = (s: string) => s
    .replace(/\{schema\}/g, String(opts.schema))
    .replace(/\{b\}/g, opts.bookingAlias)
    .replace(/\{w\}/g, opts.assignmentAlias);

  const lines = BRANCHES.map((branch) => {
    const predicate = fill(branch.sql);
    if (typeof branch.state === 'function') {
      const whenNull = project(branch.state({
        bookingStatus: null, workerStatus: null, workerUid: null, hasUnresolvedEscalation: false,
      }));
      const whenSet = project(branch.state({
        bookingStatus: null, workerStatus: null, workerUid: 'x', hasUnresolvedEscalation: false,
      }));
      return `          WHEN ${predicate}\n`
        + `            THEN CASE WHEN ${uid} IS NULL THEN '${whenNull}' ELSE '${whenSet}' END`;
    }
    return `          WHEN ${predicate}\n            THEN '${project(branch.state)}'`;
  });

  return `        CASE\n${lines.join('\n')}\n          ELSE '${project(FALLBACK)}'\n        END`;
}

/**
 * The CANONICAL state. This is what filtering and counting use, so an operator
 * can filter to EN_ROUTE and ARRIVED rather than only see them.
 */
export const adminCanonicalStateSql = (opts: OpsStatusSqlOptions): string =>
  emitCase(opts, (state) => state);

/** The legacy value, for compatibility. Same branches, collapsed. */
export const adminOpsStatusSql = (opts: OpsStatusSqlOptions): string =>
  emitCase(opts, legacyOpsFor);

/** Exposed so a test can assert the SQL and the evaluator cover the same branches. */
export const OPS_STATUS_BRANCH_COUNT = BRANCHES.length;

/** Every canonical state the expression can produce. Pins the filter's domain. */
export const CANONICAL_STATE_VALUES: readonly BookingState[] = [
  ...new Set<BookingState>([
    ...BRANCHES.flatMap((b) => (typeof b.state === 'function'
      ? [
        b.state({ bookingStatus: null, workerStatus: null, workerUid: null, hasUnresolvedEscalation: false }),
        b.state({ bookingStatus: null, workerStatus: null, workerUid: 'x', hasUnresolvedEscalation: false }),
      ]
      : [b.state])),
    FALLBACK,
  ]),
];

/** Every legacy value the expression can produce. */
export const OPS_STATUS_VALUES: readonly LegacyOperationsStatus[] =
  [...new Set(CANONICAL_STATE_VALUES.map(legacyOpsFor))];

/**
 * Is this a canonical state the machine actually knows?
 *
 * Used to reject a filter value at the boundary. A filter that silently matches
 * nothing is worse than one that refuses: the operator reads an empty board as
 * "no such bookings" rather than "you asked the wrong question".
 */
export const isBookingState = (v: unknown): v is BookingState =>
  typeof v === 'string' && (BOOKING_STATES as readonly string[]).includes(v);
