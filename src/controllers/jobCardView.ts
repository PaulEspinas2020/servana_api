import { disclosureLevelFor } from "./providerDisclosure";
import { evaluateCancellation } from "../services/booking/bookingPolicies";
import { deriveCanonicalState } from "../services/booking/canonicalState";
import { toProviderProjection } from "../services/booking/projections";
import { providerActionsForState } from "../services/booking/providerActions";
import { coordinatesForAddress } from "../helpers/servanaLocationId";

/// Stages customer disclosure by the provider's relationship to the booking.
///
/// Command 17 §11. This response used to return the customer's full name,
/// phone number and complete street address UNCONDITIONALLY, for every status
/// the job-cards query returns — which includes `ASSIGNED` and `DECLINED`.
///
/// Two concrete disclosures resulted:
///
///   1. A provider held the customer's name, phone and home address from the
///      moment admin assigned the job — BEFORE they had accepted anything.
///   2. A provider who DECLINED the job kept receiving all of it, indefinitely,
///      because `DECLINED` is in the query's status filter.
///
/// Neither is a cross-provider leak, which is why no isolation test caught
/// them: it is each provider's own feed, over-disclosing.
///
/// Full disclosure is the OPERATIONAL window only — a provider who has accepted
/// needs the address to travel and the phone to coordinate. Before acceptance
/// they need enough to decide (service, schedule, area), and after declining
/// they need nothing.
///
/// Keys are never removed, only emptied, so no consumer's shape changes.
/// "Maria Santos" -> "Maria S." — enough to recognise the job, not enough to
/// identify the person. Mirrors the provider portal's `customerDisplayName`.
function maskCustomerName(first: any, last: any): string {
  const f = String(first ?? "").trim();
  const l = String(last ?? "").trim();
  if (!f && !l) return "";
  return l ? `${f} ${l.charAt(0).toUpperCase()}.`.trim() : f;
}

export function formatJobCard(job: any) {
  const workerStatus = String(job.worker_status ?? "").toUpperCase();
  // ONE decision, shared with getProviderBookingDetail. See providerDisclosure.
  const level = disclosureLevelFor(workerStatus);
  const relinquished = level === "none";
  const fullDisclosure = level === "full";

  const customer = fullDisclosure
    ? { uid: job.customer_id, name: `${job.first_name} ${job.last_name}`, phone: job.phone_number }
    : {
        uid: relinquished ? null : job.customer_id,
        name: relinquished ? "" : maskCustomerName(job.first_name, job.last_name),
        phone: null,
      };

  // Coordinates travel at FULL DISCLOSURE ONLY, and they are additive (§4) —
  // `lat`/`lng` are new keys on an object that already existed.
  //
  // SW-05. The exact point has always been in the database: `user_address`
  // holds the canonical `loc_{lat}_{lng}`, and admin-created bookings put
  // lat/lon into `service_address`. The job card sent neither, so ServanaWorker
  // fell back to geocoding the address TEXT on the device — and pre-acceptance
  // that text is city + country, so "Makati, PH" resolved to the city centre
  // and was drawn under the heading "Service location". §39 forbids exactly
  // that: do not fabricate coordinates from a city centre.
  //
  // Withholding them before acceptance is not a limitation, it is the same
  // staging as the street address. A precise pin IS the street address, so
  // sending it early would hand over what the text above deliberately withholds.
  const coords = fullDisclosure
    ? coordinatesForAddress({
        locationId: job.location_id,
        lat: job.service_address_lat,
        lng: job.service_address_lon,
      })
    : null;

  // Pre-acceptance the provider gets the AREA, which is what a travel decision
  // needs. After declining they get nothing.
  const address = fullDisclosure
    ? { addressOne: job.address_one, addressTwo: job.address_two, city: job.post_town, zipCode: job.zip_code, country: job.country, label: job.label, instructions: job.delivery_instructions ?? null, lat: coords ? coords.lat : null, lng: coords ? coords.lng : null }
    : relinquished
      ? { addressOne: null, addressTwo: null, city: null, zipCode: null, country: null, label: null, instructions: null, lat: null, lng: null }
      : { addressOne: null, addressTwo: null, city: job.post_town, zipCode: null, country: job.country, label: job.label, instructions: null, lat: null, lng: null };

  /**
   * THE state, derived once from the same machine every other surface uses.
   *
   * `status` and `workerStatus` below are the raw legacy columns and stay
   * exactly as they were (§4). They are what shipped provider clients read
   * today, so removing or changing them would break live apps. `canonicalState`
   * travels beside them and is what the next client version reads.
   *
   * Deriving here rather than in the query is deliberate: this formatter is the
   * ONE place all three provider surfaces pass through, so one derivation here
   * reaches v1, Provider Web and legacy mobile with no chance of the three
   * drifting apart — which is exactly how Admin's list and detail came to
   * disagree about the same booking.
   */
  const canonicalState = deriveCanonicalState({
    bookingStatus: job.status,
    workerStatus: job.worker_status,
    workerUid: job.worker_uid ?? null,
    hasEscalation: job.has_escalation === true,
  });
  const provider = toProviderProjection(canonicalState);

  return {
    bookingId:    job.booking_id,
    workerId:     job.worker_uid ?? null,
    /** @deprecated Raw `bookings.status`. Read `canonicalState`. */
    status:       job.status,
    scheduleAt:   job.schedule,
    paymentMethod: job.payment_method,
    paymentStatus: job.payment_status,
    customer,
    address,
    service:      { name: job.service_name, type: job.service_type },
    addOns:       job.pricing_breakdown,
    /** @deprecated Raw `booking_workers.status`. Read `canonicalState`. */
    workerStatus: job.worker_status,
    assignedAt:   job.assigned_at,
    startedAt:    job.started_at,
    completedAt:  job.completed_at,

    // ── Canonical state, additive ─────────────────────────────────────────
    canonicalState,
    /** Provider-voice label: what they do next, not what the booking is. */
    stateLabel:   provider.label,
    /** The single obvious next step, or null. Never one the machine refuses. */
    nextAction:   provider.nextAction,
    terminal:     provider.terminal,

    /**
     * Authorized actions, now GENERATED from the transition whitelist rather
     * than switched on a raw status string.
     *
     * Behaviour is identical for any row whose two status columns agree. It
     * CHANGES, deliberately, where they disagree: a booking cancelled while the
     * assignment row still read ACCEPTED used to offer MARK_EN_ROUTE, and an
     * assignment still reading ASSIGNED on a cancelled booking used to offer
     * ACCEPT. Both are now read-only, because the canonical state is CANCELLED.
     * The old list was answering a question about the assignment row; the right
     * question is about the booking.
     */
    availableActions: providerActionsForState(canonicalState, {
      /**
       * The guard's OWN policy function, not a re-derivation.
       *
       * Discovery and enforcement both call `evaluateCancellation`, so the
       * client never calculates the 48-hour rule and a Cancel button can never
       * disagree with the POST that follows it. A race between loading this
       * list and tapping is still possible and still fine — the POST remains
       * authoritative.
       */
      cancellation: evaluateCancellation({
        workerStatus: job.worker_status,
        schedule: job.schedule,
        now: new Date(),
      }),
    }),
  };
}
