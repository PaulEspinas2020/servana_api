/**
 * The messaging policy is ONE declaration with real consumers.
 *
 * `messagingPolicy` is only worth having if the services enforce it, the
 * document is generated from it, and nothing restates it. A policy module that
 * everybody imports and nobody obeys is a comment with a type signature.
 *
 * So this suite checks two things:
 *
 *   1. the DECISIONS behave — precedence, fail-closed, the legacy boolean;
 *   2. the declaration is WIRED — the repository re-exports the states rather
 *      than owning a second copy, the emitter refuses undeclared events, the
 *      telemetry codes and the declared signals are the same set, and the
 *      services import the limits instead of restating the numbers.
 */

import fs from 'fs';
import path from 'path';
import {
  ATTACHMENT_POLICY,
  CLIENT_MESSAGE_ID,
  CONVERSATION_STATUS,
  CONVERSATION_STATES,
  CONVERSATION_STATUS_NAMES,
  MESSAGE_BODY_MAX,
  MESSAGE_PAGE,
  MESSAGING_CAPABILITIES,
  MESSAGING_SIGNAL_CODES,
  PARTICIPANT_SEATS,
  REALTIME_EVENTS,
  REALTIME_EVENT_NAMES,
  SEAT_OF_ACCESS_ROLE,
  SEND_RATE_LIMIT,
  SERVER_EMITTED_EVENTS,
  WRITABLE_STATUSES,
  mayOpenConversation,
  mayWrite,
  messageReadFloor,
} from '../src/services/messaging/messagingPolicy';
import {
  EMITTED_SIGNAL_CODES,
  undeclaredSignals,
} from '../src/services/messaging/messagingTelemetry';

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

// ─── Decisions ────────────────────────────────────────────────────────────────

describe('mayWrite', () => {
  it('lets the parties post only in the writable states', () => {
    for (const status of CONVERSATION_STATUS_NAMES) {
      const expected = CONVERSATION_STATES[status].partiesMayWrite;
      expect(mayWrite(status, 'customer').allowed).toBe(expected);
      expect(mayWrite(status, 'provider').allowed).toBe(expected);
    }
  });

  it('lets support post in every state, including a closed thread', () => {
    for (const status of CONVERSATION_STATUS_NAMES) {
      expect(mayWrite(status, 'support').allowed).toBe(true);
    }
  });

  it('derives WRITABLE_STATUSES from the state specs rather than restating them', () => {
    expect([...WRITABLE_STATUSES].sort()).toEqual(['ACTIVE', 'SUPPORT_ESCALATED']);
  });

  /**
   * The ordering that a leakage test caught. `setConversationStatus` writes
   * `is_closed` for EVERY non-writable state, so consulting the boolean first
   * answered a READ_ONLY conversation with the generic "Conversation is
   * closed" — losing the sentence that tells the customer their booking
   * finished rather than being cancelled.
   */
  it('gives the state-specific reason even when the legacy boolean is also set', () => {
    expect(mayWrite('READ_ONLY', 'customer', { legacyIsClosed: true }).reason)
      .toMatch(/read-only/i);
    expect(mayWrite('ARCHIVED', 'customer', { legacyIsClosed: true }).reason)
      .toMatch(/archived/i);
  });

  it('still refuses on the legacy boolean alone — a pre-status row is closed', () => {
    // The case the boolean exists for: `status` defaulted to ACTIVE on a row
    // written before the column existed, and `is_closed` is the only truth.
    const decision = mayWrite(CONVERSATION_STATUS.ACTIVE, 'customer', { legacyIsClosed: true });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('Conversation is closed');
  });

  it('fails closed on a status it does not recognise', () => {
    expect(mayWrite('SOMETHING_NEW' as any, 'customer').allowed).toBe(false);
    // ...and support is not exempt from a state that does not exist.
    expect(mayWrite('SOMETHING_NEW' as any, 'support').allowed).toBe(false);
  });
});

describe('messageReadFloor', () => {
  it('gives the customer and support the whole transcript', () => {
    expect(messageReadFloor('customer', null).mode).toBe('full');
    expect(messageReadFloor('support', null).mode).toBe('full');
  });

  it('bounds a provider to their own assignment', () => {
    const floor = messageReadFloor('provider', '2026-08-03T00:00:00.000Z');
    expect(floor.mode).toBe('since');
    expect(floor.since).toBe('2026-08-03T00:00:00.000Z');
  });

  it('DENIES a provider whose assignment carries no usable start', () => {
    // "I cannot tell where your access begins" is not an argument for showing
    // everything. This is the fail-closed that stopped a replacement provider
    // reading the previous provider's transcript.
    for (const value of [null, undefined, '']) {
      expect(messageReadFloor('provider', value as any).mode).toBe('denied');
    }
  });
});

