import { Server, Socket } from "socket.io";
import { getAuth as getAuthAdmin } from "firebase-admin/auth";

import { getFirebaseAdmin } from "./middleware/firebaseApp";
import { tempId, db } from "./config";
import { setProviderIo, providerRoomKey } from "./provider.realtime";
import * as repo from "./chat/chat.repository";
import dbQuery from "./db/dbQuery";
import { isProviderRole } from "./constants/providerRoles";

// Lazy: resolving the Auth service at module scope made importing this file
// require a live Admin credential. getAuth() memoises per app internally and
// getFirebaseAdmin() memoises the app, so calling this per request is cheap.
const defaultAuthAdmin = () => getAuthAdmin(getFirebaseAdmin());

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
        const role = await repo.getUserRole(tempId);
        if (!isProviderRole(role)) return next(new Error("Unauthorized"));
        (socket as any).actor = { uid: tempId, role };
        return next();
      }

      const token: string =
        socket.handshake.auth?.token ||
        (socket.handshake.headers.authorization || "").replace("Bearer ", "");

      if (!token) return next(new Error("Unauthorized"));

      const decoded = await defaultAuthAdmin().verifyIdToken(token);
      const role = await repo.getUserRole(decoded.uid);
      if (!isProviderRole(role)) return next(new Error("Unauthorized"));
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
    // Security: personal room ('provider' type) is ownership-checked by room key.
    // Booking rooms are ownership-checked via DB — booking IDs are sequential integers
    // and therefore guessable, so we must verify before granting subscription.
    // Support/other rooms use UUID-based keys (gen_random_uuid) and are not guessable;
    // access control for those is enforced by the REST endpoints that emit to those rooms.
    socket.on("join_room", async (data: { roomKey: string; type: string }) => {
      if (!data || !data.roomKey) return;

      if (data.type === "provider") {
        if (data.roomKey !== providerRoomKey(actor.uid)) return;
        socket.join(data.roomKey);
        return;
      }

      if (data.type === "booking") {
        // Room key format: booking:{bookingId} — verify ownership before joining
        const bookingId = data.roomKey.replace(/^booking:/, "");
        if (!bookingId || bookingId === data.roomKey) return;
        try {
          const { rows } = await dbQuery.query(
            `SELECT id FROM ${db.schema}.bookings WHERE id = $1 AND worker_uid = $2 LIMIT 1`,
            [bookingId, actor.uid]
          );
          if (!rows.length) return;
        } catch {
          return;
        }
        socket.join(data.roomKey);
        return;
      }

      // Other types (support, active_job, additional_work): UUID-keyed rooms — join without DB check.
      socket.join(data.roomKey);
    });

    // leave_room — clean up any room the client no longer needs.
    socket.on("leave_room", (data: { roomKey: string }) => {
      if (!data || !data.roomKey) return;
      socket.leave(data.roomKey);
    });
  });
};
