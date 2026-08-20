/**
 * "Can this service be booked at this address?" — answered before the customer
 * fills in a form, not after they submit one.
 *
 * ## The experience this fixes
 *
 * Today a customer browses a service, picks a saved address, chooses a date and
 * a payment method, presses Confirm, and only then learns:
 *
 *     Service not available in your area.
 *
 * Every one of those steps is wasted, and the app could have known at the first
 * one. `createBooking` is the only thing that runs the coverage test, and it
 * runs it last.
 *
 * ## Why an answer and not the id
 *
 * The obvious shortcut is to publish `legacy_service_option_id` on the public
 * catalog payload so a client can call the existing public
 * `/api/services/:familyId/coverage-geo` itself. `catalogPublicService`
 * deliberately withholds exactly that field, along with `providerCount` and
 * `legacy_service_family_id` — "a customer learns what they can book, never how
 * thin supply is behind it or how the catalog was migrated" (§11, §58). Making
 * a customer resolve an internal migration key to ask a product question is
 * also §38's complaint in a different costume: users give an address, the
 * backend derives the technical data.
 *
 * So this exposes the verdict and keeps the key.
 *
 * ## Why it resolves the family the way `createBooking` does, exactly
 *
 * A pre-check that disagrees with the thing it predicts is worse than no
 * pre-check: it either blocks a booking the server would have taken, or —
 * far worse — promises one the server will refuse, which is the failure this
 * exists to remove, moved earlier.
 *
 * The query below is `createBooking`'s, character for character, including
 * `option_type = 'MAIN'` and `is_active = true`. If booking's resolution ever
 * changes, this must change with it; `serviceability.test.ts` pins the two
 * together by reading both sources.
 */

import { db } from "../config";
import dbQuery from "../db/dbQuery";
import { checkCoverageGeo } from "./serviceService";
import { isWithinSupportedFootprint } from "./serviceAreaFootprint";

const dbSchema = db.schema;

export type ServiceabilityReason =
  | "OUTSIDE_SERVICE_AREA"
  | "UNKNOWN_SERVICE"
  | "INVALID_LOCATION";

export interface Serviceability {
  serviceable: boolean;
  reason: ServiceabilityReason | null;
  /** True when no coverage was configured and the supported footprint decided. */
  defaulted: boolean;
}

/**
 * [serviceOptionId] is what the booking payload calls `serviceOptionId` and
 * what the canonical catalog calls `services.id` — the same value for every
 * promoted row, and the same one `createBooking` receives.
 */
export const checkServiceability = async (
  serviceOptionId: number,
  lat: number,
  lon: number,
): Promise<Serviceability> => {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    (lat === 0 && lon === 0)
  ) {
    // An undeterminable location must not be answered "yes" (§11 fail closed).
    // 0,0 is Null Island and is what an absent coordinate arrives as.
    return {
      serviceable: false,
      reason: "INVALID_LOCATION",
      defaulted: false,
    };
  }

  const svcRes = await dbQuery.query(
    `
      SELECT s.id AS service_id
      FROM ${dbSchema}.service_options so
      JOIN ${dbSchema}.service_families s ON s.id = so.service_id
      WHERE so.id = $1
        AND so.option_type = 'MAIN'
        AND so.is_active = true
      `,
    [serviceOptionId],
  );

  if (!svcRes.rowCount) {
    // `createBooking` throws "Invalid service option." here. This is the same
    // condition reported rather than thrown, because a browse is not a
    // submission — the customer has not asked for anything yet.
    //
    // A Service created through the Admin API has no legacy option row at all,
    // so it lands here too. It is not "unserviceable" for that reason: it has
    // no coverage configured, which §28 says means the supported footprint.
    return {
      serviceable: isWithinSupportedFootprint(lat, lon),
      reason: isWithinSupportedFootprint(lat, lon)
        ? null
        : "OUTSIDE_SERVICE_AREA",
      defaulted: true,
    };
  }

  const serviceId = Number(svcRes.rows[0].service_id);
  const coverage = await checkCoverageGeo(serviceId, lat, lon);

  return {
    serviceable: coverage.covered,
    reason: coverage.covered ? null : "OUTSIDE_SERVICE_AREA",
    defaulted: Boolean((coverage as { defaulted?: boolean }).defaulted),
  };
};
