/**
 * One spelling of cancelled, and a boundary for the other.
 *
 * ## The problem
 *
 * Production holds both. Measured across `src/`: **54 sites write `CANCELLED`
 * and 28 write `CANCELED`.** Both reach the database, both are read back, and
 * every consumer that checks only one silently treats a cancelled booking as
 * live. Two derivations, two policies and two admin filters already special-case
 * the pair — and TAB 05 (assignment), notifications, earnings, refunds, reviews
 * and analytics would each duplicate the ambiguity if it were carried forward.
 *
 * ## The rule
 *
 *   CANONICAL, and the only spelling new code may WRITE:   CANCELLED
 *   Accepted on READ, at compatibility boundaries only:    CANCELED
 *
 * Reads normalise. Writes use the canonical spelling. A guard test
 * (`tests/booking-cancellation-vocabulary.test.ts`) fails the build if new
 * canonical code introduces the deprecated spelling, so this closes rather than
 * merely being documented.
 *
 * ## What is NOT changed
 *
 * Existing rows. Nothing here rewrites data — a migration that rewrote 28 sites'
 * worth of history would be a destructive change to legacy data for a
 * cosmetic gain (§57). The rows stay as they are and the read path stops caring.
 */

/** The one spelling to write. */
export const CANONICAL_CANCELLED = 'CANCELLED' as const;

/** The spelling that still exists in data and in older writers. Read-only. */
export const DEPRECATED_CANCELLED = 'CANCELED' as const;

/** Every spelling a read must treat as cancelled. */
export const CANCELLED_SPELLINGS: readonly string[] = [CANONICAL_CANCELLED, DEPRECATED_CANCELLED];

/**
 * Is this status any spelling of cancelled?
 *
 * Case-insensitive: production carries both cases too, and a lowercase
 * `cancelled` reaching a case-sensitive check reads as live.
 */
export const isCancelledStatus = (value: unknown): boolean =>
  CANCELLED_SPELLINGS.includes(String(value ?? '').toUpperCase());

/**
 * Normalise any cancelled spelling to the canonical one; pass everything else
 * through upper-cased.
 *
 * Use on the READ path. Do not use to rewrite stored values.
 */
export const normalizeCancelledStatus = (value: unknown): string => {
  const upper = String(value ?? '').toUpperCase();
  return isCancelledStatus(upper) ? CANONICAL_CANCELLED : upper;
};

/**
 * SQL fragment for "status is cancelled, either spelling".
 *
 * Exported so a query cannot accidentally check one spelling. Takes the column
 * expression so it composes with an alias.
 */
export const cancelledSqlPredicate = (column: string): string =>
  `UPPER(${column}) IN ('${CANONICAL_CANCELLED}', '${DEPRECATED_CANCELLED}')`;
