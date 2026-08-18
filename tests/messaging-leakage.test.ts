/**
 * Cross-account and cross-thread leakage, over the CANONICAL endpoints.
 *
 * ## What this suite is for
 *
 * The release gate says "no cross-account/thread leakage". That is not a
 * property you can read off a route table: it is a claim about what happens when
 * somebody asks for a conversation that is not theirs, and the only way to know
 * is to ask.
 *
 * So every case here drives `messagingService` — the module the v1 handlers call
 * — against a fake database that evaluates the real SQL, including the read
 * floor and the unread clauses. Nothing is stubbed at the repository level,
 * because the repository is where the guarantees live.
 *
 * ## The matrix the command asks for (§88)
 *
 *   Customer A vs Customer B      — different bookings, no visibility either way
 *   Provider A vs Provider B      — different bookings
 *   Provider A after reassignment — read floor, and no future messages
 *   Provider B on the same booking — reads from THEIR assignment, not before
 *   unassigned provider           — refused outright
 *   cancelled booking             — readable, not writable
 *   completed + grace elapsed     — readable, not writable
 *   admin                         — privileged, explicit, and no unread invented
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
// Notification fan-out is fire-and-forget and has its own suite. Here it would
// only add unrouted SQL to the fake.
jest.mock('../src/services/adminNotificationService', () => ({ notifyAdminsSafely: jest.fn() }));
jest.mock('../src/services/notification.service', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
  createCustomerNotification: jest.fn().mockResolvedValue(undefined),
  clearFcmToken: jest.fn().mockResolvedValue(undefined),
}));

import * as fake from './support/chatDbFake';
import * as messaging from '../src/services/messaging/messagingService';

const CUSTOMER_A = 'customer-a';
const CUSTOMER_B = 'customer-b';
const PROVIDER_A = 'provider-a';
const PROVIDER_B = 'provider-b';
const OUTSIDER = 'provider-outsider';
const ADMIN = 'admin-1';

const actor = (uid: string, role: number) => ({ uid, role });

/**
 * Two independent bookings, each with its own customer, provider and thread.
 * Booking 100 also carries a reassignment, so the provider-to-provider case has
 * something real to be refused.
 */
const seedWorld = () => {
  fake.reset();
  fake.seedUser(CUSTOMER_A, 3);
  fake.seedUser(CUSTOMER_B, 3);
  fake.seedUser(PROVIDER_A, 2);
  fake.seedUser(PROVIDER_B, 2);
  fake.seedUser(OUTSIDER, 2);
  fake.seedUser(ADMIN, 1);

  fake.seedBooking(100, CUSTOMER_A);
  fake.seedBooking(200, CUSTOMER_B);

  // Booking 100: provider A was assigned, then replaced by provider B.
  fake.seedAssignment(100, PROVIDER_A, 'DECLINED', '2026-08-01T00:00:00.000Z');
  fake.seedAssignment(100, PROVIDER_B, 'ACCEPTED', '2026-08-03T00:00:00.000Z');
  // Booking 200: an unrelated provider on an unrelated booking.
  fake.seedAssignment(200, OUTSIDER, 'ACCEPTED', '2026-08-01T00:00:00.000Z');

  const c100 = fake.seedConversation(100);
  const c200 = fake.seedConversation(200);

  fake.seedParticipant(Number(c100.id), CUSTOMER_A, 3, { joined_at: '2026-08-01T00:00:00.000Z' });
  fake.seedParticipant(Number(c100.id), PROVIDER_A, 2, {
    joined_at: '2026-08-01T00:00:00.000Z',
    left_at: '2026-08-03T00:00:00.000Z',
    can_read: false,
    can_send: false,
  });
  fake.seedParticipant(Number(c100.id), PROVIDER_B, 2, { joined_at: '2026-08-03T00:00:00.000Z' });
  fake.seedParticipant(Number(c200.id), CUSTOMER_B, 3, { joined_at: '2026-08-01T00:00:00.000Z' });
  fake.seedParticipant(Number(c200.id), OUTSIDER, 2, { joined_at: '2026-08-01T00:00:00.000Z' });

  // Booking 100's transcript spans the reassignment.
  fake.seedMessage(Number(c100.id), CUSTOMER_A, 'before the handover', {
    created_at: '2026-08-02T00:00:00.000Z',
  });
  fake.seedMessage(Number(c100.id), PROVIDER_A, 'provider A speaking', {
    sender_role: 2,
    created_at: '2026-08-02T01:00:00.000Z',
  });
  fake.seedMessage(Number(c100.id), CUSTOMER_A, 'after the handover', {
    created_at: '2026-08-04T00:00:00.000Z',
  });
  fake.seedMessage(Number(c200.id), CUSTOMER_B, "customer B's private thread", {
    created_at: '2026-08-02T00:00:00.000Z',
  });

  return { c100: Number(c100.id), c200: Number(c200.id) };
};

