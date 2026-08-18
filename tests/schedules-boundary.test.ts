import fs from 'fs';
import path from 'path';

const supplyController = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'adminProviderAvailabilityController.ts'), 'utf8');
const providerController = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'adminProviderController.ts'), 'utf8');
const engine = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'providerAvailabilityEngine.ts'), 'utf8');
const bookingService = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'bookingService.ts'), 'utf8');
const serviceService = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'serviceService.ts'), 'utf8');

describe('schedule and availability input boundaries', () => {
  it('clamps supply horizons and list limits to finite positive integers', () => {
    expect(supplyController).toMatch(/Math\.min\(30, Math\.max\(1, Math\.trunc\(rawDays\)\)\)/);
    expect(supplyController).toMatch(/Math\.min\(100, Math\.max\(1, Math\.trunc\(rawLimit\)\)\)/);
  });

  it('requires positive booking and time-off IDs', () => {
    expect(supplyController).toMatch(/Number\.isSafeInteger\(parsedBookingId\)/);
    expect(providerController).toMatch(/Number\.isSafeInteger\(timeOffId\)/);
  });

  it('stores schedules only in the canonical operational timezone', () => {
    expect(engine).toMatch(/timezone !== OPERATIONAL_TIMEZONE/);
    expect(engine).toMatch(/timezone must be \$\{OPERATIONAL_TIMEZONE\}/);
  });

  it('serializes stale schedule and overlapping time-off writes', () => {
    expect(engine).toMatch(/worker_availability\.version = \$5::integer/);
    expect(engine).toMatch(/pg_advisory_xact_lock/);
    expect(engine).toMatch(/Time off overlaps an existing active period/);
  });

  it('counts and locks branch capacity in Manila local time', () => {
    expect(serviceService).toMatch(/schedule AT TIME ZONE 'Asia\/Manila'/);
    expect(bookingService).toMatch(/FOR UPDATE OF bs/);
    expect(bookingService).toMatch(/branch_id/);
    expect(bookingService).toMatch(/SLOT_FULL/);
  });
});
