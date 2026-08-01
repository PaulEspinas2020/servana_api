/**
 * Booking-scoped authorization — cross-customer isolation.
 *
 * A failure here means one customer can read another customer's booking, which
 * carries their name, phone number and home address. Booking ids are sequential
 * integers, so an unscoped read is enumerable: before this guard existed,
 * `GET /api/1`, `/api/2`, `/api/3` … walked the entire table.
 *
 * These are pure unit tests over the access predicate with `dbQuery` mocked, so
 * they need no server and no database and cannot flake.
 */

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

jest.mock('../src/config', () => ({
  db: { schema: 'servana' },
}));

import dbQuery from '../src/db/dbQuery';
import {
  resolveBookingAccess,
  assertBookingAccess,
  BookingAccessError,
} from '../src/services/bookingAccessService';

const q = dbQuery.query as jest.Mock;

const CUSTOMER_A = 'uid-customer-A';
const CUSTOMER_B = 'uid-customer-B';
const PROVIDER = 'uid-provider-1';
const ADMIN = 'uid-admin-1';
const BOOKING = 4242;

/**
 * Stubs the three lookups the predicate makes, in order:
 *   1. the booking row (owner)
 *   2. the active booking_workers row
 *   3. the actor's role
 */
function stub(opts: {
  ownerUid?: string | null;
  bookingExists?: boolean;
  isActiveWorker?: boolean;
  role?: number | null;
}) {
  const {
    ownerUid = CUSTOMER_A,
    bookingExists = true,
    isActiveWorker = false,
    role = null,
  } = opts;

  q.mockReset();
  q.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM servana.bookings')) {
      return bookingExists
        ? { rowCount: 1, rows: [{ user_id: ownerUid }] }
        : { rowCount: 0, rows: [] };
    }
    if (sql.includes('booking_workers')) {
      return isActiveWorker
        ? { rowCount: 1, rows: [{ '?column?': 1 }] }
        : { rowCount: 0, rows: [] };
    }
    if (sql.includes('user_credentials')) {
      return role === null
        ? { rowCount: 0, rows: [] }
        : { rowCount: 1, rows: [{ role }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
}

describe('who may read a booking', () => {
  it('grants the owning customer', async () => {
    stub({ ownerUid: CUSTOMER_A });
    await expect(resolveBookingAccess(BOOKING, CUSTOMER_A)).resolves.toBe('customer');
  });

  it('REFUSES a different customer', async () => {
    // The whole point. Customer B must not read Customer A's booking.
    stub({ ownerUid: CUSTOMER_A });
    await expect(resolveBookingAccess(BOOKING, CUSTOMER_B)).resolves.toBeNull();
    await expect(assertBookingAccess(BOOKING, CUSTOMER_B)).rejects.toThrow(
      BookingAccessError,
    );
  });

  it('grants an actively assigned provider', async () => {
    stub({ ownerUid: CUSTOMER_A, isActiveWorker: true });
    await expect(resolveBookingAccess(BOOKING, PROVIDER)).resolves.toBe('provider');
  });

  it('REFUSES a provider whose assignment is not active', async () => {
    // A provider who declined the job, or was reassigned away, loses visibility
    // of the customer's address (§22 reassignment revokes future access).
    stub({ ownerUid: CUSTOMER_A, isActiveWorker: false });
    await expect(resolveBookingAccess(BOOKING, PROVIDER)).resolves.toBeNull();
  });

  it('grants an admin (role 1)', async () => {
    stub({ ownerUid: CUSTOMER_A, role: 1 });
    await expect(resolveBookingAccess(BOOKING, ADMIN)).resolves.toBe('admin');
  });

  it('REFUSES a non-admin role', async () => {
    stub({ ownerUid: CUSTOMER_A, role: 2 });
    await expect(resolveBookingAccess(BOOKING, 'uid-someone')).resolves.toBeNull();
  });
});

describe('fails closed', () => {
  it('refuses an unauthenticated caller', async () => {
    stub({});
    for (const actor of [null, undefined, '']) {
      await expect(resolveBookingAccess(BOOKING, actor)).resolves.toBeNull();
    }
    // No lookup should even be attempted without an actor.
    expect(q).not.toHaveBeenCalled();
  });

  it('refuses a guest booking to everyone but provider and admin', async () => {
    // Guest bookings (§8) are admin-created and have no user_id. A guest holds
    // no Servana login, so no token can ever match — which is correct: guests
    // are served by phone/Messenger, not through the app.
    stub({ ownerUid: null });
    await expect(resolveBookingAccess(BOOKING, CUSTOMER_A)).resolves.toBeNull();

    stub({ ownerUid: null, isActiveWorker: true });
    await expect(resolveBookingAccess(BOOKING, PROVIDER)).resolves.toBe('provider');

    stub({ ownerUid: null, role: 1 });
    await expect(resolveBookingAccess(BOOKING, ADMIN)).resolves.toBe('admin');
  });

  it('rejects a non-existent booking with 404, not 403', async () => {
    stub({ bookingExists: false });
    await expect(assertBookingAccess(BOOKING, CUSTOMER_A)).rejects.toMatchObject({
      statusCode: 404,
      code: 'BOOKING_NOT_FOUND',
    });
  });

  it('rejects a malformed booking id without querying', async () => {
    stub({});
    for (const id of [0, -1, NaN, 1.5]) {
      await expect(resolveBookingAccess(id, CUSTOMER_A)).resolves.toBeNull();
    }
    expect(q).not.toHaveBeenCalled();
  });

  it('uses 403 for a real booking that is not yours', async () => {
    // Deliberately not 404: the ids are sequential so 404 would leak existence
    // by omission anyway, while making genuine "deleted booking" bugs
    // indistinguishable from permission errors.
    stub({ ownerUid: CUSTOMER_A });
    await expect(assertBookingAccess(BOOKING, CUSTOMER_B)).rejects.toMatchObject({
      statusCode: 403,
      code: 'BOOKING_ACCESS_DENIED',
    });
  });
});

describe('error shape is safe to surface (§21)', () => {
  it('carries no SQL, schema or internal detail', async () => {
    stub({ ownerUid: CUSTOMER_A });
    const err = await assertBookingAccess(BOOKING, CUSTOMER_B).catch((e) => e);
    expect(err).toBeInstanceOf(BookingAccessError);
    for (const leak of ['SELECT', 'servana.', 'bookings', 'user_credentials', 'pg']) {
      expect(err.message).not.toContain(leak);
    }
  });

  it('does not reveal the owner of a booking you cannot see', async () => {
    stub({ ownerUid: CUSTOMER_A });
    const err = await assertBookingAccess(BOOKING, CUSTOMER_B).catch((e) => e);
    expect(err.message).not.toContain(CUSTOMER_A);
  });
});
