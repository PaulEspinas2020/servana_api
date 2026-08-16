import fs from 'fs';
import path from 'path';

import { CAPABILITY_GRANT_EXISTS_SQL } from '../src/services/booking/eligibilityPipeline';
import { providerRoleSqlPredicate } from '../src/constants/providerRoles';

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

  /**
   * The properties below were asserted against the SQL written out by hand in
   * this function. They are now asserted against the SQL the SHARED builders
   * emit, plus a check that this producer calls those builders — which is
   * strictly stronger: the old form proved this one copy was right, and stayed
   * green while a second copy elsewhere said something different.
   */
  const roleSql  = providerRoleSqlPredicate('uc.role');
  // Two id spaces: the canonical `services.id` and the legacy family id.
  const grantSql = CAPABILITY_GRANT_EXISTS_SQL('servana', 'uc.uid', '$2', '$1');

  it('builds its predicates from the canonical declarations, not a local copy', () => {
    expect(candidatesBlock).toMatch(/providerRoleSqlPredicate\('uc\.role'\)/);
    expect(candidatesBlock).toMatch(/CAPABILITY_GRANT_EXISTS_SQL\(dbSchema, 'uc\.uid', '\$2', '\$1'\)/);
    // No re-inlined predicate alongside the imported one.
    expect(candidatesBlock).not.toMatch(/role::int/);
    expect(candidatesBlock).not.toMatch(/FROM \$\{dbSchema\}\.employee_services/);
  });

  it('offers both provider roles, not just role 2', () => {
    // Role 4 is the second provider role. `role::int = 2` meant no internal
    // provider could ever be offered for a booking, while every other provider
    // query in the codebase uses IN (2,4).
    expect(roleSql).toMatch(/role::int IN \(2,\s*4\)/);
    expect(roleSql).not.toMatch(/role::int = 2/);
  });

  it('does not admit role 6, whose meaning is undefined', () => {
    // Two production accounts hold role 6 and nothing defines it. Fail closed.
    expect(roleSql).not.toMatch(/\b6\b/);
  });

  it('asks the canonical capability table first', () => {
    // The Master Command's source. The legacy grants below it are the
    // instrumented fallback, not the answer.
    expect(grantSql).toContain('catalog_provider_services');
    expect(grantSql.indexOf('catalog_provider_services'))
      .toBeLessThan(grantSql.indexOf('employee_services'));
  });

  it('qualifies on approved applications as well as employee_services', () => {
    // adminAssignProvider accepts the UNION of both, so a candidate list built
    // from employee_services alone hides providers that are in fact assignable.
    expect(grantSql).toMatch(/employee_services/);
    expect(grantSql).toMatch(/worker_service_applications/);
    expect(grantSql).toMatch(/status = 'approved'/);
  });

  it('cannot silently drop a provider through an inner join', () => {
    expect(grantSql).not.toMatch(/\bJOIN\b/);
    expect(grantSql).toMatch(/EXISTS \(SELECT 1/);
  });

  it("asks the executor's occupancy question rather than assembling its own", () => {
    /**
     * This used to hand-write the query: a shorter status list (so a REFUNDED
     * booking made a provider look busy the assign call would have accepted)
     * and a fixed ±2h window that ignored how long the job lasts.
     *
     * Both are now one shared builder, so the preview and the committer cannot
     * answer differently.
     */
    expect(candidatesBlock).toContain('BUSY_PROVIDERS_SQL(dbSchema)');
    expect(candidatesBlock).not.toMatch(/status NOT IN/);
    expect(candidatesBlock).not.toMatch(/conflictWindowFor/);
    expect(candidatesBlock).not.toMatch(/2 \* 60 \* 60 \* 1000/);
  });

  it("passes this booking's real span, resolved in SQL", () => {
    // `ends_at` comes from `bookingEndSql`, so the duration the preview uses is
    // the duration the database holds — never one computed here.
    expect(candidatesBlock).toContain('bookingEndSql');
    expect(candidatesBlock).toContain('[schedule, ends_at, bookingId]');
  });
});
