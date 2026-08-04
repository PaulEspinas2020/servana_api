import { Request, Response } from "express";
import * as svc from "../services/customerSupportService";

// ─── Support tickets ──────────────────────────────────────────────────────────

export async function listTickets(req: Request, res: Response) {
  try {
    const uid = req.user?.uid as string;
    if (!uid) return res.status(401).json({ status: 'failed', message: 'Unauthorized' });
    const tickets = await svc.listCustomerTickets(uid);
    return res.json({ status: 'success', data: tickets });
  } catch (err) {
    console.error('listTickets', err);
    return res.status(500).json({ status: 'failed', message: 'Could not load tickets' });
  }
}

export async function createTicket(req: Request, res: Response) {
  try {
    const uid = req.user?.uid as string;
    if (!uid) return res.status(401).json({ status: 'failed', message: 'Unauthorized' });

    const { subject, description, category, clientRequestId, bookingId } = req.body as Record<string, string>;
    if (!subject?.trim() || !description?.trim()) {
      return res.status(400).json({ status: 'failed', message: 'subject and description are required' });
    }
    if (description.trim().length < 10) {
      return res.status(400).json({ status: 'failed', message: 'description must be at least 10 characters' });
    }

    const ticket = await svc.createCustomerTicket(
      uid,
      subject.trim(),
      description.trim(),
      (category || 'other').toLowerCase(),
      clientRequestId?.trim() || null,
      bookingId?.trim() || null,
    );
    return res.status(201).json({ status: 'success', data: ticket });
  } catch (err) {
    console.error('createTicket', err);
    return res.status(500).json({ status: 'failed', message: 'Could not create ticket' });
  }
}

export async function getTicketDetail(req: Request, res: Response) {
  try {
    const uid = req.user?.uid as string;
    if (!uid) return res.status(401).json({ status: 'failed', message: 'Unauthorized' });

    const { ticketKey } = req.params as Record<string, string>;
    const detail = await svc.getCustomerTicketDetail(uid, ticketKey);
    if (!detail) {
      return res.status(404).json({ status: 'failed', message: 'Ticket not found' });
    }
    return res.json({ status: 'success', data: detail });
  } catch (err) {
    console.error('getTicketDetail', err);
    return res.status(500).json({ status: 'failed', message: 'Could not load ticket' });
  }
}

export async function addReply(req: Request, res: Response) {
  try {
    const uid = req.user?.uid as string;
    if (!uid) return res.status(401).json({ status: 'failed', message: 'Unauthorized' });

    const { ticketKey } = req.params as Record<string, string>;
    const { message } = req.body as { message?: string };
    if (!message?.trim() || message.trim().length < 2) {
      return res.status(400).json({ status: 'failed', message: 'message is required' });
    }

    const result = await svc.addCustomerTicketReply(uid, ticketKey, message.trim());
    if (!result) {
      return res.status(404).json({ status: 'failed', message: 'Ticket not found' });
    }
    if ('error' in result) {
      return res.status(409).json({ status: 'failed', message: result.error });
    }
    return res.json({ status: 'success', data: result });
  } catch (err) {
    console.error('addReply', err);
    return res.status(500).json({ status: 'failed', message: 'Could not send reply' });
  }
}

export async function markRead(req: Request, res: Response) {
  try {
    const uid = req.user?.uid as string;
    if (!uid) return res.status(401).json({ status: 'failed', message: 'Unauthorized' });
    const { ticketKey } = req.params as Record<string, string>;
    await svc.markCustomerTicketRead(uid, ticketKey);
    return res.json({ status: 'success' });
  } catch (err) {
    console.error('markRead', err);
    return res.status(500).json({ status: 'failed', message: 'Could not mark read' });
  }
}

