import { Server, Socket } from "socket.io";
import { getAuth as getAuthAdmin } from "firebase-admin/auth";

import { firebaseAdmin } from "./middleware/firebaseApp";
import { tempId } from "./config";
import { setProviderIo, providerRoomKey } from "./provider.realtime";
import * as repo from "./chat/chat.repository";

const defaultAuthAdmin = getAuthAdmin(firebaseAdmin);

interface SocketActor {
  uid: string;
  role: number;
}

/**
 * Initialises the root Socket.IO namespace for provider real-time events.
 *
 * Responsibilities:
 *  - Authenticate every connection with Firebase ID token (mirrors /chat namespace)
 *  - Auto-join the provider's personal room (provider:<uid>) on connect so
 *    emitToProvider() works immediately without a join_room handshake
 *  - Handle join_room / leave_room emitted by ProviderSocketService for
 *    booking/support/active_job room subscriptions
 *
 * Call once from app.ts with the io Server returned by initChatSocket().
 */
export const initProviderSocket = (io: Server): void => {
  setProviderIo(io);

  // Auth middleware — same pattern as the /chat namespace
  io.use(async (socket: Socket, next) => {
    try {
      if (tempId) {
        const role = (await repo.getUserRole(tempId)) || 3;
        (socket as any).actor = { uid: tempId, role };
        return next();
      }

      const token: string =
        socket.handshake.auth?.token ||
        (socket.handshake.headers.authorization || "").replace("Bearer ", "");

      if (!token) return next(new Error("Unauthorized"));

      const decoded = await defaultAuthAdmin.verifyIdToken(token);
      const role = (await repo.getUserRole(decoded.uid)) || 3;
      (socket as any).actor = { uid: decoded.uid, role };
      return next();
    } catch {
      return next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const actor: SocketActor = (socket as any).actor;

    // Auto-join the provider's personal notification room.
    // The client does NOT need to emit join_room for their own notification channel —
    // they receive notifications the moment they connect.
    socket.join(providerRoomKey(actor.uid));

    // join_room — provider can subscribe to booking/support/active_job/additional_work rooms.
    // Security: personal room (type === 'provider') is only joinable by the owner.
    // Other room types are joined without DB verification here; access control is
    // enforced by the REST endpoints that control what events are emitted to those rooms.
    socket.on("join_room", (data: { roomKey: string; type: string }) => {
      if (!data || !data.roomKey) return;
      if (data.type === "provider" && data.roomKey !== providerRoomKey(actor.uid)) { return; }
      socket.join(data.roomKey);
    });

    // leave_room — clean up any room the client no longer needs.
    socket.on("leave_room", (data: { roomKey: string }) => {
      if (!data || !data.roomKey) return;
      socket.leave(data.roomKey);
    });
  });
};
