/**
 * Readiness must answer for the store booking creation depends on.
 *
 * ## The defect
 *
 * `/readyz` reported `ready:true` with five green dependencies — firebase-admin,
 * admin-permission-seed, customer-review-schema, provider-catalog,
 * provider-onboarding — none of which is MongoDB. But
 * `bookingService.createBooking` resolves the customer's address through
 * `address.service.getLatLonByLocationId`, which reads the Mongo `addresses`
 * collection and THROWS when it cannot. There is no fallback: the coordinates
 * feed `checkCoverageGeo`, so without them no booking is created at all.
 *
 * So readiness could answer green for everything except the thing the customer
 * came to do.
 *
 * ## What is asserted, and why in this shape
 *
 * The declaration is checked, and then the probe is RUN against a mocked
 * driver. Asserting only that an entry named `address-geocode-store` exists
 * would pass for an entry whose `start` is `async () => {}` — a green tick for
 * a probe that touches nothing, which is the failure this replaces rather than
 * a fix for it.
 */

const command = jest.fn();

jest.mock('../src/db/mongodbQuery', () => ({
  __esModule: true,
  default: {
    // The real export is a lazy thenable, not a promise. `then` is what an
    // `await` calls, so the double has to be one too — a plain object with a
    // `command` method would be awaited straight through and the probe would
    // pass without ever reaching a driver.
    then: (resolve: (db: unknown) => unknown) => resolve({ command }),
  },
}));

import { STARTUP_DEPENDENCIES } from '../src/startup';

const entry = () =>
  STARTUP_DEPENDENCIES.find((d) => d.name === 'address-geocode-store');

describe('the address geocode store is declared', () => {
  beforeEach(() => command.mockReset().mockResolvedValue({ ok: 1 }));

  it('appears in the startup dependency graph', () => {
    expect(entry()).toBeDefined();
  });

  it('is required, not optional', () => {
    // A booking dependency must not be silently downgraded (TAB 03's stop
    // condition). `required` withholds readiness rather than killing the
    // process, so an operator still has /readyz to ask why.
    expect(entry()!.kind).toBe('required');
  });

  it('is bounded, so a hung driver cannot hold the boot open', () => {
    const timeout = entry()!.timeoutMs;
    expect(timeout).toBeGreaterThan(0);
    // Long enough for server selection, short enough to be a boot step. The
    // driver's own serverSelectionTimeoutMS is 60s, which is not a boot budget.
    expect(timeout).toBeLessThanOrEqual(30_000);
  });

  it('carries the reason it is required', () => {
    // `why` is what stops the next person downgrading it to optional because
    // nothing said what it was for.
    const why = entry()!.why ?? '';
    expect(why).toMatch(/booking/i);
    expect(why.length).toBeGreaterThan(80);
  });
});

describe('the probe actually reaches the driver', () => {
  beforeEach(() => command.mockReset().mockResolvedValue({ ok: 1 }));

  it('issues a ping', async () => {
    // An entry whose `start` is a no-op would satisfy every assertion in the
    // block above and prove nothing about the database.
    await entry()!.start();

    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith({ ping: 1 });
  });

  it('fails when the store does not answer, rather than resolving', async () => {
    // The whole point: an unreachable store must withhold readiness. A probe
    // that swallowed its own error would report ready for a database nothing
    // can read — which is the state this dependency was added to end.
    command.mockRejectedValue(
      new Error('MongoServerSelectionError: connect ECONNREFUSED'),
    );

    await expect(entry()!.start()).rejects.toThrow(/ECONNREFUSED/);
  });
});
