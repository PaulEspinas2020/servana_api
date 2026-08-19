/**
 * The canonical admin finance endpoints — TAB 08 wave 3, first entry.
 *
 * ## Why this one arrives alone
 *
 * The book is explicit that finance must not be canonicalised before the
 * disbursement surface is unified, and that the refund review LIFECYCLE must be
 * correct before refunds are migrated. This endpoint is the lifecycle work, not
 * the migration: `failed` is the terminal the state machine never had.
 *
 * `requested -> approved -> processed` was the only path out. A refund the
 * processor refuses — a closed wallet, a reversed card, a bank that rejects the
 * transfer — stayed `approved` for ever, and because `openRefundReview` refuses
 * a second review while one is `requested` or `approved`, that stuck row BLOCKED
 * every retry for the booking. The customer could not be refunded by anyone.
 *
 * It arrives in v1 rather than only in the legacy router because the orphan
 * ratchet asked the right question: a NEW legacy route with no v1 disposition
 * grows the undispositioned surface, and this repository's gate refuses that.
 * Adding the route to the canonical contract answers it properly instead of
 * freezing one more exception.
 *
 * ## Transport only
 *
 * `markRefundFailed` — the state guard, the audit, and the decision not to
 * touch the payments row — stays in `adminFinanceService`. Both surfaces call
 * the same executor. A transport layer that can disagree with its domain
 * service is a second implementation of the rule, and for money the second one
 * is always the one that skips the audit.
 *
 * ## Authorization is declared, not implied
 *
 * `auth: 'admin'` proves role 1. The contract entry additionally names
 * `refunds.mark_failed`, the same permission the legacy twin demands, and
 * `register.ts` refuses to start if an admin entry declares none. A v1
 * successor gated on role alone would be a quieter route to the same
 * capability — privilege escalation arriving as a migration.
 */

import { Request, Response } from 'express';
import * as svc from '../../../services/adminFinanceService';
import { ok, sendCaught } from '../envelope';
import { ApiError } from '../errors';
import { V1Handlers } from '../types';

const actorUid = (req: Request): string => String((req as any).user?.uid ?? '');
const actorName = (req: Request): string | null => (req as any).user?.name ?? null;
const requestId = (req: Request): string | null => (req as any).id ?? null;

/**
 * `refundId` is attacker-supplied, so it is refused rather than coerced.
 *
 * `Number('12abc')` is NaN and `Number('')` is 0; both would reach the executor
 * as a query for a review that cannot exist, and the operator would be told
 * "not found" for a request that was never valid.
 */
/**
 * Translate a domain refusal into the v1 vocabulary.
 *
 * The domain services throw plain errors carrying a `code` — the legacy
 * controller reads it in `handleSvcError`. `sendCaught` only understands
 * `ApiError`, so without this every refusal the executor raises would be logged
 * as an internal error and answered 500: "this refund is already processed"
 * reported as a crash. Watched happening — the live router test caught it,
 * which is precisely what a real-socket gate is for.
 *
 * An unrecognised code is deliberately NOT mapped. It falls through to
 * `sendCaught`, which logs it and answers INTERNAL — because a code this layer
 * has never seen is a genuine surprise, and inventing a 4xx for it would tell
 * the caller their request was at fault when nobody knows that yet.
 */
const DOMAIN_TO_V1: Record<string, string> = {
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  FORBIDDEN: 'FORBIDDEN',
  BUSINESS_RULE: 'VALIDATION_FAILED',
};

const asApiError = (error: unknown): unknown => {
  const code = (error as { code?: string } | null)?.code;
  const mapped = code ? DOMAIN_TO_V1[code] : undefined;
  if (!mapped) return error;
  return new ApiError(mapped as never, (error as Error).message);
};

const readRefundId = (req: Request): number => {
  const id = Number(req.params.refundId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ApiError('VALIDATION_FAILED', 'refundId must be a positive integer');
  }
  return id;
};

export const handlers: V1Handlers = {
  /**
   * Record that an approved refund did not go through.
   *
   * The reason is required. "Failed" with no explanation leaves the next
   * operator unable to tell a retriable processor timeout from a closed
   * account, and this row is the only place that distinction is written down.
   */
  'admin.refunds.markFailed': async (req: Request, res: Response) => {
    try {
      const refundId = readRefundId(req);
      const reason = req.body?.failureReason;
      if (typeof reason !== 'string' || !reason.trim()) {
        throw new ApiError('VALIDATION_FAILED', 'failureReason is required');
      }

      await svc.markRefundFailed(refundId, reason.trim(), actorUid(req), actorName(req), requestId(req));

      // The projection is the transition, not the row. A caller that needs the
      // review reads it back; answering with a full record here would make this
      // endpoint a second, subtly different source for it.
      return ok(res, req, { refundId, status: 'failed' });
    } catch (error) {
      return sendCaught(res, req, 'admin.refunds.markFailed', asApiError(error));
    }
  },
};