const rejects = async (fn: () => Promise<unknown>): Promise<{ code: string; status: number }> => {
  try {
    await fn();
  } catch (error: any) {
    return { code: String(error?.code ?? 'NONE'), status: Number(error?.status ?? 0) };
  }
  throw new Error('expected a refusal, and the call succeeded');
};

// ─── Customer A vs Customer B ─────────────────────────────────────────────────

describe("a customer sees their own thread and nothing else", () => {
  let world: ReturnType<typeof seedWorld>;
  beforeEach(() => { world = seedWorld(); });

  it("customer B cannot read customer A's conversation", async () => {
    const refusal = await rejects(() =>
      messaging.getConversation(actor(CUSTOMER_B, 3), world.c100),
    );
    expect(refusal.code).toBe('CONVERSATION_ACCESS_DENIED');
    expect(refusal.status).toBe(403);
  });

  it("customer B cannot page customer A's messages", async () => {
    const refusal = await rejects(() =>
      messaging.listMessages(actor(CUSTOMER_B, 3), world.c100),
    );
    expect(refusal.code).toBe('CONVERSATION_ACCESS_DENIED');
  });

  it("customer B cannot post into customer A's conversation", async () => {
    const refusal = await rejects(() =>
      messaging.sendMessage(actor(CUSTOMER_B, 3), world.c100, {
        body: 'hello stranger',
        clientMsgId: 'aaaaaaaaaaaaaaaa-1',
      }),
    );
    expect(refusal.code).toBe('CONVERSATION_ACCESS_DENIED');
  });

  it("customer B cannot move a read pointer in customer A's conversation", async () => {
    const refusal = await rejects(() =>
      messaging.markRead(actor(CUSTOMER_B, 3), world.c100, 1),
    );
    expect(refusal.code).toBe('CONVERSATION_ACCESS_DENIED');
  });

  it('the inbox contains only the conversations the caller participates in', async () => {
    const a = await messaging.listConversations(actor(CUSTOMER_A, 3));
    const b = await messaging.listConversations(actor(CUSTOMER_B, 3));
    expect(a.map((c) => c.id)).toEqual([world.c100]);
    expect(b.map((c) => c.id)).toEqual([world.c200]);
  });

  it('there is no parameter anywhere that names another subject', () => {
    // The property, not an instance of it: `listConversations` takes an actor
    // and nothing else, so no request field can redirect it. A test that only
    // checked today's routes would pass the day somebody adds `?uid=`.
    expect(messaging.listConversations.length).toBe(1);
  });
});

// ─── Provider A vs Provider B ─────────────────────────────────────────────────

