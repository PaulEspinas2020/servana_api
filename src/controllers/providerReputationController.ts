import { Request, Response } from 'express';
import {
  appealOwnedReview,
  getOwnedProviderReview,
  getProviderReputationSummary,
  listOwnedProviderReviews,
  reportOwnedReview,
  submitProviderResponse,
} from '../services/providerReputationService';

const uid = (req: Request) => req.user?.uid as string;
const sendError = (res: Response, error: any) => res.status(error?.statusCode ?? error?.status ?? 500).json({
  status: 'failed', code: error?.code ?? 'SERVER_ERROR',
  message: (error?.statusCode ?? error?.status) && (error.statusCode ?? error.status) < 500 ? error.message : 'Server error',
});

export const summary = async (req: Request, res: Response) => {
  try { return res.json({ status: 'success', data: await getProviderReputationSummary(uid(req)) }); }
  catch (error) { return sendError(res, error); }
};

export const list = async (req: Request, res: Response) => {
  try { return res.json({ status: 'success', data: await listOwnedProviderReviews(uid(req), req.query) }); }
  catch (error) { return sendError(res, error); }
};

export const detail = async (req: Request, res: Response) => {
  try { return res.json({ status: 'success', data: await getOwnedProviderReview(uid(req), String(req.params.reviewId)) }); }
  catch (error) { return sendError(res, error); }
};

export const respond = async (req: Request, res: Response) => {
  try { return res.status(201).json({ status: 'success', data: await submitProviderResponse(uid(req), String(req.params.reviewId), req.body) }); }
  catch (error) { return sendError(res, error); }
};

export const report = async (req: Request, res: Response) => {
  try { return res.status(201).json({ status: 'success', data: await reportOwnedReview(uid(req), String(req.params.reviewId), req.body) }); }
  catch (error) { return sendError(res, error); }
};

export const appeal = async (req: Request, res: Response) => {
  try { return res.status(201).json({ status: 'success', data: await appealOwnedReview(uid(req), String(req.params.caseId), req.body) }); }
  catch (error) { return sendError(res, error); }
};
