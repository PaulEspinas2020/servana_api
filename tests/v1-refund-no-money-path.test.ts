/**
 * The v1 refund endpoint cannot move money (TAB 08, F-11).
 *
 * ## The bypass this closes
 *
 * `POST /api/v1/bookings/:bookingId/refunds` declares `auth: 'authenticated'`
 * and no permission. Its actor comes from `assertBookingAccess`, which answers
 * `admin` for any role-1 user on ANY booking. `refundBookingPayment` then
 * branched on that actor and, for an admin, called
 * `refundService.forceRefund()` — a live PayMongo refund inside the request.
 *
 * The complete path to moving money was one POST from any admin. The legacy
 * admin surface demands four steps behind four named permissions, including
 * `refunds.approve` at `risk_level: critical`. So an admin deliberately denied
 * `refunds.approve` could issue a refund through the customer's endpoint.
 *
 * Same shape as F-01 on payouts: a second, quieter path to a capability whose
 * guard lives somewhere else — and live, because v1 is deployed.
 *
 * ## Why the fix is not a permission check
 *
 * A single permissioned refund call still collapses request, review, approval
 * and processing into one actor and one moment, which is the control the legacy
 * design encodes. The money path is REMOVED instead: every actor opens a
 * review, and refunds complete through the reviewed, permissioned admin
 * surface.
 *
 * These assertions are deliberately about the SOURCE. The behavioural half —
 * that an admin call returns `outcome: 'requested'` — is covered by the finance
 * domain suites; what cannot be caught behaviourally is somebody reintroducing
 * a processor call in a branch no fixture exercises.
 */

import fs from 'fs';
import path from 'path';
import { V1_CONTRACT } from '../src/api/v1/contract';

const SERVICE = path.join(__dirname, '..', 'src', 'services', 'finance', 'bookingPaymentService.ts');
const source = fs.readFileSync(SERVICE, 'utf8');

/** Comments carry the history of this defect; the code must be read without them. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('the fixture is real (positive control)', () => {
  it('reads the service and finds the refund entry point', () => {
    expect(code).toMatch(/export async function refundBookingPayment/);
  });

  it('still opens reviews — the endpoint was not simply disabled', () => {
    expect(code).toMatch(/openRefundReview\(/);
  });
});

describe('no processor call survives in the booking refund path', () => {
  it('does not call forceRefund', () => {
    expect(code).not.toMatch(/forceRefund/);
  });

  it('does not import the refund service at all', () => {
    // The dependency goes with the capability. Leaving the import is an
    // invitation to re-add the call.
    expect(code).not.toMatch(/from '\.\.\/refund\.service'/);
  });

  it('an actor that is not customer or admin is refused, not fallen through', () => {
    expect(code).toMatch(/PAYMENT_ACTOR_NOT_PERMITTED/);
  });
});

describe('the v1 refund entry is honest about what it is', () => {
  const entry = V1_CONTRACT.find((e) => e.id === 'bookings.refunds.create');

  it('exists and is implemented', () => {
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('implemented');
  });

  /**
   * It stays `authenticated` DELIBERATELY. It is the customer's "request a
   * refund" button, and requiring an admin role would break the flow it exists
   * for. What made it dangerous was never the auth mode — it was that an admin
   * reaching the same endpoint got a different and far more powerful outcome.
   */
  it('is a request endpoint, so it is authenticated rather than admin', () => {
    expect(entry!.auth).toBe('authenticated');
  });

  it('declares no permission, because it no longer performs a privileged act', () => {
    expect((entry as { permission?: string }).permission).toBeUndefined();
  });
});

describe('the reviewed admin surface is still the way money moves', () => {
  const routes = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'adminFinance.routes.ts'),
    'utf8',
  );

  it.each([
    ['refunds.review.open', '/admin/finance/refunds'],
    ['refunds.approve', 'approve'],
    ['refunds.reject', 'reject'],
    ['refunds.mark_processed', 'mark-processed'],
  ])('%s is still demanded on %s', (permission) => {
    expect(routes).toContain(`requirePermission('${permission}')`);
  });
});
