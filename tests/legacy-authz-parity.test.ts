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

import { loosenings, authOf } from '../scripts/legacy-authz-inventory';
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
});
