/**
 * SW-03 — a chat message must reach the people in the conversation.
 *
 * Before this, `sendMessage` emitted `message:new` over Socket.IO and notified
 * ADMINS. ServanaWorker has no Socket.IO client and does not poll, so a
 * customer's message reached the provider through no channel at all.
 *
 * The recipient rule is the part that must not be wrong — it decides who is
 * told about a conversation — so it is a pure function and tested as behaviour
 * rather than as source text. The wiring assertions at the bottom are source
 * checks on purpose: "is this called from the send path" is a wiring question,
 * and there is no way to answer it without a database otherwise.
 */
import fs from 'fs';
import path from 'path';

import { messageNotificationRecipients } from '../src/chat/chat.service';

const CUSTOMER = 'uid-customer';
const PROVIDER = 'uid-provider';
const OTHER_PROVIDER = 'uid-provider-2';

const recipients = (over: Partial<Parameters<typeof messageNotificationRecipients>[0]> = {}) =>
  messageNotificationRecipients({
    clientUid: CUSTOMER,
    workerUids: [PROVIDER],
    departedUids: [],
    senderUid: CUSTOMER,
    ...over,
  });

describe('who a chat message notifies', () => {
  it('tells the provider when the customer writes', () => {
    expect(recipients()).toEqual({ providers: [PROVIDER], customer: null });
  });

  it('tells the customer when the provider writes', () => {
    expect(recipients({ senderUid: PROVIDER })).toEqual({
      providers: [],
      customer: CUSTOMER,
    });
  });

  it('never tells the sender about their own message', () => {
    // The one thing that would be immediately, visibly wrong to a user.
    for (const sender of [CUSTOMER, PROVIDER]) {
      const out = recipients({ senderUid: sender });
      expect(out.providers).not.toContain(sender);
      expect(out.customer).not.toBe(sender);
    }
  });

  it('tells both sides when an admin writes', () => {
    expect(recipients({ senderUid: 'uid-admin' })).toEqual({
      providers: [PROVIDER],
      customer: CUSTOMER,
    });
  });

  it('tells every current provider on the booking except the one writing', () => {
    expect(
      recipients({ workerUids: [PROVIDER, OTHER_PROVIDER], senderUid: PROVIDER }),
    ).toEqual({ providers: [OTHER_PROVIDER], customer: CUSTOMER });
  });
});

describe('§11 — a departed participant stops hearing about the thread', () => {
  it('drops a provider whose participant row records a left_at', () => {
    // Reassigned, declined or cancelled. They can no longer read the
    // transcript, so being told a message arrived in it is a disclosure.
    expect(recipients({ departedUids: [PROVIDER] })).toEqual({
      providers: [],
      customer: null,
    });
  });

  it('drops the customer if they left', () => {
    expect(recipients({ senderUid: PROVIDER, departedUids: [CUSTOMER] })).toEqual({
      providers: [],
      customer: null,
    });
  });

  it('keeps the remaining provider when only one of two has left', () => {
    expect(
      recipients({
        workerUids: [PROVIDER, OTHER_PROVIDER],
        departedUids: [PROVIDER],
        senderUid: CUSTOMER,
      }),
    ).toEqual({ providers: [OTHER_PROVIDER], customer: null });
  });
});

describe('absence of a participant row is not absence from the booking', () => {
  it('still notifies when nobody has a departure recorded', () => {
    // The rule is subtractive. An earlier draft required a participant row to
    // be PRESENT, which silently dropped the customer on any conversation
    // seeded before their row existed.
    expect(recipients({ departedUids: [] }).customer).toBeNull(); // sender
    expect(recipients({ senderUid: 'uid-admin', departedUids: [] })).toEqual({
      providers: [PROVIDER],
      customer: CUSTOMER,
    });
  });
});

describe('degenerate inputs fail closed rather than throwing', () => {
  it('handles a booking with no customer', () => {
    expect(recipients({ clientUid: null, senderUid: PROVIDER })).toEqual({
      providers: [],
      customer: null,
    });
  });

  it('handles a booking with no providers', () => {
    expect(recipients({ workerUids: [] })).toEqual({
      providers: [],
      customer: null,
    });
  });

  it('ignores empty uids rather than notifying ""', () => {
    expect(recipients({ workerUids: ['', PROVIDER] }).providers).toEqual([PROVIDER]);
    expect(recipients({ clientUid: '', senderUid: PROVIDER }).customer).toBeNull();
  });

  it('collapses a provider listed twice into one notification', () => {
    // Production booking 75 has two booking_workers rows for one reassignment.
    expect(
      recipients({ workerUids: [PROVIDER, PROVIDER] }).providers,
    ).toEqual([PROVIDER]);
  });
});

describe('wiring and payload safety', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../src/chat/chat.service.ts'),
    'utf8',
  );

  it('is called from the send path', () => {
    const sendBlock = src.slice(src.indexOf('emitToConversation(conversationId, "message:new"'));
    expect(sendBlock).toMatch(/notifyMessageRecipients\(/);
  });

  it('is fire-and-forget, so a committed message cannot fail on a notification', () => {
    expect(src).toMatch(/void notifyMessageRecipients\([\s\S]{0,200}?\.catch\(/);
  });

  it('is idempotent per message, so a retried send cannot notify twice', () => {
    expect(src).toContain('const notificationKey = `chat_msg:${messageId}`');
  });

  it('never puts the message body in a notification (§58)', () => {
    // A push payload is readable on a lock screen. Only who and which booking
    // may travel — this is a conversation between a customer and someone
    // standing in their home.
    const fn = src.slice(
      src.indexOf('const notifyMessageRecipients'),
      src.indexOf('const MESSAGE_BODY_MAX'),
    );
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).not.toMatch(/\bsafeBody:\s*[^;]*\bbody\b/);
    expect(fn).not.toMatch(/message\.body/);
  });

  it('sends the customer a route key their apps already understand', () => {
    // client mobile notification_target.dart maps CONVERSATION -> the thread;
    // client web has no such key and renders it un-clickable rather than wrong.
    expect(src).toContain("routeKey: 'CONVERSATION'");
  });

  it('sends the provider no bookingId, which would open a dead-end screen', () => {
    // ServanaWorker's NotificationRouteResolver prefers a booking id over a
    // page name and would open JobDetailsView, which has no chat entry point.
    const providerBlock = src.slice(
      src.indexOf('for (const uid of providers)'),
      src.indexOf('if (customer)'),
    );
    expect(providerBlock).toContain("route: { page: 'messages' }");
    expect(providerBlock).not.toMatch(/bookingId/);
  });
});
