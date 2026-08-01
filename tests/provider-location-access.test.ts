/**
 * Booking-scoped provider location + self-scoped schedule.
 *
 * These replace two unauthenticated legacy routes that took their subject from
 * the URL: `GET /workers/location/:uid` (follow any provider's live position)
 * and `GET /workers/:workerId/schedule` (read any provider's week).
 *
 * The property being tested is that the successors cannot be *asked* about an
 * arbitrary provider at all — schedule comes from the token, and location comes
 * from a booking the caller must already be entitled to.
 */

jest.mock('../src/services/bookingAccessService', () => ({
  __esModule: true,
  assertBookingAccess: jest.fn(),
  sendBookingAccessError: jest.fn(() => false),
}));

jest.mock('../src/services/technicianService', () => ({
  __esModule: true,
  getWorkerSchedule: jest.fn(),
  getWorkerLocation: jest.fn(),
  getAssignedWorkerUid: jest.fn(),
}));

import * as technician from '../src/services/technicianService';
import { assertBookingAccess } from '../src/services/bookingAccessService';
import {
  getMySchedule,
  getBookingProviderLocation,
} from '../src/controllers/providerLocationAccessController';

const assertAccess = assertBookingAccess as jest.Mock;
const getSchedule = technician.getWorkerSchedule as jest.Mock;
const getLocation = technician.getWorkerLocation as jest.Mock;
const getAssigned = technician.getAssignedWorkerUid as jest.Mock;

const PROVIDER = 'uid-provider-1';
const OTHER_PROVIDER = 'uid-provider-2';

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const reqWith = (uid?: string, params: Record<string, string> = {}) =>
  ({ params, user: uid ? { uid } : undefined }) as any;

beforeEach(() => {
  jest.clearAllMocks();
  assertAccess.mockResolvedValue('customer');
});

describe('GET /worker/schedule — self-scoped', () => {
  it('reads the schedule of the token subject', async () => {
    getSchedule.mockResolvedValue([{ day: 'mon' }]);
    const res = mockRes();

    await getMySchedule(reqWith(PROVIDER), res);

    expect(getSchedule).toHaveBeenCalledWith(PROVIDER);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      schedule: [{ day: 'mon' }],
    });
  });

  it('cannot be pointed at another provider', async () => {
    // The legacy route took :workerId from the path. This one ignores params
    // entirely — supplying one must change nothing.
    getSchedule.mockResolvedValue([]);

    await getMySchedule(
      reqWith(PROVIDER, { workerId: OTHER_PROVIDER, uid: OTHER_PROVIDER }),
      mockRes(),
    );

    expect(getSchedule).toHaveBeenCalledWith(PROVIDER);
    expect(getSchedule).not.toHaveBeenCalledWith(OTHER_PROVIDER);
  });

  it('401s without a token', async () => {
    const res = mockRes();
    await getMySchedule(reqWith(undefined), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(getSchedule).not.toHaveBeenCalled();
  });
});

describe('GET /booking/:bookingId/provider-location — booking-scoped', () => {
  it('returns the location of the provider on a booking the caller owns', async () => {
    getAssigned.mockResolvedValue(PROVIDER);
    getLocation.mockResolvedValue({ lat: 14.55, lng: 121.02 });
    const res = mockRes();

    await getBookingProviderLocation(reqWith('uid-customer', { bookingId: '42' }), res);

    expect(assertAccess).toHaveBeenCalledWith(42, 'uid-customer');
    expect(getLocation).toHaveBeenCalledWith(PROVIDER);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      assigned: true,
      location: { lat: 14.55, lng: 121.02 },
    });
  });

  it('never looks up a location when access is refused', async () => {
    // The guard must run BEFORE any provider data is touched, or a refused
    // caller could still time the response to infer assignment.
    assertAccess.mockRejectedValue(
      Object.assign(new Error('denied'), { statusCode: 403 }),
    );

    await getBookingProviderLocation(
      reqWith('uid-stranger', { bookingId: '42' }),
      mockRes(),
    ).catch(() => {});

    expect(getAssigned).not.toHaveBeenCalled();
    expect(getLocation).not.toHaveBeenCalled();
  });

  it('distinguishes "no provider yet" from "no position reported"', async () => {
    // A customer watching an unmatched booking is a normal state, not an error,
    // and it must not look identical to an assigned provider with no fix.
    getAssigned.mockResolvedValue(null);
    let res = mockRes();
    await getBookingProviderLocation(reqWith('uid-customer', { bookingId: '42' }), res);
    expect(res.json).toHaveBeenCalledWith({
      success: true, assigned: false, location: null,
    });
    expect(getLocation).not.toHaveBeenCalled();

    getAssigned.mockResolvedValue(PROVIDER);
    getLocation.mockResolvedValue(null);
    res = mockRes();
    await getBookingProviderLocation(reqWith('uid-customer', { bookingId: '42' }), res);
    expect(res.json).toHaveBeenCalledWith({
      success: true, assigned: true, location: null,
    });
  });

  it('takes the provider from the booking, never from the caller', async () => {
    // There is no request shape that names a provider. Supplying one is inert.
    getAssigned.mockResolvedValue(PROVIDER);
    getLocation.mockResolvedValue({ lat: 1, lng: 2 });

    await getBookingProviderLocation(
      reqWith('uid-customer', { bookingId: '42', uid: OTHER_PROVIDER }),
      mockRes(),
    );

    expect(getLocation).toHaveBeenCalledWith(PROVIDER);
    expect(getLocation).not.toHaveBeenCalledWith(OTHER_PROVIDER);
  });

  it('rejects a malformed booking id before authorizing', async () => {
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      const res = mockRes();
      await getBookingProviderLocation(reqWith('uid-customer', { bookingId: bad }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(assertAccess).not.toHaveBeenCalled();
  });
});
