/**
 * The pre-check must agree with the booking it predicts.
 *
 * A serviceability answer that disagrees with `createBooking` is worse than no
 * answer at all: it either blocks a booking the server would have taken, or
 * promises one the server will refuse — which is the failure it exists to
 * remove, moved earlier in the journey.
 *
 * So the family resolution is pinned against `bookingService`'s own SQL by
 * reading both sources, and the verdict is exercised against a stubbed pool.
 */

import fs from 'fs';
import path from 'path';

const query = jest.fn();

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => query(...args) },
}));

import { checkServiceability } from '../src/services/serviceabilityService';

const read = (relative: string) =>
  fs
    .readFileSync(path.resolve(__dirname, '..', relative), 'utf8')
    // Normalised: a CRLF checkout must not change what this test reads.
    .replace(/\r\n/g, '\n');

/** Collapse whitespace so indentation differences are not differences. */
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

/** The family-resolution statement, extracted from a source file. */
const familyResolutionIn = (source: string): string | null => {
  const match = source.match(
    /SELECT s\.id AS service_id[\s\S]*?is_active = true/,
  );
  return match ? normalise(match[0]) : null;
};

describe('the pre-check resolves the service family exactly as booking does', () => {
  it('uses the same statement, character for character', () => {
    const booking = familyResolutionIn(read('src/services/bookingService.ts'));
    const precheck = familyResolutionIn(
      read('src/services/serviceabilityService.ts'),
    );

    expect(booking).not.toBeNull();
    expect(precheck).not.toBeNull();
    expect(precheck).toBe(booking);
  });

  it('keeps the two predicates that decide which options count', () => {
    // `option_type = 'MAIN'` and `is_active = true` are what stop an add-on or
    // a retired option resolving to a family. Dropping either here would make
    // the pre-check answer for a service the booking will not accept.
    const precheck = familyResolutionIn(
      read('src/services/serviceabilityService.ts'),
    )!;
    expect(precheck).toContain("option_type = 'MAIN'");
    expect(precheck).toContain('is_active = true');
  });
});

describe('a location that cannot be judged is never answered yes', () => {
  beforeEach(() => query.mockReset());

  it.each([
    ['missing latitude', NaN, 121.0244],
    ['missing longitude', 14.5547, NaN],
    ['null island', 0, 0],
  ])('%s is INVALID_LOCATION', async (_name, lat, lon) => {
    const result = await checkServiceability(1, lat as number, lon as number);

    expect(result.serviceable).toBe(false);
    expect(result.reason).toBe('INVALID_LOCATION');
    // And it must not have gone to the database to decide that.
    expect(query).not.toHaveBeenCalled();
  });
});

