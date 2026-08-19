/**
 * No v1 successor may be less restrictive than the route it supersedes (TAB 04).
 *
 * ## Why this could not be checked before
 *
 * `ContractEntry.auth` gives every v1 route a machine-readable access rule.
 * `LegacyMapping` gives its predecessor a method, a path, a disposition and a
 * note — and nothing about who may call it. So a v1 endpoint could drop a role
 * bar its predecessor carried and no gate would notice.
 *
 * `scripts/legacy-authz-inventory.ts` derives the legacy rule from the mounted
 * middleware chain, which is how Express actually decides, and compares.
 *
 * ## Three exemptions, each of which was a false positive first
 *
 * The unrefined comparison reported NINE. Every one was wrong, and in a
 * different way:
 *
 *   1. `/me/…` — role-scoped legacy becomes self-scoped canonical. Demanding
 *      `provider` on `/me/notification-preferences` refuses a CUSTOMER their
 *      own settings, which inverts the goal.
 *   2. object-scoped — `/bookings/:bookingId/timeline` is `authenticated`
 *      because `assertBookingAccess` decides, not the role.
 *   3. `ROLE_SPECIFIC` — `POST /api/auth/add-employees` is admin bulk
 *      PROVISIONING and is RETAINED, not superseded. Comparing it against
 *      public self-registration reads as privilege escalation that does not
 *      exist.
 *
 * A check that reported those nine would have been switched off within a week.
 * Getting to zero honestly is what makes the first real one credible.
 */

import {
  loosenings,
  authOf,
  capabilitiesOf,
  capabilityLoosenings,
  resolvedChain,
  requiresActiveProvider,
} from '../scripts/legacy-authz-inventory';
import { buildMountedRoutes } from '../scripts/lib/routeTable';

