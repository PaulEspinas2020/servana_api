import { Router } from "express";
import verifyAuth from "../middleware/verifyAuth";
import * as ctrl from "../controllers/customerSupportController";
import { ensureCustomerSupportTables } from "../services/customerSupportService";

// Ensure tables exist at module load time so the first request isn't slow
ensureCustomerSupportTables().catch(console.error);

const router = Router();

// Support tickets
router.get ('/support/unread-count',                    verifyAuth, ctrl.getUnreadCount);
router.get ('/support/tickets',                         verifyAuth, ctrl.listTickets);
router.post('/support/tickets',                         verifyAuth, ctrl.createTicket);
router.get ('/support/tickets/:ticketKey',              verifyAuth, ctrl.getTicketDetail);
router.post('/support/tickets/:ticketKey/replies',      verifyAuth, ctrl.addReply);
router.post('/support/tickets/:ticketKey/mark-read',    verifyAuth, ctrl.markRead);
router.post('/support/tickets/:ticketKey/close',        verifyAuth, ctrl.closeTicket);
router.post('/support/tickets/:ticketKey/reopen',       verifyAuth, ctrl.reopenTicket);

// Safety incidents
router.get ('/support/safety/emergency-config',         verifyAuth, ctrl.getEmergencyConfig);
router.get ('/support/safety/incidents',                verifyAuth, ctrl.listSafetyIncidents);
router.post('/support/safety/incidents',                verifyAuth, ctrl.submitSafetyIncident);

export default router;
