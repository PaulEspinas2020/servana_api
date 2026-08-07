import { validateCustomerBookingCreatePayload } from '../src/services/bookingCreateValidation';

const now = Date.parse('2026-08-07T10:00:00.000Z');
const valid = () => ({
  userAddressId: 'address-1',
  serviceOptionId: 12,
  schedule: '2026-08-08T10:00:00.000Z',
  paymentMethod: 'PAYMONGO',
  pricing: { addonOptionIds: [3] },
});

describe('customer booking create boundary', () => {
  test('normalizes compatible scalar fields without trusting price totals', () => {
    const result = validateCustomerBookingCreatePayload({
      ...valid(),
      serviceOptionId: '12',
      paymentMethod: 'cash',
    }, now);
    expect(result.serviceOptionId).toBe(12);
    expect(result.paymentMethod).toBe('CASH');
    expect(result.schedule).toBe('2026-08-08T10:00:00.000Z');
    expect(result).not.toHaveProperty('totalAmount');
  });

  test.each([
    [null, 'Booking details'],
    [{ ...valid(), userAddressId: '' }, 'service address'],
    [{ ...valid(), serviceOptionId: 0 }, 'service option'],
    [{ ...valid(), schedule: 'not-a-date' }, 'booking schedule'],
    [{ ...valid(), schedule: '2026-08-07T09:59:59.000Z' }, 'future'],
    [{ ...valid(), paymentMethod: 'CARD' }, 'payment method'],
  ])('rejects an invalid boundary payload', (payload, message) => {
    expect(() => validateCustomerBookingCreatePayload(payload, now))
      .toThrow(message as string);
  });
});
