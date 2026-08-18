import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', 'src');
const read = (...parts: string[]) => fs.readFileSync(path.join(SRC, ...parts), 'utf8');

describe('additional work remains a booking-scoped operation', () => {
  const routes = read('routes', 'additional.routes.ts');
  const controller = read('controllers', 'additional.controller.ts');
  const service = read('services', 'additional.service.ts');
  const providerRoutes = read('routes', 'provider.routes.ts');
  const providerController = read('controllers', 'providerController.ts');

  test('legacy provider mutations require provider role and active account', () => {
    for (const route of [
      '/additional/request/:userId',
      '/additional/:id/worker-decision',
      '/additional/:id/withdraw',
      '/additional/:id/confirm-proceed',
    ]) {
      const line = routes.split('\n').find(value => value.includes(`"${route}"`));
      expect(line).toContain('verifyAuth');
      expect(line).toContain('requireProviderRole');
      expect(line).toContain('requireActiveProvider');
    }
  });

  test('every request-id read or mutation resolves its booking before access', () => {
    expect(controller).toContain('additionalService.getRequestContext(id)');
    expect(controller).toContain('assertBookingAccess(bookingId, actorUid(req))');
    expect(controller).toContain('Only the booking customer or an administrator');
  });

  test('the customer id retained in the compatibility URL is never the actor', () => {
    const create = controller.slice(
      controller.indexOf('export const createRequest'),
      controller.indexOf('export const approveRequest'),
    );
    expect(create).not.toMatch(/req\.params.*userId/);
    expect(create).toContain('actorUid(req)');
  });

  test('submission uses one transaction and an in-progress assignment', () => {
    expect(service).toContain('const client = await pool.connect()');
    expect(service).toContain('bw.worker_uid = $2');
    expect(service).toContain("bw.status = 'IN_PROGRESS'");
    expect(service).toContain('FOR UPDATE OF b');
    expect(service).toContain('item?.unitPrice ?? item?.amount');
    expect(service).toContain('item.serviceOptionId ?? booking.rows[0].service_option_id');
  });

  test('state mutations are compare-and-set, not blind updates', () => {
    expect(service).toMatch(/WHERE id = \$1 AND status = 'PENDING_ADMIN_APPROVAL'/);
    expect(service).toMatch(/WHERE id = \$1 AND status = 'WAITING_FOR_PAYMENT'/);
    expect(service).toMatch(/WHERE id = \$1 AND status = 'WAITING_WORKER_APPROVAL'/);
    expect(service).toMatch(/WHERE id = \$1 AND status = 'ACCEPTED'/);
  });

  test('booking-scoped reads project safe fields rather than leaking whole rows', () => {
    const readBlock = service.slice(service.indexOf('async getByBooking'));
    expect(readBlock).not.toContain('SELECT *');
    expect(readBlock).not.toContain('requested_by');
  });

  test('canonical provider routes also gate operational actions', () => {
    const lines = providerRoutes.split('\n').filter(line =>
      line.includes('/worker/additional-work/:id/'),
    );
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toContain('requireActiveProvider');
  });

  test('provider ownership follows booking_workers, not the denormalized booking field', () => {
    const block = providerController.slice(
      providerController.indexOf('export const workerAdditionalDecision'),
      providerController.indexOf('// ─── Provider Profile'),
    );
    expect(block).toContain('booking_workers');
    expect(block).not.toMatch(/b\.worker_uid\s*=\s*\$2/);
    expect(block).toContain("status = 'IN_PROGRESS'");
    expect(block).not.toContain("status = 'PROCEEDING'");
  });

  test('provider booking detail does not expose OTP or payment-provider credentials', () => {
    const detail = providerController.slice(
      providerController.indexOf('export const getProviderBookingDetail'),
      providerController.indexOf('export const getProviderBookingTracking'),
    );
    expect(detail).not.toContain('SELECT b.*');
    expect(detail).not.toContain('otp_code');
    expect(detail).not.toContain('reference_no');
    expect(detail).not.toContain('proof_url');
    expect(detail).toContain('p.additional_request_id IS NULL');
    expect(detail).toContain('bw.worker_uid = $2');
  });
});
