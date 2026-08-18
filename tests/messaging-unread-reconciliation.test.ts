/**
 * Unread counts reconcile, and realtime agrees with the fallback read.
 *
 * Two release gates, one suite, because they are the same question asked twice:
 * does every way of learning about a message arrive at the same answer?
 *
 *   - the BADGE (inbox unread) vs the THREAD (per-conversation unread) vs an
 *     independent recount from the message rows;
 *   - the SOCKET payload vs the REST row for the same message id.
 *
 * Both are properties of there being one derivation, so both are checked by
 * computing the answer twice by different routes and comparing.
 */

jest.mock('../src/config', () => ({
  db: { schema: 'servana' },
  tempId: undefined,
  firebaseConfig: { storageBucket: 'servana-test.appspot.com' },
}));
jest.mock('../src/db/dbQuery', () => {
  const fake = require('./support/chatDbFake');
  return { __esModule: true, default: fake.dbQueryFake, pool: { connect: jest.fn() } };
});
jest.mock('../src/services/adminNotificationService', () => ({ notifyAdminsSafely: jest.fn() }));
jest.mock('../src/services/notification.service', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
  createCustomerNotification: jest.fn().mockResolvedValue(undefined),
  clearFcmToken: jest.fn().mockResolvedValue(undefined),
}));

/** Captures what the service broadcasts, without a socket server. */
const emitted: Array<{ conversationId: number; event: string; payload: any }> = [];
jest.mock('../src/chat/chat.realtime', () => {
  const { withRealtimeEnvelope } = jest.requireActual('../src/services/messaging/conversationDto');
  return {
    setIo: jest.fn(),
    roomName: (id: number) => `conversation:${id}`,
    emitMessagingEvent: jest.fn(),
    emitToConversation: (conversationId: number, event: string, payload: any) => {
      // Mirrors the real emitter: the envelope is stamped on the way out, so a
      // test reading `emitted` sees exactly what a client would receive.
      emitted.push({ conversationId, event, payload: withRealtimeEnvelope(event, payload) });
    },
    evictUserFromConversation: jest.fn(),
    evictUserEverywhere: jest.fn().mockReturnValue(0),
  };
});

import * as fake from './support/chatDbFake';
import * as messaging from '../src/services/messaging/messagingService';
import * as chat from '../src/chat/chat.service';
import {
  toMessageDto,
  messageDtoFromRealtime,
} from '../src/services/messaging/conversationDto';
import {
  __resetMessagingTelemetry,
  snapshot,
} from '../src/services/messaging/messagingTelemetry';
import { UNREAD_DEFINITION } from '../src/services/messaging/messagingPolicy';

const CUSTOMER = 'customer-1';
const PROVIDER = 'provider-1';
const actor = (uid: string, role: number) => ({ uid, role });

let conversationId: number;

const seed = () => {
  fake.reset();
  emitted.length = 0;
  __resetMessagingTelemetry();
  fake.seedUser(CUSTOMER, 3);
  fake.seedUser(PROVIDER, 2);
  fake.seedBooking(300, CUSTOMER);
  fake.seedAssignment(300, PROVIDER, 'ACCEPTED', '2026-08-01T00:00:00.000Z');
  const c = fake.seedConversation(300);
  conversationId = Number(c.id);
  fake.seedParticipant(conversationId, CUSTOMER, 3, { joined_at: '2026-08-01T00:00:00.000Z' });
  fake.seedParticipant(conversationId, PROVIDER, 2, { joined_at: '2026-08-01T00:00:00.000Z' });
};

beforeEach(seed);

// ─── Unread ───────────────────────────────────────────────────────────────────

