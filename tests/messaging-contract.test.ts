/**
 * The canonical route and the legacy route are ONE backend.
 *
 * ## What is being proven, and why it needs a test rather than a paragraph
 *
 * The command permits role-specific and legacy routes to survive a migration,
 * on one condition: they must not create separate business truth. That is easy
 * to claim in a migration matrix and impossible to verify by reading it — the
 * two paths are in different files, and a guard added to one is invisible from
 * the other.
 *
 * So this suite DRIVES both. The legacy `chat.controller` handlers and the v1
 * `conversations` handlers are called over one fake database with one fixture,
 * and the assertions are that they authorize the same people, refuse the same
 * people, and produce the same message identity for the same write.
 *
 * The admin portal's send is driven too, because it is the third caller of the
 * same write and the one most likely to acquire its own rules.
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
jest.mock('../src/chat/chat.realtime', () => ({
  setIo: jest.fn(),
  roomName: (id: number) => `conversation:${id}`,
  emitMessagingEvent: jest.fn(),
  emitToConversation: jest.fn(),
  evictUserFromConversation: jest.fn(),
  evictUserEverywhere: jest.fn().mockReturnValue(0),
}));
// The upload endpoint's storage call. The attachment RULES are the subject
// here; Firebase is not.
jest.mock('../src/helpers/firebaseStorageUploader', () => ({
  uploadFileToStorage: jest.fn(async (folder: string, key: string) =>
    `https://firebasestorage.googleapis.com/v0/b/servana-test.appspot.com/o/${folder}%2F${key}?alt=media`),
}));

import * as fake from './support/chatDbFake';
import * as chatController from '../src/chat/chat.controller';
import { handlers as v1 } from '../src/api/v1/domains/conversations';
import * as messaging from '../src/services/messaging/messagingService';

const CUSTOMER = 'customer-1';
const PROVIDER = 'provider-1';
const STRANGER = 'stranger-1';
const ADMIN = 'admin-1';

let conversationId: number;

// ─── A response double that records what a handler answered ───────────────────

interface Captured { status: number; body: any; headers: Record<string, string> }

const makeRes = () => {
  const captured: Captured = { status: 200, body: undefined, headers: {} };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(body: any) { captured.body = body; return res; },
    set(key: string, value: string) { captured.headers[key] = value; return res; },
  };
  return { res, captured };
};

const req = (o: Partial<{ params: any; query: any; body: any; user: any }> = {}) => ({
  params: o.params ?? {},
  query: o.query ?? {},
  body: o.body ?? {},
  user: o.user,
  get: () => undefined,
  id: 'test-request',
}) as any;

const seed = () => {
  fake.reset();
  fake.seedUser(CUSTOMER, 3);
  fake.seedUser(PROVIDER, 2);
  fake.seedUser(STRANGER, 3);
  fake.seedUser(ADMIN, 1);
  fake.seedBooking(400, CUSTOMER);
  fake.seedAssignment(400, PROVIDER, 'ACCEPTED', '2026-08-01T00:00:00.000Z');
  const c = fake.seedConversation(400);
  conversationId = Number(c.id);
  fake.seedParticipant(conversationId, CUSTOMER, 3, { joined_at: '2026-08-01T00:00:00.000Z' });
  fake.seedParticipant(conversationId, PROVIDER, 2, { joined_at: '2026-08-01T00:00:00.000Z' });
};

beforeEach(seed);

// ─── Authorization parity ─────────────────────────────────────────────────────

describe('the legacy route and the canonical route authorize identically', () => {
  const cases: Array<{ who: string; uid: string; allowed: boolean }> = [
    { who: 'the booking customer', uid: CUSTOMER, allowed: true },
    { who: 'the assigned provider', uid: PROVIDER, allowed: true },
    { who: 'an unrelated account', uid: STRANGER, allowed: false },
    { who: 'an admin', uid: ADMIN, allowed: true },
  ];

  for (const { who, uid, allowed } of cases) {
    it(`${who} gets the same answer from both transcript routes`, async () => {
      const legacy = makeRes();
      await chatController.getMessages(
        req({ params: { id: String(conversationId) }, user: { uid } }),
        legacy.res,
      );

      const canonical = makeRes();
      await v1['conversations.messages.list'](
        req({ params: { conversationId: String(conversationId) }, user: { uid } }),
        canonical.res,
      );

      if (allowed) {
        expect(legacy.captured.status).toBe(200);
        expect(canonical.captured.status).toBe(200);
      } else {
        expect(legacy.captured.status).toBe(403);
        expect(canonical.captured.status).toBe(403);
        expect(canonical.captured.body.error.code).toBe('CONVERSATION_ACCESS_DENIED');
      }
    });
  }

  it('both refuse a conversation that does not exist, with the same status', async () => {
    const legacy = makeRes();
    await chatController.getConversation(
      req({ params: { id: '9999' }, user: { uid: CUSTOMER } }),
      legacy.res,
    );
    const canonical = makeRes();
    await v1['conversations.get'](
      req({ params: { conversationId: '9999' }, user: { uid: CUSTOMER } }),
      canonical.res,
    );

    // The legacy detail route answers 403 for an unknown id — access is
    // resolved before existence, and a 404 there would confirm which
    // conversation ids exist. The canonical route keeps that behaviour rather
    // than "improving" it into an enumeration oracle.
    expect(legacy.captured.status).toBe(403);
    expect(canonical.captured.status).toBe(403);
    expect(canonical.captured.body.error.code).toBe('CONVERSATION_ACCESS_DENIED');
  });
});

// ─── One write, three callers ─────────────────────────────────────────────────

describe('every send path is the same write', () => {
  it('the canonical route and the legacy route produce ONE message for one key', async () => {
    const canonical = makeRes();
    await v1['conversations.messages.create'](
      req({
        params: { conversationId: String(conversationId) },
        user: { uid: CUSTOMER },
        body: { body: 'same message', clientMsgId: 'shared-idempotency-key-1' },
      }),
      canonical.res,
    );
    expect(canonical.captured.status).toBe(201);
    const created = canonical.captured.body.data;

    const legacy = makeRes();
    await chatController.sendMessage(
      req({
        params: { id: String(conversationId) },
        user: { uid: CUSTOMER },
        body: { body: 'same message', clientMsgId: 'shared-idempotency-key-1' },
      }),
      legacy.res,
    );

    // Same key, same sender, same conversation: the second call resolves to the
    // FIRST message. Two write paths that each minted a row would show up here
    // as two ids.
    expect(legacy.captured.body.message.id).toBe(created.id);
    expect(fake.store.messages.filter((m) => m.client_msg_id === 'shared-idempotency-key-1'))
      .toHaveLength(1);
  });

  it("the admin portal's send goes through the same service and obeys the same rules", async () => {
    const adminService = jest.requireActual('../src/services/adminCommunicationService');
    const message = await adminService.sendAdminMessage(
      conversationId, ADMIN, 'Support here.', 'admin-idempotency-key-001',
    );
    expect(message.senderUid).toBe(ADMIN);
    expect(message.senderSeat).toBe('support');

    // The same key again returns the same row, because it is the same write.
    const again = await adminService.sendAdminMessage(
      conversationId, ADMIN, 'Support here.', 'admin-idempotency-key-001',
    );
    expect(again.id).toBe(message.id);
  });

  it('the sender is the token, and a body field claiming otherwise is ignored', async () => {
    const captured = makeRes();
    await v1['conversations.messages.create'](
      req({
        params: { conversationId: String(conversationId) },
        user: { uid: CUSTOMER },
        body: {
          body: 'who sent this?',
          clientMsgId: 'identity-forgery-attempt-1',
          // Every shape a caller might try.
          senderUid: PROVIDER,
          senderId: PROVIDER,
          userId: PROVIDER,
          providerId: PROVIDER,
          customerId: STRANGER,
          senderRole: 1,
        },
      }),
      captured.res,
    );

    expect(captured.captured.status).toBe(201);
    expect(captured.captured.body.data.senderUid).toBe(CUSTOMER);
    expect(captured.captured.body.data.senderSeat).toBe('customer');
    const row = fake.store.messages.find((m) => m.client_msg_id === 'identity-forgery-attempt-1')!;
    expect(row.sender_uid).toBe(CUSTOMER);
    expect(Number(row.sender_role)).toBe(3);
  });
});

// ─── The canonical shapes ─────────────────────────────────────────────────────

describe('the canonical endpoints answer in the v1 envelope', () => {
  it('the inbox carries the badge total in meta', async () => {
    fake.seedMessage(conversationId, PROVIDER, 'hello', { sender_role: 2 });
    const captured = makeRes();
    await v1['conversations.list'](req({ user: { uid: CUSTOMER } }), captured.res);

    expect(captured.captured.status).toBe(200);
    expect(captured.captured.body.meta.unreadTotal).toBe(1);
    expect(captured.captured.body.data[0].unreadCount).toBe(1);
    // No second, independently-settable success signal.
    expect(captured.captured.body).not.toHaveProperty('success');
    expect(captured.captured.body).not.toHaveProperty('status');
  });

  it('opening a conversation for a booking is idempotent', async () => {
    const first = makeRes();
    await v1['conversations.create'](
      req({ user: { uid: CUSTOMER }, body: { bookingId: 400 } }), first.res,
    );
    const second = makeRes();
    await v1['conversations.create'](
      req({ user: { uid: CUSTOMER }, body: { bookingId: 400 } }), second.res,
    );

    expect(first.captured.status).toBe(201);
    expect(second.captured.body.data.id).toBe(first.captured.body.data.id);
    expect(fake.store.conversations.filter((c) => Number(c.booking_id) === 400)).toHaveLength(1);
  });

  it('a booking with no confirmed provider has no conversation to open', async () => {
    fake.seedBooking(401, CUSTOMER);
    const captured = makeRes();
    await v1['conversations.create'](
      req({ user: { uid: CUSTOMER }, body: { bookingId: 401 } }), captured.res,
    );
    expect(captured.captured.status).toBe(409);
    expect(captured.captured.body.error.code).toBe('CONVERSATION_NOT_AVAILABLE');
    expect(fake.store.conversations.filter((c) => Number(c.booking_id) === 401)).toHaveLength(0);
  });

  it('support MAY open one on an unassigned booking — that is how a customer gets help early', async () => {
    fake.seedBooking(402, CUSTOMER);
    const captured = makeRes();
    await v1['conversations.create'](
      req({ user: { uid: ADMIN }, body: { bookingId: 402 } }), captured.res,
    );
    expect(captured.captured.status).toBe(201);
    expect(captured.captured.body.data.bookingId).toBe(402);
  });

  it('pages with a cursor rather than an offset', async () => {
    for (let i = 0; i < 5; i += 1) {
      fake.seedMessage(conversationId, PROVIDER, `message ${i}`, {
        sender_role: 2,
        created_at: `2026-08-0${i + 2}T00:00:00.000Z`,
      });
    }
    const first = makeRes();
    await v1['conversations.messages.list'](
      req({
        params: { conversationId: String(conversationId) },
        query: { limit: '2' },
        user: { uid: CUSTOMER },
      }),
      first.res,
    );
    const page1 = first.captured.body.data;
    expect(page1.messages).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBe(page1.messages[1].id);

    const second = makeRes();
    await v1['conversations.messages.list'](
      req({
        params: { conversationId: String(conversationId) },
        query: { limit: '2', cursor: String(page1.nextCursor) },
        user: { uid: CUSTOMER },
      }),
      second.res,
    );
    const page2 = second.captured.body.data;
    // Strictly older, no overlap. An offset scan would repeat a row here the
    // moment anything was appended between the two calls.
    expect(page2.messages.every((m: any) => m.id < page1.nextCursor)).toBe(true);
  });

  it('clamps an oversized limit rather than refusing to page at all', async () => {
    const captured = makeRes();
    await v1['conversations.messages.list'](
      req({
        params: { conversationId: String(conversationId) },
        query: { limit: '5000' },
        user: { uid: CUSTOMER },
      }),
      captured.res,
    );
    expect(captured.captured.status).toBe(200);
    expect(captured.captured.body.data.limit).toBe(100);
  });

  it('rejects a non-numeric conversation id with VALIDATION_FAILED, not a 500', async () => {
    const captured = makeRes();
    await v1['conversations.get'](
      req({ params: { conversationId: 'not-a-number' }, user: { uid: CUSTOMER } }),
      captured.res,
    );
    expect(captured.captured.status).toBe(400);
    expect(captured.captured.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('reports the resulting unread count from the read endpoint', async () => {
    const m = fake.seedMessage(conversationId, PROVIDER, 'unread', { sender_role: 2 });
    const captured = makeRes();
    await v1['conversations.read'](
      req({
        params: { conversationId: String(conversationId) },
        user: { uid: CUSTOMER },
        body: { lastReadMessageId: Number(m.id) },
      }),
      captured.res,
    );
    expect(captured.captured.body.data).toMatchObject({
      conversationId, lastReadMessageId: Number(m.id), unreadCount: 0,
    });
  });
});

// ─── Attachments ──────────────────────────────────────────────────────────────

describe('attachments are owned, bounded and typed', () => {
  const send = (attachments: unknown, uid = CUSTOMER, key = 'attachment-key-000001') =>
    messaging.sendMessage({ uid, role: uid === CUSTOMER ? 3 : 2 }, conversationId, {
      body: 'see attached',
      clientMsgId: key,
      attachments: attachments as any,
    });

  it('accepts an owned storage key', async () => {
    const message = await send([{ url: `${CUSTOMER}_abc-123`, mimeType: 'image/png', sizeBytes: 1024 }]);
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].mimeType).toBe('image/png');
  });

  it('accepts a Firebase URL in the configured bucket under chat-attachments/', async () => {
    const url =
      `https://firebasestorage.googleapis.com/v0/b/servana-test.appspot.com/o/chat-attachments/${CUSTOMER}_x1?alt=media`;
    const message = await send([{ url, mimeType: 'application/pdf' }], CUSTOMER, 'attachment-key-000002');
    expect(message.attachments[0].url).toBe(url);
  });

  it("REFUSES another person's object, even quoted verbatim", async () => {
    await expect(send([{ url: `${PROVIDER}_secret-file` }], CUSTOMER, 'attachment-key-000003'))
      .rejects.toMatchObject({ code: 'ATTACHMENT_REJECTED' });
  });

  it('refuses a URL on another host — an unchecked url field is an SSRF surface', async () => {
    await expect(
      send([{ url: `https://evil.example.com/v0/b/servana-test.appspot.com/o/chat-attachments/${CUSTOMER}_x` }],
        CUSTOMER, 'attachment-key-000004'),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_REJECTED' });
  });

  it('refuses a URL in another bucket', async () => {
    await expect(
      send([{ url: `https://firebasestorage.googleapis.com/v0/b/someone-else/o/chat-attachments/${CUSTOMER}_x` }],
        CUSTOMER, 'attachment-key-000005'),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_REJECTED' });
  });

  it('refuses a disallowed content type', async () => {
    await expect(
      send([{ url: `${CUSTOMER}_script`, mimeType: 'application/x-msdownload' }],
        CUSTOMER, 'attachment-key-000006'),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_REJECTED' });
  });

  it('refuses an oversized attachment', async () => {
    await expect(
      send([{ url: `${CUSTOMER}_big`, mimeType: 'image/png', sizeBytes: 11 * 1024 * 1024 }],
        CUSTOMER, 'attachment-key-000007'),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_REJECTED' });
  });

  it('refuses more than the per-message ceiling', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ url: `${CUSTOMER}_f${i}`, mimeType: 'image/png' }));
    await expect(send(many, CUSTOMER, 'attachment-key-000008'))
      .rejects.toMatchObject({ code: 'ATTACHMENT_REJECTED' });
  });

  it('the upload endpoint refuses somebody who cannot send into the conversation', async () => {
    const captured = makeRes();
    await chatController.uploadAttachment(
      req({
        user: { uid: STRANGER },
        body: {
          file: 'data:image/png;base64,iVBORw0KGgo=',
          name: 'photo.png',
          conversationId: String(conversationId),
        },
      }),
      captured.res,
    );
    expect([403, 422]).toContain(captured.captured.status);
  });
});
