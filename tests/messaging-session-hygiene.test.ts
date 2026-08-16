/**
 * Sign-out, account switch, and the events that may leave this process.
 *
 * ## The gap this covers
 *
 * Revoking a token stops the next REQUEST. A Socket.IO connection is already
 * open: it authenticated once at handshake, it is sitting in its conversation
 * rooms, and nothing about a token revocation removes it. So the account
 * somebody just left keeps receiving messages on a socket the app is still
 * holding — which is the state in which a cached transcript gets rendered under
 * the next person's identity.
 *
 * The other half is the emitter. An event nobody declared is one no client can
 * be written against, and a mistyped broadcast used to be a silent no-op that
 * looked exactly like a working emit.
 */

import { EventEmitter } from 'events';

jest.mock('../src/config', () => ({
  db: { schema: 'servana' },
  tempId: undefined,
  firebaseConfig: { storageBucket: 'servana-test.appspot.com' },
}));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));

import {
  setIo,
  emitMessagingEvent,
  evictUserEverywhere,
  evictUserFromConversation,
  roomName,
} from '../src/chat/chat.realtime';
import { SESSION_HYGIENE } from '../src/services/messaging/messagingPolicy';
import { __resetMessagingTelemetry, snapshot } from '../src/services/messaging/messagingTelemetry';

// ─── A Socket.IO double ───────────────────────────────────────────────────────

class FakeSocket extends EventEmitter {
  readonly rooms: Set<string>;
  readonly emitted: Array<{ event: string; payload: any }> = [];
  disconnected = false;

  constructor(readonly id: string, uid: string, rooms: string[] = []) {
    super();
    (this as any).actor = { uid, role: 3 };
    this.rooms = new Set([id, ...rooms]);
  }

  emit(event: string, payload?: any): boolean {
    this.emitted.push({ event, payload });
    return true;
  }

  leave(room: string): void { this.rooms.delete(room); }
  disconnect(_close: boolean): void { this.disconnected = true; }
}

const makeIo = (sockets: FakeSocket[]) => {
  const roomEmits: Array<{ room: string; event: string; payload: any }> = [];
  const namespace = {
    sockets: new Map(sockets.map((s) => [s.id, s])),
    to: (room: string) => ({
      emit: (event: string, payload: any) => { roomEmits.push({ room, event, payload }); },
    }),
  };
  return { io: { of: () => namespace } as any, roomEmits };
};

beforeEach(() => __resetMessagingTelemetry());

// ─── Eviction ─────────────────────────────────────────────────────────────────

describe('signing out closes the account\'s live chat sockets', () => {
  it('removes every room, says why, and drops the connection', () => {
    const mine = new FakeSocket('s1', 'user-a', ['conversation:1', 'conversation:2']);
    const theirs = new FakeSocket('s2', 'user-b', ['conversation:1']);
    const { io } = makeIo([mine, theirs]);
    setIo(io);

    const closed = evictUserEverywhere('user-a', 'logout');

    expect(closed).toBe(1);
    // The socket's own id room is not a conversation and is left alone; every
    // conversation room is gone.
    expect([...mine.rooms]).toEqual(['s1']);
    expect(mine.disconnected).toBe(true);
    expect(mine.emitted[0].event).toBe('conversation:access-revoked');
    expect(mine.emitted[0].payload.reason).toBe('logout');

    // Somebody else's socket is untouched — this is an eviction, not a purge.
    expect([...theirs.rooms].sort()).toEqual(['conversation:1', 's2'].sort());
    expect(theirs.disconnected).toBe(false);
  });

  it('counts the disconnect it caused', () => {
    const mine = new FakeSocket('s1', 'user-a', ['conversation:1']);
    setIo(makeIo([mine]).io);
    evictUserEverywhere('user-a');
    expect(snapshot().counts['REALTIME_DISCONNECTED:SESSION_ENDED']).toBe(1);
  });

  it('is a no-op, not a throw, when no socket server is running', () => {
    setIo(undefined as any);
    expect(evictUserEverywhere('user-a')).toBe(0);
  });

  it('an account switch is a sign-out, so it takes the same path', () => {
    // Stated in the policy rather than left as an assumption about what the
    // apps happen to do: a switch IS a sign-out followed by a sign-in.
    expect(SESSION_HYGIENE.onAccountSwitch).toMatch(/Identical to sign-out/);
    expect(SESSION_HYGIENE.clientObligation).toMatch(/clear the account-scoped/);
  });

  /**
   * The wiring, at the one place sessions end.
   *
   * `endAllSessions` is called by logout, password change, "sign out all
   * devices" and admin security actions. Putting the eviction there rather than
   * in the logout handler means every one of those paths gets it, which is the
   * lesson `clearFcmToken` already taught this module.
   */
  it('is wired into endAllSessions, not into one handler', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'authSessionService.ts'),
      'utf8',
    );
    expect(source).toMatch(/evictUserEverywhere\(uid, reason\)/);
    expect(source).toMatch(/realtimeSocketsClosed/);
  });

  it('a revoked booking assignment evicts only that conversation', () => {
    const socket = new FakeSocket('s1', 'user-a', [roomName(1), roomName(2)]);
    setIo(makeIo([socket]).io);

    evictUserFromConversation(1, 'user-a');

    expect(socket.rooms.has(roomName(1))).toBe(false);
    expect(socket.rooms.has(roomName(2))).toBe(true);
    expect(socket.disconnected).toBe(false);
    expect(socket.emitted[0].event).toBe('conversation:access-revoked');
    expect(socket.emitted[0].payload.conversationId).toBe(1);
  });
});

// ─── The emitter ──────────────────────────────────────────────────────────────

describe('only declared events leave this process', () => {
  it('emits a declared event to the conversation room, with the envelope', () => {
    const { io, roomEmits } = makeIo([]);
    setIo(io);

    emitMessagingEvent(7, 'message:read', { conversationId: 7, lastReadMessageId: 42 });

    expect(roomEmits).toHaveLength(1);
    expect(roomEmits[0].room).toBe('conversation:7');
    expect(roomEmits[0].payload).toMatchObject({
      conversationId: 7,
      lastReadMessageId: 42,
      event: 'message:read',
      schemaVersion: 1,
    });
    expect(typeof roomEmits[0].payload.emittedAt).toBe('string');
  });

  it('THROWS on an undeclared event outside production, so a typo is not a silent no-op', () => {
    setIo(makeIo([]).io);
    expect(() => emitMessagingEvent(7, 'message:nwe', {})).toThrow(/undeclared realtime event/);
  });

  it('refuses a client→server event name as a broadcast', () => {
    // `message:send` is something a client emits. Broadcasting it would be a
    // server sending a command to itself, which is a bug with a plausible name.
    setIo(makeIo([]).io);
    expect(() => emitMessagingEvent(7, 'message:send', {})).toThrow(/undeclared/);
  });

  it('logs rather than throws in production — a committed write must not fail on a broadcast', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      setIo(makeIo([]).io);
      expect(() => emitMessagingEvent(7, 'message:nwe', {})).not.toThrow();
      expect(error).toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previous;
      error.mockRestore();
    }
  });
});
