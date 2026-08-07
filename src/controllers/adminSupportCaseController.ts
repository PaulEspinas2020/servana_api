import { Request, Response } from 'express';
import * as support from '../services/adminSupportCaseService';

const uid = (req: Request) => String(req.user?.uid ?? '');
const sendError = (res: Response, error: any) => res.status(error?.statusCode ?? 500).json({
  status: 'failed',
  code: error?.code ?? 'SERVER_ERROR',
  message: error?.statusCode && error.statusCode < 500
    ? error.message
    : 'Support operations are temporarily unavailable.',
});

export const list = async (req: Request, res: Response) => {
  try { return res.json({ status: 'success', data: await support.listAdminCases(req.query) }); }
  catch (error) { return sendError(res, error); }
};
export const detail = async (req: Request, res: Response) => {
  try { return res.json({ status: 'success', data: await support.getAdminCase(String(req.params.caseId)) }); }
  catch (error) { return sendError(res, error); }
};
export const reply = async (req: Request, res: Response) => {
  try { return res.json({ status: 'success', data: await support.addAdminMessage(uid(req), String(req.params.caseId), req.body) }); }
  catch (error) { return sendError(res, error); }
};
export const note = async (req: Request, res: Response) => {
  try { return res.status(201).json({ status: 'success', data: await support.addInternalNote(uid(req), String(req.params.caseId), req.body) }); }
  catch (error) { return sendError(res, error); }
};
export const transition = async (req: Request, res: Response) => {
  try { return res.json({ status: 'success', data: await support.transitionCase(uid(req), String(req.params.caseId), req.body) }); }
  catch (error) { return sendError(res, error); }
};
export const escalate = async (req: Request, res: Response) => {
  try { return res.json({ status: 'success', data: await support.escalateCase(uid(req), String(req.params.caseId), req.body) }); }
  catch (error) { return sendError(res, error); }
};
export const resolve = async (req: Request, res: Response) => {
  try { return res.json({ status: 'success', data: await support.resolveCase(uid(req), String(req.params.caseId), req.body) }); }
  catch (error) { return sendError(res, error); }
};
export const decideAppeal = async (req: Request, res: Response) => {
  try { return res.json({ status: 'success', data: await support.decideAppeal(uid(req), String(req.params.caseId), String(req.params.appealId), req.body) }); }
  catch (error) { return sendError(res, error); }
};
export const preview = async (req: Request, res: Response) => {
  try { return res.json({ status: 'success', data: await support.previewAdminAttachment(uid(req), String(req.params.caseId), String(req.params.attachmentId)) }); }
  catch (error) { return sendError(res, error); }
};
export const sweepSla = async (req: Request, res: Response) => {
  try { return res.json({ status: 'success', data: await support.sweepBreachedCases(uid(req)) }); }
  catch (error) { return sendError(res, error); }
};
