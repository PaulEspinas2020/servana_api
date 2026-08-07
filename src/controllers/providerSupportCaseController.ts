import { Request, Response } from 'express';
import * as support from '../services/providerSupportCaseService';

const uid = (req: Request) => String(req.user?.uid ?? '');
const sendError = (res: Response, error: any) => res.status(error?.statusCode ?? 500).json({
  status: 'failed', code: error?.code ?? 'SERVER_ERROR',
  message: error?.statusCode && error.statusCode < 500 ? error.message : 'Support service is temporarily unavailable.',
  ...(error?.data ? { data: error.data } : {}),
});

export const categories = async (_req: Request, res: Response) => {
  try { return res.json({ status: 'success', data: await support.listCategories() }); }
  catch (error) { return sendError(res, error); }
};
export const list = async (req: Request, res: Response) => {
  try { return res.json({ status: 'success', data: await support.listCases(uid(req), req.query) }); }
  catch (error) { return sendError(res, error); }
};
export const detail = async (req: Request, res: Response) => {
  try { return res.json({ status: 'success', data: await support.getCase(uid(req), String(req.params.caseId)) }); }
  catch (error) { return sendError(res, error); }
};
export const create = async (req: Request, res: Response) => {
  try {
    const data = await support.createCase(uid(req), req.body);
    return res.status(data.duplicate ? 200 : 201).json({ status: 'success', data });
  } catch (error) { return sendError(res, error); }
};
export const reply = async (req: Request, res: Response) => {
  try { return res.json({ status: 'success', data: await support.addProviderMessage(uid(req), String(req.params.caseId), req.body) }); }
  catch (error) { return sendError(res, error); }
};
export const withdraw = async (req: Request, res: Response) => {
  try { return res.json({ status: 'success', data: await support.withdrawCase(uid(req), String(req.params.caseId), req.body) }); }
  catch (error) { return sendError(res, error); }
};
export const reopen = async (req: Request, res: Response) => {
  try { return res.json({ status: 'success', data: await support.reopenCase(uid(req), String(req.params.caseId), req.body) }); }
  catch (error) { return sendError(res, error); }
};
export const appeal = async (req: Request, res: Response) => {
  try { return res.status(201).json({ status: 'success', data: await support.appealCase(uid(req), String(req.params.caseId), req.body) }); }
  catch (error) { return sendError(res, error); }
};
export const upload = async (req: Request, res: Response) => {
  try { return res.status(201).json({ status: 'success', data: await support.uploadAttachment(uid(req), String(req.params.caseId), req.body) }); }
  catch (error) { return sendError(res, error); }
};
export const preview = async (req: Request, res: Response) => {
  try { return res.json({ status: 'success', data: await support.previewAttachment(uid(req), String(req.params.caseId), String(req.params.attachmentId)) }); }
  catch (error) { return sendError(res, error); }
};