describe('legacy → v1 authorization parity', () => {
  it('reads the mounted routes at all (positive fixture)', () => {
    // A broken route table would find none and pass the real check forever.
    expect(buildMountedRoutes().length).toBeGreaterThan(500);
  });

  it('classifies a chain at its strictest rung', () => {
    const admin = { handlers: ['verifyAuth', 'verifyRoles([1])'] } as never;
    const provider = { handlers: ['verifyAuth', 'requireProviderRole'] } as never;
    const authed = { handlers: ['verifyAuth'] } as never;
    const open = { handlers: ['someController.handler'] } as never;

    // A chain carrying several is reported at the strictest, because that is
    // what a request actually has to survive.
    expect(authOf(admin)).toBe('admin');
    expect(authOf(provider)).toBe('provider');
    expect(authOf(authed)).toBe('authenticated');
    expect(authOf(open)).toBe('public');
  });

  it('no superseded legacy route is stricter than its v1 successor', () => {
    expect(loosenings()).toEqual([]);
  });

  /**
   * The role ladder was not the whole rule, and its silence was not evidence.
   *
   * `authOf` knows `verifyRoles`, `requireProviderRole` and `verifyAuth`. It has
   * no word for `requireCapability`, so a chain of
   * [verifyAuth, requireProviderRole, requireCapability("canViewEarnings")]
   * resolved to plain `provider` — equal to the v1 entry's `provider`, so the
   * strictness comparison short-circuited and the check above reported zero
   * while three live v1 earnings endpoints were reachable without the capability
   * their legacy aliases require.
   *
   * When this dimension was first added it found FOUR. That is the number worth
   * remembering: a gate reporting zero because it cannot see the thing is
   * indistinguishable from a gate reporting zero because the thing is absent.
   */
  it('reads capabilities out of a chain (positive AND negative fixture)', () => {
    const guarded = {
      handlers: ['verifyAuth', 'requireProviderRole', 'requireCapability("canViewEarnings")'],
    } as never;
    const plain = { handlers: ['verifyAuth', 'requireProviderRole'] } as never;

    expect(capabilitiesOf(guarded)).toEqual(['canViewEarnings']);
    // The negative fixture matters more than the positive one here: a matcher
    // that returned a capability for every chain would make the gate below
    // unfailable in the other direction.
    expect(capabilitiesOf(plain)).toEqual([]);
    expect(authOf(guarded)).toBe('provider');
    expect(authOf(plain)).toBe('provider');
  });

  it('no v1 successor drops a capability its legacy route requires', () => {
    expect(capabilityLoosenings()).toEqual([]);
  });

  /**
   * The ladder reads middleware by NAME, and 224 of 520 legacy routes declare
   * their auth as `...adminOnly` — an array defined in the same file as
   * `[verifyAuth, verifyRoles([1]), adminRateLimit]`. The literal spread carries
   * none of the ladder's names, so every one of those routes classified as
   * `public`: the WEAKEST rung.
   *
   * That is not a cosmetic mislabel. `loosenings()` reports only when the legacy
   * route is STRICTER than its v1 successor, so a route mis-read as `public` can
   * never produce a finding — the gate was blind across 43% of the legacy
   * surface, and 83% of its own "public" bucket was wrong.
   *
   * Resolution is per-file on purpose: `technician.routes.ts` defines the same
   * alias as `verifyRoles([0, 1])`, so a single shared definition would report
   * role 0 as admin.
   */
  it('resolves a spread middleware alias against the file that defines it', () => {
    const adminRoute = buildMountedRoutes().find(
      (r) => r.handlers.join(' ').includes('...adminOnly') && r.file.includes('adminCustomer'),
    );
    expect(adminRoute).toBeDefined();

    // Before resolution the chain names no ladder middleware at all.
    expect(adminRoute!.handlers.join(' ')).not.toMatch(/verifyRoles/);
    // After it, the real chain is visible and the route reads as admin.
    expect(resolvedChain(adminRoute!)).toMatch(/verifyRoles\(\[1\]\)/);
    expect(authOf(adminRoute!)).toBe('admin');
  });

  it('leaves an alias it cannot resolve exactly as written (negative fixture)', () => {
    // Widening the chain is safe; inventing one is not. An unknown alias must
    // pass through untouched rather than resolve to something convenient.
    const fake = { handlers: ['...noSuchAlias', 'ctrl.handler'], file: 'src/routes/adminCustomer.routes.ts' } as never;
    expect(resolvedChain(fake)).toContain('...noSuchAlias');
    expect(authOf(fake)).toBe('public');
  });

  it('no longer classifies the bulk of the legacy surface as public', () => {
    // The number that made the blindness visible. 270 of 520 were called public
    // before resolution; anything near that again means the alias stopped
    // resolving and the gate went quiet without failing.
    const legacy = buildMountedRoutes().filter((r) => !r.fullPath.startsWith('/api/v1'));
    const pub = legacy.filter((r) => authOf(r) === 'public');
    expect(pub.length).toBeLessThan(legacy.length / 4);
    expect(pub.filter((r) => r.handlers.join(' ').includes('...'))).toEqual([]);
  });

  /**
   * `requireActiveProvider` was a third invisible dimension.
   *
   * Not a role rung and not a named capability, so a chain carrying it resolved
   * to plain `provider` — identical to a v1 entry declaring `auth: 'provider'`.
   * All seven legacy provider job actions carry it, and their v1 successors
   * carried no active-status check anywhere: not in the chain, not in
   * `domains/bookingActions`, not in `transitionExecutor`.
   *
   * Its own docblock says what that means: a suspended provider's token stays
   * valid, `verifyAuth` keeps passing, and "anyone holding that token, including
   * the suspended provider with any HTTP client, could still accept bookings,
   * start jobs and move their location." The v1 surface reopened that on a WRITE
   * path, and the eighth case — additional-work — is one the portal has already
   * migrated to.
   */
  it('reads requireActiveProvider as its OWN dimension, not as a capability', () => {
    const guarded = {
      handlers: ['verifyAuth', 'requireProviderRole', 'requireActiveProvider', 'ctrl.acceptJob'],
      file: 'src/routes/provider.routes.ts',
    } as never;
    const plain = {
      handlers: ['verifyAuth', 'requireProviderRole', 'ctrl.get'],
      file: 'src/routes/provider.routes.ts',
    } as never;

    expect(requiresActiveProvider(guarded)).toBe(true);
    // The negative fixture: a matcher true for every provider chain would make
    // the gate unfailable in the other direction.
    expect(requiresActiveProvider(plain)).toBe(false);

    // And it must NOT be reported as a capability. The first version of this
    // gate mapped it onto `canAcceptJobs`, which is `fullyActive &&
    // complianceCurrent` — strictly stronger than a middleware that reads
    // `account_status` alone and treats a blank one as working. That mapping
    // made the v1 contract refuse providers the legacy route admits.
    expect(capabilitiesOf(guarded)).not.toContain('canAcceptJobs');
    expect(capabilitiesOf(guarded)).toEqual([]);

    // Both still read as `provider` on the role ladder, which is why the ladder
    // alone could never separate them.
    expect(authOf(guarded)).toBe('provider');
    expect(authOf(plain)).toBe('provider');
  });
});
