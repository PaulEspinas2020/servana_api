import { Router } from "express";
import * as chat from "./chat.controller";
import verifyAuth from "../middleware/verifyAuth";

const router = Router();

// All chat routes require an authenticated user.
router.use(verifyAuth);

// Inbox
router.get("/chat/conversations", chat.listConversations);

// Get/create the conversation tied to a booking
router.get("/bookings/:bookingId/conversation", chat.getBookingConversation);

// Conversation detail + messages
router.get("/chat/conversations/:id", chat.getConversation);
router.get("/chat/conversations/:id/messages", chat.getMessages);
router.post("/chat/conversations/:id/messages", chat.sendMessage);
router.patch("/chat/conversations/:id/messages/:msgId", chat.editMessage);
router.delete("/chat/conversations/:id/messages/:msgId", chat.deleteMessage);

// State
router.post("/chat/conversations/:id/read", chat.markRead);
router.post("/chat/conversations/:id/close", chat.closeConversation);

export default router;
