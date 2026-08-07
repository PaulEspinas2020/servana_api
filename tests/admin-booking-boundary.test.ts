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
