/**
 * Dismiss resolves the caller's STORE, like every other inbox verb.
 *
 * ## The defect this exists to prevent, which already happened once
 *
 * `notifications.list` used to call `listCustomerNotifications` directly. A
 * PROVIDER calling the canonical endpoint therefore received an empty array —
 * not an error, not a 403, just nothing — because their rows live in
 * `provider_notifications` and that function only ever reads
 * `customer_notifications`. The v1 inbox exists to make that unrepresentable.
 *
 * `dismiss` arrives last of the four verbs, and it is the one most able to
 * repeat the mistake: the legacy route it replaces is provider-only and calls
 * `deleteNotificationByKey`, which is hardcoded to `provider_notifications`.
 * Wiring the v1 handler straight to it would compile, pass a provider test, and
 * silently miss for every customer — a DELETE that reports success and deletes
 * nothing.
 *
 * These tests assert the ROUTING, not the SQL. Which table each service touches
 * is that service's business; which service is called for which caller is this
 * module's, and it is the part that was wrong before.
 */

import * as notificationService from '../src/services/notification.service';
import * as inbox from '../src/services/events/notificationInbox';

jest.mock('../src/services/notification.service', () => ({
  __esModule: true,
  deleteNotificationByKey: jest.fn(),
  deleteCustomerNotificationByKey: jest.fn(),
  countUnreadNotifications: jest.fn(),
  countCustomerUnreadNotifications: jest.fn(),
  isSafeNotificationKey: jest.fn(() => true),
}));

jest.mock('../src/services/adminNotificationService', () => ({
  __esModule: true,
  unreadCount: jest.fn(async () => 0),
}));

const svc = notificationService as jest.Mocked<typeof notificationService>;

/**
 * Role ids as `storeForRole` actually reads them — checked against
 * `constants/providerRoles.ts` and `STAFF_ROLES`, not assumed.
 *
 * Providers are **2 and 4**, and 4 is not a typo: `adminBookingService` once
 * had `role::int = 2` in two places and `IN (2, 4)` in a third, so an admin
 * could not assign a role-4 provider and was told "Provider not found".
 * Staff are **0 and 1** — so `role: 1` is an ADMIN here, which is what this
 * constant block got wrong on the first attempt.
 */
const PROVIDER = 2;
const PROVIDER_ALT = 4;
const CUSTOMER = 3;
const ADMIN = 1;

beforeEach(() => {
  jest.clearAllMocks();
  (svc.countUnreadNotifications as jest.Mock).mockResolvedValue(0);
  (svc.countCustomerUnreadNotifications as jest.Mock).mockResolvedValue(0);
  (svc.deleteNotificationByKey as jest.Mock).mockResolvedValue({ found: true, allowed: true });
  (svc.deleteCustomerNotificationByKey as jest.Mock).mockResolvedValue({ found: true, allowed: true });
});

describe('dismiss reaches the caller\'s own store', () => {
  it('a provider dismisses from provider_notifications', async () => {
    const result = await inbox.dismiss({ uid: 'worker-A', role: PROVIDER }, 'k1');

    expect(svc.deleteNotificationByKey).toHaveBeenCalledWith('worker-A', 'k1');
    expect(svc.deleteCustomerNotificationByKey).not.toHaveBeenCalled();
    expect(result.changed).toBe(true);
    expect(result.supported).toBe(true);
  });

  it('the SECOND provider role reaches the same store', () => {
    // Role 4 is a provider too. A dismiss keyed on `role === 1` would send that
    // seat to the customer table and delete nothing, forever.
    return inbox.dismiss({ uid: 'worker-B', role: PROVIDER_ALT }, 'k1').then(() => {
      expect(svc.deleteNotificationByKey).toHaveBeenCalledWith('worker-B', 'k1');
      expect(svc.deleteCustomerNotificationByKey).not.toHaveBeenCalled();
    });
  });

  it('a customer dismisses from customer_notifications', async () => {
    // The case the legacy route could not serve at all: it is provider-only,
    // so this is a capability customers gain with v1 rather than keep.
    const result = await inbox.dismiss({ uid: 'user-A', role: CUSTOMER }, 'k2');

    expect(svc.deleteCustomerNotificationByKey).toHaveBeenCalledWith('user-A', 'k2');
    expect(svc.deleteNotificationByKey).not.toHaveBeenCalled();
    expect(result.changed).toBe(true);
  });

  it('an unknown role is treated as a customer, not as a provider', async () => {
    // Least privilege on an unrecognised seat: the same default `actorOf`
    // applies when `user_credentials` has no row.
    await inbox.dismiss({ uid: 'who', role: 99 }, 'k3');
    expect(svc.deleteCustomerNotificationByKey).toHaveBeenCalled();
    expect(svc.deleteNotificationByKey).not.toHaveBeenCalled();
  });
});

