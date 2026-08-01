/**
 * The anonymous-bypass class of bug.
 *
 * Three routes sat behind `verifyAuthOptional` — a middleware that verifies a
 * token when one is present and passes through when it is not. Their
 * controllers then guarded with:
 *
 *     if (actor?.uid && actor.uid !== userId) deny
 *
 * which reads as an ownership check but is not one. With no Authorization
 * header, `actor` is undefined, the condition short-circuits, and the request
 * proceeds unchecked. Sending *no* credentials was strictly more powerful than
 * sending someone else's.
 *
 * Affected: listing any customer's bookings, reading any customer's saved home
 * addresses, and cancelling any customer's booking — the last also writing a
 * timeline row with `actor_uid = NULL`, so the cancellation was unattributable
 * (§15, §16).
 *
 * Every real caller already sends a Bearer token, so the "mobile may call
 * without a token" premise the middleware was chosen for did not hold.
 *
 * These are source-level assertions, matching the existing leak-isolation.test.js
 * convention, so they run without a server or database.
 */

import fs from 'fs';
import path from 'path';

const SRC = (...p: string[]) =>
  path.join(__dirname, '..', 'src', ...p);

const read = (...p: string[]) => fs.readFileSync(SRC(...p), 'utf8');

describe('no customer-scoped route uses optional auth', () => {
  const ROUTE_FILES = ['booking.routes.ts', 'user.route.ts'];

  it.each(ROUTE_FILES)('%s registers no route with verifyAuthOptional', (file) => {
    const src = read('routes', file);
    const optional = src
      .split('\n')
      .filter((l) => /^router\.(get|post|put|patch|delete)/.test(l.trim()))
      .filter((l) => l.includes('verifyAuthOptional'));
    expect(optional).toEqual([]);
  });

  it.each(ROUTE_FILES)('%s does not import verifyAuthOptional', (file) => {
    // Keeping the import around is an invitation to reach for it again.
    expect(read('routes', file)).not.toMatch(/^import verifyAuthOptional/m);
  });

  it('verifyAuthOptional is unused by every route file', () => {
    const dir = SRC('routes');
    const offenders = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => fs.readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .some((l) => /^router\./.test(l.trim()) && l.includes('verifyAuthOptional')));
    expect(offenders).toEqual([]);
  });
});

describe('the three previously-bypassable routes require authentication', () => {
  const CASES: Array<[string, string, RegExp]> = [
    ['list a customer\'s bookings', 'booking.routes.ts', /router\.get\("\/users\/:userId\/bookings",\s*verifyAuth\b/],
    ['cancel a booking', 'booking.routes.ts', /router\.post\("\/bookings\/:id\/cancel",\s*verifyAuth\b/],
    ['read saved addresses', 'user.route.ts', /router\.get\("\/user\/:userId\/addresses",\s*verifyAuth\b/],
  ];

  it.each(CASES)('%s', (_name, file, pattern) => {
    expect(read('routes', file)).toMatch(pattern);
  });
});

describe('the guards that made the bypass invisible', () => {
  it('cancellation cannot record a NULL actor once auth is required', () => {
    // customerCancelBooking still guards with `if (customerUid && ...)`, which
    // is only safe because the route can no longer be reached anonymously.
    // If the route is ever loosened again, this pairing silently breaks — so
    // assert the route side, which is the load-bearing half.
    const routes = read('routes', 'booking.routes.ts');
    expect(routes).toMatch(/\/bookings\/:id\/cancel",\s*verifyAuth/);

    const service = read('services', 'bookingService.ts');
    expect(service).toContain('customerUid && ownerId && ownerId !== customerUid');
  });

  it('listUserBookings still compares the actor to the requested userId', () => {
    // Auth alone is not enough: an authenticated customer must not read another
    // customer's list either.
    const src = read('controllers', 'bookingController.ts');
    expect(src).toMatch(/actor\?\.uid\s*&&\s*actor\.uid\s*!==\s*userId/);
  });
});
