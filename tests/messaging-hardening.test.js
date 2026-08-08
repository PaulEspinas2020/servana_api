const fs = require('fs');
const path = require('path');

const read = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

describe('messaging privacy and integrity hardening', () => {
  const service = read('src/chat/chat.service.ts');
  const repository = read('src/chat/chat.repository.ts');
  const controller = read('src/chat/chat.controller.ts');
  const gateway = read('src/chat/chat.gateway.ts');
  const realtime = read('src/chat/chat.realtime.ts');
  const admin = read('src/services/adminCommunicationService.ts');

  it('only advances read state to a visible message in the same conversation', () => {
    expect(repository).toMatch(/p\.last_read_message_id IS NULL OR p\.last_read_message_id < \$3/);
    expect(repository).toMatch(/m\.conversation_id = \$1/);
    expect(repository).toMatch(/m\.created_at >= p\.joined_at/);
    expect(service).toMatch(/if \(updated\) \{[\s\S]*?"message:read"/);
  });

  it('limits replacement providers to messages created after their current join point', () => {
    expect(repository).toMatch(/joined_at = CASE[\s\S]*?left_at IS NOT NULL THEN NOW\(\)/);
    expect(service).toMatch(/const visibleAfter = participant\?\.joined_at/);
    expect(repository).toMatch(/created_at >= \$4/);
    expect(repository).toMatch(/m\.created_at >= p\.joined_at/);
  });

  it('removes reassigned providers from live rooms and ordinary participant views', () => {
    expect(service).toMatch(/evictUserFromConversation\(conversation\.id, fromProviderUid\)/);
    expect(realtime).toMatch(/socket\.leave\(room\)/);
    expect(realtime).toMatch(/conversation:access-revoked/);
    expect(repository).toMatch(/\$2::boolean = TRUE OR p\.left_at IS NULL/);
  });

  it('binds reports and edits to the authorized conversation', () => {
    expect(service).toMatch(/Number\(message\.conversation_id\) !== conversationId/);
    expect(service).toMatch(/original\.conversation_id !== conversation\.id/);
    expect(service).toMatch(/if \(!access\.canSend\) throw httpError\(409/);
    expect(service).toMatch(/System messages cannot be reported/);
  });

  it('accepts only bounded, provider-owned Servana chat attachments', () => {
    expect(service).toMatch(/ATTACHMENT_MAX/);
    expect(service).toMatch(/ATTACHMENT_BYTES_MAX/);
    expect(service).toMatch(/firebasestorage\.googleapis\.com/);
    expect(service).toMatch(/firebaseConfig\.storageBucket/);
    expect(service).toMatch(/objectName\.startsWith\(ownerPrefix\)/);
    expect(service).toMatch(/metadata: \{\}/);
  });

  it('validates REST and socket identifiers before authorization or persistence', () => {
    expect(controller).toMatch(/const positiveId =/);
    expect(controller).toMatch(/positiveId\(req\.body\?\.lastReadMessageId/);
    expect(gateway).toMatch(/conversationIdOf/);
  });

  it('hides attachments from deleted messages in participant and admin views', () => {
    expect(repository).toMatch(/JOIN .*chat_messages m ON m\.id = a\.message_id[\s\S]*?m\.deleted_at IS NULL/);
    expect(admin).toMatch(/a\.id IS NOT NULL AND m\.deleted_at IS NULL/);
    expect(admin).toMatch(/await deleteMessage\(/);
  });
});
