import { Router } from 'express';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import { requirePermission } from '../middleware/requirePermission';
import * as ctrl from '../controllers/adminProviderController';
import * as attrCtrl from '../controllers/adminMobileAttributionController';

const router = Router();
const adminOnly = [verifyAuth, verifyRoles([1])];

// ── Provider Registry ─────────────────────────────────────────────────────────
router.get('/admin/providers/metrics', ...adminOnly, requirePermission('providers.view'), ctrl.getProviderMetrics);
router.get('/admin/providers',         ...adminOnly, requirePermission('providers.view'), ctrl.listProviders);

// ── Service Applications (global view) ───────────────────────────────────────
router.get('/admin/providers/service-applications',            ...adminOnly, requirePermission('providers.view'), ctrl.listAllServiceApplications);
router.patch('/admin/providers/service-applications/:id/approve', ...adminOnly, requirePermission('providers.status.change'), ctrl.approveServiceApplication);
router.patch('/admin/providers/service-applications/:id/reject',  ...adminOnly, requirePermission('providers.status.change'), ctrl.rejectServiceApplication);

// ── Mobile Attribution & Catalog Association ──────────────────────────────────
// NOTE: must stay ABOVE /:uid routes or Express matches mobile-metrics as uid
router.get('/admin/providers/mobile-metrics',          ...adminOnly, requirePermission('providers.view'), attrCtrl.getMobileMetrics);
router.post('/admin/providers/attribution/backfill',   ...adminOnly, requirePermission('providers.view'), attrCtrl.triggerBackfill);

// ── Provider 360 Workspace ────────────────────────────────────────────────────
router.get('/admin/providers/:uid',                        ...adminOnly, requirePermission('providers.profile.view'), ctrl.getProvider);
router.get('/admin/providers/:uid/services',               ...adminOnly, requirePermission('providers.active_services.view'), ctrl.getProviderServices);
router.get('/admin/providers/:uid/service-applications',   ...adminOnly, requirePermission('providers.profile.view'), ctrl.getProviderServiceApplications);
router.get('/admin/providers/:uid/catalog-capabilities',   ...adminOnly, requirePermission('providers.profile.view'), ctrl.getProviderCatalogCapabilities);
router.get('/admin/providers/:uid/requirements',                   ...adminOnly, requirePermission('providers.documents.view'), ctrl.getProviderRequirements);
router.post('/admin/providers/:uid/requirements',                  ...adminOnly, requirePermission('providers.documents.upload'), ctrl.uploadProviderRequirement);
router.delete('/admin/providers/:uid/requirements/:id',            ...adminOnly, requirePermission('providers.documents.delete'), ctrl.deleteProviderRequirement);
router.patch('/admin/providers/:uid/requirements/:id/verify',      ...adminOnly, requirePermission('providers.documents.verify'), ctrl.verifyProviderRequirement);
router.patch('/admin/providers/:uid/requirements/:id/reject',             ...adminOnly, requirePermission('providers.documents.reject'), ctrl.rejectProviderRequirement);
router.patch('/admin/providers/:uid/requirements/:id/request-resubmission', ...adminOnly, requirePermission('providers.documents.request_resubmission'), ctrl.needsResubmissionProviderRequirement);
router.get('/admin/providers/:uid/jobs',                   ...adminOnly, requirePermission('providers.jobs.view'), ctrl.getProviderJobs);
router.get('/admin/providers/:uid/performance',            ...adminOnly, requirePermission('providers.performance.view'), ctrl.getProviderPerformance);
router.get('/admin/providers/:uid/earnings',               ...adminOnly, requirePermission('providers.earnings.view'), ctrl.getProviderEarnings);
router.get('/admin/providers/:uid/availability',                   ...adminOnly, requirePermission('provider_availability.view'), ctrl.getProviderAvailability);
router.put('/admin/providers/:uid/availability',                   ...adminOnly, requirePermission('provider_availability.weekly_schedule.edit'), ctrl.saveProviderAvailabilityAdmin);
router.delete('/admin/providers/:uid/availability',                ...adminOnly, requirePermission('provider_availability.weekly_schedule.edit'), ctrl.deleteProviderAvailabilityAdmin);
router.get('/admin/providers/:uid/availability/timeline',          ...adminOnly, requirePermission('provider_availability.view'), ctrl.getAvailabilityTimeline);
router.get('/admin/providers/:uid/time-off',                       ...adminOnly, requirePermission('provider_availability.view'), ctrl.getProviderTimeOff);
router.post('/admin/providers/:uid/time-off',                      ...adminOnly, requirePermission('provider_availability.time_off.add'), ctrl.createProviderTimeOff);
router.patch('/admin/providers/:uid/time-off/:timeOffId/cancel',   ...adminOnly, requirePermission('provider_availability.time_off.cancel'), ctrl.cancelProviderTimeOff);
router.post('/admin/providers/:uid/eligibility-preview',           ...adminOnly, requirePermission('provider_eligibility.preview'), ctrl.eligibilityPreviewAdmin);
router.get('/admin/providers/:uid/service-area',                   ...adminOnly, requirePermission('provider_service_area.view'), ctrl.getProviderServiceArea);
router.put('/admin/providers/:uid/service-area',                   ...adminOnly, requirePermission('provider_service_area.edit'), ctrl.saveProviderServiceAreaAdmin);
router.patch('/admin/providers/:uid/account-status',   ...adminOnly, requirePermission('providers.status.change'), ctrl.updateProviderAccountStatus);
router.patch('/admin/providers/:uid/archive',          ...adminOnly, requirePermission('providers.archive'), ctrl.setProviderArchive);

// ── Mobile Attribution (per-provider) ─────────────────────────────────────────
router.get('/admin/providers/:uid/attribution',        ...adminOnly, requirePermission('providers.profile.view'), attrCtrl.getProviderAttribution);
router.get('/admin/providers/:uid/catalog-association',...adminOnly, requirePermission('providers.profile.view'), attrCtrl.getProviderCatalogAssociation);

export default router;