describe('a provider sees their own assignment, and only from when it began', () => {
  let world: ReturnType<typeof seedWorld>;
  beforeEach(() => { world = seedWorld(); });

  it('a provider on another booking is refused outright', async () => {
    const refusal = await rejects(() =>
      messaging.getConversation(actor(OUTSIDER, 2), world.c100),
    );
    expect(refusal.code).toBe('CONVERSATION_ACCESS_DENIED');
  });

  it('a provider with no assignment at all is refused', async () => {
    fake.seedUser('provider-never', 2);
    const refusal = await rejects(() =>
      messaging.listMessages(actor('provider-never', 2), world.c100),
    );
    expect(refusal.code).toBe('CONVERSATION_ACCESS_DENIED');
  });

  it('the replacement provider does NOT inherit the previous provider\'s transcript', async () => {
    const page = await messaging.listMessages(actor(PROVIDER_B, 2), world.c100);
    const bodies = page.messages.map((m) => m.body);
    expect(bodies).toContain('after the handover');
    expect(bodies).not.toContain('provider A speaking');
    expect(bodies).not.toContain('before the handover');
  });

  it('the reassigned provider loses the thread, including messages sent later', async () => {
    const refusal = await rejects(() =>
      messaging.listMessages(actor(PROVIDER_A, 2), world.c100),
    );
    expect(refusal.code).toBe('CONVERSATION_ACCESS_DENIED');
  });

  it('a reassigned provider does not keep the conversation in their inbox', async () => {
    const inbox = await messaging.listConversations(actor(PROVIDER_A, 2));
    expect(inbox).toEqual([]);
  });

  it('an assignment with no usable start FAILS CLOSED rather than showing everything', async () => {
    // The window travels with the authorization. Strip the timestamp and the
    // backend can no longer prove where this provider's access starts.
    fake.store.bookingWorkers
      .filter((w) => w.worker_uid === PROVIDER_B)
      .forEach((w) => { w.assigned_at = null; });
    const refusal = await rejects(() =>
      messaging.listMessages(actor(PROVIDER_B, 2), world.c100),
    );
    expect(refusal.code).toBe('MESSAGE_HISTORY_UNAVAILABLE');
    expect(refusal.status).toBe(403);
  });

  it('the last-message preview also respects the floor', async () => {
    // A preview built without the floor is the quiet version of the same leak:
    // the transcript is refused and the inbox row shows the text anyway.
    const conversation = await messaging.getConversation(actor(PROVIDER_B, 2), world.c100);
    expect(conversation.lastMessage?.body).toBe('after the handover');
  });
});

// ─── Conversation state ───────────────────────────────────────────────────────

describe('a cancelled or completed booking is readable and not writable', () => {
  let world: ReturnType<typeof seedWorld>;
  beforeEach(() => { world = seedWorld(); });

  const setStatus = (conversationId: number, status: string, isClosed: boolean) => {
    const row = fake.store.conversations.find((c) => Number(c.id) === conversationId)!;
    row.status = status;
    row.is_closed = isClosed;
  };

  it('CLOSED (cancelled): the customer may read and may not post', async () => {
    setStatus(world.c100, 'CLOSED', true);
    const page = await messaging.listMessages(actor(CUSTOMER_A, 3), world.c100);
    expect(page.messages.length).toBeGreaterThan(0);

    const refusal = await rejects(() =>
      messaging.sendMessage(actor(CUSTOMER_A, 3), world.c100, {
        body: 'one more thing',
        clientMsgId: 'bbbbbbbbbbbbbbbb-1',
      }),
    );
    expect(refusal.code).toBe('CONVERSATION_NOT_WRITABLE');
    expect(refusal.status).toBe(409);
  });

  it('READ_ONLY (grace elapsed): the assigned provider may read and may not post', async () => {
    setStatus(world.c100, 'READ_ONLY', true);
    const page = await messaging.listMessages(actor(PROVIDER_B, 2), world.c100);
    expect(page.messages.length).toBeGreaterThan(0);

    const refusal = await rejects(() =>
      messaging.sendMessage(actor(PROVIDER_B, 2), world.c100, {
        body: 'left my tools',
        clientMsgId: 'cccccccccccccccc-1',
      }),
    );
    expect(refusal.code).toBe('CONVERSATION_NOT_WRITABLE');
  });

  it('the DTO says why, so a client can hide the composer instead of guessing', async () => {
    setStatus(world.c100, 'READ_ONLY', true);
    const conversation = await messaging.getConversation(actor(CUSTOMER_A, 3), world.c100);
    expect(conversation.canSend).toBe(false);
    expect(conversation.cannotSendReason).toMatch(/read-only/i);
  });

  it('support may still post into a closed thread — that is the point of support', async () => {
    setStatus(world.c100, 'CLOSED', true);
    const message = await messaging.sendMessage(actor(ADMIN, 1), world.c100, {
      body: 'We have refunded this booking.',
      clientMsgId: 'dddddddddddddddd-1',
    });
    expect(message.senderSeat).toBe('support');
    expect(message.senderUid).toBe(ADMIN);
  });

  it('the inbox agrees with the transcript about writability', async () => {
    setStatus(world.c100, 'CLOSED', true);
    const [row] = await messaging.listConversations(actor(CUSTOMER_A, 3));
    expect(row.canSend).toBe(false);
  });
});