describe('the verdict', () => {
  beforeEach(() => query.mockReset());

  /**
   * Family lookup answers `serviceId`, coverage answers `rows`, and the supply
   * count answers `capable` — the third query, asked only when coverage passes.
   */
  const stub = (serviceId: number | null, rows: unknown[], capable = 1) => {
    query
      .mockResolvedValueOnce(
        serviceId === null
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ service_id: serviceId }] },
      )
      .mockResolvedValueOnce({ rowCount: rows.length, rows })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ capable }] });
  };

  it('is yes inside a configured disc', async () => {
    stub(52, [{ id: 1, radius_km: 25, distance_km: 3 }]);

    const result = await checkServiceability(19, 14.5547, 121.0244);

    expect(result.serviceable).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.defaulted).toBe(false);
  });

  it('is no outside every configured disc, and says why', async () => {
    // Family 52 is Metro Manila only — measured, a single 25km disc. A
    // customer in Cebu is 564km away.
    stub(52, [{ id: 1, radius_km: 25, distance_km: 564 }]);

    const result = await checkServiceability(19, 10.3157, 123.8854);

    expect(result.serviceable).toBe(false);
    expect(result.reason).toBe('OUTSIDE_SERVICE_AREA');
  });

  it('falls back to the supported footprint when nothing is configured', async () => {
    // §28: no explicit restriction is not "covers nowhere". This is the state
    // family 67 was in, and it is why the only Home Maintenance service in the
    // catalogue could not be booked anywhere.
    stub(67, []);

    const manila = await checkServiceability(180, 14.5547, 121.0244);
    expect(manila.serviceable).toBe(true);
    expect(manila.defaulted).toBe(true);
  });

  it('the footprint fallback is not "everywhere"', async () => {
    stub(67, []);

    const davao = await checkServiceability(180, 7.1907, 125.4553);
    expect(davao.serviceable).toBe(false);
    expect(davao.reason).toBe('OUTSIDE_SERVICE_AREA');
  });

  it('a Service with no legacy option is judged by the footprint, not refused',
    async () => {
      // A Service created through the Admin API has no `service_options` row,
      // so the family lookup finds nothing. `createBooking` throws "Invalid
      // service option." there — but a browse is not a submission, and the
      // honest answer for an unconfigured service is §28's default.
      query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

      const result = await checkServiceability(9001, 14.5547, 121.0244);

      expect(result.serviceable).toBe(true);
      expect(result.defaulted).toBe(true);
      // One query only — it never reached the coverage read.
      expect(query).toHaveBeenCalledTimes(1);
    });

  it('exposes no coverage geometry and no legacy id', async () => {
    // §11/§58: `catalogPublicService` withholds `legacy_service_option_id` and
    // `legacy_service_family_id` deliberately. This route must not leak
    // through the back door what that one keeps.
    stub(52, [{ id: 1, radius_km: 25, distance_km: 3 }]);

    const result = await checkServiceability(19, 14.5547, 121.0244);

    expect(Object.keys(result).sort()).toEqual([
      'defaulted',
      'reason',
      'serviceable',
    ]);
  });
});

describe('in the area, but nobody can do it', () => {
  beforeEach(() => query.mockReset());

  const stub = (serviceId: number, rows: unknown[], capable: number) => {
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ service_id: serviceId }] })
      .mockResolvedValueOnce({ rowCount: rows.length, rows })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ capable }] });
  };

  it('reports NO_CAPABLE_PROVIDER rather than pretending it is bookable', async () => {
    // Measured 2026-08-20: services.id 180 — the only Home Maintenance service
    // — has zero grants across all three capability sources, while two
    // applications sit in pending_review since July. Coverage was added to
    // family 67 that day, so the service is now inside the area and still has
    // nobody to send. Without this it would take bookings nobody can serve.
    stub(67, [{ id: 1, radius_km: 50, distance_km: 3 }], 0);

    const result = await checkServiceability(180, 14.5547, 121.0244);

    expect(result.serviceable).toBe(false);
    expect(result.reason).toBe('NO_CAPABLE_PROVIDER');
  });

  it('is a DIFFERENT answer from being outside the area', async () => {
    // The customer can act on OUTSIDE_SERVICE_AREA — another saved address
    // might work. They can do nothing about supply, and telling them to try
    // another address sends them round a loop with no exit.
    stub(52, [{ id: 1, radius_km: 25, distance_km: 564 }], 6);

    const result = await checkServiceability(19, 10.3157, 123.8854);

    expect(result.reason).toBe('OUTSIDE_SERVICE_AREA');
    expect(result.reason).not.toBe('NO_CAPABLE_PROVIDER');
  });

  it('does not ask about supply for an address outside the area', async () => {
    // The reason given is the FIRST that applies, not the cheapest to compute.
    // A customer in Cebu is not told the platform has no electricians.
    stub(52, [{ id: 1, radius_km: 25, distance_km: 564 }], 0);

    await checkServiceability(19, 10.3157, 123.8854);

    expect(query).toHaveBeenCalledTimes(2);
  });

  it('one capable provider is enough', async () => {
    // Capability, not availability. A provider who is offline, booked or on
    // leave is still capable — refusing for that would make the catalogue
    // flicker with the roster.
    stub(52, [{ id: 1, radius_km: 25, distance_km: 3 }], 1);

    const result = await checkServiceability(19, 14.5547, 121.0244);

    expect(result.serviceable).toBe(true);
    expect(result.reason).toBeNull();
  });
});
