/**
 * Cross-platform customer projection. bookings owns terminal/cancellation
 * state; booking_workers owns the provider lifecycle after acceptance.
 */
export const deriveEffectiveBookingStatus = (
  bookingStatus: unknown,
  workerStatus: unknown,
): string => {
  const booking = String(bookingStatus ?? '').toUpperCase();
  const worker = String(workerStatus ?? '').toUpperCase();

  if (['CANCELLED', 'CANCELED', 'COMPLETED', 'REFUNDED', 'FAILED', 'EXPIRED'].includes(booking)) {
    return booking;
  }
  if (['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED'].includes(worker)) {
    return worker;
  }
  return booking;
};
