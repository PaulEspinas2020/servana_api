/**
 * The refund-approval statement, alone in a module with no dependencies.
 *
 * ## Why it lives here rather than in adminFinanceService
 *
 * `scripts/verify-refund-segregation.ts` executes this against real PostgreSQL
 * (PGlite) to prove the engine refuses a self-approval. That gate is only worth
 * having if it runs the statement the service ACTUALLY issues — a copy in the
 * gate would keep passing while this one drifted, which is the failure a gate
 * exists to remove rather than reproduce.
 *
 * Importing `adminFinanceService` from a script pulls in the whole domain graph
 * — config, env validation, every service it touches — which ts-node
 * type-checks in one pass and which fails there for reasons that have nothing
 * to do with refunds. A statement has no business requiring a database
 * connection and a Firebase credential to be readable.
 *
 * ## The guard
 *
 * `refunds.approve` declares `requires: ['refunds.review.open']`, so the
 * permission closure GUARANTEES every approver can also open a request. A
 * single admin runs open -> approve -> processed by construction and no
 * arrangement of grants separates them, which is why the rule is a predicate in
 * the write rather than a permission or a hidden button.
 *
 * `requested_by IS NULL OR` is not defensive noise. `requested_by` is nullable
 * and rows predating the admin route carry NULL; `NULL <> 'bob'` is NULL rather
 * than true, so without it every historical review would become permanently
 * unapprovable — a control that bricks old data instead of refusing one act.
 */

/**
 * @param schema the Postgres schema, injected rather than imported so this
 *   module needs no config. `db.schema` is typed `string | undefined` because
 *   it comes from the environment, and every other statement in the service
 *   interpolates it as-is — so this accepts the same type rather than forcing
 *   one call site to assert what the other forty do not. An unset schema
 *   produces `undefined.finance_refund_reviews`, which fails loudly at the
 *   engine; silently defaulting to `public` would be far worse, because it
 *   would find a different table and succeed.
 * @param enforceSegregation false only when REFUND_ALLOW_SELF_APPROVAL is set,
 *   which is audited on every approval taken under it
 */
export const approveRefundSql = (schema: string | undefined, enforceSegregation: boolean): string => `
  UPDATE ${schema}.finance_refund_reviews
     SET status='approved', reviewed_by=$2, reviewed_at=NOW(), updated_at=NOW()
   WHERE id=$1 AND status='requested'
     ${enforceSegregation ? 'AND (requested_by IS NULL OR requested_by <> $2)' : ''}
  RETURNING id, booking_id, amount, payout_reversal_needed`;
