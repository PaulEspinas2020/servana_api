const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'src');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

describe('Command 23 provider services hardening', () => {
  const service = read('services', 'serviceApplicationService.ts');
  const autoOnline = read('services', 'providerAutoOnlineEngine.ts');
  const assignmentEligibility = read('services', 'providerEligibilityEngine.ts');
  const controller = read('controllers', 'providerController.ts');
  const catalogRoute = read('routes', 'providerCatalog.routes.ts');
  const providerRoute = read('routes', 'provider.routes.ts');
  const adminController = read('controllers', 'adminProviderController.ts');

  it('provider catalog is role-gated and provider scoped', () => {
    expect(catalogRoute).toContain('requireProviderRole');
    expect(controller).toContain('req.user?.uid');
    expect(service).toContain('evaluateApplicationEligibility');
  });

  it('submission is idempotent across concurrent devices', () => {
    expect(service).toContain('wsa_provider_request_idempotency');
    expect(service).toContain('client_request_id');
    expect(service).toContain('pg_advisory_xact_lock');
    expect(service).toContain('SERVICE_REQUIREMENTS_VERSION_CONFLICT');
    expect(controller).toContain('clientRequestId');
  });

  it('application enumeration is always bound to the token uid', () => {
    expect(service).toContain('WHERE wsa.id = $1 AND wsa.worker_uid = $2');
    expect(service).toContain('WHERE id = $1 AND worker_uid = $2');
    expect(controller).not.toContain('req.body?.workerUid');
    expect(controller).not.toContain('req.body?.providerId');
  });

  it('provider DTO exposes safe reasons but not internal review notes', () => {
    const dtoStart = controller.indexOf('const toApplicationDto');
    const dtoEnd = controller.indexOf('export const getServiceApplications', dtoStart);
    const dto = controller.slice(dtoStart, dtoEnd);
    expect(dto).toContain('providerReasonCode');
    expect(dto).toContain('providerReasonDetail');
    expect(dto).not.toContain('review_reason');
    expect(dto).not.toContain('reviewReason');
  });

  it('approval uses one database client transaction', () => {
    expect(service).toContain('approveApplicationAtomic');
    expect(service).toContain("await client.query('BEGIN')");
    expect(service).toContain("await client.query('COMMIT')");
    expect(service).toContain("await client.query('ROLLBACK')");
    expect(service).toContain('INSERT INTO ${dbSchema}.employee_services');
    expect(adminController).toContain('approveApplicationAtomic');
  });

  it('provider service routes expose overview, eligibility and owned detail', () => {
    expect(providerRoute).toContain('/worker/services-overview');
    expect(providerRoute).toContain('/worker/services/:serviceId/eligibility');
    expect(providerRoute).toContain('/worker/service-applications/:applicationId');
  });

  it('timeline and safe provider reason fields are persisted', () => {
    expect(service).toContain('worker_service_application_timeline');
    expect(service).toContain('provider_reason_code');
    expect(service).toContain('provider_reason_detail');
    expect(service).toContain('ON CONFLICT (application_id, event_key) DO NOTHING');
  });

  it('pending applications never grant auto-online or provisional Jobs access', () => {
    expect(autoOnline).toContain('complete: activeServiceIds.length > 0');
    expect(autoOnline).toContain("COALESCE(status, 'active') = 'active'");
    const syncStart = autoOnline.indexOf('export const syncProvisionalBookableServices');
    const syncEnd = autoOnline.indexOf('export const applyAutoOnline', syncStart);
    const syncBody = autoOnline.slice(syncStart, syncEnd);
    expect(syncBody).toContain('employee_services');
    expect(syncBody).not.toContain('worker_service_applications');
  });

  it('booking assignment requires provider activation and an active operational service', () => {
    expect(assignmentEligibility).toContain('PROVIDER_ACTIVATION_NOT_ACTIVE');
    expect(assignmentEligibility).toContain('pa.activation_status');
    expect(assignmentEligibility).toContain("COALESCE(status, 'active') = 'active'");
    expect(assignmentEligibility).toContain('ORDER BY submitted_at DESC');
  });
});
