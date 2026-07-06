import { Request, Response } from "express";
import * as chatService from "./chat.service";
import { uploadFileToStorage } from "../helpers/firebaseStorageUploader";

const ALLOWED_CHAT_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];

/**
 * Pull the authenticated actor (uid + numeric role) off the request.
 * req.user is set by verifyAuth (firebase decoded token). We resolve the
 * numeric role from user_credentials so authorization matches the rest of
 * the app's role model.
 */
const getActor = async (req: any): Promise<chatService.ChatActor> => {
  const uid = req.user?.uid;
  // chat.service authorizes off uid; role only matters for admin shortcut.
  const repo = await import("./chat.repository");
  const role = (await repo.getUserRole(uid)) ?? 3;
  return { uid, role };
};

const handle = (res: Response, e: any) => {
  const status = e?.status || 500;
  return res.status(status).json({ success: false, message: e?.message || "Server error" });
};

export const listConversations = async (req: any, res: Response) => {
  try {
    const actor = await getActor(req);
    console.log("Listing conversations for actor", actor);
    const conversations = await chatService.listConversations(actor);
    return res.json({ success: true, conversations });
  } catch (e: any) {
    return handle(res, e);
  }
};

/** GET /bookings/:bookingId/conversation — get or lazily create it. */
export const getBookingConversation = async (req: any, res: Response) => {
  try {
    const bookingId = Number(req.params.bookingId);
    if (!bookingId || Number.isNaN(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking id" });
    }
    const actor = await getActor(req);
    const access = await chatService.resolveAccessForBooking(actor, bookingId);
    if (!access.allowed) {
      return res.status(403).json({ success: false, message: "Not allowed for this booking" });
    }
    const conversation = await chatService.getOrCreateConversation(bookingId);
    const full = await chatService.getConversationWithParticipants(conversation.id);
    return res.json({ success: true, conversation: full });
  } catch (e: any) {
    return handle(res, e);
  }
};

export const getConversation = async (req: any, res: Response) => {
  try {
    const conversationId = Number(req.params.id);
    const actor = await getActor(req);
    const { access } = await chatService.resolveAccessForConversation(actor, conversationId);
    if (!access.allowed) return res.status(403).json({ success: false, message: "Not allowed" });
    const full = await chatService.getConversationWithParticipants(conversationId);
    if (!full) return res.status(404).json({ success: false, message: "Conversation not found" });
    return res.json({ success: true, conversation: full });
  } catch (e: any) {
    return handle(res, e);
  }
};

export const getMessages = async (req: any, res: Response) => {
  try {
    const conversationId = Number(req.params.id);
    const limit = req.query.limit ? Number(req.query.limit) : 30;
    const before = req.query.before ? Number(req.query.before) : undefined;
    const actor = await getActor(req);
    const result = await chatService.getMessages(actor, conversationId, limit, before);
    return res.json({ success: true, ...result });
  } catch (e: any) {
    return handle(res, e);
  }
};

export const sendMessage = async (req: any, res: Response) => {
  try {
    const conversationId = Number(req.params.id);
    const actor = await getActor(req);
    const message = await chatService.sendMessage(actor, conversationId, {
      type: req.body.type,
      body: req.body.body,
      metadata: req.body.metadata,
      clientMsgId: req.body.clientMsgId,
      attachments: req.body.attachments,
    });
    return res.status(201).json({ success: true, message });
  } catch (e: any) {
    return handle(res, e);
  }
};

export const editMessage = async (req: any, res: Response) => {
  try {
    const conversationId = Number(req.params.id);
    const messageId = Number(req.params.msgId);
    const actor = await getActor(req);
    const message = await chatService.editMessage(actor, conversationId, messageId, req.body.body);
    return res.json({ success: true, message });
  } catch (e: any) {
    return handle(res, e);
  }
};

export const deleteMessage = async (req: any, res: Response) => {
  try {
    const conversationId = Number(req.params.id);
    const messageId = Number(req.params.msgId);
    const actor = await getActor(req);
    const message = await chatService.deleteMessage(actor, conversationId, messageId);
    return res.json({ success: true, message });
  } catch (e: any) {
    return handle(res, e);
  }
};

export const markRead = async (req: any, res: Response) => {
  try {
    const conversationId = Number(req.params.id);
    const actor = await getActor(req);
    await chatService.markRead(actor, conversationId, Number(req.body.lastReadMessageId));
    return res.json({ success: true });
  } catch (e: any) {
    return handle(res, e);
  }
};

/**
 * POST /api/chat/attachments/upload
 * Uploads a chat attachment to Firebase Storage.
 * Body: { file: dataUri, name: string }
 * Returns: { attachmentId, previewUrl, fileName, mimeType }
 */
export const uploadAttachment = async (req: any, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });
    const { file, name } = req.body;
    if (!file || !name) {
      return res.status(400).json({ success: false, message: "file (data URI) and name are required" });
    }
    if (!file.startsWith("data:")) {
      return res.status(422).json({ success: false, message: "file must be a data URI" });
    }
    const mimeType = file.slice(file.indexOf(":") + 1, file.indexOf(";"));
    if (!ALLOWED_CHAT_MIMES.includes(mimeType)) {
      return res.status(422).json({ success: false, message: "File type not allowed. Use JPG, PNG, WebP, GIF, or PDF." });
    }
    const sanitizedName = String(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
    const storageKey = `${uid}_${Date.now()}`;
    const previewUrl = await uploadFileToStorage("chat-attachments", storageKey, file);
    return res.status(201).json({
      success: true,
      attachmentId: storageKey,
      previewUrl,
      fileName: sanitizedName,
      mimeType,
    });
  } catch (e: any) {
    return handle(res, e);
  }
};

/**
 * POST /api/chat/conversations/:id/messages/:msgId/report
 * Body: { category: string, description?: string }
 */
export const reportMessage = async (req: any, res: Response) => {
  try {
    const conversationId = Number(req.params.id);
    const messageId = Number(req.params.msgId);
    const { category, description } = req.body;
    if (!category) {
      return res.status(400).json({ success: false, message: "category is required" });
    }
    const actor = await getActor(req);
    const result = await chatService.reportMessage(actor, conversationId, messageId, category, description ?? "");
    return res.json({ success: true, ...result });
  } catch (e: any) {
    return handle(res, e);
  }
};

export const closeConversation = async (req: any, res: Response) => {
  try {
    const conversationId = Number(req.params.id);
    const actor = await getActor(req);
    const { access } = await chatService.resolveAccessForConversation(actor, conversationId);
    if (!access.allowed) return res.status(403).json({ success: false, message: "Not allowed" });
    if (access.role === "client") {
      return res.status(403).json({ success: false, message: "Only admin or coworker can close" });
    }
    const conversation = await chatService.closeConversation(conversationId);
    return res.json({ success: true, conversation });
  } catch (e: any) {
    return handle(res, e);
  }
};
