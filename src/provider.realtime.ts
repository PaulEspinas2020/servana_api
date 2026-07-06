import { Server } from "socket.io";

/**
 * Holds the root Socket.IO namespace so the service layer can push
 * real-time events to providers without importing the gateway.
 * provider.gateway.ts calls setProviderIo() once at startup.
 */
let io: Server | null = null;

export const setProviderIo = (server: Server): void => {
  io = server;
};

export const providerRoomKey = (uid: string): string => `provider:${uid}`;

/**
 * Emit a real-time event to a specific provider's personal room.
 * No-op if the socket server has not been initialized yet.
 */
export const emitToProvider = (workerUid: string, event: string, payload: unknown): void => {
  if (!io) return;
  io.to(providerRoomKey(workerUid)).emit(event, payload);
};
