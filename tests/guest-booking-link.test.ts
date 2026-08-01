/**
 * How a guest booking becomes visible to a registered customer.
 *
 * `getBookingsByUserId` used to widen its WHERE clause with:
 *
 *     WHERE gc.phone_number IS NOT NULL AND gc.phone_number = uc.phone_number
 *
 * That was wrong twice. `guest_customers` has no `phone_number` column — it
 * stores `phone_normalized` — so the subquery raised at runtime and took the
 * entire booking list with it. And had the column existed, matching on an
 * unverified, non-unique phone number would have handed one customer another's
 * guest bookings: anyone who had ever given Servana the same number, including
 * a recycled or mistyped one.
 *
 * §8 is explicit that a guest is not automatically converted to a client. The
 * table already carries the deliberate, audited link — `linked_customer_uid`,
 * with `linked_at`, `linked_by_admin_uid` and `link_reason` beside it — so that
 * is the only path.
 *
 * Source-level assertions: this query is not reachable without a database, and
 * the property worth protecting is which columns it keys on.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', 'src');
const bookingService = fs.readFileSync(
  path.join(SRC, 'services', 'bookingService.ts'), 'utf8');

/** The `getBookingsByUserId` body, which owns the guest-visibility rule. */
function listQuery(): string {
  const i = bookingService.indexOf('getBookingsByUserId');
  expect(i).toBeGreaterThan(-1);
  const next = bookingService.indexOf('export const', i + 10);
  return bookingService.slice(i, next === -1 ? undefined : next);
}

describe('guest bookings are linked deliberately, never inferred', () => {
  it('keys on the explicit linked_customer_uid', () => {
    expect(listQuery()).toContain('gc.linked_customer_uid = $1');
  });

  it('never matches a guest to a customer by phone number', () => {
    const q = listQuery();
    expect(q).not.toMatch(/gc\.phone_number/);
    expect(q).not.toMatch(/gc\.phone_normalized\s*=\s*uc\./);
  });

  it('does not reference a column guest_customers lacks', () => {
    // The schema is declared in adminCreateBookingService/adminGuestService.
    // Anything selected off `gc.` must appear in one of those definitions.
    const schema = [
      fs.readFileSync(path.join(SRC, 'services', 'adminCreateBookingService.ts'), 'utf8'),
      fs.readFileSync(path.join(SRC, 'services', 'adminGuestService.ts'), 'utf8'),
    ].join('\n');

    const referenced = new Set(
      [...listQuery().matchAll(/\bgc\.([a-z_]+)/g)].map((m) => m[1]),
    );
    expect(referenced.size).toBeGreaterThan(0);

    for (const col of referenced) {
      expect(schema).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });
});

describe('the whole codebase', () => {
  it('has no remaining gc.phone_number reference', () => {
    const dir = path.join(SRC, 'services');
    const offenders = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /gc\.phone_number\b/.test(
        fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