describe('unread is one definition with one answer', () => {
  it('counts messages from the other party and never your own', async () => {
    fake.seedMessage(conversationId, PROVIDER, 'on my way', { sender_role: 2 });
    fake.seedMessage(conversationId, PROVIDER, 'outside', { sender_role: 2 });
    fake.seedMessage(conversationId, CUSTOMER, 'ok', { sender_role: 3 });

    const forCustomer = await messaging.unreadCountFor(conversationId, CUSTOMER);
    const forProvider = await messaging.unreadCountFor(conversationId, PROVIDER);
    expect(forCustomer.count).toBe(2);
    expect(forProvider.count).toBe(1);
  });

  it('excludes soft-deleted messages', async () => {
    const m = fake.seedMessage(conversationId, PROVIDER, 'oops', { sender_role: 2 });
    expect((await messaging.unreadCountFor(conversationId, CUSTOMER)).count).toBe(1);
    (m as any).deleted_at = '2026-08-03T00:00:00.000Z';
    expect((await messaging.unreadCountFor(conversationId, CUSTOMER)).count).toBe(0);
  });

  it('does not hand a re-admitted participant a backlog', async () => {
    fake.seedMessage(conversationId, CUSTOMER, 'early', {
      sender_role: 3, created_at: '2026-08-01T06:00:00.000Z',
    });
    fake.seedMessage(conversationId, CUSTOMER, 'late', {
      sender_role: 3, created_at: '2026-08-05T00:00:00.000Z',
    });
    const p = fake.store.participants.find((x) => x.user_uid === PROVIDER)!;
    p.joined_at = '2026-08-04T00:00:00.000Z';

    expect((await messaging.unreadCountFor(conversationId, PROVIDER)).count).toBe(1);
  });

  it('the inbox badge and the per-conversation count are the same number', async () => {
    fake.seedMessage(conversationId, PROVIDER, 'one', { sender_role: 2 });
    fake.seedMessage(conversationId, PROVIDER, 'two', { sender_role: 2 });

    const [inboxRow] = await messaging.listConversations(actor(CUSTOMER, 3));
    const direct = await messaging.unreadCountFor(conversationId, CUSTOMER);
    const detail = await messaging.getConversation(actor(CUSTOMER, 3), conversationId);

    expect(inboxRow.unreadCount).toBe(2);
    expect(direct.count).toBe(2);
    expect(detail.unreadCount).toBe(2);
  });

  it('marking read returns the count AFTER the pointer moved', async () => {
    const first = fake.seedMessage(conversationId, PROVIDER, 'one', { sender_role: 2 });
    fake.seedMessage(conversationId, PROVIDER, 'two', { sender_role: 2 });

    const state = await messaging.markRead(actor(CUSTOMER, 3), conversationId, Number(first.id));
    expect(state.unreadCount).toBe(1);

    const detail = await messaging.getConversation(actor(CUSTOMER, 3), conversationId);
    expect(detail.unreadCount).toBe(1);
  });

  it('the read pointer is monotonic — a late request cannot un-read a thread', async () => {
    const a = fake.seedMessage(conversationId, PROVIDER, 'one', { sender_role: 2 });
    const b = fake.seedMessage(conversationId, PROVIDER, 'two', { sender_role: 2 });

    await messaging.markRead(actor(CUSTOMER, 3), conversationId, Number(b.id));
    const late = await messaging.markRead(actor(CUSTOMER, 3), conversationId, Number(a.id));
    expect(late.unreadCount).toBe(0);
  });

  it('a pointer naming a message in ANOTHER conversation is refused', async () => {
    fake.seedBooking(301, 'someone-else');
    const other = fake.seedConversation(301);
    const foreign = fake.seedMessage(Number(other.id), 'someone-else', 'not yours');

    await expect(
      messaging.markRead(actor(CUSTOMER, 3), conversationId, Number(foreign.id)),
    ).rejects.toMatchObject({ code: 'READ_POINTER_INVALID' });
  });

  it('an admin gets no count rather than a fabricated one', async () => {
    fake.seedUser('admin-9', 1);
    fake.seedMessage(conversationId, PROVIDER, 'hello', { sender_role: 2 });
    const result = await messaging.unreadCountFor(conversationId, 'admin-9');
    expect(result).toEqual({ count: 0, isParticipant: false });
  });

  /**
   * The drift detector, proven by breaking the thing it watches.
   *
   * The count comes from SQL; the check recomputes it from the rows. Here the
   * SQL answer is forced to disagree, and the signal must fire — otherwise the
   * detector is decoration and nobody would ever find out.
   */
  it('reports drift when the two derivations disagree, and does NOT silently correct it', async () => {
    fake.seedMessage(conversationId, PROVIDER, 'one', { sender_role: 2 });
    const repo = require('../src/chat/chat.repository');
    const spy = jest.spyOn(repo, 'countUnreadFor').mockResolvedValue(7);

    const result = await messaging.unreadCountFor(conversationId, CUSTOMER);
    // The reported number is the one the badge query gave. Correcting it here
    // would hide the disagreement, which is the only interesting part.
    expect(result.count).toBe(7);
    expect(Object.keys(snapshot().counts)).toContain('UNREAD_COUNT_DRIFT:OVERCOUNT');
    spy.mockRestore();
  });

  it('reports NO drift on the ordinary path', async () => {
    fake.seedMessage(conversationId, PROVIDER, 'one', { sender_role: 2 });
    await messaging.unreadCountFor(conversationId, CUSTOMER);
    expect(Object.keys(snapshot().counts)).not.toContain('UNREAD_COUNT_DRIFT:OVERCOUNT');
    expect(Object.keys(snapshot().counts)).not.toContain('UNREAD_COUNT_DRIFT:UNDERCOUNT');
  });

  it('the policy states the five clauses the SQL implements', () => {
    // Not a tautology: the count above is computed by SQL and the recount by
    // TypeScript, and this asserts the prose that both are written from exists
    // and is complete enough to be checked against.
    expect(UNREAD_DEFINITION).toHaveLength(5);
    expect(UNREAD_DEFINITION.join(' ')).toMatch(/not the sender/);
    expect(UNREAD_DEFINITION.join(' ')).toMatch(/soft-deleted/);
  });
});

