import { Request, Response } from 'express';
import * as svc from '../services/adminOnboardingService';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ok = (res: Response, data: any, meta?: any) =>
  res.status(200).json({ status: 'success', data, ...(meta ? { meta } : {}) });

const created = (res: Response, data: any) =>
  res.status(201).json({ status: 'success', data });

const fail = (res: Response, status: number, message: string) =>
  res.status(status).json({ status: 'failed', message });

const actorUid = (req: Request): string => req.user?.uid ?? '';

const parseIntQ = (val: any, fallback: number) => {
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
};

// ── Queue Summary ─────────────────────────────────────────────────────────────

export const getQueueSummary = async (_req: Request, res: Response) => {
  try {
    const summary = await svc.getQueueSummary();
    return ok(res, summary);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch queue summary');
  }
};

// ── Case List ─────────────────────────────────────────────────────────────────

export const listCases = async (req: Request, res: Response) => {
  try {
    const {
      status, priority, assigned_reviewer, waiting_party, search,
    } = req.query;
    const page = parseIntQ(req.query.page, 1);
    const limit = Math.min(parseIntQ(req.query.limit, 50), 200);

    const result = await svc.listCases({
      status: status as string | undefined,
      priority: priority as string | undefined,
      assignedReviewer: assigned_reviewer as string | undefined,
      waitingParty: waiting_party as string | undefined,
      search: search as string | undefined,
      page,
      limit,
    });

    return ok(res, result.rows, {
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: Math.ceil(result.total / result.limit),
    });
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch cases');
  }
};

// ── Case Detail ───────────────────────────────────────────────────────────────

export const getCaseDetail = async (req: Request, res: Response) => {
  try {
    const caseId = String(req.params.caseId);
    const detail = await svc.getCaseDetail(caseId);
    if (!detail) return fail(res, 404, 'Case not found');
    return ok(res, detail);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch case detail');
  }
};

// ── Assign Case ───────────────────────────────────────────────────────────────

export const assignCase = async (req: Request, res: Response) => {
  try {
    const caseId = String(req.params.caseId);
    const { reviewer_uid, reason } = req.body as { reviewer_uid?: string | null; reason?: string };
    const result = await svc.assignCase(
      caseId,
      reviewer_uid ?? null,
      actorUid(req),
      reason,
    );
    return ok(res, result);
  } catch (err: any) {
    return fail(res, 400, err?.message ?? 'Failed to assign case');
  }
};

// ── Set Priority ──────────────────────────────────────────────────────────────

export const setPriority = async (req: Request, res: Response) => {
  try {
    const caseId = String(req.params.caseId);
    const { priority } = req.body as { priority: string };
    if (!priority) return fail(res, 400, 'priority is required');
    const result = await svc.setPriority(caseId, priority, actorUid(req));
    return ok(res, result);
  } catch (err: any) {
    return fail(res, 400, err?.message ?? 'Failed to set priority');
  }
};

// ── Move Case (state transition) ──────────────────────────────────────────────

export const moveCase = async (req: Request, res: Response) => {
  try {
    const caseId = String(req.params.caseId);
    const { to_status, expected_version, reason } = req.body as {
      to_status: string;
      expected_version: number;
      reason?: string;
    };
    if (!to_status) return fail(res, 400, 'to_status is required');
    if (expected_version === undefined || expected_version === null) {
      return fail(res, 400, 'expected_version is required');
    }
    const result = await svc.moveCase(caseId, to_status, expected_version, actorUid(req), reason);
    return ok(res, result);
  } catch (err: any) {
    const status = (err as any)?.statusCode ?? 400;
    return fail(res, status, err?.message ?? 'Failed to move case');
  }
};

// ── Readiness ─────────────────────────────────────────────────────────────────

export const getCaseReadiness = async (req: Request, res: Response) => {
  try {
    // caseId query param → look up providerUid; or pass providerUid directly via :caseId
    const caseId = String(req.params.caseId);
    // calculateReadiness accepts a providerUid, not a case UUID — resolve it
    const caseRes = await svc.getCaseDetail(caseId);
    const providerUid = (caseRes as any)?.providerUid ?? caseId;
    const readiness = await svc.calculateReadiness(providerUid);
    return ok(res, readiness);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to calculate readiness');
  }
};

// ── Requirement Decisions ─────────────────────────────────────────────────────

export const approveRequirement = async (req: Request, res: Response) => {
  try {
    const id = parseIntQ(req.params.id, 0);
    if (!id) return fail(res, 400, 'Invalid requirement id');
    const { reason_code, provider_message, internal_rationale } = req.body as Record<string, any>;
    const result = await svc.decideRequirement(id, 'approved', actorUid(req), {
      reasonCode: reason_code,
      providerMessage: provider_message,
      internalRationale: internal_rationale,
    });
    return ok(res, result);
  } catch (err: any) {
    return fail(res, 400, err?.message ?? 'Failed to approve requirement');
  }
};

