/**
 * "Today" and "this month", in ONE definition.
 *
 * ## The defect this closes
 *
 * Servana operates in Asia/Manila, and `src/db/dbQuery.ts` pins the pg session
 * to `timezone=UTC` — deliberately, so that timestamps parse identically on
 * every machine. That pinning is right and is not what changed here.
 *
 * The consequence is that a bare `DATE_TRUNC('month', ts)` truncates to a **UTC**
 * month. Manila is UTC+8, so the first eight hours of every Manila month fall in
 * the previous UTC one. Five services computed a period boundary and they did
 * not agree:
 *
 *   Manila-bounded, correct        adminDashboardService  (6 sites)
 *                                  adminFinanceService    (2 sites)
 *
 *   UTC-bounded, wrong             adminProviderService   thisMonthGross
 *                                  technicianService      monthly earnings label
 *
 * So two admin screens reported "this month" over different months, and a
 * provider's monthly earnings breakdown could file a job completed at 03:00 on
 * the first into the month before — money in the wrong row, on the screen a
 * provider checks to see whether they were paid correctly.
 *
 * ## Why a shared fragment rather than five careful edits
 *
 * Because the five sites were already five careful edits, and three of them
 * happened to be right. A rule that has to be remembered at every call site is
 * a rule that will be half-applied again the next time somebody adds a
 * dashboard tile. One definition, imported, is the only version of this that
 * stays true.
 *
 * The same argument `revenueSplit.ts` makes about the commission rate: a number
 * duplicated across twelve sites is not a constant, it is twelve opportunities
 * to disagree.
 *
 * ## What `AT TIME ZONE` does here
 *
 * Applied to a `timestamptz`, it converts to wall-clock time in that zone and
 * yields a `timestamp` (no zone). So both sides of a comparison must be
 * converted, or a Manila wall time is compared against a UTC instant and the
 * eight hours reappear.
 */

/**
 * The business timezone.
 *
 * An IANA name, not an offset, because the Philippines has no daylight saving
 * today but an offset hard-coded as +08 would be a silent lie if that ever
 * changed. Postgres resolves the name against its own tz database.
 */
export const BUSINESS_TIMEZONE = 'Asia/Manila';

/**
 * A **timestamptz** expression as Manila wall-clock time.
 *
 * ONLY for a column that carries a zone. Applying this to a
 * `timestamp without time zone` converts the WRONG WAY — it reads the naive
 * value as though it were already Manila and hands back a timestamptz — and the
 * result looks plausible while being eight hours out. Measured against PGlite
 * for the instant 2026-08-31 19:00 UTC, which is 1 September in Manila:
 *
 *   naive, no conversion                        2026-08   wrong
 *   naive AT TIME ZONE 'Asia/Manila'            2026-08   wrong, and wrong way
 *   naive AT TIME ZONE 'UTC' AT TIME ZONE …     2026-09   correct
 *   timestamptz, no conversion                  2026-08   wrong
 *   timestamptz AT TIME ZONE 'Asia/Manila'      2026-09   correct
 *
 * Use `inBusinessZoneFromNaiveUtc` for the naive case.
 */
export const inBusinessZone = (expr: string): string =>
  `(${expr} AT TIME ZONE '${BUSINESS_TIMEZONE}')`;

/**
 * A **timestamp without time zone** column, stored UTC, as Manila wall time.
 *
 * Two conversions, and both are needed. The first states what the naive value
 * MEANS — `src/db/dbQuery.ts` says of these columns "It is stored UTC" — which
 * produces a real instant; the second moves that instant into Manila. Skipping
 * the first is the mistake that reads a UTC timestamp as a Manila one.
 */
export const inBusinessZoneFromNaiveUtc = (expr: string): string =>
  `(${expr} AT TIME ZONE 'UTC' AT TIME ZONE '${BUSINESS_TIMEZONE}')`;

/** `now`, as Manila wall-clock time. */
export const businessNow = (): string => inBusinessZone('NOW()');

/**
 * The start of the current business day / week / month, as a Manila wall-clock
 * timestamp. Compare it against `inBusinessZone(column)`, never against the
 * raw column.
 */
export const businessPeriodStart = (unit: 'day' | 'week' | 'month'): string =>
  `DATE_TRUNC('${unit}', ${businessNow()})`;

/**
 * True when `expr` falls in the current business period.
 *
 * Both sides are converted, which is the part that is easy to get half-right:
 * truncating only `NOW()` and leaving the column in UTC moves the boundary
 * rather than fixing it.
 */
export const inCurrentBusinessPeriod = (
  expr: string,
  unit: 'day' | 'week' | 'month',
): string =>
  `DATE_TRUNC('${unit}', ${inBusinessZone(expr)}) = ${businessPeriodStart(unit)}`;

/**
 * The business-month label for a timestamptz, as `YYYY-MM`.
 *
 * Used for grouping an earnings history. Without the zone conversion a job
 * completed at 03:00 Manila on the first of a month is labelled with the
 * PREVIOUS month, which puts a provider's money in the wrong row.
 */
export const businessMonthLabel = (expr: string, naiveUtc = false): string =>
  `TO_CHAR(${businessMonthOf(expr, naiveUtc)}, 'YYYY-MM')`;

/**
 * The truncated business month, for GROUP BY / ORDER BY.
 *
 * `naiveUtc` when the column is `timestamp without time zone` — the label and
 * the grouping MUST use the same expression, or rows group into one month and
 * are labelled with another.
 */
export const businessMonthOf = (expr: string, naiveUtc = false): string =>
  `DATE_TRUNC('month', ${naiveUtc ? inBusinessZoneFromNaiveUtc(expr) : inBusinessZone(expr)})`;
