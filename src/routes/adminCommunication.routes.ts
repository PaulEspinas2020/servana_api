import { Router } from 'express';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import { requirePermission } from '../middleware/requirePermission';
import * as ctrl from '../controllers/adminCommunicationController';

const router = Router();
const adminOnly = [verifyAuth, verifyRoles([1])];

// Summary metrics
router.get('/admin/communications/summary',                                    ...adminOnly, requirePermission('communications.view'), ctrl.getSummary);

// Retryable failure queue
router.get('/admin/communications/failures',                                   ...adminOnly, requirePermission('communications.failed_queue.view'), ctrl.listFailures);

// Chat conversation summaries
router.get('/admin/communications/conversations',                              ...adminOnly, requirePermission('communications.support_conversations.view'), ctrl.getConversations);

// Conversation detail + messages + admin send (must precede /:id to avoid conflicts)
router.get('/admin/communications/conversations/:id/messages',                ...adminOnly, requirePermission('communications.support_conversations.view'), ctrl.getConversationMessages);
router.post('/admin/communications/conversations/:id/messages',               ...adminOnly, requirePermission('communications.support_conversations.view'), ctrl.sendConversationMessage);
router.get('/admin/communications/conversations/:id',                         ...adminOnly, requirePermission('communications.support_conversations.view'), ctrl.getConversationDetail);

// Message reports (moderation)
router.get('/admin/communications/reports',                                   ...adminOnly, requirePermission('communications.support_conversations.view'), ctrl.listReports);
router.patch('/admin/communications/reports/:reportId',                       ...adminOnly, requirePermission('communications.support_conversations.view'), ctrl.resolveReport);

// Event list + export
router.get('/admin/communications/events',                                     ...adminOnly, requirePermission('communications.notification_logs.view'), ctrl.listEvents);
router.post('/admin/communications/export',                                    ...adminOnly, requirePermission('communications.export'), ctrl.exportEvents);

// Bulk retry (before :eventKey to avoid param collision)
router.post('/admin/communications/events/bulk-retry',                        ...adminOnly, requirePermission('communications.bulk_retry_failed'), ctrl.bulkRetryEvents);

// Single event detail + retry
router.get('/admin/communications/events/:eventKey',                          ...adminOnly, requirePermission('communications.details.view'), ctrl.getEventDetail);
router.post('/admin/communications/events/:eventKey/retry',                   ...adminOnly, requirePermission('communications.retry_failed'), ctrl.retryEvent);

// Entity + recipient timelines
router.get('/admin/communications/entity/:entityType/:entityId',              ...adminOnly, requirePermission('communications.notification_logs.view'), ctrl.getEntityTimeline);
router.get('/admin/communications/recipient/:recipientUid',                   ...adminOnly, requirePermission('communications.notification_logs.view'), ctrl.getRecipientTimeline);

// Templates CRUD + preview
router.get('/admin/communications/templates',                                  ...adminOnly, requirePermission('communications.templates.view'), ctrl.listTemplates);
router.post('/admin/communications/templates',                                 ...adminOnly, requirePermission('communications.templates.create'), ctrl.createTemplate);
router.post('/admin/communications/templates/:templateKey/preview',           ...adminOnly, requirePermission('communications.templates.preview'), ctrl.previewTemplate);
router.get('/admin/communications/templates/:templateKey',                    ...adminOnly, requirePermission('communications.templates.view'), ctrl.getTemplate);
router.patch('/admin/communications/templates/:templateKey',                  ...adminOnly, requirePermission('communications.templates.edit'), ctrl.updateTemplate);
router.delete('/admin/communications/templates/:templateKey',                 ...adminOnly, requirePermission('communications.templates.archive'), ctrl.archiveTemplate);

export default router;
