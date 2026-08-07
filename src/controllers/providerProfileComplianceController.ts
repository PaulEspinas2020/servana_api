import { Request, Response } from 'express';
import * as profileService from '../services/providerProfileComplianceService';
import * as contactService from '../services/providerContactChangeService';
import * as mediaService from '../services/providerProfileMediaService';

const uidOf = (req: Request): string => String(req.user?.uid ?? '');
const fail = (res: Response, error: any, fallback: string) => {
  const status = Number(error?.statusCode ?? 500);
  return res.status(status).json({
    status: 'failed',
    code: error?.code ?? (status === 500 ? 'PROFILE_COMPLIANCE_UNAVAILABLE' : 'REQUEST_REJECTED'),
    message: status === 500 ? fallback : String(error?.message ?? fallback),
    ...(error?.recovery ? { recovery: error.recovery } : {}),
    ...(typeof error?.retryable === 'boolean' ? { retryable: error.retryable } : {}),
  });
};

export const requestContactChange = async (req: Request, res: Response) => {
  try {
    const kind = String(req.body?.kind ?? '') as contactService.ContactKind;
    const data = await contactService.requestContactChange(uidOf(req), req.user, {
      kind,
      target: String(req.body?.target ?? ''),
      clientRequestId: String(req.body?.clientRequestId ?? ''),
    });
    return res.status(202).json({ status: 'success', data });
  } catch (error) {
    return fail(res, error, 'Contact change could not be started');
  }
};

export const confirmContactChange = async (req: Request, res: Response) => {
  try {
    const data = await contactService.confirmContactChange(uidOf(req), req.user, {
      requestId: String(req.body?.requestId ?? ''),
      code: String(req.body?.code ?? ''),
    });
    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    return fail(res, error, 'Contact change could not be confirmed');
  }
};

export const getProfilePhotoSubmissions = async (req: Request, res: Response) => {
  try {
    return res.status(200).json({ status: 'success', data: await mediaService.listProfilePhotos(uidOf(req)) });
  } catch (error) {
    return fail(res, error, 'Profile photo submissions are temporarily unavailable');
  }
};

export const getProfilePhotoPreview = async (req: Request, res: Response) => {
  try {
    return res.status(200).json({ status: 'success', data: await mediaService.previewProfilePhoto(uidOf(req), String(req.params.submissionId ?? '')) });
  } catch (error) {
    return fail(res, error, 'Profile photo preview is temporarily unavailable');
  }
};

export const getProfileCenter = async (req: Request, res: Response) => {
  try {
    return res.status(200).json({ status: 'success', data: await profileService.getProfileCenter(uidOf(req)) });
  } catch (error) {
    return fail(res, error, 'Profile and compliance information is temporarily unavailable');
  }
};

export const getFieldRegistry = (_req: Request, res: Response) =>
  res.status(200).json({ status: 'success', data: { version: 1, fields: profileService.PROFILE_FIELD_REGISTRY } });

export const getPublicProfilePreview = async (req: Request, res: Response) => {
  try {
    return res.status(200).json({ status: 'success', data: await profileService.getPublicProfile(uidOf(req)) });
  } catch (error) {
    return fail(res, error, 'Public profile preview is temporarily unavailable');
  }
};

export const submitPublicProfileRevision = async (req: Request, res: Response) => {
  try {
    const clientRequestId = String(req.body?.clientRequestId ?? '');
    const fields = req.body?.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      return res.status(400).json({ status: 'failed', code: 'INVALID_FIELDS', message: 'fields object is required' });
    }
    const data = await profileService.submitPublicProfileRevision(uidOf(req), { clientRequestId, fields });
    return res.status(201).json({ status: 'success', data });
  } catch (error) {
    return fail(res, error, 'Public profile revision could not be submitted');
  }
};

export const getDocumentCatalog = (_req: Request, res: Response) =>
  res.status(200).json({ status: 'success', data: { version: 1, documentTypes: profileService.DOCUMENT_TYPE_CATALOG } });

export const getDocuments = async (req: Request, res: Response) => {
  try {
    return res.status(200).json({ status: 'success', data: await profileService.listDocuments(uidOf(req)) });
  } catch (error) {
    return fail(res, error, 'Documents are temporarily unavailable');
  }
};

export const uploadDocument = async (req: Request, res: Response) => {
  try {
    const replacement = req.body?.replacementForId == null ? null : Number(req.body.replacementForId);
    if (replacement != null && (!Number.isInteger(replacement) || replacement <= 0)) {
      return res.status(400).json({ status: 'failed', code: 'INVALID_REPLACEMENT', message: 'replacementForId is invalid' });
    }
    const data = await profileService.uploadDocument(uidOf(req), {
      documentTypeId: String(req.body?.documentTypeId ?? ''),
      fileName: String(req.body?.fileName ?? ''),
      file: String(req.body?.file ?? ''),
      clientRequestId: String(req.body?.clientRequestId ?? ''),
      issueDate: req.body?.issueDate == null ? null : String(req.body.issueDate),
      expiresAt: req.body?.expiresAt == null ? null : String(req.body.expiresAt),
      identifierLast4: req.body?.identifierLast4 == null ? null : String(req.body.identifierLast4),
      replacementForId: replacement,
    });
    return res.status(201).json({ status: 'success', data });
  } catch (error) {
    return fail(res, error, 'Document could not be submitted');
  }
};

export const getDocumentPreview = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.documentId);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ status: 'failed', message: 'Document not found' });
    return res.status(200).json({ status: 'success', data: await profileService.getDocumentPreview(uidOf(req), id) });
  } catch (error) {
    return fail(res, error, 'Document preview is temporarily unavailable');
  }
};

export const getCertifications = async (req: Request, res: Response) => {
  try {
    return res.status(200).json({ status: 'success', data: await profileService.listCertifications(uidOf(req)) });
  } catch (error) {
    return fail(res, error, 'Certifications are temporarily unavailable');
  }
};

export const submitCertification = async (req: Request, res: Response) => {
  try {
    const relatedDocumentId = Number(req.body?.relatedDocumentId);
    if (!Number.isInteger(relatedDocumentId) || relatedDocumentId <= 0) {
      return res.status(400).json({ status: 'failed', code: 'INVALID_DOCUMENT', message: 'A provider-owned related document is required' });
    }
    const data = await profileService.submitCertification(uidOf(req), {
      certificationType: String(req.body?.certificationType ?? ''),
      issuingAuthority: String(req.body?.issuingAuthority ?? ''),
      credentialLast4: req.body?.credentialLast4 == null ? null : String(req.body.credentialLast4),
      issueDate: req.body?.issueDate == null ? null : String(req.body.issueDate),
      expiresAt: req.body?.expiresAt == null ? null : String(req.body.expiresAt),
      relatedDocumentId,
      renewalOfId: req.body?.renewalOfId == null ? null : String(req.body.renewalOfId),
      clientRequestId: String(req.body?.clientRequestId ?? ''),
    });
    return res.status(201).json({ status: 'success', data });
  } catch (error) {
    return fail(res, error, 'Certification could not be submitted');
  }
};

export const getCompliance = async (req: Request, res: Response) => {
  try {
    return res.status(200).json({ status: 'success', data: await profileService.calculateCompliance(uidOf(req)) });
  } catch (error) {
    return fail(res, error, 'Compliance information is temporarily unavailable');
  }
};

export const getVerificationTimeline = async (req: Request, res: Response) => {
  try {
    return res.status(200).json({ status: 'success', data: await profileService.getVerificationTimeline(uidOf(req)) });
  } catch (error) {
    return fail(res, error, 'Verification history is temporarily unavailable');
  }
};
