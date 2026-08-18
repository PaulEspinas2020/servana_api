import { Server } from "socket.io";
import {
  REALTIME_NAMESPACE,
  SERVER_EMITTED_EVENTS,
} from "../services/messaging/messagingPolicy";
import { withRealtimeEnvelope } from "../services/messaging/conversationDto";
import { recordRealtimeDisconnected } from "../services/messaging/messagingTelemetry";

/**
 * Holds the Socket.IO server instance so the service layer can broadcast
 * without importing the gateway (avoids a circular dependency).
 * The gateway calls setIo() once at startup.
 */
let io: Server | null = null;

export const setIo = (server: Server) => {
  io = server;
};

export const roomName = (conversationId: number) => `conversation:${conversationId}`;

/**
 * The ONE way a messaging event leaves this process.
 *
 * Two things happen here that did not happen when each call site emitted for
 * itself:
 *
 *   1. The event name is checked against the declared catalog. An event nobody
 *      documented is one no client can be written against, and a typo used to
 *      produce a silent no-op that looked exactly like a working emit.
 *   2. `event`, `schemaVersion` and `emittedAt` are stamped on the payload,
 *      ADDITIVELY. All four shipped clients read the message fields at the top
 *      level, so wrapping the payload would break every one of them; adding
 *      three keys they ignore breaks none and gives the next change somewhere
 *      to be detected.
 *
 * A bad event name throws in development and is swallowed in production: a
 * mistyped broadcast must fail loudly where somebody can fix it, and must not
 * take down a request path that has already committed its write.
 */
export const emitMessagingEvent = (
  conversationId: number,
  event: string,
  payload: Record<string, unknown>,
) => {
  if (!SERVER_EMITTED_EVENTS.includes(event)) {
    const error = new Error(
      `[chat] refusing to emit undeclared realtime event "${event}". ` +
        `Add it to REALTIME_EVENTS in services/messaging/messagingPolicy.`,
    );
    if (process.env.NODE_ENV !== 'production') throw error;
    // eslint-disable-next-line no-console
    console.error(error.message);
    return;
  }
  if (!io) return;
  io.of(REALTIME_NAMESPACE)
    .to(roomName(conversationId))
    .emit(event, withRealtimeEnvelope(event, payload));
};

/**
 * Kept for callers that predate the catalog. Delegates, so there is still only
 * one emit path — the validation and the envelope are not optional.
 */
export const emitToConversation = (
  conversationId: number,
  event: string,
  payload: any,
) => emitMessagingEvent(conversationId, event, payload as Record<string, unknown>);

/** Remove every live socket for a participant whose booking access was revoked. */
export const evictUserFromConversation = (conversationId: number, userUid: string) => {
  if (!io) return;
  const namespace = io.of(REALTIME_NAMESPACE);
  const room = roomName(conversationId);
  for (const socket of namespace.sockets.values()) {
    if ((socket as any).actor?.uid !== userUid || !socket.rooms.has(room)) continue;
    socket.leave(room);
    socket.emit(
      'conversation:access-revoked',
      withRealtimeEnvelope('conversation:access-revoked', { conversationId }),
    );
  }
};

/**
 * Sign-out and account switch (§86).
 *
 * A socket authenticates once at handshake and its actor never changes, so a
 * connection cannot start speaking for a second account. The failure this closes
 * is the other one: a live socket belonging to the account somebody just left,
 * still in its rooms, still receiving that account's messages while the app
 * renders a different person's inbox.
 *
 * The client's obligation is the other half — drop the account-scoped cache when
 * this arrives — and it is stated in `SESSION_HYGIENE` so it is a contract
 * rather than an assumption about what the apps happen to do.
 *
 * Returns the number of sockets evicted, so the caller can log a real number
 * instead of "attempted".
 */
export const evictUserEverywhere = (userUid: string, reason = 'signed-out'): number => {
  if (!io) return 0;
  let evicted = 0;
  const namespace = io.of(REALTIME_NAMESPACE);
  for (const socket of namespace.sockets.values()) {
    if ((socket as any).actor?.uid !== userUid) continue;
    for (const room of [...socket.rooms]) {
      if (room !== socket.id) socket.leave(room);
    }
    socket.emit(
      'conversation:access-revoked',
      withRealtimeEnvelope('conversation:access-revoked', { conversationId: null, reason }),
    );
    // The connection itself goes too. Leaving it open would keep an
    // authenticated transport alive for an identity the user has left.
    socket.disconnect(true);
    recordRealtimeDisconnected('session_ended');
    evicted += 1;
  }
  return evicted;
};
