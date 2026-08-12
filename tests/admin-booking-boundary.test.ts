import fs from 'fs';
import path from 'path';

const service = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'adminBookingService.ts'), 'utf8');
const controller = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'adminBookingController.ts'), 'utf8');

describe('admin booking list and input boundaries', () => {
  it('clamps malformed pagination and returns the normalized metadata', () => {
    expect(service).toMatch(/Number\.isFinite\(rawPage\)/);
    expect(service).toMatch(/Math\.min\(100, Math\.max\(1, Math\.trunc\(rawLimit\)\)\)/);
    expect(service).toMatch(/return \{ rows, total:[\s\S]*page, limit \}/);
    expect(controller).toMatch(/page: result\.page/);
    expect(controller).toMatch(/limit: result\.limit/);
  });

  it('keeps contact and address PII out of the bookings list projection', () => {
    const listBlock = service.slice(service.indexOf('export const getAdminBookings'), service.indexOf('export const getAdminBookingMetrics'));
    expect(listBlock).not.toMatch(/AS customer_phone|AS customer_email|AS provider_phone|AS address_line/);
    expect(listBlock).not.toMatch(/customerPhone:|customerEmail:|providerPhone:|addressLine:/);
  });

  it('still permits guest phone and email search without returning those fields', () => {
    expect(service).toMatch(/gc\.email ILIKE/);
    expect(service).toMatch(/gc\.phone_normalized ILIKE/);
  });

  it('requires safe positive integer booking and service-option IDs', () => {
    expect(controller).toMatch(/Number\.isSafeInteger\(value\) && value > 0/);
    expect(controller).not.toMatch(/!id \|\| isNaN\(id\)/);
    expect(controller).toMatch(/serviceOptionId must be a positive integer/);
  });

  it('validates reschedule and slot ranges before the database', () => {
    expect(controller).toMatch(/scheduledAt must be a valid ISO 8601 date-time/);
    expect(controller).toMatch(/endAt must be after startAt/);
  });
});

describe('assignment candidates match what the assign path will accept', () => {
  /**
   * Comment-stripped.
   *
   * The slice ends at `adminAssignProvider`, and that function's docblock now
   * explains the role-4 defect by quoting the predicate it replaced. Prose
   * naming `role::int = 2` would satisfy a check for its absence.
   */
  const candidatesBlock = service
    .slice(
      service.indexOf('export const getAssignmentCandidates'),
      service.indexOf('export const adminAssignProvider'),
    )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

  it('offers both provider roles, not just role 2', () => {
    // Role 4 is the second provider role. `role::int = 2` meant no internal
    // provider could ever be offered for a booking, while every other provider
    // query in the codebase uses IN (2,4).
    expect(candidatesBlock).toMatch(/role::int IN \(2,\s*4\)/);
    expect(candidatesBlock).not.toMatch(/role::int = 2/);
  });

  it('does not admit role 6, whose meaning is undefined', () => {
    // Two production accounts hold role 6 and nothing defines it. Fail closed.
    expect(candidatesBlock).not.toMatch(/\b6\b\s*\)/);
  });

  it('qualifies on approved applications as well as employee_services', () => {
    // adminAssignProvider accepts the UNION of both, so a candidate list built
    // from employee_services alone hides providers that are in fact assignable.
    expect(candidatesBlock).toMatch(/employee_services/);
    expect(candidatesBlock).toMatch(/worker_service_applications/);
    expect(candidatesBlock).toMatch(/status = 'approved'/);
  });

  it('cannot silently drop a provider through an inner join', () => {
    expect(candidatesBlock).not.toMatch(/JOIN \$\{dbSchema\}\.employee_services/);
    expect(candidatesBlock).toMatch(/EXISTS \(SELECT 1/);
  });
});