export const rejectRequirement = async (req: Request, res: Response) => {
  try {
    const id = parseIntQ(req.params.id, 0);
    if (!id) return fail(res, 400, 'Invalid requirement id');
    const { reason_code, provider_message, internal_rationale } = req.body as Record<string, any>;
    if (!reason_code && !provider_message) {
      return fail(res, 400, 'reason_code or provider_message is required for rejection');
    }
    const result = await svc.decideRequirement(id, 'rejected', actorUid(req), {
      reasonCode: reason_code,
      providerMessage: provider_message,
      internalRationale: internal_rationale,
    });
    return ok(res, result);
  } catch (err: any) {
    return fail(res, 400, err?.message ?? 'Failed to reject requirement');
  }
};

export const requestResubmission = async (req: Request, res: Response) => {
  try {
    const id = parseIntQ(req.params.id, 0);
    if (!id) return fail(res, 400, 'Invalid requirement id');
    const { reason_code, provider_message, internal_rationale } = req.body as Record<string, any>;
    if (!provider_message) {
      return fail(res, 400, 'provider_message is required when requesting resubmission');
    }
    const result = await svc.decideRequirement(id, 'needs_resubmission', actorUid(req), {
      reasonCode: reason_code,
      providerMessage: provider_message,
      internalRationale: internal_rationale,
    });
    return ok(res, result);
  } catch (err: any) {
    return fail(res, 400, err?.message ?? 'Failed to request resubmission');
  }
};

// ── Final Approval / Rejection ────────────────────────────────────────────────

export const finalApproveProvider = async (req: Request, res: Response) => {
  try {
    const caseId = String(req.params.caseId);
    const { expected_version, provider_message } = req.body as Record<string, any>;
    if (expected_version === undefined || expected_version === null) {
      return fail(res, 400, 'expected_version is required');
    }
    const result = await svc.finalApproveProvider(
      caseId,
      Number(expected_version),
      actorUid(req),
      provider_message,
    );
    return ok(res, result);
  } catch (err: any) {
    const status = (err as any)?.statusCode ?? 400;
    return fail(res, status, err?.message ?? 'Failed to approve provider');
  }
};

export const finalRejectProvider = async (req: Request, res: Response) => {
  try {
    const caseId = String(req.params.caseId);
    const { expected_version, reason_code, provider_message, internal_rationale } =
      req.body as Record<string, any>;
    if (expected_version === undefined || expected_version === null) {
      return fail(res, 400, 'expected_version is required');
    }
    if (!reason_code && !provider_message) {
      return fail(res, 400, 'reason_code or provider_message is required for final rejection');
    }
    const result = await svc.finalRejectProvider(
      caseId,
      Number(expected_version),
      actorUid(req),
      reason_code ?? '',
      provider_message ?? '',
      internal_rationale,
    );
    return ok(res, result);
  } catch (err: any) {
    const status = (err as any)?.statusCode ?? 400;
    return fail(res, status, err?.message ?? 'Failed to reject provider');
  }
};

// ── Timeline ──────────────────────────────────────────────────────────────────

export const getTimeline = async (req: Request, res: Response) => {
  try {
    const caseId = String(req.params.caseId);
    const limit = Math.min(parseIntQ(req.query.limit, 50), 200);
    const events = await svc.getTimeline(caseId, limit);
    return ok(res, events);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch timeline');
  }
};

// ── Notes ─────────────────────────────────────────────────────────────────────

export const getCaseNotes = async (req: Request, res: Response) => {
  try {
    const caseId = String(req.params.caseId);
    const includeInternal = req.query.include_internal !== 'false';
    const notes = await svc.getNotes(caseId, includeInternal);
    return ok(res, notes);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch notes');
  }
};

export const addCaseNote = async (req: Request, res: Response) => {
  try {
    const caseId = String(req.params.caseId);
    const { body, note_type } = req.body as Record<string, any>;
    if (!body || !String(body).trim()) return fail(res, 400, 'Note body is required');
    const validTypes = ['internal', 'provider_message', 'escalation'];
    const noteType: 'internal' | 'provider_message' | 'escalation' =
      validTypes.includes(note_type) ? note_type : 'internal';
    const note = await svc.addNote(caseId, actorUid(req), String(body).trim(), noteType);
    return created(res, note);
  } catch (err: any) {
    return fail(res, 400, err?.message ?? 'Failed to add note');
  }
};

// ── Reason Codes ──────────────────────────────────────────────────────────────

export const getReasonCodes = async (req: Request, res: Response) => {
  try {
    const domain = req.query.domain as string | undefined;
    const codes = await svc.getReasonCodes(domain);
    return ok(res, codes);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch reason codes');
  }
};