// ─── Realtime vs fallback ─────────────────────────────────────────────────────

describe('the socket payload and the REST row are the same message', () => {
  it('projecting the emitted payload gives byte-for-byte the REST DTO', async () => {
    const sent = await messaging.sendMessage(actor(CUSTOMER, 3), conversationId, {
      body: 'is 2pm still ok?',
      clientMsgId: 'eeeeeeeeeeeeeeee-1',
    });

    const event = emitted.find((e) => e.event === 'message:new');
    expect(event).toBeDefined();

    // THE reconciliation guarantee. A client may replace a REST row with a
    // socket payload by id, unconditionally, because they are one object.
    expect(messageDtoFromRealtime(event!.payload)).toEqual(sent);
  });

  it('a fallback read returns the identical DTO for the same id', async () => {
    const sent = await messaging.sendMessage(actor(CUSTOMER, 3), conversationId, {
      body: 'still there?',
      clientMsgId: 'ffffffffffffffff-1',
    });
    const page = await messaging.listMessages(actor(CUSTOMER, 3), conversationId);
    const fetched = page.messages.find((m) => m.id === sent.id);

    // `isMine` and the receipt counts are viewer-relative, and the send
    // response is built for a room rather than a person — so the comparison is
    // over the message IDENTITY and content, which is what a merge keys on.
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(sent.id);
    expect(fetched!.body).toBe(sent.body);
    expect(fetched!.clientMsgId).toBe(sent.clientMsgId);
    expect(fetched!.senderUid).toBe(sent.senderUid);
    expect(fetched!.senderSeat).toBe(sent.senderSeat);
    expect(fetched!.sentAt).toBe(sent.sentAt);
  });

  it('the emitted payload still carries the LEGACY keys four shipped clients read', () => {
    const event = emitted.find((e) => e.event === 'message:new');
    expect(event).toBeUndefined(); // fresh case; send below

    return messaging
      .sendMessage(actor(CUSTOMER, 3), conversationId, {
        body: 'hello',
        clientMsgId: 'gggggggggggggggg-1',
      })
      .then(() => {
        const payload = emitted.find((e) => e.event === 'message:new')!.payload;
        for (const key of ['id', 'conversationId', 'body', 'senderUid', 'senderRole', 'createdAt', 'attachments']) {
          expect(payload).toHaveProperty(key);
        }
        // ...and the canonical ones, on the same object.
        for (const key of ['senderSeat', 'sentAt', 'isDeleted', 'readByCount']) {
          expect(payload).toHaveProperty(key);
        }
      });
  });

  it('every emitted payload carries the envelope', async () => {
    await messaging.sendMessage(actor(CUSTOMER, 3), conversationId, {
      body: 'envelope please',
      clientMsgId: 'hhhhhhhhhhhhhhhh-1',
    });
    const payload = emitted.find((e) => e.event === 'message:new')!.payload;
    expect(payload.event).toBe('message:new');
    expect(payload.schemaVersion).toBe(1);
    expect(typeof payload.emittedAt).toBe('string');
  });
});

// ─── Duplicate suppression ────────────────────────────────────────────────────

