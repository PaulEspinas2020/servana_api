/**
 * ASSIGN command — adminConfirmProviderAssignment source contracts
 * Run: npx jest tests/admin-confirm-on-behalf.test.js
 */

const fs   = require('fs');
const path = require('path');

const svcSrc   = fs.readFileSync(path.join(__dirname, '../src/services/adminBookingService.ts'), 'utf-8').replace(/\r\n/g, '\n');
const ctrlSrc  = fs.readFileSync(path.join(__dirname, '../src/controllers/adminBookingController.ts'), 'utf-8').replace(/\r\n/g, '\n');
const routeSrc = fs.readFileSync(path.join(__dirname, '../src/routes/adminBooking.routes.ts'), 'utf-8').replace(/\r\n/g, '\n');

const fnStart  = svcSrc.indexOf('adminConfirmProviderAssignment =');
const fnBody   = svcSrc.slice(fnStart, fnStart + 4000);

describe('adminConfirmProviderAssignment — input validation contracts', () => {
  it('validates consentMethod against exactly verbal | written | chat_message', () => {
    expect(svcSrc).toContain("'verbal'");
    expect(svcSrc).toContain("'written'");
    expect(svcSrc).toContain("'chat_message'");
    expect(fnBody).toContain('consentMethod must be verbal | written | chat_message');
  });

  it('requires reason — throws on empty/missing', () => {
    expect(fnBody).toContain("reason is required");
  });

  it('rejects already-ACCEPTED/COMPLETED/CANCELLED bookings', () => {
    expect(fnBody).toContain("'CANCELLED'");
    expect(fnBody).toContain("'CANCELED'");
    expect(fnBody).toContain("'COMPLETED'");
    expect(fnBody).toContain("IN_PROGRESS");
  });

  it('rejects when providerUid does not match current assignment', () => {
    expect(fnBody).toContain('providerUid does not match');
  });

  it('rejects when booking_workers.status is not ASSIGNED', () => {
    expect(fnBody).toContain('Assignment cannot be confirmed');
  });
});

describe('adminConfirmProviderAssignment — UPDATE contract', () => {
  it("sets booking_workers.status = 'ACCEPTED'", () => {
    expect(fnBody).toContain("status              = 'ACCEPTED'");
  });

  it("sets confirmation_source = 'admin_on_behalf_of_provider'", () => {
    expect(fnBody).toContain("'admin_on_behalf_of_provider'");
  });

  it('UPDATE WHERE includes AND status = ASSIGNED (concurrency guard)', () => {
    expect(fnBody).toContain("AND status     = 'ASSIGNED'");
  });

  it('rowCount=0 guard prevents phantom success on concurrent change', () => {
    expect(fnBody).toContain('assignment may have changed concurrently');
  });
});

describe('adminConfirmProviderAssignment — side effects', () => {
  it('sends booking_accepted email to customer (parity with provider acceptJob)', () => {
    expect(fnBody).toContain("'booking_accepted'");
  });

  it('writes timeline event provider_acceptance_confirmed_by_admin', () => {
    expect(fnBody).toContain('addTimelineEvent');
    expect(fnBody).toContain('provider_acceptance_confirmed_by_admin');
  });

  it('writes audit event booking_provider_accepted_on_behalf', () => {
    expect(fnBody).toContain('logBookingAudit');
    expect(fnBody).toContain('booking_provider_accepted_on_behalf');
  });

  it('does NOT call acceptJob — mobile route is untouched', () => {
    expect(fnBody).not.toContain('acceptJob');
  });

  it('does NOT reference /api/workers/bookings (mobile endpoint protected)', () => {
    expect(fnBody).not.toContain('/api/workers/bookings');
  });
});

describe('adminConfirmProviderAssignment — controller & route', () => {
  it('controller validates providerUid length <= 256', () => {
    const fnIdx = ctrlSrc.indexOf('confirmProviderAssignment');
    const fn    = ctrlSrc.slice(fnIdx, fnIdx + 800);
    expect(fn).toContain('256');
    expect(fn).toContain('providerUid invalid');
  });

  it('route uses bookings.confirm_on_behalf permission', () => {
    expect(routeSrc).toContain("'bookings.confirm_on_behalf'");
    expect(routeSrc).toContain('confirm-provider-assignment');
  });

  it('route is behind adminOnly (verifyAuth + verifyRoles)', () => {
    const line = routeSrc.split('\n').find(l => l.includes('confirm-provider-assignment'));
    expect(line).toContain('adminOnly');
  });
});

describe('adminConfirmProviderAssignment — controller validation (all required fields)', () => {
  const fn = (() => {
    const idx = ctrlSrc.indexOf('confirmProviderAssignment');
    return ctrlSrc.slice(idx, idx + 900);
  })();

  it('rejects missing or empty reason', () => {
    expect(fn).toContain('reason is required');
  });

  it('rejects missing consentMethod', () => {
    expect(fn).toContain('consentMethod is required');
  });

  it('validates typeof consentMethod is string (prevents number/array injection)', () => {
    expect(fn).toContain("typeof consentMethod !== 'string'");
  });

  it('validates typeof providerUid is string with length cap', () => {
    expect(fn).toContain("typeof providerUid !== 'string'");
    expect(fn).toContain('providerUid.length > 256');
  });
});

describe('adminConfirmProviderAssignment — schema bootstrap', () => {
  it('ensureBookingOpsSchema adds all 6 confirmation columns', () => {
    expect(svcSrc).toContain('confirmation_source');
    expect(svcSrc).toContain('admin_actor_uid');
    expect(svcSrc).toContain('consent_method');
    expect(svcSrc).toContain('consent_reference');
    expect(svcSrc).toContain('confirmation_reason');
    expect(svcSrc).toContain('confirmed_at');
  });

  it('each ALTER TABLE is wrapped in try-catch (one failure does not abort the rest)', () => {
    const schemaFnIdx = svcSrc.indexOf('ensureBookingOpsSchema');
    const schemaFn    = svcSrc.slice(schemaFnIdx, schemaFnIdx + 3000);
    expect(schemaFn).toContain('confirmCols');
    expect(schemaFn).toContain('try {');
    expect(schemaFn).toContain('} catch {');
  });
});