describe('admin has no dismiss, and says so', () => {
  it('answers unsupported rather than a fabricated miss', async () => {
    const result = await inbox.dismiss({ uid: 'admin-A', role: ADMIN }, 'k1');

    expect(result.supported).toBe(false);
    expect(result.changed).toBe(false);
    // And it did not go looking in somebody else's table on the way.
    expect(svc.deleteNotificationByKey).not.toHaveBeenCalled();
    expect(svc.deleteCustomerNotificationByKey).not.toHaveBeenCalled();
  });

  it('unsupported is NOT the same answer as not-found', async () => {
    // Both would map to a 404 if collapsed, and an admin would be told their
    // notification does not exist. It does; the store simply cannot dismiss —
    // and that stops being true the day admin gains one.
    const admin = await inbox.dismiss({ uid: 'admin-A', role: ADMIN }, 'k1');

    (svc.deleteNotificationByKey as jest.Mock).mockResolvedValue({ found: false, allowed: false });
    const missing = await inbox.dismiss({ uid: 'worker-A', role: PROVIDER }, 'nope');

    expect(admin.supported).toBe(false);
    expect(missing.supported).toBe(true);
    expect(missing.found).toBe(false);
  });
});

describe('the row\'s own policy is obeyed', () => {
  it('a row that refuses dismissal is not deleted and not reported changed', async () => {
    (svc.deleteNotificationByKey as jest.Mock).mockResolvedValue({ found: true, allowed: false });

    const result = await inbox.dismiss({ uid: 'worker-A', role: PROVIDER }, 'sticky');

    expect(result.found).toBe(true);
    expect(result.allowed).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.supported).toBe(true);
  });

  it('a missing row changes nothing', async () => {
    (svc.deleteCustomerNotificationByKey as jest.Mock).mockResolvedValue({ found: false, allowed: false });

    const result = await inbox.dismiss({ uid: 'user-A', role: CUSTOMER }, 'gone');

    expect(result.found).toBe(false);
    expect(result.changed).toBe(false);
  });

  it('repeating it is a no-op, which is what the contract calls idempotent', async () => {
    (svc.deleteNotificationByKey as jest.Mock)
      .mockResolvedValueOnce({ found: true, allowed: true })
      .mockResolvedValueOnce({ found: false, allowed: false });

    const first = await inbox.dismiss({ uid: 'worker-A', role: PROVIDER }, 'k1');
    const second = await inbox.dismiss({ uid: 'worker-A', role: PROVIDER }, 'k1');

    expect(first.changed).toBe(true);
    // The end state after one call and after two is identical. The second is
    // not an error — it is the same world, reported honestly.
    expect(second.changed).toBe(false);
  });
});

describe('the badge comes back with the answer', () => {
  it('the unread count is read AFTER the delete, from the caller\'s store', async () => {
    (svc.countUnreadNotifications as jest.Mock).mockResolvedValue(7);

    const result = await inbox.dismiss({ uid: 'worker-A', role: PROVIDER }, 'k1');

    expect(result.unreadCount).toBe(7);
    expect(svc.countUnreadNotifications).toHaveBeenCalledWith('worker-A');
    // A client that must re-fetch to learn its badge renders a stale one in
    // between, and then every client solves it locally by decrementing a
    // number it guessed.
    expect(svc.countCustomerUnreadNotifications).not.toHaveBeenCalled();
  });

  it('and from the CUSTOMER store for a customer', async () => {
    (svc.countCustomerUnreadNotifications as jest.Mock).mockResolvedValue(3);

    const result = await inbox.dismiss({ uid: 'user-A', role: CUSTOMER }, 'k2');

    expect(result.unreadCount).toBe(3);
    expect(svc.countUnreadNotifications).not.toHaveBeenCalled();
  });
});