// ─── Admin ────────────────────────────────────────────────────────────────────

describe('admin access is privileged, explicit, and does not invent numbers', () => {
  let world: ReturnType<typeof seedWorld>;
  beforeEach(() => { world = seedWorld(); });

  it('an admin may read any conversation, and is seated as support', async () => {
    const conversation = await messaging.getConversation(actor(ADMIN, 1), world.c100);
    expect(conversation.viewerSeat).toBe('support');
    expect(conversation.id).toBe(world.c100);
  });

  it('an admin reads the WHOLE transcript — the audit trail is the point', async () => {
    const page = await messaging.listMessages(actor(ADMIN, 1), world.c100);
    expect(page.messages.map((m) => m.body)).toEqual(
      expect.arrayContaining(['before the handover', 'provider A speaking', 'after the handover']),
    );
  });

  it('an admin sees departed participants; the customer does not', async () => {
    const asAdmin = await messaging.getConversation(actor(ADMIN, 1), world.c100);
    const asCustomer = await messaging.getConversation(actor(CUSTOMER_A, 3), world.c100);
    expect(asAdmin.participants.some((p) => p.uid === PROVIDER_A)).toBe(true);
    expect(asCustomer.participants.some((p) => p.uid === PROVIDER_A)).toBe(false);
  });

  it('an admin gets no unread count rather than an invented one', async () => {
    const conversation = await messaging.getConversation(actor(ADMIN, 1), world.c100);
    expect(conversation.isParticipant).toBe(false);
    expect(conversation.unreadCount).toBe(0);
  });

  it('the admin inbox is every conversation, and says it is not participating', async () => {
    const inbox = await messaging.listConversations(actor(ADMIN, 1));
    expect(inbox.map((c) => c.id).sort()).toEqual([world.c100, world.c200].sort());
    for (const row of inbox) expect(row.isParticipant).toBe(false);
  });
});

// ─── Participant disclosure ───────────────────────────────────────────────────

describe('the conversation DTO discloses no contact route', () => {
  let world: ReturnType<typeof seedWorld>;
  beforeEach(() => { world = seedWorld(); });

  it('publishes a display name and an avatar and nothing else about a person', async () => {
    // The participant query joins user_credentials and user_profile, so the
    // rows in hand carry more than this. The projection is ADDITIVE, which is
    // why the extra columns cannot arrive by being forgotten.
    fake.store.users.forEach((u) => {
      (u as any).email = 'leak@example.com';
      (u as any).mobile_number = '+639170000000';
    });
    const conversation = await messaging.getConversation(actor(CUSTOMER_A, 3), world.c100);
    const serialized = JSON.stringify(conversation);
    expect(serialized).not.toContain('leak@example.com');
    expect(serialized).not.toContain('+639170000000');
    expect(conversation.participants.every((p) => 'displayName' in p)).toBe(true);
  });
});
