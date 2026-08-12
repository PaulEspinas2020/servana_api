/**
 * Repairs `chat_participants` from `booking_workers`.
 *
 * ## Why a reconciler and not a transaction
 *
 * Chat membership is updated fire-and-forget after a reassignment commits, so
 * a chat-table problem cannot fail a reassignment an admin has already
 * requested. That is the right trade — a reassignment refused because a chat
 * table was slow is a worse day than a stale participant row — but it means the
 * projection can drift.
 *
 * The drift used to be dangerous, because the projection was ALSO the
 * authorization source: a missing row meant no read floor and full capability.
 * That is fixed at the source now — `booking_workers` decides, and
 * `chat_participants` may only narrow. So drift is no longer a leak.
 *
 * It is still wrong, and it still needs repairing, for three reasons the
 * authorization fix does not cover:
 *
 *   - realtime membership is a live socket room, not a query;
 *   - unread counts and conversation lists read the participant table;
 *   - a stale row is evidence that something failed, and evidence that nobody
 *     acts on is just noise.
 *
 * ## Idempotent by construction
 *
 * It computes the DESIRED state from the booking and writes that, rather than
 * applying a diff. Running it twice changes nothing the second time; running it
 * on a conversation that was already correct is a no-op. So it is safe to
 * retry, safe to run on a timer, and safe to call after every reassignment as a
 * belt-and-braces follow-up.
 */

import * as repo from './chat.repository';
import { evictUserFromConversation } from './chat.realtime';

export interface ReconcileOutcome {
  bookingId: number;
  conversationId: number | null;
  admitted: string[];
  departed: string[];
  /** True when nothing needed changing — the common case. */
  alreadyConsistent: boolean;
}

/**
 * Bring one booking's conversation membership back in line with its assignments.
 *
 * Never widens beyond what `booking_workers` says, because that is the only
 * thing it reads to decide.
 */
export async function reconcileConversationMembership(
  bookingId: number,
): Promise<ReconcileOutcome> {
  const conversation = await repo.findConversationByBookingId(bookingId);
  if (!conversation) {
    return { bookingId, conversationId: null, admitted: [], departed: [], alreadyConsistent: true };
  }

  const [activeUids, participants] = await Promise.all([
    repo.getBookingWorkerUids(bookingId),
    repo.listParticipants(conversation.id, true),
  ]);

  const clientUid = await repo.getBookingClientUid(bookingId);
  const active = new Set(activeUids.map(String));

  const admitted: string[] = [];
  const departed: string[] = [];

  // ── Anyone active on the booking must be present and able to send ──────────
  for (const uid of active) {
    const row = participants.find((p: any) => String(p.user_uid) === uid);
    const needsAdmitting = !row || row.left_at != null
      || row.can_read === false || row.can_send === false;
    if (!needsAdmitting) continue;
    const role = (await repo.getUserRole(uid)) ?? 2;
    await repo.upsertParticipant(conversation.id, uid, role);
    admitted.push(uid);
  }

  // ── Anyone no longer active must be marked departed ────────────────────────
  for (const p of participants) {
    const uid = String(p.user_uid);
    if (active.has(uid)) continue;
    // The customer is not an assignment and must never be evicted by this.
    if (clientUid && uid === String(clientUid)) continue;
    // Admins are authorized by role, not by a participant row.
    const role = Number(p.role);
    if (role === 1) continue;
    const alreadyGone = p.left_at != null && p.can_send === false && p.can_read === false;
    if (alreadyGone) continue;

    /**
     * `retainRead` is deliberately NOT passed.
     *
     * Read stays revoked by default. The fairness case for a departed provider
     * keeping evidence of work they performed is real, but the answer is a
     * BOUNDED historical window — from their assigned_at to their departure —
     * not the indefinite entitlement this boolean would grant, which would also
     * expose future messages between the customer and the new provider.
     * Queued as its own policy change.
     */
    await repo.removeParticipant(conversation.id, uid);
    evictUserFromConversation(conversation.id, uid);
    departed.push(uid);
  }

  return {
    bookingId,
    conversationId: conversation.id,
    admitted,
    departed,
    alreadyConsistent: admitted.length === 0 && departed.length === 0,
  };
}

/**
 * Repeated failure has to be visible.
 *
 * A `console.error` per attempt is not observability: it produces one line that
 * looks the same on the first failure and the hundredth, so a persistently
 * broken projection reads exactly like a transient blip. This counts
 * consecutive failures per booking and escalates the log once a run of them
 * establishes that it is not transient.
 */
const consecutiveFailures = new Map<number, number>();

/** Escalate after this many consecutive failures for the same booking. */
export const RECONCILE_ALERT_THRESHOLD = 3;

export async function reconcileWithRetryTracking(bookingId: number): Promise<ReconcileOutcome | null> {
  try {
    const outcome = await reconcileConversationMembership(bookingId);
    consecutiveFailures.delete(bookingId);
    return outcome;
  } catch (err) {
    const count = (consecutiveFailures.get(bookingId) ?? 0) + 1;
    consecutiveFailures.set(bookingId, count);
    if (count >= RECONCILE_ALERT_THRESHOLD) {
      console.error(
        `[chat-reconcile] booking ${bookingId} has failed ${count} consecutive times — `
        + 'the participant projection is stale and is not repairing itself. '
        + 'Access is NOT widened by this (booking_workers governs), but realtime '
        + 'membership and unread counts are wrong.',
        err,
      );
    } else {
      console.warn(`[chat-reconcile] booking ${bookingId} attempt ${count} failed`, err);
    }
    return null;
  }
}

/** Test-only: reset the failure counters between cases. */
export const __resetReconcileState = () => consecutiveFailures.clear();
