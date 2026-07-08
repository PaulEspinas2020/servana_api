import { Router } from 'express';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import * as ctrl from '../controllers/adminProviderController';

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
router.get('/admin/providers/:uid/jobs', ...adminOnly, ctrl.getProviderJobs);
router.get('/admin/providers/:uid/performance', ...adminOnly, ctrl.getProviderPerformance);
router.get('/admin/providers/:uid/earnings', ...adminOnly, ctrl.getProviderEarnings);
router.get('/admin/providers/:uid/availability', ...adminOnly, ctrl.getProviderAvailability);
router.get('/admin/providers/:uid/service-area', ...adminOnly, ctrl.getProviderServiceArea);
router.patch('/admin/providers/:uid/account-status', ...adminOnly, ctrl.updateProviderAccountStatus);
router.patch('/admin/providers/:uid/archive', ...adminOnly, ctrl.setProviderArchive);

export default router;
