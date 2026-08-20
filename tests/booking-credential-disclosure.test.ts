/**
 * The one-time codes on a booking are credentials, and `formatBooking` was
 * handing them to the party they are meant to be proved TO.
 *
 * ## What was wrong
 *
 * `bookings` carries two one-time codes. `formatBooking` spreads the whole
 * camelCased row — `{ ...toCamel(raw) }` — and `getBookingById` selects `b.*`,
 * so both codes travelled to every caller who could read the booking at all.
 *
 * `worker_code` is the SERVICE_START credential.
 * `experiencePolicy.BOOKING_OTP_PURPOSES` states the property plainly: *"The
 * RECIPIENT is the customer even though the VERIFIER is the provider — that
 * inversion is the entire security property. The customer reads the code out on
 * the doorstep; the provider types it in."*
 *
 * `bookingAccessService.resolveBookingAccess` returns the role `provider` for
 * any worker whose assignment row is ASSIGNED, ACCEPTED, EN_ROUTE or ARRIVED —
 * every state BEFORE the start that code gates. So the assigned provider could
 * fetch the proof of presence from the API and start a job without arriving.
 *
 * ## Why no existing test caught it
 *
 * Nothing could bind to the shape. `Booking` was declared in the contract as
 * `{ type: 'object' }` with no properties, which openapi-typescript renders as
 * `Record<string, never>` — so no client and no contract assertion could say
 * what the response contains, and therefore none could say what it must NOT
 * contain. TAB 02 of the Admin API Master Command exists to close exactly that
 * hole, and this defect is what was hiding in it.
 *
 * ## What these tests pin
 *
 * The formatter denies by default and discloses only when a caller has
 * established the actor. They assert the leak is GONE rather than that the fix
 * is present: the first phrasing fails if somebody reintroduces the spread, the
 * second passes as long as the new code exists beside the old.
 */

import {
  formatBooking,
  formatBookings,
  BOOKING_CREDENTIAL_FIELDS,
} from '../src/services/bookingService';

/** A row exactly as `SELECT b.*` yields it for an ASSIGNED booking. */
const assignedRow = () => ({
  id: 4242,
  user_id: 'customer-uid',
  worker_uid: 'provider-uid',
  status: 'CONFIRMED',
  worker_status: 'ASSIGNED',
  schedule: '2026-08-21T00:00:00.000Z',
  otp_code: '123456',
  worker_code: '778899',
  quoted_price: '1500.00',
});

describe('booking credentials are not disclosed by default', () => {
  it('omits the doorstep start code', () => {
    const out = formatBooking(assignedRow());
    expect(out.workerCode).toBeUndefined();
    expect(out.worker_code).toBeUndefined();
  });

  it('omits the booking confirmation code', () => {
    const out = formatBooking(assignedRow());
    expect(out.otpCode).toBeUndefined();
    expect(out.otp_code).toBeUndefined();
  });

  it('leaks no credential under ANY key, not merely the two spellings checked', () => {
    // The stronger phrasing: search the whole emitted object for the VALUES.
    // A rename of the column, or a third code added to the table later, is
    // caught here and not by the two assertions above.
    const out = formatBooking(assignedRow());
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain('778899');
    expect(serialised).not.toContain('123456');
  });

  it('still returns everything that is not a credential', () => {
    // Deny-by-default must not become deny-everything: the reason this bug
    // survived is that the spread was doing real work for real fields.
    const out = formatBooking(assignedRow());
    expect(out.bookingId).toBe(4242);
    expect(out.providerUid).toBe('provider-uid');
    expect(out.customerUid).toBe('customer-uid');
    expect(out.bookingCode).toBe('SVN-004242');
    expect(out.scheduledAt).toBe('2026-08-21T00:00:00.000Z');
    expect(out.statusLower).toBe('confirmed');
  });
});

describe('booking credentials are disclosed when the caller establishes the actor', () => {
  it('returns the doorstep code to a caller that opts in', () => {
    // The customer legitimately needs it: BOOKING_OTP_PURPOSES declares
    // `delivery: 'booking_detail'`, so this response IS the delivery channel.
    const out = formatBooking(assignedRow(), { includeCredentials: true });
    expect(out.workerCode).toBe('778899');
    expect(out.otpCode).toBe('123456');
  });

  it('names the credential fields in one place', () => {
    // A second list of these field names, somewhere else, is how the next code
    // gets added to the table and to only one of the lists.
    expect([...BOOKING_CREDENTIAL_FIELDS].sort()).toEqual([
      'otpCode',
      'otp_code',
      'workerCode',
      'worker_code',
    ]);
  });
});

describe('the list formatter', () => {
  it('redacts every row, not merely the first', () => {
    const rows = [assignedRow(), { ...assignedRow(), id: 4243 }, { ...assignedRow(), id: 4244 }];
    const out = formatBookings(rows);
    expect(out).toHaveLength(3);
    for (const row of out) {
      expect(row.workerCode).toBeUndefined();
      expect(row.otpCode).toBeUndefined();
    }
  });

  it('does not pass the array INDEX where the options belong', () => {
    /**
     * `rows.map(formatBooking)` passes (value, index, array), so `index`
     * arrives as `options`. Row 0 gets `0` — falsy, redacted — and every row
     * after it gets a truthy number, whose `.includeCredentials` is undefined…
     * which is also falsy, so today it happens to be harmless.
     *
     * It is pinned anyway because it is harmless only by accident: the moment
     * the option object grows a field whose absence means "allow", the
     * arithmetic flips and rows 1..n disclose. A three-row fixture is what
     * makes the difference visible at all — a single-row test passes either way.
     */
    const rows = [assignedRow(), { ...assignedRow(), id: 4243 }];
    const serialised = JSON.stringify(formatBookings(rows));
    expect(serialised).not.toContain('778899');
  });

  it('opts in for every row when asked', () => {
    const out = formatBookings([assignedRow(), { ...assignedRow(), id: 4243 }], {
      includeCredentials: true,
    });
    for (const row of out) expect(row.workerCode).toBe('778899');
  });
});