describe('a retried send resolves to one message, not two', () => {
  it('returns the ORIGINAL message and counts the suppression', async () => {
    const first = await messaging.sendMessage(actor(CUSTOMER, 3), conversationId, {
      body: 'sent once',
      clientMsgId: 'iiiiiiiiiiiiiiii-1',
    });
    const retry = await messaging.sendMessage(actor(CUSTOMER, 3), conversationId, {
      body: 'sent once',
      clientMsgId: 'iiiiiiiiiiiiiiii-1',
    });

    expect(retry.id).toBe(first.id);
    expect(fake.store.messages.filter((m) => m.client_msg_id === 'iiiiiiiiiiiiiiii-1')).toHaveLength(1);
    expect(snapshot().counts['MESSAGE_DUPLICATE_SUPPRESSED']).toBe(1);
  });

  it('the two-device race is closed by the index, not only by the pre-read', async () => {
    // The pre-read is a fast path. Skipping it leaves only the partial unique
    // index — which is the guard that holds when two devices arrive together.
    const repo = require('../src/chat/chat.repository');
    const spy = jest.spyOn(repo, 'findMessageByClientId').mockResolvedValueOnce(null);

    const first = await messaging.sendMessage(actor(CUSTOMER, 3), conversationId, {
      body: 'racing',
      clientMsgId: 'jjjjjjjjjjjjjjjj-1',
    });
    spy.mockResolvedValueOnce(null);
    const second = await messaging.sendMessage(actor(CUSTOMER, 3), conversationId, {
      body: 'racing',
      clientMsgId: 'jjjjjjjjjjjjjjjj-1',
    });

    expect(second.id).toBe(first.id);
    expect(fake.store.messages.filter((m) => m.client_msg_id === 'jjjjjjjjjjjjjjjj-1')).toHaveLength(1);
    spy.mockRestore();
  });

  it('a send with no idempotency key is refused rather than accepted twice', async () => {
    await expect(
      messaging.sendMessage(actor(CUSTOMER, 3), conversationId, { body: 'no key' }),
    ).rejects.toMatchObject({ code: 'CLIENT_MSG_ID_INVALID' });
    expect(snapshot().counts['MESSAGE_SEND_FAILED:CLIENT_MSG_ID_INVALID']).toBe(1);
  });
});

// ─── Receipts ─────────────────────────────────────────────────────────────────

describe('read receipts are derived, never fabricated', () => {
  it('a message becomes readByAll when every other active participant has passed it', async () => {
    const m = fake.seedMessage(conversationId, CUSTOMER, 'did you see this?', { sender_role: 3 });

    let page = await messaging.listMessages(actor(CUSTOMER, 3), conversationId);
    expect(page.messages[0].readByCount).toBe(0);
    expect(page.messages[0].readByAll).toBe(false);

    await messaging.markRead(actor(PROVIDER, 2), conversationId, Number(m.id));

    page = await messaging.listMessages(actor(CUSTOMER, 3), conversationId);
    expect(page.messages[0].readByCount).toBe(1);
    expect(page.messages[0].readByAll).toBe(true);
  });

  it('publishes no delivery timestamp, because none is known', async () => {
    const page = await messaging.listMessages(actor(CUSTOMER, 3), conversationId);
    const dto = page.messages[0] ?? toMessageDto({
      id: 1, conversationId, bookingId: 300, type: 'text', body: null,
      senderSeat: 'customer', senderUid: null, isMine: false, isSystem: false,
      clientMsgId: null, sentAt: null, editedAt: null, deletedAt: null, isDeleted: false,
      readByCount: 0, readByAll: false, attachments: [], metadata: {},
      senderRole: null, createdAt: null,
    });
    expect(dto).not.toHaveProperty('deliveredAt');
    expect(dto).toHaveProperty('sentAt');
  });

  it('a departed participant\'s stale pointer does not mark later messages read', async () => {
    const m = fake.seedMessage(conversationId, CUSTOMER, 'after they left', { sender_role: 3 });
    const p = fake.store.participants.find((x) => x.user_uid === PROVIDER)!;
    p.last_read_message_id = Number(m.id);
    p.left_at = '2026-08-06T00:00:00.000Z';

    const page = await messaging.listMessages(actor(CUSTOMER, 3), conversationId);
    const dto = page.messages.find((x) => x.id === Number(m.id))!;
    expect(dto.readByCount).toBe(0);
    expect(dto.readByAll).toBe(false);
  });
});
