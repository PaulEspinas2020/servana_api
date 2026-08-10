jest.mock('../src/services/bookingAccessService', () => {
  class BookingAccessError extends Error {
    constructor(
      message: string,
      public statusCode: number,
      public code: string,
    ) { super(message); }
  }
  return {
    __esModule: true,
    BookingAccessError,
    assertBookingAccess: jest.fn(),
    sendBookingAccessError: jest.fn((res: any, error: any) => {
      if (!(error instanceof BookingAccessError)) return false;
      res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
      return true;
    }),
  };
});

jest.mock('../src/services/paymentService', () => ({
  __esModule: true,
  createCheckoutSession: jest.fn(),
}));
jest.mock('../src/helpers/idGenerator', () => ({ toCamel: (value: any) => value }));

import { createPaymongoPayment } from '../src/controllers/paymentController';
import { assertBookingAccess } from '../src/services/bookingAccessService';
import { createCheckoutSession } from '../src/services/paymentService';

const access = assertBookingAccess as jest.Mock;
const create = createCheckoutSession as jest.Mock;

const response = () => {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  create.mockResolvedValue({ checkout_url: 'https://checkout.paymongo.com/session/test' });
});

describe('PayMongo checkout access', () => {
  test.each(['customer', 'admin'])('%s may start checkout', async (role) => {
    access.mockResolvedValue(role);
    const res = response();
    await createPaymongoPayment({ params: { bookingId: '42' }, user: { uid: 'actor' } } as any, res);
    // No Origin header — a native mobile caller. returnOrigin is undefined, so
    // the service falls back to the configured default exactly as before.
    expect(create).toHaveBeenCalledWith(42, { returnOrigin: undefined });
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      checkout_url: 'https://checkout.paymongo.com/session/test',
    });
  });

  test('an allowlisted browser Origin is threaded through to the service', async () => {
    access.mockResolvedValue('customer');
    const res = response();
    await createPaymongoPayment({
      params: { bookingId: '42' },
      user: { uid: 'customer' },
      headers: { origin: 'https://client.servana.com.ph' },
    } as any, res);
    expect(create).toHaveBeenCalledWith(42, { returnOrigin: 'https://client.servana.com.ph' });
  });

  test('an unrecognised Origin falls back to the default, never to itself', async () => {
    access.mockResolvedValue('customer');
    const res = response();
    await createPaymongoPayment({
      params: { bookingId: '42' },
      user: { uid: 'customer' },
      headers: { origin: 'https://evil.example.com' },
    } as any, res);
    expect(create).toHaveBeenCalledWith(42, { returnOrigin: undefined });
  });

  test('provider cannot receive the customer checkout URL', async () => {
    access.mockResolvedValue('provider');
    const res = response();
    await createPaymongoPayment({ params: { bookingId: '42' }, user: { uid: 'provider' } } as any, res);
    expect(create).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('processor failures keep their stable public code and status', async () => {
    access.mockResolvedValue('customer');
    create.mockRejectedValue(Object.assign(
      new Error('Online payment is temporarily unavailable'),
      { code: 'PAYMONGO_CHECKOUT_FAILED', statusCode: 502 },
    ));
    const res = response();
    await createPaymongoPayment({ params: { bookingId: '42' }, user: { uid: 'customer' } } as any, res);
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      code: 'PAYMONGO_CHECKOUT_FAILED',
      message: 'Online payment is temporarily unavailable',
    });
  });
});
