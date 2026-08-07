import fs from 'fs';
import path from 'path';

const controller = fs.readFileSync(path.join(__dirname, '../src/controllers/adminDashboardController.ts'), 'utf8');
const service = fs.readFileSync(path.join(__dirname, '../src/services/adminDashboardService.ts'), 'utf8');

describe('admin dashboard granular permission boundary', () => {
  const keys = [
    'dashboard.operations_metrics.view',
    'dashboard.revenue_metrics.view',
    'dashboard.provider_supply_metrics.view',
    'dashboard.booking_pipeline_metrics.view',
    'dashboard.system_health.view',
  ];

  test.each(keys)('controller evaluates %s', key => {
    expect(controller).toContain(`can('${key}')`);
  });

  test('controller returns the fail-closed projection', () => {
    expect(controller).toContain('projectDashboardForAccess(data');
    expect(controller).toContain("const uid = (req as any).user?.uid ?? ''");
  });

  test('restricted metric families are zeroed or removed', () => {
    expect(service).toContain("revenueToday: access.revenue ? data.snapshot.revenueToday : 0");
    expect(service).toContain('bookingPipeline: access.pipeline ? data.bookingPipeline');
    expect(service).toContain('providerHealth: access.providers ? data.providerHealth');
    expect(service).toContain("systemHealth: access.systemHealth ? data.snapshot.systemHealth : 'unknown'");
    expect(service).toContain("if (['payment_review', 'payment_exception'].includes(item.type)) return access.revenue");
    expect(service).toContain("if (['provider_application', 'document_review', 'onboarding_case'].includes(item.type)) return access.providers");
    expect(service).toContain('customersWithPaymentIssues: access.revenue');
    expect(service).toContain('paymentExceptions: access.revenue');
    expect(service).toContain('recentActivity: access.operations ? data.recentActivity : []');
  });
});
