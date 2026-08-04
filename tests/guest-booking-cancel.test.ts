/**
 * The fail-open guard that survived bd8c355, and the linked-guest ownership gap.
 *
 * bd8c355 removed `verifyAuthOptional` from every route, which was described at
 * the time as closing the anonymous-bypass class. It closed the *carrier*, not
 * the class. The same shape — `if (a && a !== b) throw` — was still living one
 * layer down in the service:
 *
 *     if (customerUid && ownerId && ownerId !== customerUid) throw 403
 *
 * `bookings.user_id` is NULL on a guest booking (§8, admin-created), so `ownerId
 * &&` short-circuits and the guard never fires. Any authenticated user could
 * cancel any guest booking. Two independent audit agents derived this from the
 * source before it was confirmed by hand.
 *
 * The same NULL owner also made linked guest bookings unreachable in the other
 * direction: 880d5bc taught the booking LIST query to match
 * `guest_customers.linked_customer_uid`, but resolveBookingAccess still keyed on
 * `user_id` alone — so a linked booking appeared in the customer's list and 403'd
 * when they tapped it. One root cause, two opposite symptoms.
 */

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

jest.mock('../src/config', () => ({
  db: { schema: 'servana' },
}));

import fs from 'fs';
import path from 'path';
import dbQuery from '../src/db/dbQuery';
import { resolveBookingAccess } from '../src/services/bookingAccessService';

const q = dbQuery.query as jest.Mock;

const OWNER = 'uid-customer-owner';
const STRANGER = 'uid-customer-stranger';
const BOOKING = 91;
const GUEST_ID = 'guest-abc';

const SRC = path.join(__dirname, '..', 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

beforeEach(() => q.mockReset());

/**
 * Stubs the lookups resolveBookingAccess makes, in order:
 *   1. booking row (user_id, guest_customer_id)
 *   2. guest link  — only when guest_customer_id is present
 *   3. active booking_workers row
 *   4. actor role
 */
function stubGuestBooking(opts: { linkedTo?: string | null }) {
  q.mockReset();
  q.mockResolvedValueOnce({
    rowCount: 1,
    rows: [{ user_id: null, guest_customer_id: GUEST_ID }],
  });
  const linked = opts.linkedTo;
  q.mockResolvedValueOnce({ rowCount: linked ? 1 : 0, rows: linked ? [{ '?column?': 1 }] : [] });
  q.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // not the assigned provider
  q.mockResolvedValueOnce({ rowCount: 1, rows: [{ role: 3 }] }); // a customer, not admin
}

describe('guest bookings fail closed', () => {
  it('a stranger gets no access to an UNLINKED guest booking', async () => {
    stubGuestBooking({ linkedTo: null });
    await expect(resolveBookingAccess(BOOKING, STRANGER)).resolves.toBeNull();
  });

  it('a stranger gets no access to a guest booking linked to someone else', async () => {
    // The link row exists but does not match this actor, so the lookup — which
    // filters on linked_customer_uid = $2 — returns nothing.
    stubGuestBooking({ linkedTo: null });
    await expect(resolveBookingAccess(BOOKING, STRANGER)).resolves.toBeNull();
  });

  it('the linked customer IS the customer', async () => {
    stubGuestBooking({ linkedTo: OWNER });
    await expect(resolveBookingAccess(BOOKING, OWNER)).resolves.toBe('customer');
  });

  it('matches on the admin-set link column, never on phone number', async () => {
    stubGuestBooking({ linkedTo: OWNER });
    await resolveBookingAccess(BOOKING, OWNER);
    const linkSql = q.mock.calls[1][0] as string;
    expect(linkSql).toContain('linked_customer_uid');
    // 880d5bc removed phone matching from the list query because two people can
    // share a phone; re-introducing it here would undo that.
    expect(linkSql).not.toContain('phone_number');
  });

  it('skips the link lookup entirely for a normal booking', async () => {
    q.mockReset();
    q.mockResolvedValueOnce({ rowCount: 1, rows: [{ user_id: OWNER, guest_customer_id: null }] });
    await expect(resolveBookingAccess(BOOKING, OWNER)).resolves.toBe('customer');
    expect(q).toHaveBeenCalledTimes(1);
  });
});

describe('the cancel path no longer guards itself', () => {
  const svc = read('services', 'bookingService.ts');
  const cancel = svc.slice(
    svc.indexOf('export const customerCancelBooking'),
    svc.indexOf('export const customerCancelBooking') + 2600,
  );

  it('delegates to assertBookingAccess instead of comparing ids inline', () => {
    expect(cancel).toMatch(/await assertBookingAccess\(\s*bookingId,\s*customerUid\s*\)/);
  });

  it('no longer contains the fail-open ownership comparison', () => {
    // The precise shape that let it through. Anchored on the `&&` chain rather
    // than on variable names so a rename cannot quietly restore it.
    expect(cancel).not.toMatch(/if\s*\(\s*customerUid\s*&&\s*ownerId\s*&&/);
    expect(cancel).not.toMatch(/ownerId\s*&&\s*ownerId\s*!==/);
  });

  it('refuses a provider, who declines rather than cancels', () => {
    expect(cancel).toMatch(/actorRole === 'provider'/);
  });

  it('destructures only what it still uses', () => {
    // A leftover `user_id: ownerId` would be the tell that the old guard is
    // being reconstructed somewhere below.
    expect(cancel).not.toContain('user_id: ownerId');
  });
});

describe('the retry job cannot bill a cancelled booking', () => {
  const scheduler = read('scheduler.ts');

  it('excludes both spellings of cancelled', () => {
    const filter = scheduler.match(/NOT IN \(([^)]*)\)/)?.[1] ?? '';
    expect(filter).toContain("'CANCELED'");
    expect(filter).toContain("'CANCELLED'");
  });

  it('compares case-insensitively', () => {
    expect(scheduler).toMatch(/UPPER\(b\.status\) NOT IN/);
  });

  it('still excludes the terminal states it always did', () => {
    const filter = scheduler.match(/NOT IN \(([^)]*)\)/)?.[1] ?? '';
    expect(filter).toContain("'COMPLETED'");
    expect(filter).toContain("'PAID'");
  });

  it('covers every spelling the codebase actually writes to bookings.status', () => {
    // Guards against a third spelling appearing later. Only bookings.status
    // matters here — booking_workers.status is a different column with its own
    // vocabulary, so restrict the scan to UPDATEs against bookings.
    const svc = read('services', 'bookingService.ts') + read('services', 'technicianService.ts');
    const filter = scheduler.match(/NOT IN \(([^)]*)\)/)?.[1] ?? '';
    const written = new Set(
      [...svc.matchAll(/UPDATE \$\{dbSchema\}\.bookings\s+SET[^;]*?status\s*=\s*'([A-Z_]+)'/g)]
        .map((m) => m[1])
        .filter((s) => s.startsWith('CANCEL')),
    );
    expect(written.size).toBeGreaterThan(0);
    for (const spelling of written) expect(filter).toContain(`'${spelling}'`);
  });
});
