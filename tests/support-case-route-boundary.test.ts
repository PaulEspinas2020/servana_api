import fs from 'fs';
import path from 'path';

const providerRoutes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'provider.routes.ts'), 'utf8');
const adminRoutes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'adminSupportCase.routes.ts'), 'utf8');
const providerService = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'providerSupportCaseService.ts'), 'utf8');

describe('support case route boundaries', () => {
  it('guards every canonical provider case endpoint with provider authentication', () => {
    const lines = providerRoutes.split('\n').filter(line => line.includes('/provider/support/cases'));
    expect(lines.length).toBeGreaterThanOrEqual(9);
    for (const line of lines) {
      expect(line).toContain('verifyAuth');
      expect(line).toContain('requireProviderRole');
    }
  });

  it('uses distinct permissions for restricted admin operations', () => {
    expect(adminRoutes).toContain("requirePermission('support.cases.internal_notes')");
    expect(adminRoutes).toContain("requirePermission('support.evidence.sensitive.view')");
    expect(adminRoutes).toContain("requirePermission('support.appeals.decide')");
    expect(adminRoutes).toContain("requirePermission('support.sla.manage')");
  });

  it('scopes provider detail and attachment reads to the authenticated uid', () => {
    expect(providerService).toMatch(/WHERE c\.case_id = \$1 AND c\.provider_uid = \$2/);
    expect(providerService).toMatch(/attachment_id = \$1 AND case_id = \$2 AND provider_uid = \$3/);
  });

  it('fails closed until migration 014 is deployed', () => {
    expect(providerService).toContain('SUPPORT_SCHEMA_NOT_DEPLOYED');
    expect(providerService).toContain('Apply migration 014');
  });
});
