export type CustomerBookingCreatePayload = {
  userAddressId: string;
  serviceOptionId: number;
  schedule: string;
  paymentMethod: 'CASH' | 'GCASH' | 'PAYMONGO';
  pricing: Record<string, unknown>;
};

export function validateCustomerBookingCreatePayload(
  raw: unknown,
  nowMs = Date.now(),
): CustomerBookingCreatePayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Booking details are required.');
  }
  const body = raw as Record<string, unknown>;
  const userAddressId = String(body.userAddressId ?? '').trim();
  if (!userAddressId) throw new Error('A service address is required.');

  const serviceOptionId = Number(body.serviceOptionId);
  if (!Number.isSafeInteger(serviceOptionId) || serviceOptionId <= 0) {
    throw new Error('A valid service option is required.');
  }

  const schedule = String(body.schedule ?? '').trim();
  const scheduleMs = Date.parse(schedule);
  if (!schedule || !Number.isFinite(scheduleMs)) {
    throw new Error('A valid booking schedule is required.');
  }
  if (scheduleMs <= nowMs) {
    throw new Error('The booking schedule must be in the future.');
  }

  const paymentMethod = String(body.paymentMethod ?? '').trim().toUpperCase();
  if (!['CASH', 'GCASH', 'PAYMONGO'].includes(paymentMethod)) {
    throw new Error('A valid payment method is required.');
  }

  const pricing = body.pricing;
  return {
    userAddressId,
    serviceOptionId,
    schedule: new Date(scheduleMs).toISOString(),
    paymentMethod: paymentMethod as CustomerBookingCreatePayload['paymentMethod'],
    pricing:
      pricing && typeof pricing === 'object' && !Array.isArray(pricing)
        ? pricing as Record<string, unknown>
        : {},
  };
}
