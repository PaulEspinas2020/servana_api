import { Router } from 'express';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import * as ctrl from '../controllers/adminProviderController';
import * as attrCtrl from '../controllers/adminMobileAttributionController';

const router = Router();
const adminOnly = [verifyAuth, verifyRoles([1])];

// ── Provider Registry ─────────────────────────────────────────────────────────
// GET  /api/admin/providers               — list with search/filter/sort/pagination
// GET  /api/admin/providers/metrics       — summary metric cards
router.get('/admin/providers/metrics', ...adminOnly, ctrl.getProviderMetrics);
router.get('/admin/providers', ...adminOnly, ctrl.listProviders);

// ── Service Applications (global view) ───────────────────────────────────────
// GET   /api/admin/providers/service-applications
// PATCH /api/admin/providers/service-applications/:id/approve
// PATCH /api/admin/providers/service-applications/:id/reject
router.get('/admin/providers/service-applications', ...adminOnly, ctrl.listAllServiceApplications);
router.patch('/admin/providers/service-applications/:id/approve', ...adminOnly, ctrl.approveServiceApplication);
router.patch('/admin/providers/service-applications/:id/reject', ...adminOnly, ctrl.rejectServiceApplication);

// ── Mobile Attribution & Catalog Association ──────────────────────────────────
// NOTE: must stay ABOVE /:uid routes or Express matches mobile-metrics as uid
router.get('/admin/providers/mobile-metrics', ...adminOnly, attrCtrl.getMobileMetrics);
router.post('/admin/providers/attribution/backfill', ...adminOnly, attrCtrl.triggerBackfill);

// ── Provider 360 Workspace ────────────────────────────────────────────────────
// GET /api/admin/providers/:uid           — identity + status
// GET /api/admin/providers/:uid/services  — active services (employee_services)
// GET /api/admin/providers/:uid/service-applications — per-provider applications
// GET /api/admin/providers/:uid/catalog-capabilities
// GET /api/admin/providers/:uid/requirements
// GET /api/admin/providers/:uid/jobs
// GET /api/admin/providers/:uid/performance
// GET /api/admin/providers/:uid/earnings
// GET /api/admin/providers/:uid/availability
// GET /api/admin/providers/:uid/service-area
// PATCH /api/admin/providers/:uid/account-status
// PATCH /api/admin/providers/:uid/archive
router.get('/admin/providers/:uid', ...adminOnly, ctrl.getProvider);
router.get('/admin/providers/:uid/services', ...adminOnly, ctrl.getProviderServices);
router.get('/admin/providers/:uid/service-applications', ...adminOnly, ctrl.getProviderServiceApplications);
router.get('/admin/providers/:uid/catalog-capabilities', ...adminOnly, ctrl.getProviderCatalogCapabilities);
router.get('/admin/providers/:uid/requirements', ...adminOnly, ctrl.getProviderRequirements);
router.post('/admin/providers/:uid/requirements', ...adminOnly, ctrl.uploadProviderRequirement);
router.delete('/admin/providers/:uid/requirements/:id', ...adminOnly, ctrl.deleteProviderRequirement);
router.get('/admin/providers/:uid/jobs', ...adminOnly, ctrl.getProviderJobs);
router.get('/admin/providers/:uid/performance', ...adminOnly, ctrl.getProviderPerformance);
router.get('/admin/providers/:uid/earnings', ...adminOnly, ctrl.getProviderEarnings);
router.get('/admin/providers/:uid/availability',                      ...adminOnly, ctrl.getProviderAvailability);
router.put('/admin/providers/:uid/availability',                      ...adminOnly, ctrl.saveProviderAvailabilityAdmin);
router.delete('/admin/providers/:uid/availability',                   ...adminOnly, ctrl.deleteProviderAvailabilityAdmin);
router.get('/admin/providers/:uid/availability/timeline',             ...adminOnly, ctrl.getAvailabilityTimeline);
router.get('/admin/providers/:uid/time-off',                          ...adminOnly, ctrl.getProviderTimeOff);
router.post('/admin/providers/:uid/time-off',                         ...adminOnly, ctrl.createProviderTimeOff);
router.patch('/admin/providers/:uid/time-off/:timeOffId/cancel',      ...adminOnly, ctrl.cancelProviderTimeOff);
router.post('/admin/providers/:uid/eligibility-preview',              ...adminOnly, ctrl.eligibilityPreviewAdmin);
router.get('/admin/providers/:uid/service-area',                      ...adminOnly, ctrl.getProviderServiceArea);
router.put('/admin/providers/:uid/service-area',                      ...adminOnly, ctrl.saveProviderServiceAreaAdmin);
router.patch('/admin/providers/:uid/account-status', ...adminOnly, ctrl.updateProviderAccountStatus);
router.patch('/admin/providers/:uid/archive', ...adminOnly, ctrl.setProviderArchive);

// ── Mobile Attribution (per-provider) ─────────────────────────────────────────
// GET  /api/admin/providers/:uid/attribution         — per-provider source attribution
// GET  /api/admin/providers/:uid/catalog-association — legacy service → catalog mapping status
router.get('/admin/providers/:uid/attribution', ...adminOnly, attrCtrl.getProviderAttribution);
router.get('/admin/providers/:uid/catalog-association', ...adminOnly, attrCtrl.getProviderCatalogAssociation);

export default router;
