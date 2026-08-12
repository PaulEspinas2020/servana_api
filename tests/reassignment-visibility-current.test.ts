/**
 * What reassignment visibility does TODAY. Measurement, not policy.
 *
 * These tests document current behaviour so a contract can be written against
 * something measured rather than assumed — and so that when the contract does
 * land, the diff shows exactly what changed. Nothing here asserts what the
 * behaviour *should* be; where current behaviour is a leak, the test says so in
 * its name and pins the leak rather than pretending it is correct.
 *
 * ## The headline
 *
 * Most of the privacy-first contract is ALREADY implemented. Reassignment marks
 * the old provider departed with read revoked, admits the new one with a fresh
 * join timestamp, and message reads are floored at that timestamp — so the new
 * provider does not inherit the previous provider's messages.
 *
 * The gap is not the design. It is that the design FAILS OPEN.
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

describe('CURRENT: the old provider loses access at reassignment', () => {
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

describe('CURRENT: the new provider does not inherit the old transcript', () => {
  const service = codeOf('chat/chat.service.ts');
  const repo = codeOf('chat/chat.repository.ts');

  it('joins with a FRESH joined_at, even if they were on the booking before', () => {
    // upsertParticipant resets joined_at when a left_at is present, so a
    // provider re-admitted after departure does not regain the earlier window.
    expect(repo).toContain('WHEN ${dbSchema}.chat_participants.left_at IS NOT NULL THEN NOW()');
  });

  it('message reads are floored at the joining timestamp', () => {
    expect(service).toContain('const visibleAfter = participant?.joined_at');
    expect(repo).toContain('($4::timestamptz IS NULL OR created_at >= $4)');
  });

  it('attachments cannot be used to step around the floor', () => {
    // Attachments hydrate from rows listMessages already returned, so they
    // inherit the window rather than being addressable independently.
    expect(service).toContain('repo.listAttachments(row.id)');
    const routes = codeOf('chat/chat.routes.ts');
    expect(routes).not.toContain('attachments/:attachmentId');
  });

  it('admin keeps the whole history', () => {
    // `visibleAfter` is null for admin, deliberately: the audit trail is the
    // point, and support cannot investigate half a conversation.
    expect(service).toContain("access.role === 'admin' ? null : await repo.findParticipant");
  });

  it('the handover message does not say WHY the provider changed', () => {
    expect(service).toContain('The assigned provider has changed.');
    for (const leak of ['cancelled', 'declined', 'removed for', 'no-show', 'unavailable']) {
      expect(service.toLowerCase()).not.toContain(`provider has changed. ${leak}`);
    }
  });
});

// ─── The gap: the design fails OPEN ───────────────────────────────────────────

describe('LEAK CASE: the transcript floor fails open with no participant row', () => {
  const service = codeOf('chat/chat.service.ts');

  it('visibleAfter falls back to null — the FULL history — when the row is missing', () => {
    /**
     * `participant?.joined_at ?? null`, and `listMessages` treats null as
     * "no floor". So a provider who is authorized by the BOOKING but has no
     * `chat_participants` row reads the entire transcript, including every
     * message the previous provider wrote.
     *
     * Authorization and windowing come from DIFFERENT sources — access from
     * `booking_workers`, the window from `chat_participants` — so the two can
     * disagree, and when they do the disagreement resolves in favour of more
     * access.
     *
     * PINNED AS CURRENT BEHAVIOUR, not endorsed. This is the leak the contract
     * has to close.
     */
    expect(service).toContain('participant?.joined_at ?? null');
  });

  it('the membership update is FIRE-AND-FORGET, so the row can be absent', () => {
    /**
     * This is how the missing row happens. `handleProviderReassignment` runs in
     * a detached async IIFE with its own catch, deliberately, so chat cannot
     * fail a committed reassignment.
     *
     * That reasoning is right for a NOTIFICATION (§45) and wrong for
     * AUTHORIZATION. If it throws: the old provider keeps `can_read` and
     * `can_send`, the new provider never gets a participant row, and the only
     * trace is a console line. The reassignment is committed and nothing
     * retries.
     */
    const admin = codeOf('services/adminBookingService.ts');
    expect(admin).toContain('handleProviderReassignment(bookingId, fromProviderUid, toProviderUid)');
    expect(admin).toContain("console.error('[reassign] chat membership update failed'");
    // No retry, no queue, no reconciliation.
    expect(admin).not.toContain('retryChatMembership');
  });

  it('the two failure modes compound into a cross-provider read', () => {
    // Provider B is authorized by booking_workers, has no participant row
    // because the update failed, so reads Provider A's messages in full.
    // Documented as a scenario rather than asserted against a live database.
    const scenario = [
      'ADMIN_REASSIGN commits: A -> DECLINED, B -> ASSIGNED',
      'handleProviderReassignment throws (schema bootstrap, transient DB error)',
      'A keeps can_read/can_send; B has no chat_participants row',
      'B calls GET messages: authorized via booking_workers',
      'visibleAfter = null -> B reads A\'s entire conversation with the customer',
    ];
    expect(scenario).toHaveLength(5);
  });
});

// ─── Booking facts, as distinct from messages ─────────────────────────────────

describe('CURRENT: booking-fact visibility follows the pointer, not the assignment', () => {
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
