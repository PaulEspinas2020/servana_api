import { readFileSync } from 'fs';
import { join } from 'path';
import { isProviderRole, PROVIDER_ROLES } from '../src/constants/providerRoles';

/**
 * The provider self-service surface is for providers.
 *
 * Command 6, masterlist S-01 / access matrix A-01. Every route in
 * provider.routes.ts was `verifyAuth` only. Handlers scope by the token's uid,
 * so this was never a cross-account leak — but a customer token reached the
 * whole surface: dashboard, ledger, payout settings, safety incidents,
 * onboarding submission.
 *
 * Two halves are tested here, and they fail in different ways:
 *
 *   1. The predicate — unit, with positive AND negative controls. A guard whose
 *      test only feeds it the values it accepts proves nothing; the same lesson
 *      as the detector that once deleted six secured routes because nobody
 *      checked what it did to input it should reject.
 *   2. The wiring — read as text. Middleware that exists and is not mounted is
 *      the most common way a security fix fails silently, and no unit test of
 *      the middleware can see it.
 */

const ROUTES = readFileSync(
  join(__dirname, '..', 'src', 'routes', 'provider.routes.ts'),
  'utf8'
);

/**
 * Routes deliberately reachable by a non-provider. Each is a real caller, not
 * an oversight — the customer app tracks its own booking's provider, and the
 * discovery endpoint has to be able to tell someone why they are refused.
 */
const UNGUARDED_BY_DESIGN = new Set([
  '/provider/account-state',
  '/admin/provider/reconciliation',
  '/booking/:bookingId/provider-location',
  '/booking/:bookingId/provider',
]);

type Route = { method: string; path: string; line: string };

function parseRoutes(src: string): Route[] {
  const out: Route[] = [];
  for (const line of src.split('\n')) {
    const m = line.match(/^router\.(get|post|put|patch|delete)\("([^"]+)"/);
    if (m) out.push({ method: m[1], path: m[2], line });
  }
  return out;
}

describe('isProviderRole', () => {
  // Positive controls.
  it.each(['2', '4', 2, 4, ' 2 '])('accepts provider role %p', (role) => {
    expect(isProviderRole(role)).toBe(true);
  });

  it('accepts role 4 — a check written as role === 2 is wrong', () => {
    // Role 4 is a second provider role. No production account holds it yet
    // (read 2026-08-04), which is exactly why it is easy to drop and why it is
    // asserted separately rather than trusted to the table above.
    expect(PROVIDER_ROLES.has('4')).toBe(true);
  });

  // Negative controls. These are the roles that actually exist in production:
  // 1 × 6 admins, 3 × 31 customers, 6 × 2 accounts with no provider evidence.
  it.each(['1', '3', '6', '0', 1, 3, 6, '', '   ', 'provider', '2x', null, undefined, NaN])(
    'refuses %p',
    (role) => {
      expect(isProviderRole(role)).toBe(false);
    }
  );

  it('refuses an absent role rather than treating it as legacy', () => {
    // The deliberate contrast with account_status, where absence IS permitted.
    // That column was added after accounts existed, so null there means
    // "nothing was ever written" and denying on it caused a production outage.
    // `role` is NOT NULL and every one of the 109 production rows carries one,
    // so an absent role is an unknown actor, not an old one.
    expect(isProviderRole(null)).toBe(false);
    expect(isProviderRole(undefined)).toBe(false);
  });
});

describe('provider.routes.ts wiring', () => {
  const routes = parseRoutes(ROUTES);

  it('parses the route table at all', () => {
    // If this ever reads zero, every assertion below passes vacuously and the
    // suite would report a guarded surface that is entirely unguarded.
    expect(routes.length).toBeGreaterThan(50);
  });

  it('guards every route except the four documented exceptions', () => {
    const unguarded = routes
      .filter((r) => !r.line.includes('requireProviderRole'))
      .map((r) => r.path);
    expect(new Set(unguarded)).toEqual(UNGUARDED_BY_DESIGN);
  });

  it('keeps the guard after verifyAuth, never before it', () => {
    // Ordering is not cosmetic: the guard reads req.user.uid, which verifyAuth
    // sets. Reversed, every request would be refused as unauthenticated.
    for (const r of routes) {
      if (!r.line.includes('requireProviderRole')) continue;
      expect(r.line.indexOf('verifyAuth')).toBeLessThan(
        r.line.indexOf('requireProviderRole')
      );
    }
  });

  it('leaves the customer booking-tracking routes reachable', () => {
    // These are called by the CUSTOMER app for a booking it owns. Guarding
    // them would have broken live tracking for every customer, which is the
    // failure mode a blanket router.use() would have shipped.
    for (const path of [
      '/booking/:bookingId/provider-location',
      '/booking/:bookingId/provider',
    ]) {
      const r = routes.find((x) => x.path === path);
      expect(r).toBeDefined();
      expect(r!.line).not.toContain('requireProviderRole');
    }
  });

  it('leaves account-state reachable so a refusal can be explained', () => {
    const r = routes.find((x) => x.path === '/provider/account-state');
    expect(r!.line).not.toContain('requireProviderRole');
    expect(r!.line).toContain('verifyAuth');
  });
});

describe('one role vocabulary', () => {
  it('the state endpoint and the guard share a set', () => {
    // They answered the same question independently before this: the endpoint
    // said ROLE_NOT_PERMITTED while the routes let the caller through. Sharing
    // the constant is what stops them drifting again.
    const service = readFileSync(
      join(__dirname, '..', 'src', 'services', 'providerAccountStateService.ts'),
      'utf8'
    );
    const middleware = readFileSync(
      join(__dirname, '..', 'src', 'middleware', 'requireProviderRole.ts'),
      'utf8'
    );
    expect(service).toContain('constants/providerRoles');
    expect(middleware).toContain('constants/providerRoles');
    // And neither may re-declare its own copy.
    expect(service).not.toMatch(/const PROVIDER_ROLES\s*=/);
    expect(middleware).not.toMatch(/const PROVIDER_ROLES\s*=/);
  });

  it('ROLE_NOT_PERMITTED is spelled the same in both vocabularies', () => {
    const authErrors = readFileSync(
      join(__dirname, '..', 'src', 'errors', 'authErrors.ts'),
      'utf8'
    );
    const service = readFileSync(
      join(__dirname, '..', 'src', 'services', 'providerAccountStateService.ts'),
      'utf8'
    );
    // A client that already routes the nextStep code needs no second branch.
    expect(authErrors).toContain('ROLE_NOT_PERMITTED');
    expect(service).toContain('ROLE_NOT_PERMITTED');
  });
});
