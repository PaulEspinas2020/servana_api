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
