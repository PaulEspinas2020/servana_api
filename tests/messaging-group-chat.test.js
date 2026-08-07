'use strict';

/**
 * MESSAGING command — auto group-chat, idempotency, LEAK isolation,
 * and admin conversation route tests.
 *
 * Pattern: source-inspection + inline pure-logic re-implementations.
 * (Jest config matches only *.test.js; TypeScript modules are not imported
 * directly — source text is used as the source of truth.)
 */

var fs   = require('fs');
var path = require('path');

var SRC   = function () { return path.join.apply(path, [__dirname, '..', 'src'].concat(Array.from(arguments))); };

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip comments before asserting.
 *
 * Added 2026-08-07. `removeParticipant sets left_at` began failing not because
 * the code changed meaning but because a comment elsewhere in the file
 * mentioned `removeParticipant` by name, and the block regex matched the prose
 * first. A source-inspection test that can be satisfied by an explanation of
 * the behaviour, rather than the behaviour, is worse than no test.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function readSrc() {
  return stripComments(fs.readFileSync(SRC.apply(null, arguments), 'utf8'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section A — Auto group-chat trigger in technicianService
// ─────────────────────────────────────────────────────────────────────────────

describe('technicianService — auto group-chat trigger on acceptJob', function () {
  var src;
  beforeAll(function () { src = readSrc('services', 'technicianService.ts'); });

  it('imports getOrCreateConversation from chat.service', function () {
    expect(src).toMatch(/getOrCreateConversation/);
    expect(src).toMatch(/chat\.service/);
  });

  it('imports postSystemMessageOnce from chat.service', function () {
    expect(src).toMatch(/postSystemMessageOnce/);
  });

  it('calls getOrCreateConversation inside acceptJob body', function () {
    // Find the acceptJob function block and assert getOrCreateConversation is inside it.
    var acceptBlock = src.match(/acceptJob[\s\S]{0,3000}/)?.[0] || '';
    expect(acceptBlock).toMatch(/getOrCreateConversation/);
  });

  it('uses fire-and-forget async IIFE pattern in acceptJob (never blocks response)', function () {
    var acceptBlock = src.match(/acceptJob[\s\S]{0,3000}/)?.[0] || '';
    expect(acceptBlock).toMatch(/\(async\s*\(\)/);
  });

  it('uses event key provider_accepted_${bookingId}', function () {
    expect(src).toMatch(/provider_accepted_/);
  });

  it('has a try/catch so chat errors do not break job acceptance', function () {
    var acceptBlock = src.match(/acceptJob[\s\S]{0,3000}/)?.[0] || '';
    expect(acceptBlock).toMatch(/catch\s*\(/);
  });
});

describe('technicianService — system messages on startJob / completeJob / declineJob', function () {
  var src;
  beforeAll(function () { src = readSrc('services', 'technicianService.ts'); });

  it('emits service_started_${bookingId} system message in startJob', function () {
    expect(src).toMatch(/service_started_/);
  });

  it('emits service_completed_${bookingId} system message in completeJob', function () {
    expect(src).toMatch(/service_completed_/);
  });

  it('emits provider_declined_${bookingId}_${workerUid} system message in declineJob', function () {
    // The message key is built inside releaseBookingAndReassign, which
    // declineJob and the C18 provider-cancellation path both call — one
    // implementation so the two cannot drift into reassigning differently.
    // Assert BOTH halves: the helper composes the key from its eventKind, and
    // declineJob passes 'provider_declined'. Grepping only for the old literal
    // would now pass for a cancellation that never declines anything.
    expect(src).toMatch(/\$\{eventKind\}_\$\{bookingId\}_\$\{workerUid\}/);
    expect(src).toMatch(/"provider_declined"/);
  });

  it('uses findExistingConversationByBookingId for non-creating hooks', function () {
    expect(src).toMatch(/findExistingConversationByBookingId/);
  });

  it('only creates new conversation in acceptJob (startJob checks for existing)', function () {
    // startJob should NOT call getOrCreateConversation — only findExisting
    // Anchored on the DECLARATION, not on any mention. `/startJob/` matched the
    // first occurrence anywhere in the file, so a doc comment that merely named
    // the function shifted this assertion onto prose and it failed against text
    // instead of code.
    var startBlock = src.match(/export const startJob[\s\S]{0,3000}/)?.[0] || '';
    // The presence of findExistingConversationByBookingId in startBlock proves only existing is used
    expect(startBlock).toMatch(/findExistingConversationByBookingId/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section B — Idempotency contract (inline re-implementation)
// ─────────────────────────────────────────────────────────────────────────────

describe('postSystemMessageOnce — deduplication logic (inline re-implementation)', function () {
  // Re-implements the exact branch logic from chat.service.ts postSystemMessageOnce
  var messageStore = {};

  function findSystemMessage(conversationId, eventKey) {
    return messageStore[conversationId + ':' + eventKey] || null;
  }

  function insertMessage(input) {
    var id = Math.floor(Math.random() * 10000);
    messageStore[input.conversationId + ':' + input.metadata.eventKey] = { id: id };
    return { id: id, type: input.type, metadata: input.metadata };
  }

  function postSystemMessageOnce(conversationId, eventKey, body, metadata) {
    metadata = metadata || {};
    var existing = findSystemMessage(conversationId, eventKey);
    if (existing) return existing;
    return insertMessage({ conversationId: conversationId, type: 'system', body: body, metadata: Object.assign({}, metadata, { eventKey: eventKey }) });
  }

  beforeEach(function () { messageStore = {}; });

  it('inserts a new message when no prior message with that eventKey exists', function () {
    var result = postSystemMessageOnce(1, 'provider_accepted_100', 'Provider accepted');
    expect(result).toBeTruthy();
    expect(result.type).toBe('system');
    expect(result.metadata.eventKey).toBe('provider_accepted_100');
  });

  it('returns the existing message without inserting when called again with the same key', function () {
    var first  = postSystemMessageOnce(1, 'provider_accepted_100', 'Provider accepted');
    var second = postSystemMessageOnce(1, 'provider_accepted_100', 'Provider accepted');
    expect(second.id).toBe(first.id);
  });

  it('different event keys for the same conversation produce separate messages', function () {
    var a = postSystemMessageOnce(1, 'provider_accepted_100', 'Accepted');
    var b = postSystemMessageOnce(1, 'service_started_100',   'Started');
    expect(a.id).not.toBe(b.id);
  });

  it('same event key on different conversations produces separate messages', function () {
    var a = postSystemMessageOnce(1, 'provider_accepted_100', 'Booking 100');
    var b = postSystemMessageOnce(2, 'provider_accepted_100', 'Booking 101');
    expect(a.id).not.toBe(b.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section C — LEAK isolation — access control source proofs
// ─────────────────────────────────────────────────────────────────────────────

describe('chat.service — resolveAccessForBooking source proofs', function () {
  var src;
  beforeAll(function () { src = readSrc('chat', 'chat.service.ts'); });

  it('grants admin access for ADMIN_ROLES (0 and 1)', function () {
    expect(src).toMatch(/ADMIN_ROLES/);
    expect(src).toMatch(/0,\s*1/);
  });

  it('checks clientUid === actor.uid for client role', function () {
    expect(src).toMatch(/clientUid.*actor\.uid|actor\.uid.*clientUid/);
  });

  it('checks workerUids.includes(actor.uid) for coworker role', function () {
    expect(src).toMatch(/workerUids\.includes\(actor\.uid\)/);
  });

  it('returns { allowed: false, role: null } as the default deny', function () {
    expect(src).toMatch(/allowed:\s*false,\s*role:\s*null/);
  });

  /**
   * The rule is unchanged — a non-admin cannot write to a closed conversation
   * — but it moved. It used to be an inline `is_closed && role !== admin`
   * check in sendMessage. It now lives in resolveAccessForConversation, which
   * still reads is_closed (so rows predating the `status` column behave
   * correctly) and still exempts admins, and sendMessage gates on the derived
   * canSend. Asserting the old expression would now be asserting the shape of
   * a line rather than the behaviour it encoded.
   */
  it('access is denied for closed conversations for non-admin', function () {
    expect(src).toMatch(/is_closed/);
    expect(src).toMatch(/role\s*===?\s*"admin"|"admin"/);
    expect(src).toMatch(/canSend/);
  });
});

describe('chat.service — sendMessage access enforcement source proofs', function () {
  var src;
  beforeAll(function () { src = readSrc('chat', 'chat.service.ts'); });

  it('throws 403 if access is not allowed', function () {
    expect(src).toMatch(/403/);
    expect(src).toMatch(/Not a participant/);
  });

  it('throws 409 for closed conversation', function () {
    expect(src).toMatch(/409/);
    expect(src).toMatch(/closed/i);
  });

  it('deduplicates by clientMsgId (idempotent send)', function () {
    expect(src).toMatch(/clientMsgId/);
    expect(src).toMatch(/findMessageByClientId/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section D — LEAK isolation — resolveAccessForBooking inline logic tests
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveAccessForBooking — logic tests (inline re-implementation)', function () {
  var ADMIN_ROLES = [0, 1];

  function resolveAccess(actor, clientUid, workerUids) {
    if (ADMIN_ROLES.indexOf(actor.role) !== -1) return { allowed: true, role: 'admin' };
    if (clientUid && clientUid === actor.uid) return { allowed: true, role: 'client' };
    if (workerUids.indexOf(actor.uid) !== -1) return { allowed: true, role: 'coworker' };
    return { allowed: false, role: null };
  }

  it('admin role 0 always gets access', function () {
    var r = resolveAccess({ uid: 'uid-admin', role: 0 }, 'uid-client', []);
    expect(r.allowed).toBe(true);
    expect(r.role).toBe('admin');
  });

  it('admin role 1 always gets access', function () {
    var r = resolveAccess({ uid: 'uid-admin', role: 1 }, 'uid-client', []);
    expect(r.allowed).toBe(true);
    expect(r.role).toBe('admin');
  });

  it('grants client role to the booking customer', function () {
    var r = resolveAccess({ uid: 'uid-client', role: 3 }, 'uid-client', []);
    expect(r.allowed).toBe(true);
    expect(r.role).toBe('client');
  });

  it('grants coworker role to the assigned provider', function () {
    var r = resolveAccess({ uid: 'uid-worker', role: 3 }, 'uid-client', ['uid-worker']);
    expect(r.allowed).toBe(true);
    expect(r.role).toBe('coworker');
  });

  it('denies an unrelated user (LEAK proof: Customer A cannot read Customer B conversation)', function () {
    var r = resolveAccess({ uid: 'uid-stranger', role: 3 }, 'uid-client', ['uid-worker']);
    expect(r.allowed).toBe(false);
    expect(r.role).toBeNull();
  });

  it('denies a provider not assigned to this booking', function () {
    var r = resolveAccess({ uid: 'uid-other-provider', role: 3 }, 'uid-client', ['uid-worker']);
    expect(r.allowed).toBe(false);
  });

  it('denies if uid matches clientUid of a DIFFERENT booking (cross-booking LEAK proof)', function () {
    // clientUid is set to a different booking's client — actor.uid doesn't match
    var r = resolveAccess({ uid: 'uid-client', role: 3 }, 'uid-different-client', []);
    expect(r.allowed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section E — Admin conversation routes registered correctly
// ─────────────────────────────────────────────────────────────────────────────

describe('adminCommunication.routes — new messaging routes registered', function () {
  var src;
  beforeAll(function () { src = readSrc('routes', 'adminCommunication.routes.ts'); });

  it('registers GET /admin/communications/conversations/:id', function () {
    expect(src).toMatch(/router\.get.*conversations\/:id[^/]/);
  });

  it('registers GET /admin/communications/conversations/:id/messages', function () {
    expect(src).toMatch(/conversations\/:id\/messages/);
  });

  it('registers POST /admin/communications/conversations/:id/messages', function () {
    expect(src).toMatch(/router\.post.*conversations\/:id\/messages/);
  });

  it('registers GET /admin/communications/reports', function () {
    expect(src).toMatch(/communications\/reports/);
  });

  it('registers PATCH /admin/communications/reports/:reportId', function () {
    expect(src).toMatch(/patch.*reports\/:reportId/i);
  });

  it(':id/messages route appears BEFORE :id route to avoid param collision', function () {
    var msgIdx  = src.indexOf('/:id/messages');
    var detIdx  = src.search(/\/conversations\/:id[^/]/);
    expect(msgIdx).toBeLessThan(detIdx);
  });

  it('conversation reads require view and sends require send permission', function () {
    var routeBlock = src.match(/conversations\/:id[\s\S]{0,1000}/)?.[0] || '';
    expect(routeBlock).toMatch(/support_conversations\.view/);
    expect(src).toMatch(/router\.post\('\/admin\/communications\/conversations\/:id\/messages'[\s\S]{0,200}support_conversations\.send/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section F — chat.repository — new functions present
// ─────────────────────────────────────────────────────────────────────────────

describe('chat.repository — MESSAGING additions present', function () {
  var src;
  beforeAll(function () { src = readSrc('chat', 'chat.repository.ts'); });

  it('exports removeParticipant', function () {
    expect(src).toMatch(/export const removeParticipant/);
  });

  it('exports findSystemMessage', function () {
    expect(src).toMatch(/export const findSystemMessage/);
  });

  it('exports findExistingConversationByBookingId', function () {
    expect(src).toMatch(/export const findExistingConversationByBookingId/);
  });

  it('findSystemMessage queries metadata->\'eventKey\'', function () {
    expect(src).toMatch(/metadata->>'eventKey'/);
  });

  it('findSystemMessage filters by type = \'system\'', function () {
    var block = src.match(/findSystemMessage[\s\S]{0,300}/)?.[0] || '';
    expect(block).toMatch(/type\s*=\s*'system'/);
  });

  it('removeParticipant sets left_at = NOW() not DELETE', function () {
    // Anchor on the definition, not the first mention. COALESCE(left_at, NOW())
    // is the same soft-leave semantics, made idempotent so removing an already
    // departed participant does not reset when they actually left.
    var block = src.match(/export const removeParticipant[\s\S]{0,600}/)?.[0] || '';
    expect(block).toMatch(/left_at\s*=\s*(COALESCE\(\s*left_at\s*,\s*)?NOW\(\)/);
    expect(block).not.toMatch(/DELETE/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section G — adminCommunicationService — new functions present
// ─────────────────────────────────────────────────────────────────────────────

describe('adminCommunicationService — MESSAGING additions present', function () {
  var src;
  beforeAll(function () { src = readSrc('services', 'adminCommunicationService.ts'); });

  it('exports getAdminConversationDetail', function () {
    expect(src).toMatch(/getAdminConversationDetail/);
  });

  it('exports getAdminConversationMessages', function () {
    expect(src).toMatch(/getAdminConversationMessages/);
  });

  it('exports sendAdminMessage', function () {
    expect(src).toMatch(/sendAdminMessage/);
  });

  it('exports listMessageReports', function () {
    expect(src).toMatch(/listMessageReports/);
  });

  it('exports resolveMessageReport', function () {
    expect(src).toMatch(/resolveMessageReport/);
  });

  it('sendAdminMessage uses dynamic import to avoid circular deps', function () {
    var block = src.match(/sendAdminMessage[\s\S]{0,500}/)?.[0] || '';
    expect(block).toMatch(/await import/);
  });

  it('resolveMessageReport with action=redact sets body to [Message removed]', function () {
    expect(src).toMatch(/\[Message removed/);
    expect(src).toMatch(/redact/i);
  });
});