describe('mayOpenConversation', () => {
  it('refuses the parties until a provider is confirmed', () => {
    for (const seat of ['customer', 'provider'] as const) {
      expect(mayOpenConversation(seat, { hasActiveProvider: false }).allowed).toBe(false);
      expect(mayOpenConversation(seat, { hasActiveProvider: true }).allowed).toBe(true);
    }
  });

  it('lets support open one regardless — that is how a customer gets help early', () => {
    expect(mayOpenConversation('support', { hasActiveProvider: false }).allowed).toBe(true);
  });
});

describe('seats', () => {
  it('translates every internal access role', () => {
    expect(SEAT_OF_ACCESS_ROLE.client).toBe('customer');
    expect(SEAT_OF_ACCESS_ROLE.coworker).toBe('provider');
    expect(SEAT_OF_ACCESS_ROLE.admin).toBe('support');
    expect(Object.values(SEAT_OF_ACCESS_ROLE).sort()).toEqual([...PARTICIPANT_SEATS].sort());
  });
});

// ─── Wiring ───────────────────────────────────────────────────────────────────

describe('the declaration has real consumers, not just readers', () => {
  const repository = read('src/chat/chat.repository.ts');
  const service = read('src/chat/chat.service.ts');
  const realtime = read('src/chat/chat.realtime.ts');

  it('the repository RE-EXPORTS the states rather than declaring a second copy', () => {
    expect(repository).toMatch(/from "\.\.\/services\/messaging\/messagingPolicy"/);
    expect(repository).toMatch(/export \{ CONVERSATION_STATUS, WRITABLE_STATUSES \}/);
    // The literal must be gone. Two declarations that agree today is the state
    // every drift starts from.
    expect(repository).not.toMatch(/CONVERSATION_STATUS = \{/);
  });

  it('the service DECIDES writability with the policy, not with its own predicate', () => {
    expect(service).toMatch(/mayWrite\(status, seat/);
    expect(service).not.toMatch(/repo\.WRITABLE_STATUSES\.includes/);
  });

  it('the service applies the policy read floor', () => {
    expect(service).toMatch(/messageReadFloor\(seat, access\.assignedAt/);
  });

  it('the message limits are imported, not restated', () => {
    expect(service).toMatch(/MESSAGE_BODY_MAX = POLICY_MESSAGE_BODY_MAX/);
    expect(service).toMatch(/ATTACHMENT_MAX = ATTACHMENT_POLICY\.maxPerMessage/);
    expect(service).toMatch(/ATTACHMENT_BYTES_MAX = ATTACHMENT_POLICY\.maxBytes/);
    expect(service).toMatch(/SEND_RATE_LIMIT/);
    expect(service).toMatch(/CLIENT_MESSAGE_ID\.minLength/);
    // The old literals are gone from the code paths that enforce them.
    expect(service).not.toMatch(/const MESSAGE_BODY_MAX = 4000/);
    expect(service).not.toMatch(/clientMsgId\.length < 16/);
  });

  it('the emitter refuses an event that is not in the catalog', () => {
    expect(realtime).toMatch(/SERVER_EMITTED_EVENTS\.includes\(event\)/);
    expect(realtime).toMatch(/refusing to emit undeclared realtime event/);
  });

  it('every server-emitted event carries the envelope', () => {
    expect(realtime).toMatch(/withRealtimeEnvelope\(event, payload\)/);
  });
});

// ─── The realtime catalog ─────────────────────────────────────────────────────

describe('the realtime catalog', () => {
  it('names every event exactly once', () => {
    expect(new Set(REALTIME_EVENT_NAMES).size).toBe(REALTIME_EVENT_NAMES.length);
  });

  it('splits into server and client directions with nothing left over', () => {
    const server = REALTIME_EVENTS.filter((e) => e.direction === 'server→client');
    const client = REALTIME_EVENTS.filter((e) => e.direction === 'client→server');
    expect(server.length + client.length).toBe(REALTIME_EVENTS.length);
    expect(SERVER_EMITTED_EVENTS.length).toBe(server.length);
  });

  it('keeps the names the four shipped clients already listen to', () => {
    // Minting a clean vocabulary and emitting both for a while would
    // double-deliver every message to any client listening to the old and the
    // new name — the exact failure this tab removes.
    for (const name of ['message:new', 'message:updated', 'message:read', 'conversation:closed']) {
      expect(REALTIME_EVENT_NAMES).toContain(name);
    }
  });

  it('describes a payload for every event', () => {
    for (const event of REALTIME_EVENTS) {
      expect(event.payload.length).toBeGreaterThan(10);
      expect(event.description.length).toBeGreaterThan(20);
    }
  });
});

// ─── Telemetry ────────────────────────────────────────────────────────────────

describe('the telemetry catalog and the emitter agree', () => {
  it('every code the module emits is declared in the policy', () => {
    // A signal recorded and not declared is a metric nobody knows exists; a
    // signal declared and not recorded is documentation of one that does not.
    expect(undeclaredSignals()).toEqual([]);
  });

  it('every declared signal is actually emitted somewhere', () => {
    for (const code of MESSAGING_SIGNAL_CODES) {
      expect(EMITTED_SIGNAL_CODES).toContain(code);
    }
  });
});

// ─── The caller matrix ────────────────────────────────────────────────────────

describe('every capability names its domain module and explains its role split', () => {
  it('has a rationale for each capability, not a claim that one exists', () => {
    for (const capability of MESSAGING_CAPABILITIES) {
      expect(capability.roleSplitRationale.length).toBeGreaterThan(80);
      expect(capability.domainModule).toMatch(/^(services\/messaging|chat)\//);
      expect(capability.surfaces.length).toBeGreaterThan(0);
      expect(capability.contractIds.length).toBeGreaterThan(0);
    }
  });

  it('every contract id it names exists', () => {
    const { V1_CONTRACT } = require('../src/api/v1/contract');
    const ids = new Set(V1_CONTRACT.map((e: any) => e.id));
    for (const capability of MESSAGING_CAPABILITIES) {
      for (const id of capability.contractIds) expect(ids.has(id)).toBe(true);
    }
  });
});

// ─── Placeholder data ─────────────────────────────────────────────────────────

describe('nothing in the messaging path manufactures content', () => {
  it('the backend seeds no demo, sample or placeholder conversation', () => {
    const sources = [
      'src/chat/chat.service.ts',
      'src/chat/chat.repository.ts',
      'src/chat/chat.controller.ts',
      'src/services/messaging/messagingService.ts',
      'src/services/messaging/conversationDto.ts',
    ].map(read).join('\n');

    // Comments are stripped: several of them use these words to explain the
    // rule, and matching the explanation would pass while the code was wrong.
    const code = sources
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    for (const word of ['placeholder', 'demoConversation', 'sampleMessage', 'lorem', 'Lorem']) {
      expect(code).not.toContain(word);
    }
  });

  it('server-authored messages are all keyed system messages', () => {
    const service = read('src/chat/chat.service.ts');
    // `postSystemMessage` is the only writer with a null sender, and
    // `postSystemMessageOnce` is how the lifecycle calls it — keyed, so a
    // retried transition cannot produce a second greeting.
    expect(service).toMatch(/senderUid: null,\s*\n\s*senderRole: null,\s*\n\s*type: "system"/);
    expect(service).toMatch(/findSystemMessage\(conversationId, eventKey\)/);
  });
});

// ─── The numbers, pinned ──────────────────────────────────────────────────────

describe('the declared limits', () => {
  it('are the ones the contract document publishes', () => {
    expect(MESSAGE_BODY_MAX).toBe(4000);
    expect(MESSAGE_PAGE.defaultLimit).toBe(30);
    expect(MESSAGE_PAGE.maxLimit).toBe(100);
    expect(SEND_RATE_LIMIT).toEqual({ windowMs: 10_000, maxMessages: 20 });
    expect(ATTACHMENT_POLICY.maxPerMessage).toBe(5);
    expect(ATTACHMENT_POLICY.maxBytes).toBe(10 * 1024 * 1024);
    expect([...ATTACHMENT_POLICY.allowedMimeTypes]).toEqual([
      'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
    ]);
    expect(CLIENT_MESSAGE_ID.required).toBe(true);
  });
});
