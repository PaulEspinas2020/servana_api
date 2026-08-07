import fs from 'fs';
import path from 'path';

const src = (...parts: string[]) => fs.readFileSync(path.join(__dirname, '..', 'src', ...parts), 'utf8');

describe('admin/mobile parity remediations', () => {
  test('general user administration is isolated behind user permissions', () => {
    const routes = src('routes', 'adminUserAccount.routes.ts');
    expect(routes).toContain("'/admin/users'");
    expect(routes).toContain("requirePermission('users.view')");
    expect(routes).toContain("'/admin/users/:uid/archive'");
    expect(routes).toContain("requirePermission('users.archive')");
  });

  test('customer addresses are scoped to one client and require the sensitive permission', () => {
    const routes = src('routes', 'adminCustomer.routes.ts');
    const controller = src('controllers', 'adminGuestController.ts');
    expect(routes).toContain("'/admin/customers/clients/:identityId/addresses'");
    expect(routes).toContain("requirePermission('customers.addresses.view')");
    expect(controller).toContain('getAddressesByUserId(identityId)');
  });

  test('provider service override is explicit, audited, and separately permissioned', () => {
    const routes = src('routes', 'adminProvider.routes.ts');
    const controller = src('controllers', 'adminProviderController.ts');
    expect(routes).toContain("'/admin/providers/:uid/services'");
    expect(routes).toContain("requirePermission('providers.services.assign')");
    expect(controller).toContain("action: 'provider_services_assigned'");
    expect(controller).toContain("source: 'admin_portal'");
  });

  test('support conversation reads and sends have distinct permissions', () => {
    const routes = src('routes', 'adminCommunication.routes.ts');
    expect(routes).toContain("requirePermission('communications.support_conversations.view'), ctrl.getConversationMessages");
    expect(routes).toContain("requirePermission('communications.support_conversations.send'), ctrl.sendConversationMessage");
  });

  test('catalog publish blockers are derived from publish validation prerequisites', () => {
    const dashboard = src('services', 'adminDashboardService.ts');
    expect(dashboard).toContain('provider_catalog_offering_mappings');
    expect(dashboard).toContain('AS publish_blockers');
    expect(dashboard).toContain('publishBlockers: n(c.publish_blockers)');
    expect(dashboard).not.toContain('publishBlockers: draft');
  });
});
