import { Router } from 'express';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import * as ctrl from '../controllers/adminCommunicationController';

const router = Router();
const adminOnly = [verifyAuth, verifyRoles([1])];

// Summary metrics
router.get('/admin/communications/summary',                                    ...adminOnly, ctrl.getSummary);

// Retryable failure queue
router.get('/admin/communications/failures',                                   ...adminOnly, ctrl.listFailures);

// Chat conversation summaries
router.get('/admin/communications/conversations',                              ...adminOnly, ctrl.getConversations);

// Event list + export
router.get('/admin/communications/events',                                     ...adminOnly, ctrl.listEvents);
router.post('/admin/communications/export',                                    ...adminOnly, ctrl.exportEvents);

// Bulk retry (before :eventKey to avoid param collision)
router.post('/admin/communications/events/bulk-retry',                        ...adminOnly, ctrl.bulkRetryEvents);

// Single event detail + retry
router.get('/admin/communications/events/:eventKey',                          ...adminOnly, ctrl.getEventDetail);
router.post('/admin/communications/events/:eventKey/retry',                   ...adminOnly, ctrl.retryEvent);

// Entity + recipient timelines
router.get('/admin/communications/entity/:entityType/:entityId',              ...adminOnly, ctrl.getEntityTimeline);
router.get('/admin/communications/recipient/:recipientUid',                   ...adminOnly, ctrl.getRecipientTimeline);

// Templates CRUD + preview
router.get('/admin/communications/templates',                                  ...adminOnly, ctrl.listTemplates);
router.post('/admin/communications/templates',                                 ...adminOnly, ctrl.createTemplate);
router.post('/admin/communications/templates/:templateKey/preview',           ...adminOnly, ctrl.previewTemplate);
router.get('/admin/communications/templates/:templateKey',                    ...adminOnly, ctrl.getTemplate);
router.patch('/admin/communications/templates/:templateKey',                  ...adminOnly, ctrl.updateTemplate);
router.delete('/admin/communications/templates/:templateKey',                 ...adminOnly, ctrl.archiveTemplate);

export default router;
