import { Request, Response } from "express";
import * as chatService from "./chat.service";
import { uploadFileToStorage } from "../helpers/firebaseStorageUploader";
import { validateDataUri, AllowedUploadMime } from "../helpers/fileSignature";
import { randomUUID } from "crypto";

const ALLOWED_CHAT_MIMES: readonly AllowedUploadMime[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
];
const MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Pull the authenticated actor (uid + numeric role) off the request.
 * req.user is set by verifyAuth (firebase decoded token). We resolve the
 * numeric role from user_credentials so authorization matches the rest of
 * the app's role model.
 */
const getActor = async (req: any): Promise<chatService.ChatActor> => {
  const uid = req.user?.uid;
  if (!uid || typeof uid !== 'string') throw chatService.httpError(401, 'Unauthorized');
  // chat.service authorizes off uid; role only matters for admin shortcut.
  const repo = await import("./chat.repository");
  const role = (await repo.getUserRole(uid)) ?? 3;
  return { uid, role };
};

const handle = (res: Response, e: any) => {
  const status = e?.status || e?.statusCode || 500;
  const message = status >= 400 && status < 500 ? (e?.message || 'Invalid request') : 'Server error';
  return res.status(status).json({ success: false, message });
};

const positiveId = (raw: unknown, label: string): number => {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw chatService.httpError(400, `Invalid ${label}`);
  return value;
};

export const listConversations = async (req: any, res: Response) => {
  try {
    const actor = await getActor(req);
    const conversations = await chatService.listConversations(actor);
    return res.json({ success: true, conversations });
  } catch (e: any) {
    return handle(res, e);
  }
};

/**
 * GET /bookings/:bookingId/conversation
 *
 * Resolves the booking's conversation. It does NOT create one: a booking
 * conversation is a consequence of a provider being confirmed, created
 * transactionally by `technicianService.acceptJob` and by admin assignment —
 * not of a client opening a screen.
 *
 * 404 when it does not exist yet is the contract the customer app was already
 * written against: `MessagingRepository.resolveForBooking` maps 404 to null,
 * commenting "the conversation does not exist yet (provider not yet assigned)".
 */
export const getBookingConversation = async (req: any, res: Response) => {
  try {
    const bookingId = positiveId(req.params.bookingId, 'booking id');
    const actor = await getActor(req);
    const access = await chatService.resolveAccessForBooking(actor, bookingId);
    if (!access.allowed) {
      return res.status(403).json({ success: false, message: "Not allowed for this booking" });
    }
    const conversation = await chatService.getExistingConversation(bookingId);
    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: "No conversation for this booking yet",
      });
    }
    const full = await chatService.getConversationWithParticipants(conversation.id, actor);
    return res.json({ success: true, conversation: full });
  } catch (e: any) {
    return handle(res, e);
  }
};

export const getConversation = async (req: any, res: Response) => {
  try {
    const conversationId = positiveId(req.params.id, 'conversation id');
    const actor = await getActor(req);
    const { access } = await chatService.resolveAccessForConversation(actor, conversationId);
    if (!access.allowed) return res.status(403).json({ success: false, message: "Not allowed" });
    const full = await chatService.getConversationWithParticipants(conversationId, actor);
    if (!full) return res.status(404).json({ success: false, message: "Conversation not found" });
    return res.json({ success: true, conversation: full });
  } catch (e: any) {
    return handle(res, e);
  }
};

export const getMessages = async (req: any, res: Response) => {
  try {
    const conversationId = positiveId(req.params.id, 'conversation id');
    const rawLimit = req.query.limit === undefined ? 30 : Number(req.query.limit);
    if (!Number.isSafeInteger(rawLimit) || rawLimit < 1) throw chatService.httpError(400, 'Invalid message limit');
    const limit = Math.min(rawLimit, 100);
    const before = req.query.before === undefined ? undefined : positiveId(req.query.before, 'message cursor');
    const actor = await getActor(req);
    const result = await chatService.getMessages(actor, conversationId, limit, before);
    return res.json({ success: true, ...result });
  } catch (e: any) {
    return handle(res, e);
  }
};

export const sendMessage = async (req: any, res: Response) => {
  try {
    const conversationId = positiveId(req.params.id, 'conversation id');
    const actor = await getActor(req);
    const message = await chatService.sendMessage(actor, conversationId, {
      type: req.body?.type,
      body: req.body?.body,
      metadata: req.body?.metadata,
      clientMsgId: req.body?.clientMsgId,
      attachments: req.body?.attachments,
    });
    return res.status(201).json({ success: true, message });
  } catch (e: any) {
    return handle(res, e);
  }
};

export const editMessage = async (req: any, res: Response) => {
  try {
    const conversationId = positiveId(req.params.id, 'conversation id');
    const messageId = positiveId(req.params.msgId, 'message id');
    const actor = await getActor(req);
    const message = await chatService.editMessage(actor, conversationId, messageId, req.body?.body);
    return res.json({ success: true, message });
  } catch (e: any) {
    return handle(res, e);
  }
};

export const deleteMessage = async (req: any, res: Response) => {
  try {
    const conversationId = positiveId(req.params.id, 'conversation id');
    const messageId = positiveId(req.params.msgId, 'message id');
    const actor = await getActor(req);
    const message = await chatService.deleteMessage(actor, conversationId, messageId);
    return res.json({ success: true, message });
  } catch (e: any) {
    return handle(res, e);
  }
};

export const markRead = async (req: any, res: Response) => {
  try {
    const conversationId = positiveId(req.params.id, 'conversation id');
    const actor = await getActor(req);
    await chatService.markRead(actor, conversationId, positiveId(req.body?.lastReadMessageId, 'last read message id'));
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
    const { file, name, conversationId: rawConversationId } = req.body ?? {};

    // The validation, storage and naming now live in `chat.service`, so the v1
    // route and this one cannot disagree about what a chat attachment may be.
    // The response below is unchanged, byte for byte — four shipped clients
    // read it.
    //
    // `conversationId` stays OPTIONAL here on purpose. Omitting it skips the
    // access check, which is a hole; it is closed on the v1 route, which takes
    // the id in its path and cannot be called without one. Closing it here
    // instead would refuse uploads from installed builds that never sent it.
    const conversationId =
      rawConversationId !== undefined && rawConversationId !== null
        ? positiveId(rawConversationId, 'conversation id')
        : null;

    const result = await chatService.uploadAttachment(
      await getActor(req),
      conversationId,
      { file, name },
    );

    return res.status(201).json({ success: true, ...result });
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
    const conversationId = positiveId(req.params.id, 'conversation id');
    const messageId = positiveId(req.params.msgId, 'message id');
    const { category, description } = req.body ?? {};
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
    const conversationId = positiveId(req.params.id, 'conversation id');
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
