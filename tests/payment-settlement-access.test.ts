/**
 * Payment settlement authorization.
 *
 * These two handlers were missed by the first hardening pass because they
 * already carried `verifyAuth`, so a route-level audit counted them as covered.
 * Authentication is not authorization (§12): any Servana account holder with a
 * valid token could iterate sequential booking ids and flip a stranger's
 * payment to PAID, firing a false "Payment Received" notification at the
 * assigned provider each time.
 *
 * There is a second distinction these tests pin. Submitting evidence and
 * settling a payment are different acts (§43). `gcashSubmit` may be called by
 * the customer — they are claiming to have paid. `approve` and `markCashPaid`
 * may not: a customer declaring their own cash collected is the fraud case.
 */

jest.mock('../src/services/bookingAccessService', () => {
  class BookingAccessError extends Error {
    constructor(
      message: string,
      public statusCode: number,
      public code: string,
    ) {
      super(message);
    }
  }
  return {
    __esModule: true,
    BookingAccessError,
    assertBookingAccess: jest.fn(),
    sendBookingAccessError: jest.fn((res: any, e: any) => {
      if (e instanceof BookingAccessError) {
        res.status(e.statusCode).json({ success: false, code: e.code });
        return true;
      }
      return false;
    }),
  };
});

jest.mock('../src/services/paymentService', () => ({
  __esModule: true,
  approvePayment: jest.fn(),
  markCashPaid: jest.fn(),
  submitGcash: jest.fn(),
  createCheckoutSession: jest.fn(),
}));

jest.mock('../src/helpers/idGenerator', () => ({
  __esModule: true,
  toCamel: (x: any) => x,
}));

import * as paymentService from '../src/services/paymentService';
import { assertBookingAccess } from '../src/services/bookingAccessService';
import { approve, markCashPaid } from '../src/controllers/paymentController';

const assertAccess = assertBookingAccess as jest.Mock;
const approvePayment = paymentService.approvePayment as jest.Mock;
const markPaid = paymentService.markCashPaid as jest.Mock;

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const req = (uid: string | undefined, bookingId = '42') =>
  ({ params: { bookingId }, user: uid ? { uid } : undefined }) as any;

const HANDLERS: Array<[string, any, jest.Mock]> = [
  ['approve', approve, approvePayment],
  ['markCashPaid', markCashPaid, markPaid],
];

beforeEach(() => {
  jest.clearAllMocks();
  approvePayment.mockResolvedValue({ status: 'PAID' });
  markPaid.mockResolvedValue({ status: 'PAID' });
});

describe.each(HANDLERS)('%s', (name, handler, service) => {
  it('refuses a caller with no relationship to the booking', async () => {
    const { BookingAccessError } = jest.requireMock(
      '../src/services/bookingAccessService',
    );
    assertAccess.mockRejectedValue(
      new BookingAccessError('denied', 403, 'BOOKING_ACCESS_DENIED'),
    );
    const res = mockRes();

    await handler(req('uid-stranger'), res);

    expect(service).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('refuses the CUSTOMER even though the booking is theirs', async () => {
    // The regression that matters. Ownership passes; settlement must not.
    assertAccess.mockResolvedValue('customer');
    const res = mockRes();

    await handler(req('uid-customer'), res);

    expect(service).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows the assigned provider', async () => {
    assertAccess.mockResolvedValue('provider');
    const res = mockRes();

    await handler(req('uid-provider'), res);

    expect(service).toHaveBeenCalledWith(42);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success' }),
    );
  });

  it('allows an admin', async () => {
    assertAccess.mockResolvedValue('admin');
    const res = mockRes();

    await handler(req('uid-admin'), res);

    expect(service).toHaveBeenCalledWith(42);
  });

  it('authorizes before touching the payment record', async () => {
    // The settlement UPDATE carries no owner predicate of its own, so the guard
    // running first is the only thing standing between a stranger and a
    // stranger's money.
    assertAccess.mockImplementation(async () => {
      expect(service).not.toHaveBeenCalled();
      return 'admin';
    });

    await handler(req('uid-admin'), mockRes());
    expect(assertAccess).toHaveBeenCalledWith(42, 'uid-admin');
  });
});
