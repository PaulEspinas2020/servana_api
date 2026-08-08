import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import { getAuth as getAuthAdmin } from "firebase-admin/auth";

import { firebaseAdmin } from "../middleware/firebaseApp";
import { tempId } from "../config";
import { setIo, roomName } from "./chat.realtime";
import * as chatService from "./chat.service";
import * as repo from "./chat.repository";

const defaultAuthAdmin = getAuthAdmin(firebaseAdmin);

/**
 * Initialize Socket.IO on the /chat namespace.
 * Call once from app.ts with the http.Server instance.
 */
const ALLOWED_ORIGINS = [
  "http://localhost:4200",
  "http://localhost:4201",
  "https://provider.servana.com.ph",
  "https://admin.servana.com.ph",
  "https://www.servana.com.ph",
  "https://servana.com.ph",
];

export const initChatSocket = (httpServer: HttpServer) => {
  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, server-side, same-origin)
        if (!origin || ALLOWED_ORIGINS.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error("Not allowed by CORS"));
        }
      },
    },
  });

  setIo(io); // let the service layer broadcast

  const chat = io.of("/chat");

  // --- Handshake auth: verify the firebase id token, attach the actor ------
  chat.use(async (socket: Socket, next) => {
    try {
      if (tempId) {
        // Dev bypass, mirrors verifyAuth.
        const role = (await repo.getUserRole(tempId)) ?? 3;
        (socket as any).actor = { uid: tempId, role };
        return next();
      }

      const token =
        socket.handshake.auth?.token ||
        (socket.handshake.headers.authorization || "").replace("Bearer ", "");

      if (!token) return next(new Error("Unauthorized"));

      const decoded = await defaultAuthAdmin.verifyIdToken(token);
      const role = (await repo.getUserRole(decoded.uid)) ?? 3;
      (socket as any).actor = { uid: decoded.uid, role };
      return next();
    } catch (err) {
      return next(new Error("Unauthorized"));
    }
  });

  chat.on("connection", (socket: Socket) => {
    const actor: chatService.ChatActor = (socket as any).actor;
    const conversationIdOf = (raw: unknown): number => {
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid conversation id');
      return value;
    };

    // Join a conversation room (authorized).
    socket.on("conversation:join", async ({ conversationId }, ack) => {
      try {
        const id = conversationIdOf(conversationId);
        const { access } = await chatService.resolveAccessForConversation(actor, id);
        if (!access.allowed) return ack?.({ ok: false, error: "Forbidden" });
        socket.join(roomName(id));
        const conversation = await chatService.getConversationWithParticipants(id, actor);
        ack?.({ ok: true, conversation });
        socket.to(roomName(id)).emit("participant:joined", {
          conversationId: id,
          userUid: actor.uid,
          role: access.role,
        });
      } catch (e: any) {
        ack?.({ ok: false, error: e?.message || "error" });
      }
    });

    socket.on("conversation:leave", ({ conversationId }) => {
      try { socket.leave(roomName(conversationIdOf(conversationId))); } catch { /* no-op */ }
    });

    // Send a message (same service path as the REST endpoint).
    socket.on("message:send", async (payload, ack) => {
      try {
        const message = await chatService.sendMessage(actor, conversationIdOf(payload?.conversationId), {
          type: payload.type,
          body: payload.body,
          metadata: payload.metadata,
          clientMsgId: payload.clientMsgId,
          attachments: payload.attachments,
        });
        ack?.({ ok: true, message }); // broadcast happens inside the service
      } catch (e: any) {
        ack?.({ ok: false, error: e?.message || "error" });
      }
    });

    // Read pointer.
    socket.on("message:read", async ({ conversationId, lastReadMessageId }, ack) => {
      try {
        await chatService.markRead(actor, conversationIdOf(conversationId), Number(lastReadMessageId));
        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e?.message || "error" });
      }
    });

    // Ephemeral typing indicator (not persisted). Authorization is verified
    // before relaying so unauthenticated actors cannot spam rooms they don't belong to.
    socket.on("message:typing", async ({ conversationId, isTyping }) => {
      try {
        const id = conversationIdOf(conversationId);
        const { access } = await chatService.resolveAccessForConversation(actor, id);
        if (!access.allowed) return;
        socket.to(roomName(id)).emit("typing", {
          conversationId: id,
          userUid: actor.uid,
          isTyping: !!isTyping,
        });
      } catch (_) {
        // Swallow — typing indicators are best-effort
      }
    });
  });

  return io;
};
