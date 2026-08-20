/**
 * §28: missing coverage configuration means all Servana-supported cities — not
 * nowhere, and not everywhere.
 *
 * Both halves of the rule are asserted, because getting one right and the
 * other wrong is how this was broken in the first place: `covered: !!match`
 * satisfied "do not silently become All Cities" perfectly, by covering
 * nothing.
 *
 * Every city below is a real entry from `provider_service_area_catalog` on
 * production, 2026-08-20 — all 21 of them, which is the whole catalogue.
 */

import {
  SUPPORTED_FOOTPRINT_CENTER,
  SUPPORTED_FOOTPRINT_RADIUS_KM,
  distanceKm,
  isWithinSupportedFootprint,
} from '../src/services/serviceAreaFootprint';

/** The complete catalogue, with coordinates for each city centre. */
const SUPPORTED_CITIES: Record<string, [number, number]> = {
  manila: [14.5995, 120.9842],
  quezon: [14.676, 121.0437],
  makati: [14.5547, 121.0244],
  taguig: [14.5176, 121.0509],
  pasig: [14.5764, 121.0851],
  mandaluyong: [14.5794, 121.0359],
  marikina: [14.6507, 121.1029],
  caloocan: [14.6488, 120.9673],
  malabon: [14.6681, 120.9567],
  navotas: [14.6667, 120.9417],
  valenzuela: [14.7011, 120.9829],
  'las-pinas': [14.4499, 120.9827],
  muntinlupa: [14.408, 121.0413],
  paranaque: [14.4793, 121.0198],
  pasay: [14.5378, 120.9896],
  pateros: [14.5455, 121.0685],
  'san-juan': [14.6019, 121.0355],
  bacoor: [14.459, 120.96],
  imus: [14.4297, 120.9367],
  antipolo: [14.5878, 121.1759],
  'san-jose-del-monte': [14.8136, 121.0453],
};

/** Cities Servana does not operate in. No provider names any of these. */
const UNSUPPORTED_CITIES: Record<string, [number, number]> = {
  'cebu-city': [10.3157, 123.8854],
  'davao-city': [7.1907, 125.4553],
  baguio: [16.4023, 120.596],
  iloilo: [10.7202, 122.5621],
  'puerto-princesa': [9.7392, 118.7353],
  'cagayan-de-oro': [8.4542, 124.6319],
};

describe('the supported footprint covers the catalogue it was derived from', () => {
  it.each(Object.entries(SUPPORTED_CITIES))(
    'includes %s',
    (_city, [lat, lon]) => {
      expect(isWithinSupportedFootprint(lat, lon)).toBe(true);
    },
  );

  it('covers every city with margin, so one more at the same edge still fits', () => {
    // The radius is derived from this catalogue rather than chosen. If a city
    // is ever added beyond it, this fails and says so — which is the moment to
    // compute the default from the catalogue instead of stating it.
    const furthest = Object.entries(SUPPORTED_CITIES)
      .map(([city, [lat, lon]]) => ({
        city,
        km: distanceKm(
          lat,
          lon,
          SUPPORTED_FOOTPRINT_CENTER.lat,
          SUPPORTED_FOOTPRINT_CENTER.lon,
        ),
      }))
      .sort((a, b) => b.km - a.km)[0];

    expect(furthest.km).toBeLessThan(SUPPORTED_FOOTPRINT_RADIUS_KM);
    // Real margin, not a hair. If this tightens, the radius needs revisiting
    // rather than the assertion.
    expect(SUPPORTED_FOOTPRINT_RADIUS_KM - furthest.km).toBeGreaterThan(10);
  });
});

describe('the footprint is not "everywhere"', () => {
  // The other half of §28: malformed or missing restrictive data must not
  // silently become All Cities. A default that accepted Davao would take a
  // booking no provider on the platform could be assigned to — a customer
  // waiting for someone who is not coming, which is worse than being told no.
  it.each(Object.entries(UNSUPPORTED_CITIES))(
    'excludes %s',
    (_city, [lat, lon]) => {
      expect(isWithinSupportedFootprint(lat, lon)).toBe(false);
    },
  );
});

describe('a point that cannot be judged is not covered', () => {
  it.each([
    ['NaN latitude', NaN, 121.0244],
    ['NaN longitude', 14.5547, NaN],
    ['infinite latitude', Infinity, 121.0244],
  ])('%s fails closed', (_name, lat, lon) => {
    // An undeterminable location must deny — the one place the old
    // fail-closed behaviour was right, and kept deliberately.
    //
    // ⚠ This pins the OUTCOME, not the `Number.isFinite` guard that states
    // it. Deleting that guard fails none of these, because NaN propagates
    // through Math.acos and `NaN <= 50` is false anyway. The guard is kept for
    // being legible at the point of decision, not because a test defends it —
    // said plainly rather than left to look like coverage it is not.
    expect(isWithinSupportedFootprint(lat as number, lon as number)).toBe(false);
  });

  it('0,0 is not treated as Metro Manila', () => {
    // Null Island. A missing coordinate that arrives as zero must not resolve
    // to the centre of the footprint.
    expect(isWithinSupportedFootprint(0, 0)).toBe(false);
  });
});

describe('distanceKm agrees with the SQL it mirrors', () => {
  it('is zero at the centre', () => {
    expect(
      distanceKm(
        SUPPORTED_FOOTPRINT_CENTER.lat,
        SUPPORTED_FOOTPRINT_CENTER.lon,
        SUPPORTED_FOOTPRINT_CENTER.lat,
        SUPPORTED_FOOTPRINT_CENTER.lon,
      ),
    ).toBeCloseTo(0, 6);
  });

  it('matches a known separation', () => {
    // Makati to Cebu City, ~570 km. If the formula is ever replaced with a
    // flat-earth approximation this is what notices.
    expect(distanceKm(14.5547, 121.0244, 10.3157, 123.8854)).toBeGreaterThan(
      540,
    );
    expect(distanceKm(14.5547, 121.0244, 10.3157, 123.8854)).toBeLessThan(600);
  });

  it('is symmetric', () => {
    const a = distanceKm(14.5547, 121.0244, 14.676, 121.0437);
    const b = distanceKm(14.676, 121.0437, 14.5547, 121.0244);
    expect(a).toBeCloseTo(b, 9);
  });
});
