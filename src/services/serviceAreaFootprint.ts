/**
 * The area Servana actually operates in, and what it means for a service that
 * has no coverage configured.
 *
 * ## The rule this implements (§28)
 *
 * > Default: no explicit restriction → all Servana-supported cities. Explicit
 * > configurations (selected cities, branches, radius) remain authoritative.
 * > Do NOT interpret missing configuration as "covers nowhere."
 *
 * `checkCoverageGeo` returned `covered: !!match`, so a service with no
 * `service_coverage_geo` rows was covered NOWHERE. That is the exact reading
 * §28 forbids, and it is not theoretical: legacy family 67 (Electrical
 * Services) had zero rows, and `createBooking` refused every booking of the
 * only Home Maintenance service in the catalogue with "Service not available
 * in your area." — after the customer had chosen an address and a time.
 *
 * ## Why a footprint and not "everywhere"
 *
 * The other half of §28 matters just as much:
 *
 * > Malformed restrictive data must fail safely and surface for repair; must
 * > NOT silently become All Cities.
 *
 * "All Servana-supported cities" is not "anywhere on earth", and the
 * difference is measurable. Production, 2026-08-20:
 *
 *  - `provider_service_area_catalog` holds **21 cities, every one of them
 *    Metro Manila or its immediate fringe** — the furthest, San Jose del
 *    Monte, is about 29 km from the centre of the region.
 *  - All **27** rows of `worker_service_areas` draw from that catalogue and
 *    name nothing outside it. Not one provider serves anywhere else.
 *  - Every booking ever placed is Metro Manila: Makati 38, Metro Manila 20,
 *    Taguig 15, Mandaluyong 3, Manila 1, BGC 1 (plus 29 rows labelled
 *    "test").
 *
 * So the honest default for an unconfigured service is the area the business
 * can actually serve. Defaulting to the planet would accept a booking in
 * Davao that no provider on the platform could ever be assigned to — a
 * customer waiting for someone who is not coming, which is worse than being
 * told no.
 *
 * ## What this deliberately does NOT do
 *
 * It does not touch a service that HAS coverage rows. Families 1, 2 and 67
 * carry discs of up to 600 km reaching Mindanao — coverage no provider can
 * serve — and narrowing them would refuse bookings the platform currently
 * accepts. That is a business decision about where Servana sells, not a bug
 * fix, and §63 puts it outside what a change like this may do silently. It is
 * reported instead.
 */

/**
 * Centre of the supported footprint: Metro Manila.
 *
 * The same point families 52, 53 and 54 already use for their own coverage
 * discs, so the default and the explicit configurations agree about where the
 * region is.
 */
export const SUPPORTED_FOOTPRINT_CENTER = { lat: 14.5547, lon: 121.0244 };

/**
 * Radius covering every city in `provider_service_area_catalog`.
 *
 * Derived, not chosen: the catalogue's furthest entries are San Jose del Monte
 * (~29 km), Antipolo (~16 km), Imus (~16 km) and Bacoor (~12 km) from the
 * centre above. 50 km clears all of them with room for a city being added at
 * the same edge, and stops well short of the next region — it is a default for
 * missing configuration, not a licence.
 *
 * If the catalogue ever grows beyond the region, this stops being derivable
 * and the default should be computed from the catalogue rather than stated
 * here. `serviceAreaFootprint.test.ts` asserts the cities it must contain.
 */
export const SUPPORTED_FOOTPRINT_RADIUS_KM = 50;

/**
 * Great-circle distance in kilometres.
 *
 * The same spherical form `checkCoverageGeo` uses in SQL, so a point is not
 * judged by one formula in Postgres and a different one here.
 */
export const distanceKm = (
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number => {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const cosine =
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.cos(toRad(lon2) - toRad(lon1)) +
    Math.sin(toRad(lat1)) * Math.sin(toRad(lat2));
  return 6371 * Math.acos(Math.min(1, Math.max(-1, cosine)));
};

/**
 * Whether a point is inside the supported footprint.
 *
 * Only consulted when a service has NO coverage rows at all. A service with
 * rows is governed by them, however narrow or wide.
 */
export const isWithinSupportedFootprint = (lat: number, lon: number): boolean => {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return (
    distanceKm(
      lat,
      lon,
      SUPPORTED_FOOTPRINT_CENTER.lat,
      SUPPORTED_FOOTPRINT_CENTER.lon,
    ) <= SUPPORTED_FOOTPRINT_RADIUS_KM
  );
};
