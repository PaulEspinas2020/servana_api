'use strict';

/**
 * Booking group conversation — lifecycle, capabilities, and the two defects
 * this work closed.
 *
 * Pattern matches messaging-group-chat.test.js: source inspection plus inline
 * pure-logic re-implementations, because jest here matches only *.test.js and
 * does not compile the TypeScript sources.
 *
 * EVERY source assertion runs against COMMENT-STRIPPED text. The comments in
 * chat.repository.ts explain the bugs by name — they contain the literal
 * strings "EN_ROUTE", "ARRIVED" and "left_at IS NULL". Asserting on raw source
 * would pass on the explanation alone while the code stayed broken, which is
 * the exact failure mode this file exists to prevent.
 */

var fs = require('fs');
var path = require('path');

var SRC = function () {
  return path.join.apply(path, [__dirname, '..', 'src'].concat(Array.from(arguments)));
};

/** Strip block and line comments so assertions can only match real code. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function readCode() {
  return stripComments(fs.readFileSync(SRC.apply(null, arguments), 'utf8'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard: prove the comment stripper actually works, or every test below is
// worthless. Positive and negative fixture, per the detector self-test rule.
// ─────────────────────────────────────────────────────────────────────────────

describe('stripComments — self test', function () {
  it('removes a line comment mentioning EN_ROUTE', function () {
    expect(stripComments('// EN_ROUTE was missing\nconst a = 1;')).not.toMatch(/EN_ROUTE/);
  });

  it('removes a block comment mentioning left_at IS NULL', function () {
    expect(stripComments('/* left_at IS NULL was missing */\nconst a = 1;')).not.toMatch(/left_at IS NULL/);
  });

  it('KEEPS real code (negative fixture — must not strip everything)', function () {
    var kept = stripComments("/* note */\nconst S = ['EN_ROUTE'];");
    expect(kept).toMatch(/EN_ROUTE/);
    expect(kept).toMatch(/const S/);
  });

  it('does not eat a URL inside a string literal', function () {
    expect(stripComments('const u = "https://servana.com.ph";')).toMatch(/servana\.com\.ph/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Defect 1 — provider lost chat while EN_ROUTE / ARRIVED
// ─────────────────────────────────────────────────────────────────────────────

describe('chat.repository — active worker statuses', function () {
  var code;
  beforeAll(function () { code = readCode('chat', 'chat.repository.ts'); });

  it('declares ACTIVE_WORKER_STATUSES', function () {
    expect(code).toMatch(/ACTIVE_WORKER_STATUSES\s*=/);
  });

  it('includes EN_ROUTE — provider must keep chat once on the way', function () {
    var block = code.match(/ACTIVE_WORKER_STATUSES\s*=\s*\[[\s\S]*?\]/)[0];
    expect(block).toMatch(/'EN_ROUTE'/);
  });

  it('includes ARRIVED — provider must keep chat once on site', function () {
    var block = code.match(/ACTIVE_WORKER_STATUSES\s*=\s*\[[\s\S]*?\]/)[0];
    expect(block).toMatch(/'ARRIVED'/);
  });

  it('still includes the four original statuses (no regression)', function () {
    var block = code.match(/ACTIVE_WORKER_STATUSES\s*=\s*\[[\s\S]*?\]/)[0];
    ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED'].forEach(function (s) {
      expect(block).toMatch(new RegExp("'" + s + "'"));
    });
  });

  it('getBookingWorkerUids authorizes from that one list, not a second literal', function () {
    var fn = code.match(/getBookingWorkerUids[\s\S]{0,500}/)[0];
    expect(fn).toMatch(/ACTIVE_WORKER_STATUSES/);
  });

  it('covers every status the arrival lifecycle can write', function () {
    // Reads the EXECUTOR, not technicianService. The arrival writes moved there
    // in B1.3/B1.4, and this check used to be conditional on finding the
    // double-quoted literals "EN_ROUTE"/"ARRIVED" in technicianService — which
    // the migration removed. The guard would have gone silently vacuous:
    // still green, asserting nothing, on exactly the day the source of truth
    // moved. It now reads the file that actually writes those statuses.
    var executor = readCode('services', 'booking', 'transitionExecutor.ts');
    var block = code.match(/ACTIVE_WORKER_STATUSES\s*=\s*\[[\s\S]*?\]/)[0];

    ['EN_ROUTE', 'ARRIVED'].forEach(function (s) {
      // Positive fixture: the executor MUST name it, or the loop below proves
      // nothing. This is the assertion the old conditional was missing.
      expect(executor).toMatch(new RegExp("'" + s + "'"));
      expect(block).toMatch(new RegExp("'" + s + "'"));
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Defect 2 — removed provider kept a ghost inbox row
// ─────────────────────────────────────────────────────────────────────────────

describe('chat.repository — inbox excludes departed participants', function () {
  var code;
  beforeAll(function () { code = readCode('chat', 'chat.repository.ts'); });

  it('listConversationsForUser filters on left_at', function () {
    var fn = code.match(/listConversationsForUser[\s\S]{0,900}/)[0];
    expect(fn).toMatch(/left_at IS NULL/);
  });

  it('listConversationsForUser also honours can_read', function () {
    var fn = code.match(/listConversationsForUser[\s\S]{0,900}/)[0];
    expect(fn).toMatch(/can_read/);
  });

  it('removeParticipant revokes send unconditionally', function () {
    var fn = code.match(/removeParticipant[\s\S]{0,700}/)[0];
    expect(fn).toMatch(/can_send\s*=\s*FALSE/);
  });

  it('removeParticipant defaults to NOT retaining read (no silent widening)', function () {
    var fn = code.match(/removeParticipant[\s\S]{0,700}/)[0];
    expect(fn).toMatch(/retainRead\s*===\s*true/);
  });
});

describe('adminBookingService — reassignment updates chat membership', function () {
  var code;
  var fn;
  beforeAll(function () {
    code = readCode('services', 'adminBookingService.ts');
    var start = code.indexOf('export const adminReassignProvider');
    var end = code.indexOf('export const adminRescheduleBooking', start);
    fn = code.slice(start, end);
  });

  it('imports handleProviderReassignment', function () {
    expect(code).toMatch(/handleProviderReassignment/);
  });

  it('calls it inside adminReassignProvider', function () {
    expect(fn).toMatch(/handleProviderReassignment\(/);
  });

  it('cannot fail the reassignment it follows (own try/catch)', function () {
    var call = fn.slice(fn.indexOf('handleProviderReassignment('));
    expect(call).toMatch(/catch\s*\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-platform compatibility — is_closed must survive
// ─────────────────────────────────────────────────────────────────────────────

describe('is_closed remains a maintained compatibility flag', function () {
  var repoCode, svcCode;
  beforeAll(function () {
    repoCode = readCode('chat', 'chat.repository.ts');
    svcCode = readCode('chat', 'chat.service.ts');
  });

  it('setConversationStatus still writes is_closed', function () {
    var fn = repoCode.match(/setConversationStatus[\s\S]{0,1200}/)[0];
    expect(fn).toMatch(/is_closed\s*=/);
  });

  it('is_closed is derived from whether the status is writable', function () {
    var fn = repoCode.match(/setConversationStatus[\s\S]{0,1200}/)[0];
    expect(fn).toMatch(/WRITABLE_STATUSES\.includes/);
  });

  it('WRITABLE_STATUSES is exactly ACTIVE and SUPPORT_ESCALATED', function () {
    // Match the array literal after `= [`, not the `ConversationStatus[]`
    // type annotation in between — which has its own bracket pair.
    var block = repoCode.match(/WRITABLE_STATUSES[^=]*=\s*\[([\s\S]*?)\]/)[1];
    expect(block).toMatch(/ACTIVE/);
    expect(block).toMatch(/SUPPORT_ESCALATED/);
    expect(block).not.toMatch(/ARCHIVED/);
    expect(block).not.toMatch(/READ_ONLY/);
  });

  it('legacy rows with is_closed=TRUE are backfilled to CLOSED', function () {
    var fn = repoCode.match(/ensureChatLifecycleSchema[\s\S]{0,2000}/)[0];
    expect(fn).toMatch(/is_closed = TRUE/);
    expect(fn).toMatch(/status = 'CLOSED'/);
  });

  it('resolveAccessForConversation still honours a legacy is_closed row', function () {
    var fn = svcCode.match(/resolveAccessForConversation[\s\S]{0,3000}/)[0];
    expect(fn).toMatch(/is_closed/);
  });

  it('all lifecycle DDL is additive (IF NOT EXISTS on every column)', function () {
    var fn = repoCode.match(/ensureChatLifecycleSchema[\s\S]{0,2000}/)[0];
    var adds = fn.match(/ADD COLUMN[^,\n]*/g) || [];
    expect(adds.length).toBeGreaterThan(0);
    adds.forEach(function (a) { expect(a).toMatch(/IF NOT EXISTS/); });
  });

  it('no DROP or RENAME anywhere in the chat module', function () {
    expect(repoCode).not.toMatch(/DROP COLUMN|DROP TABLE|RENAME COLUMN/i);
  });

  /**
   * Keys the three shipping consumers actually read off a conversation:
   *   Flutter customer app  conversation_mapper.dart
   *   Provider portal       provider-chat-api.models.ts (BackendChatConversation)
   *   Admin portal          chats.component.ts
   *
   * The conversation reads are `SELECT c.*`, so this holds as long as the
   * lifecycle DDL only ever ADDs columns — which the test above pins. Listed
   * explicitly anyway: "we only added columns" is an argument, and the hard
   * rule asks for the key set, not the argument.
   */
  it('every key the consumers read is still produced', function () {
    var required = ['id', 'booking_id', 'is_closed', 'last_message_at', 'updated_at'];
    // c.* covers the table's columns; unread_count is computed alongside it.
    var fn = repoCode.match(/listConversationsForUser[\s\S]{0,900}/)[0];
    expect(fn).toMatch(/SELECT c\.\*/);
    expect(fn).toMatch(/AS unread_count/);
    // And nothing narrowed those reads to a column list that could drop one.
    required.forEach(function (k) {
      expect(repoCode).not.toMatch(new RegExp('DROP COLUMN[^;]*' + k, 'i'));
    });
    var single = repoCode.match(/findConversationById[\s\S]{0,300}/)[0];
    expect(single).toMatch(/SELECT \* FROM/);
  });

  it('participant rows keep their original keys and only gain capabilities', function () {
    var fn = repoCode.match(/ensureChatLifecycleSchema[\s\S]{0,2000}/)[0];
    var participantDdl = fn.match(/chat_participants[\s\S]{0,300}/)[0];
    expect(participantDdl).toMatch(/ADD COLUMN IF NOT EXISTS can_read/);
    expect(participantDdl).toMatch(/ADD COLUMN IF NOT EXISTS can_send/);
    expect(participantDdl).not.toMatch(/DROP|RENAME/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Creation is gated on provider confirmation
// ─────────────────────────────────────────────────────────────────────────────

describe('conversation creation follows the booking, not a screen open', function () {
  var ctrl, svc;
  beforeAll(function () {
    ctrl = readCode('chat', 'chat.controller.ts');
    svc = readCode('chat', 'chat.service.ts');
  });

  it('getBookingConversation no longer creates', function () {
    var fn = ctrl.match(/getBookingConversation[\s\S]{0,1600}/)[0];
    expect(fn).not.toMatch(/getOrCreateConversation/);
    expect(fn).toMatch(/getExistingConversation/);
  });

  it('it 404s when there is no conversation yet', function () {
    var fn = ctrl.match(/getBookingConversation[\s\S]{0,1600}/)[0];
    expect(fn).toMatch(/404/);
  });

  it('the customer app already treats 404 as "not assigned yet"', function () {
    // Contract check against the consumer, so this cannot silently diverge.
    var p = path.join(
      __dirname, '..', '..', 'servana_client-main', 'lib', 'modules',
      'messaging', 'domain', 'repositories', 'messaging_repository.dart'
    );
    if (!fs.existsSync(p)) return; // consumer not checked out beside the API
    var dart = fs.readFileSync(p, 'utf8');
    expect(dart).toMatch(/statusCode == 404/);
  });

  it('openConversationForConfirmedBooking is idempotent on the greeting', function () {
    var fn = svc.match(/openConversationForConfirmedBooking[\s\S]{0,1600}/)[0];
    expect(fn).toMatch(/postSystemMessageOnce/);
    expect(fn).not.toMatch(/postSystemMessage\(/);
  });

  it('admin on-behalf confirmation opens the conversation too', function () {
    var admin = readCode('services', 'adminBookingService.ts');
    expect(admin).toMatch(/openConversationForConfirmedBooking\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle wiring
// ─────────────────────────────────────────────────────────────────────────────

describe('lifecycle transitions are wired to booking events', function () {
  it('admin cancellation closes the conversation', function () {
    var code = readCode('services', 'adminBookingService.ts');
    expect(code).toMatch(/closeConversationForCancellation\(/);
  });

  it('customer cancellation closes it on the same terms', function () {
    var code = readCode('services', 'bookingService.ts');
    expect(code).toMatch(/closeConversationForCancellation\(/);
  });

  it('escalation reopens the same conversation, never a second one', function () {
    var code = readCode('services', 'adminBookingService.ts');
    var fn = code.match(/adminEscalateBooking[\s\S]{0,3000}/)[0];
    expect(fn).toMatch(/escalateToSupport\(/);
    expect(fn).not.toMatch(/createConversation\(/);
  });

  it('the grace sweep is scheduled', function () {
    var code = readCode('scheduler.ts');
    expect(code).toMatch(/sweepGracePeriod/);
    expect(code).toMatch(/cron\.schedule\(/);
  });

  it('completion does not close the conversation immediately', function () {
    var svc = readCode('chat', 'chat.service.ts');
    expect(svc).toMatch(/GRACE_HOURS\s*=\s*48/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Capability precedence — pure-logic re-implementation
// ─────────────────────────────────────────────────────────────────────────────

describe('capability precedence: membership -> participant row -> status', function () {
  var WRITABLE = ['ACTIVE', 'SUPPORT_ESCALATED'];

  function resolve(actor, conversation, participant) {
    if (actor.role === 'admin') {
      return { allowed: true, canRead: true, canSend: true };
    }
    if (!actor.isMember) {
      if (actor.wasMember && participant && participant.can_read === true) {
        return { allowed: true, canRead: true, canSend: false };
      }
      return { allowed: false, canRead: false, canSend: false };
    }
    var rowCanRead = participant ? participant.can_read !== false : true;
    var rowCanSend = participant ? participant.can_send !== false : true;
    var present = participant ? participant.left_at == null : true;
    var writable = WRITABLE.indexOf(conversation.status) !== -1 && conversation.is_closed !== true;
    if (!rowCanRead) return { allowed: false, canRead: false, canSend: false };
    return { allowed: true, canRead: true, canSend: present && rowCanSend && writable };
  }

  var ACTIVE = { status: 'ACTIVE', is_closed: false };

  it('active provider on an active booking can read and send', function () {
    var r = resolve({ role: 'coworker', isMember: true }, ACTIVE, null);
    expect(r).toEqual({ allowed: true, canRead: true, canSend: true });
  });

  it('customer can read but not send once the conversation is read-only', function () {
    var r = resolve({ role: 'client', isMember: true }, { status: 'READ_ONLY', is_closed: true }, null);
    expect(r.canRead).toBe(true);
    expect(r.canSend).toBe(false);
  });

  it('archived behaves the same as read-only for the parties', function () {
    var r = resolve({ role: 'client', isMember: true }, { status: 'ARCHIVED', is_closed: true }, null);
    expect(r.canSend).toBe(false);
  });

  it('admin can still post into a closed conversation', function () {
    var r = resolve({ role: 'admin' }, { status: 'CLOSED', is_closed: true }, null);
    expect(r.canSend).toBe(true);
  });

  it('escalation restores send for the parties', function () {
    var r = resolve({ role: 'client', isMember: true }, { status: 'SUPPORT_ESCALATED', is_closed: false }, null);
    expect(r.canSend).toBe(true);
  });

  it('reassigned provider is denied by default', function () {
    var r = resolve(
      { role: 'coworker', isMember: false, wasMember: true },
      ACTIVE,
      { can_read: false, can_send: false, left_at: '2026-08-07' }
    );
    expect(r.allowed).toBe(false);
  });

  it('reassigned provider gets read-only ONLY when policy granted can_read', function () {
    var r = resolve(
      { role: 'coworker', isMember: false, wasMember: true },
      ACTIVE,
      { can_read: true, can_send: false, left_at: '2026-08-07' }
    );
    expect(r).toEqual({ allowed: true, canRead: true, canSend: false });
  });

  it('a stranger is denied even with a forged conversation id', function () {
    var r = resolve({ role: 'coworker', isMember: false, wasMember: false }, ACTIVE, null);
    expect(r.allowed).toBe(false);
  });

  it('a departed participant cannot send even while the booking is active', function () {
    var r = resolve(
      { role: 'coworker', isMember: true },
      ACTIVE,
      { can_read: true, can_send: true, left_at: '2026-08-07' }
    );
    expect(r.canSend).toBe(false);
  });
});