export async function closeTicket(req: Request, res: Response) {
  try {
    const uid = req.user?.uid as string;
    if (!uid) return res.status(401).json({ status: 'failed', message: 'Unauthorized' });

    const { ticketKey } = req.params as Record<string, string>;
    const result = await svc.closeCustomerTicket(uid, ticketKey);
    if (!result) {
      return res.status(404).json({ status: 'failed', message: 'Ticket not found or cannot be closed' });
    }
    return res.json({ status: 'success', data: result });
  } catch (err) {
    console.error('closeTicket', err);
    return res.status(500).json({ status: 'failed', message: 'Could not close ticket' });
  }
}

export async function reopenTicket(req: Request, res: Response) {
  try {
    const uid = req.user?.uid as string;
    if (!uid) return res.status(401).json({ status: 'failed', message: 'Unauthorized' });

    const { ticketKey } = req.params as Record<string, string>;
    const result = await svc.reopenCustomerTicket(uid, ticketKey);
    if (!result) {
      return res.status(404).json({ status: 'failed', message: 'Ticket not found or not eligible for reopen' });
    }
    return res.json({ status: 'success', data: result });
  } catch (err) {
    console.error('reopenTicket', err);
    return res.status(500).json({ status: 'failed', message: 'Could not reopen ticket' });
  }
}

export async function getUnreadCount(req: Request, res: Response) {
  try {
    const uid = req.user?.uid as string;
    if (!uid) return res.status(401).json({ status: 'failed', message: 'Unauthorized' });
    const count = await svc.countUnreadCustomerReplies(uid);
    return res.json({ status: 'success', data: { count } });
  } catch (err) {
    console.error('getUnreadCount', err);
    return res.status(500).json({ status: 'failed', message: 'Could not get unread count' });
  }
}

// ─── Safety incidents ─────────────────────────────────────────────────────────

export async function getEmergencyConfig(req: Request, res: Response) {
  try {
    const uid = req.user?.uid as string;
    if (!uid) return res.status(401).json({ status: 'failed', message: 'Unauthorized' });
    return res.json({ status: 'success', data: svc.getEmergencyConfig() });
  } catch (err) {
    console.error('getEmergencyConfig', err);
    return res.status(500).json({ status: 'failed', message: 'Could not load emergency config' });
  }
}

export async function listSafetyIncidents(req: Request, res: Response) {
  try {
    const uid = req.user?.uid as string;
    if (!uid) return res.status(401).json({ status: 'failed', message: 'Unauthorized' });
    const incidents = await svc.listCustomerSafetyIncidents(uid);
    return res.json({ status: 'success', data: incidents });
  } catch (err) {
    console.error('listSafetyIncidents', err);
    return res.status(500).json({ status: 'failed', message: 'Could not load safety incidents' });
  }
}

export async function submitSafetyIncident(req: Request, res: Response) {
  try {
    const uid = req.user?.uid as string;
    if (!uid) return res.status(401).json({ status: 'failed', message: 'Unauthorized' });

    const {
      clientIncidentId,
      category,
      severity,
      description,
      bookingId,
      immediateDanger,
    } = req.body as Record<string, unknown>;

    if (!clientIncidentId || !category || !severity || !description) {
      return res.status(400).json({ status: 'failed', message: 'clientIncidentId, category, severity, and description are required' });
    }
    if (String(description).trim().length < 10) {
      return res.status(400).json({ status: 'failed', message: 'description must be at least 10 characters' });
    }

    const result = await svc.submitCustomerSafetyIncident({
      customerUid:      uid,
      clientIncidentId: String(clientIncidentId).substring(0, 128),
      category:         String(category).substring(0, 64),
      severity:         String(severity).substring(0, 32),
      description:      String(description).trim(),
      bookingId:        bookingId ? String(bookingId) : null,
      immediateDanger:  immediateDanger === true,
    });

    if (result.duplicate) {
      return res.status(409).json({ status: 'failed', message: 'This incident has already been submitted', data: { caseKey: result.caseKey } });
    }
    return res.status(201).json({ status: 'success', data: result });
  } catch (err) {
    console.error('submitSafetyIncident', err);
    return res.status(500).json({ status: 'failed', message: 'Could not submit safety report' });
  }
}
