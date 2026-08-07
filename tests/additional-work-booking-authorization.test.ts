jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/services/paymentService', () => ({ createPayment: jest.fn() }));
jest.mock('../src/services/refund.service', () => ({ refundService: {} }));
jest.mock('../src/helpers/mailer', () => ({ send: jest.fn() }));
jest.mock('../src/services/user.service', () => ({ getUserInfoByBookingId: jest.fn() }));

import dbQuery from '../src/db/dbQuery';
import { additionalService } from '../src/services/additional.service';

const query = dbQuery.query as jest.Mock;

describe('additional-work booking authorization', () => {
  beforeEach(() => jest.clearAllMocks());

  it('allows the assigned provider to create or read additional work', async () => {
    query.mockResolvedValue({ rows: [{ id: 42, user_id: 'customer-a', worker_uid: 'provider-a' }], rowCount: 1 });
    await expect(additionalService.authorizeBookingActor(42, 'provider-a', 'provider'))
      .resolves.toEqual(expect.objectContaining({ id: 42 }));
  });

  it('allows the booking customer to read but not create provider additional work', async () => {
    query.mockResolvedValue({ rows: [{ id: 42, user_id: 'customer-a', worker_uid: 'provider-a' }], rowCount: 1 });
    await expect(additionalService.authorizeBookingActor(42, 'customer-a', 'participant')).resolves.toBeTruthy();
    await expect(additionalService.authorizeBookingActor(42, 'customer-a', 'provider'))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns the same not-found boundary for strangers and missing bookings', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 42, user_id: 'customer-a', worker_uid: 'provider-a' }], rowCount: 1 });
    await expect(additionalService.authorizeBookingActor(42, 'stranger', 'participant'))
      .rejects.toMatchObject({ statusCode: 404, message: 'Booking not found' });

    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(additionalService.authorizeBookingActor(99, 'provider-a', 'participant'))
      .rejects.toMatchObject({ statusCode: 404, message: 'Booking not found' });
  });
});
