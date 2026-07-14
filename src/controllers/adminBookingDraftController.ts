import { Request, Response } from 'express';
import {
  createDraft,
  getDraft,
  patchDraft,
  listDrafts,
  discardDraft,
  convertDraft,
  calcDraftCompletion,
  type DraftListFilters,
} from '../services/adminBookingDraftService';

// ── POST /admin/booking-drafts ────────────────────────────────────────────────

export const createAdminBookingDraft = async (req: Request, res: Response): Promise<void> => {
  try {
    const adminUid: string = (req as any).user?.uid;
    const draft = await createDraft(adminUid);
    res.status(201).json({ success: true, data: draft });
  } catch (err: any) {
    const status = err?.statusCode ?? 500;
    res.status(status).json({ success: false, error: { message: err?.message ?? 'Failed to create draft' } });
  }
};

// ── GET /admin/booking-drafts ─────────────────────────────────────────────────

export const listAdminBookingDrafts = async (req: Request, res: Response): Promise<void> => {
  try {
    const adminUid: string = (req as any).user?.uid;

    const rawStatus = req.query['status'] as string | string[] | undefined;
    let statusFilter: DraftListFilters['status'] = ['editing', 'ready_for_review'];
    if (rawStatus) {
      const parts = (Array.isArray(rawStatus) ? rawStatus : [rawStatus])
        .flatMap((s: string) => s.split(',')) as DraftListFilters['status'];
      if (parts?.length) statusFilter = parts;
    }

    const filters: DraftListFilters = {
      adminUid,
      status: statusFilter,
      search:  req.query['search']  ? String(req.query['search'] as string)  : undefined,
      page:    req.query['page']    ? Number(req.query['page'] as string)    : 1,
      limit:   req.query['limit']   ? Math.min(Number(req.query['limit'] as string), 50) : 25,
    };

    const { rows, total } = await listDrafts(filters);
    const page  = filters.page ?? 1;
    const limit = filters.limit ?? 25;

    res.json({
      success: true,
      data:    rows,
      meta:    { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err: any) {
    const status = err?.statusCode ?? 500;
    res.status(status).json({ success: false, error: { message: err?.message ?? 'Failed to list drafts' } });
  }
};

// ── GET /admin/booking-drafts/:draftId ───────────────────────────────────────

export const getAdminBookingDraft = async (req: Request, res: Response): Promise<void> => {
  try {
    const adminUid: string = (req as any).user?.uid;
    const draftId = req.params['draftId'] as string;
    const draft = await getDraft(draftId, adminUid);
    if (!draft) {
      res.status(404).json({ success: false, error: { message: 'Draft not found' } });
      return;
    }
    res.json({ success: true, data: { ...draft, completionPct: calcDraftCompletion(draft) } });
  } catch (err: any) {
    const status = err?.statusCode ?? 500;
    res.status(status).json({ success: false, error: { message: err?.message ?? 'Failed to get draft' } });
  }
};

// ── PATCH /admin/booking-drafts/:draftId ─────────────────────────────────────

export const patchAdminBookingDraft = async (req: Request, res: Response): Promise<void> => {
  try {
    const adminUid: string = (req as any).user?.uid;
    const draftId = req.params['draftId'] as string;
    const sections = req.body ?? {};
    const result = await patchDraft(draftId, adminUid, sections);
    res.json({ success: true, data: result });
  } catch (err: any) {
    const status = err?.statusCode ?? 500;
    res.status(status).json({ success: false, error: { code: err?.code, message: err?.message ?? 'Failed to save draft' } });
  }
};

// ── DELETE /admin/booking-drafts/:draftId ────────────────────────────────────

export const discardAdminBookingDraft = async (req: Request, res: Response): Promise<void> => {
  try {
    const adminUid: string = (req as any).user?.uid;
    const draftId = req.params['draftId'] as string;
    const { reason } = req.body ?? {};
    await discardDraft(draftId, adminUid, reason);
    res.json({ success: true });
  } catch (err: any) {
    const status = err?.statusCode ?? 500;
    res.status(status).json({ success: false, error: { code: err?.code, message: err?.message ?? 'Failed to discard draft' } });
  }
};

// ── POST /admin/booking-drafts/:draftId/convert ───────────────────────────────

export const convertAdminBookingDraft = async (req: Request, res: Response): Promise<void> => {
  try {
    const adminUid: string = (req as any).user?.uid;
    const draftId = req.params['draftId'] as string;
    const { idempotencyKey } = req.body ?? {};

    if (!idempotencyKey || typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
      res.status(400).json({ success: false, error: { message: 'idempotencyKey is required' } });
      return;
    }

    const result = await convertDraft(draftId, adminUid, idempotencyKey.trim());
    res.status(201).json({ success: true, data: result });
  } catch (err: any) {
    const status = err?.statusCode ?? 500;
    res.status(status).json({ success: false, error: { code: err?.code, message: err?.message ?? 'Draft conversion failed' } });
  }
};
