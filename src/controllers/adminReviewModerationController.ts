import { Request, Response } from 'express';
import {
  decideModerationCase, decideResponseModerationCase, getProviderReputationSummary,
  listModerationCases, listOwnedProviderReviews, listResponseModerationCases,
} from '../services/providerReputationService';

const sendError = (res: Response, error: any) => res.status(error?.statusCode ?? error?.status ?? 500).json({
  status: 'failed', code: error?.code ?? 'SERVER_ERROR',
  message: (error?.statusCode ?? error?.status) && (error.statusCode ?? error.status) < 500 ? error.message : 'Server error',
});

export const list = async (req: Request, res: Response) => {
  try { return res.json({ status: 'success', data: await listModerationCases(req.query) }); }
  catch (error) { return sendError(res, error); }
};

export const decide = async (req: Request, res: Response) => {
  try {
    return res.json({ status: 'success', data: await decideModerationCase(req.user!.uid, String(req.params.caseId), req.body) });
  } catch (error) { return sendError(res, error); }
};

export const listResponses = async (req: Request, res: Response) => {
  try { return res.json({ status: 'success', data: await listResponseModerationCases(req.query) }); }
  catch (error) { return sendError(res, error); }
};

export const decideResponse = async (req: Request, res: Response) => {
  try {
    return res.json({ status: 'success', data: await decideResponseModerationCase(req.user!.uid, String(req.params.caseId), req.body) });
  } catch (error) { return sendError(res, error); }
};

export const providerSummary = async (req: Request, res: Response) => {
  try { return res.json({ status: 'success', data: await getProviderReputationSummary(String(req.params.uid)) }); }
  catch (error) { return sendError(res, error); }
};

export const providerReviews = async (req: Request, res: Response) => {
  try { return res.json({ status: 'success', data: await listOwnedProviderReviews(String(req.params.uid), req.query) }); }
  catch (error) { return sendError(res, error); }
};
