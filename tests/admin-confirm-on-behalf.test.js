/**
 * ASSIGN command — adminConfirmProviderAssignment source contracts
 * Run: npx jest tests/admin-confirm-on-behalf.test.js
 */

const fs   = require('fs');
const path = require('path');

const svcSrc   = fs.readFileSync(path.join(__dirname, '../src/services/adminBookingService.ts'), 'utf-8').replace(/\r\n/g, '\n');
const ctrlSrc  = fs.readFileSync(path.join(__dirname, '../src/controllers/adminBookingController.ts'), 'utf-8').replace(/\r\n/g, '\n');
const routeSrc = fs.readFileSync(path.join(__dirname, '../src/routes/adminBooking.routes.ts'), 'utf-8').replace(/\r\n/g, '\n');

const exeSrc   = fs.readFileSync(path.join(__dirname, '../src/services/booking/transitionExecutor.ts'), 'utf-8').replace(/\r\n/g, '\n');

/**
 * The function body, sliced to its actual END rather than to a fixed byte
 * count.
 *
 * It used to be `slice(fnStart, fnStart + 4000)`. Adding a docblock pushed the
 * email and audit calls past the window, and three assertions failed for a
 * reason that had nothing to do with the code they were checking — the same
 * fixed-window trap `source-reads-normalise-line-endings.test.ts` exists to
 * prevent, in a file it does not cover.
 */
const fnStart  = svcSrc.indexOf('adminConfirmProviderAssignment =');
const fnEnd    = svcSrc.indexOf('\nexport const ', fnStart);
const fnBody   = svcSrc.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);

/**
 * The same body with comments removed.
 *
 * Needed by the "does NOT call acceptJob" assertion: a comment inside this
 * function explains that it deliberately mirrors what `acceptJob` does, and
 * once the slice reached the real end of the function that prose started
 * satisfying a check for a CALL. Naming a thing is not calling it.
 */
const fnCode   = fnBody
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');

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

/**
 * The write moved into the canonical executor (D1). These assertions follow
 * it: the CONTRACT is unchanged, so deleting them would drop a real guarantee,
 * and leaving them pointed at the service would fail a migration that kept
 * every part of it.
 */
describe('adminConfirmProviderAssignment — UPDATE contract', () => {
  const adminBranch = exeSrc.slice(
    exeSrc.indexOf("if (input.action === 'ADMIN_CONFIRM_ASSIGNMENT')"),
    exeSrc.indexOf('// `accepted_at` is what the provider app renders'),
  );

  it("sets booking_workers.status = 'ACCEPTED'", () => {
    expect(adminBranch).toContain("status              = 'ACCEPTED'");
  });

  it("sets confirmation_source = 'admin_on_behalf_of_provider'", () => {
    expect(adminBranch).toContain("'admin_on_behalf_of_provider'");
  });

  it('the whole consent trail lands in the SAME statement as the status', () => {
    // An ACCEPTED row whose confirmation_source failed to land is
    // indistinguishable from the provider accepting themselves, which is the
    // one distinction this action exists to preserve.
    for (const col of ['admin_actor_uid', 'consent_method', 'consent_reference',
                       'confirmation_reason', 'confirmed_at']) {
      expect(adminBranch).toContain(col);
    }
  });

  it('the ASSIGNED source restriction belongs to the ACTION, not to a SQL clause', () => {
    // `AND status = 'ASSIGNED'` used to be the concurrency guard. It is now
    // `from: ['ASSIGNED']` on the action, checked under the row lock before
    // any write — which also makes it impossible for a caller to skip.
    const actions = exeSrc.slice(
      exeSrc.indexOf('ADMIN_CONFIRM_ASSIGNMENT: {'),
      exeSrc.indexOf('ADMIN_CANCEL:'),
    );
    expect(actions).toContain("from: ['ASSIGNED']");
    expect(adminBranch).not.toContain("AND status     = 'ASSIGNED'");
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
    expect(fnCode).not.toContain('acceptJob');
    // Positive fixture: the stripper must not have removed everything.
    expect(fnCode).toContain('transitionBooking');
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
