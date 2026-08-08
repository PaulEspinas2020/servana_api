import { Server } from "socket.io";

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

export const emitToConversation = (
  conversationId: number,
  event: string,
  payload: any
) => {
  if (!io) return;
  io.of("/chat").to(roomName(conversationId)).emit(event, payload);
};

/** Remove every live socket for a participant whose booking access was revoked. */
export const evictUserFromConversation = (conversationId: number, userUid: string) => {
  if (!io) return;
  const namespace = io.of('/chat');
  const room = roomName(conversationId);
  for (const socket of namespace.sockets.values()) {
    if ((socket as any).actor?.uid !== userUid || !socket.rooms.has(room)) continue;
    socket.leave(room);
    socket.emit('conversation:access-revoked', { conversationId });
  }
};
