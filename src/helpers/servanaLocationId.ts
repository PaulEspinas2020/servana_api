/**
 * The canonical Servana location id — `loc_{lat.6dp}_{lng.6dp}` (§42).
 *
 * Two producers already built this string by hand (`addressSearchService` and
 * `adminCreateBookingService`) and nothing could read it back. This is the one
 * place that does both, so a third divergent copy has nowhere to appear.
 *
 * ## Why parsing needs to be strict
 *
 * The column is not clean. Production `user_address` row `CAD-26-940687` holds
 * `ChIJ8T1GpMGzljMRq2q5T1u7I0w` — a raw Google **place id**, not a location id
 * (SW-13). Anything that reads coordinates out of this column will meet it.
 *
 * A lenient parser is the dangerous option here. The values become a map pin
 * shown to a provider as "the customer's address", so a parser that guesses
 * puts somebody at the wrong door. Every rejection below returns null, and null
 * means "this address has no coordinates" — which callers must be able to
 * render honestly, because for some rows it is simply true.
 */

export function formatServanaLocationId(lat: number, lng: number): string {
  return `loc_${lat.toFixed(6)}_${lng.toFixed(6)}`;
}

export interface ParsedLocation {
  lat: number;
  lng: number;
}

/** Philippines-plausible bounds, used only to reject nonsense, not to clamp. */
const LAT_MIN = -90;
const LAT_MAX = 90;
const LNG_MIN = -180;
const LNG_MAX = 180;

const LOCATION_ID = /^loc_(-?\d{1,3}(?:\.\d+)?)_(-?\d{1,3}(?:\.\d+)?)$/;

/**
 * Reads coordinates out of a canonical location id, or null.
 *
 * Returns null for: a Google place id, an empty or non-string value, a
 * malformed id, coordinates outside the valid range, and the 0/0 null island —
 * which is what an unset pair looks like once it has been through a formatter,
 * and is in the Gulf of Guinea rather than anywhere Servana operates.
 */
export function parseServanaLocationId(value: unknown): ParsedLocation | null {
  if (typeof value !== 'string') return null;
  const match = LOCATION_ID.exec(value.trim());
  if (!match) return null;

  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < LAT_MIN || lat > LAT_MAX) return null;
  if (lng < LNG_MIN || lng > LNG_MAX) return null;
  if (lat === 0 && lng === 0) return null;

  return { lat, lng };
}

/**
 * Coordinates for a booking address, from whichever source has them.
 *
 * `user_address` carries a location id; admin-created bookings instead put
 * `lat`/`lon` straight into the `service_address` JSONB. Both are checked so a
 * provider gets a pin either way, and the id wins because it is the canonical
 * record.
 */
export function coordinatesForAddress(input: {
  locationId?: unknown;
  lat?: unknown;
  lng?: unknown;
}): ParsedLocation | null {
  const fromId = parseServanaLocationId(input.locationId);
  if (fromId) return fromId;

  const lat = Number(input.lat);
  const lng = Number(input.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < LAT_MIN || lat > LAT_MAX) return null;
  if (lng < LNG_MIN || lng > LNG_MAX) return null;
  if (lat === 0 && lng === 0) return null;

  return { lat, lng };
}
