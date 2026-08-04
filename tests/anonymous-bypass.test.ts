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
  /**
   * REVERSED. This block used to assert the vulnerability.
   *
   * It required bookingService.ts to CONTAIN the string
   * `customerUid && ownerId && ownerId !== customerUid`, reasoning that the
   * guard was "only safe because the route can no longer be reached
   * anonymously". That reasoning was wrong, and the test made it permanent.
   *
   * `bookings.user_id` is NULL on a guest booking, so the middle term is falsy
   * and the comparison never runs — authenticated or not. Any logged-in user
   * could cancel any guest booking. Requiring the string kept the fail-open
   * shape pinned in place, and a green suite reported it as intended design.
   *
   * That is twice now: leak-isolation.test.js asserted that
   * /user/:userId/addresses "uses verifyAuthOptional for mobile parity". A test
   * that pins an implementation detail it does not understand is worse than no
   * test — it converts a bug into a requirement.
   */
  it('cancellation fails closed rather than relying on the route in front', () => {
    const routes = read('routes', 'booking.routes.ts');
    expect(routes).toMatch(/\/bookings\/:id\/cancel",\s*verifyAuth/);

    const service = read('services', 'bookingService.ts');
    expect(service).not.toContain('customerUid && ownerId && ownerId !== customerUid');
    expect(service).toMatch(/await assertBookingAccess\(\s*bookingId,\s*customerUid\s*\)/);
  });

  it('listUserBookings requires the actor to be present AND to match', () => {
    // Was: /actor\?\.uid && actor\.uid !== userId/ — present-and-differs, which
    // skips the check when the actor is absent. Now absent-or-differs.
    const src = read('controllers', 'bookingController.ts');
    expect(src).toMatch(/if\s*\(!actor\?\.uid\s*\|\|\s*actor\.uid\s*!==\s*userId\)/);
    expect(src).not.toMatch(/if\s*\(actor\?\.uid\s*&&\s*actor\.uid\s*!==\s*userId\)/);
  });

  it('address reads require the caller to be present AND to match', () => {
    const src = read('controllers', 'user.controller.ts');
    expect(src).toMatch(/if\s*\(!req\.user\?\.uid\s*\|\|\s*req\.user\.uid\s*!==\s*userId\)/);
    expect(src).not.toMatch(/if\s*\(req\.user\s*&&\s*req\.user\.uid\s*!==\s*userId\)/);
  });

  it('no controller still claims mobile calls arrive without a token', () => {
    // The premise behind every one of these guards, and it was never true for
    // the released apps. Both attach a bearer token to every request.
    for (const f of ['bookingController.ts', 'user.controller.ts']) {
      expect(read('controllers', f)).not.toMatch(/unauthenticated (path|calls) .*parity/i);
    }
  });
});
