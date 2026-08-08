'use strict';

const fs = require('fs');
const path = require('path');

const read = (...parts) => fs.readFileSync(
  path.join(__dirname, '..', 'src', ...parts),
  'utf8',
);

describe('provider communications hardening', () => {
  test('chat uploads validate content signatures and enforce a size limit', () => {
    const controller = read('chat', 'chat.controller.ts');
    expect(controller).toMatch(/validateDataUri/);
    expect(controller).toMatch(/MAX_CHAT_ATTACHMENT_BYTES/);
    expect(controller).not.toMatch(/const mimeType = file\.slice/);
    expect(controller).not.toMatch(/image\/gif/);
  });

  test('ordinary sends require a bounded client idempotency key', () => {
    const service = read('chat', 'chat.service.ts');
    expect(service).toMatch(/clientMsgId\.length < 16/);
    expect(service).toMatch(/clientMsgId\.length > 128/);
    expect(service).toMatch(/insertMessageIdempotent/);
  });

  test('the database closes the two-device duplicate-send race', () => {
    const repository = read('chat', 'chat.repository.ts');
    expect(repository).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_message_client_idempotency/);
    expect(repository).toMatch(/ON CONFLICT \(conversation_id, sender_uid, client_msg_id\)/);
    expect(repository).toMatch(/WHERE client_msg_id IS NOT NULL/);
  });

  test('message body and type are bounded server-side', () => {
    const service = read('chat', 'chat.service.ts');
    expect(service).toMatch(/body\.length > MESSAGE_BODY_MAX/);
    expect(service).toMatch(/const MESSAGE_BODY_MAX = 4000/);
    expect(service).toMatch(/allowedTypes/);
    expect(service).toMatch(/\["text", "image", "file"\]/);
  });

  test('conversation reads and sends both reauthorize participation', () => {
    const service = read('chat', 'chat.service.ts');
    const getMessages = service.match(/export const getMessages[\s\S]{0,1300}/)?.[0] ?? '';
    const sendMessage = service.match(/export const sendMessage[\s\S]{0,2400}/)?.[0] ?? '';
    expect(getMessages).toMatch(/resolveAccessForConversation/);
    expect(sendMessage).toMatch(/resolveAccessForConversation/);
  });
});
