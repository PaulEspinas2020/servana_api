import { emitToProvider } from '../provider.realtime';

export type ReputationRealtimeReason =
  | 'REVIEW_SUBMITTED'
  | 'REVIEW_EDITED'
  | 'REVIEW_WITHDRAWN'
  | 'PROVIDER_RESPONSE_SUBMITTED'
  | 'PROVIDER_RESPONSE_MODERATED'
  | 'REVIEW_REPORTED'
  | 'APPEAL_SUBMITTED'
  | 'REVIEW_MODERATED';

/**
 * Invalidates provider reputation screens without placing customer content or
 * other sensitive review data on the socket. Clients reload canonical REST
 * resources after receiving this small, forward-compatible envelope.
 */
export function emitReputationUpdated(
  providerUid: string,
  reason: ReputationRealtimeReason,
  reviewId?: string,
): void {
  emitToProvider(providerUid, 'reputation:updated', {
    reason,
    ...(reviewId ? { reviewId } : {}),
    occurredAt: new Date().toISOString(),
  });
}
