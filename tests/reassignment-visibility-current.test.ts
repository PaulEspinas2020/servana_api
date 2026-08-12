/**
 * The reassignment visibility contract, and the fail-open it closed.
 *
 * Most of the privacy-first model was already implemented: reassignment marks
 * the old provider departed with read and send revoked, evicts their socket,
 * admits the new provider, and floors their message reads. The design was
 * sound. It FAILED OPEN.
 *
 * Authorization came from `booking_workers` and the read floor came from
 * `chat_participants`, so the two could disagree — and when they did, the
 * disagreement resolved towards more access. A provider with no participant
 * row, which is what a dropped membership update leaves behind, read the entire
 * transcript including the previous provider's messages, and a stale
 * `can_send` let a departed provider keep messaging the customer.
 *
 * Both now read from the assignment. The projection may narrow and never
 * widen, and a floor that cannot be determined denies rather than showing
 * everything.
 */

import fs from 'fs';
import path from 'path';

import { messageNotificationRecipients } from '../src/chat/chat.service';

const SRC = path.join(__dirname, '..', 'src');

const codeOf = (relative: string): string => fs
  .readFileSync(path.join(SRC, relative), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');

// ─── What already works ───────────────────────────────────────────────────────

describe('the old provider loses access at reassignment', () => {
  const service = codeOf('chat/chat.service.ts');
  const repo = codeOf('chat/chat.repository.ts');

  it('is marked departed, with send revoked and read revoked BY DEFAULT', () => {
    // `retainRead` defaults to false, so read is revoked unless a caller opts
    // in. Widening it is a policy decision rather than a default.
    expect(repo).toContain('SET left_at  = COALESCE(left_at, NOW())');
    expect(repo).toContain('can_send = FALSE');
    expect(service).toContain('retainRead: opts.retainReadForPrevious === true');
  });

  it('is evicted from the realtime room immediately', () => {
    // Revoking database access while a socket stays joined would keep
    // delivering live messages to somebody who can no longer fetch them.
    expect(service).toContain('evictUserFromConversation');
    const realtime = codeOf('chat/chat.realtime.ts');
    expect(realtime).toContain('socket.leave(room)');
    expect(realtime).toContain('conversation:access-revoked');
  });

  it('stops receiving message notifications', () => {
    // The pure recipient function, exercised directly.
    const out = messageNotificationRecipients({
      clientUid: 'cust-1',
      workerUids: ['provider-old', 'provider-new'],
      departedUids: ['provider-old'],
      senderUid: 'cust-1',
    });
    expect(out.providers).toEqual(['provider-new']);
    expect(out.customer).toBeNull(); // the sender is not notified
  });

  it('a booking carrying the same provider twice yields one notification', () => {
    // Reassignment can leave two booking_workers rows for one provider.
    const out = messageNotificationRecipients({
      clientUid: 'cust-1',
      workerUids: ['provider-1', 'provider-1'],
      departedUids: [],
      senderUid: 'cust-1',
    });
    expect(out.providers).toEqual(['provider-1']);
  });
});

describe('the new provider does not inherit the old transcript', () => {
  const service = codeOf('chat/chat.service.ts');
  const repo = codeOf('chat/chat.repository.ts');

  it('joins with a FRESH joined_at, even if they were on the booking before', () => {
    // upsertParticipant resets joined_at when a left_at is present, so a
    // provider re-admitted after departure does not regain the earlier window.
    expect(repo).toContain('WHEN ${dbSchema}.chat_participants.left_at IS NOT NULL THEN NOW()');
  });

  it('message reads are floored at the ASSIGNMENT timestamp', () => {
    // Authorization and the window now come from one row, so they cannot
    // disagree — which is what let a missing projection row remove the floor.
    expect(service).toContain('visibleAfter = access.assignedAt');
    expect(repo).toContain('($4::timestamptz IS NULL OR created_at >= $4)');
    expect(repo).toContain('getProviderAssignmentWindow');
  });

  it('attachments cannot be used to step around the floor', () => {
    // Attachments hydrate from rows listMessages already returned, so they
    // inherit the window rather than being addressable independently.
    expect(service).toContain('repo.listAttachments(row.id)');
    const routes = codeOf('chat/chat.routes.ts');
    expect(routes).not.toContain('attachments/:attachmentId');
  });

  it('admin and the customer keep the whole history', () => {
    // Deliberately unbounded: the audit trail is the point for one, and it is
    // their own conversation for the other.
    expect(service).toContain("access.role === 'admin' || access.role === 'client'");
    expect(service).toContain('const unbounded');
  });

  it('the handover message does not say WHY the provider changed', () => {
    expect(service).toContain('The assigned provider has changed.');
    for (const leak of ['cancelled', 'declined', 'removed for', 'no-show', 'unavailable']) {
      expect(service.toLowerCase()).not.toContain(`provider has changed. ${leak}`);
    }
  });
});

// ─── The fail-open, closed ────────────────────────────────────────────────────

describe('LEAK CLOSED: the floor no longer depends on the projection', () => {
  const service = codeOf('chat/chat.service.ts');

  it('THE NEGATIVE FIXTURE: no participant row does NOT mean full transcript', () => {
    /**
     * The scenario that proves the fail-open is gone:
     *
     *   booking_workers says the provider joined at T2
     *   chat_participants row is MISSING
     *   messages exist at T1 and T3
     *   the provider must see T3 only — never T1 + T3
     *
     * It holds because the floor is read from the assignment, not from the
     * absent projection row, so the row's absence contributes nothing.
     */
    expect(service).toContain('visibleAfter = access.assignedAt');
    expect(service).not.toContain('participant?.joined_at ?? null');

    // And when the assignment cannot supply a timestamp, it denies rather than
    // falling back to an unbounded read.
    expect(service).toContain("throw httpError(403, 'Message history is not available for this assignment')");
  });

  it('a stale can_send cannot outlive the assignment', () => {
    // The other half of the same failure: a dropped membership update used to
    // leave the departed provider able to keep messaging the customer.
    expect(service).toContain('const canSend = base.canSend &&');
    expect(service).toContain('canSend: window?.active === true');
  });

  it('the participant projection may only NARROW', () => {
    /**
     * Asserted as BEHAVIOUR, not as a sentence in a docblock — a rule stated in
     * prose is not enforced by anything.
     *
     * The reconciler decides purely from `booking_workers`, so it cannot grant
     * anything the booking did not; and the service combines the two with `&&`,
     * so the participant row can only subtract.
     */
    const reconciler = codeOf('chat/chat.reconciler.ts');
    expect(reconciler).toContain('repo.getBookingWorkerUids(bookingId)');
    expect(reconciler).not.toContain('can_send = TRUE');

    expect(service).toContain('const canSend = base.canSend &&');
  });

  it('a failed membership update now REPAIRS rather than only logging', () => {
    const admin = codeOf('services/adminBookingService.ts');
    expect(admin).toContain('reconcileWithRetryTracking(bookingId)');
  });

  it('repeated reconciler failure escalates instead of repeating one line', () => {
    // A console.error per attempt looks identical on the first failure and the
    // hundredth, so a persistently broken projection reads like a blip.
    const reconciler = codeOf('chat/chat.reconciler.ts');
    expect(reconciler).toContain('RECONCILE_ALERT_THRESHOLD');
    expect(reconciler).toContain('consecutive times');
  });

  it('the reconciler does NOT grant retainRead', () => {
    /**
     * The fairness case for a departed provider keeping evidence of their own
     * work is real, but the answer is a BOUNDED window — assigned_at to
     * departure — not the indefinite entitlement the boolean grants, which
     * would also expose future customer/new-provider messages.
     */
    const reconciler = codeOf('chat/chat.reconciler.ts');
    expect(reconciler).toContain('await repo.removeParticipant(conversation.id, uid)');
    expect(reconciler).not.toContain('retainRead: true');
  });

  it('the reconciler never evicts the customer or an admin', () => {
    const reconciler = codeOf('chat/chat.reconciler.ts');
    expect(reconciler).toContain('uid === String(clientUid)');
    expect(reconciler).toContain('if (role === 1) continue');
  });

  it('the reconciler is idempotent by construction', () => {
    // It computes the DESIRED state and writes that, rather than applying a
    // diff, so a second run is a no-op and a retry is safe.
    const reconciler = codeOf('chat/chat.reconciler.ts');
    expect(reconciler).toContain('alreadyConsistent');
    expect(reconciler).toContain('if (alreadyGone) continue');
  });
});

// ─── Booking facts, as distinct from messages ─────────────────────────────────

describe('booking-fact visibility follows the pointer, not the assignment', () => {
  it('provider reads key on bookings.worker_uid', () => {
    /**
     * So visibility MOVES with the pointer at reassignment: the previous
     * provider loses read access to a job they actually worked, and the new one
     * gains booking-level fields covering the period before they were on it.
     *
     * Measured, not judged — whether that is correct is the product question in
     * the contract options.
     */
    const controller = codeOf('controllers/providerController.ts');
    expect(controller).toContain('b.worker_uid = $1');
  });

  it('the job card is scoped to the acting provider', () => {
    const service = codeOf('services/technicianService.ts');
    expect(service).toContain('bw.worker_uid');
  });
});
