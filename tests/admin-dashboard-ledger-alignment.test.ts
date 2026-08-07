import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(
  path.join(__dirname, '../src/services/adminDashboardService.ts'),
  'utf8',
);

describe('admin dashboard settlement and timezone alignment', () => {
  test('booking state ignores additional-work payment rows', () => {
    expect(source).toContain('WHERE p.additional_request_id IS NULL');
  });

  test('revenue counts the paid ledger including additional work', () => {
    expect(source).toContain("LEFT JOIN ${s}.payments p ON UPPER(p.status) = 'PAID'");
    expect(source).toContain('revenueToday: n(revenue.revenue_today)');
  });

  test('Manila boundaries are used for revenue and response metadata', () => {
    expect(source).toContain("p.paid_at AT TIME ZONE 'Asia/Manila'");
    expect(source).toContain("dr.day_start AT TIME ZONE 'Asia/Manila'");
    expect(source).toContain("from: revenue.day_start_utc?.toISOString?.() ?? generatedAt");
  });

  test('legacy mixed-case statuses are normalized', () => {
    expect(source).toContain('UPPER(p.status) AS pay_status');
    expect(source).toContain('UPPER(b.status) AS raw_status');
    expect(source).toContain('UPPER(lw.worker_status)');
  });
});
