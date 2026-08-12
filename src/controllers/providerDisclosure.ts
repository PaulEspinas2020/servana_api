/**
 * ONE decision about how much of a customer a provider may see.
 *
 * ## The staging
 *
 * A provider deciding whether to take a job needs the service, the schedule and
 * the AREA. They do not need the customer's street address or phone number
 * until they have accepted — Command 17 §11. After they relinquish the job
 * (declined, cancelled) they need nothing.
 *
 *   full   street address, coordinates, phone, full name
 *   area   city and country only — what a travel decision needs
 *   none   relinquished; no customer data at all
 *
 * ## Why this is shared rather than repeated
 *
 * Two places made this decision independently: `jobCardView.formatJobCard` and
 * `providerController.getProviderBookingDetail`, the latter carrying a comment
 * saying it matched the former. They did match — the sets were equal when
 * measured — but only by inspection, and only until somebody edited one. A
 * comment claiming kinship is not a mechanism.
 *
 * The consequence of drift is not cosmetic: the second site exists precisely
 * because it once spread the raw row, so an ASSIGNED provider who had accepted
 * nothing could read the street address and zip code by calling it directly.
 * Hiding a screen is not authorization (§12).
 *
 * ## What is deliberately NOT here
 *
 * `providerCalendarService` is sometimes grouped with these two. It is not a
 * third copy: it emits the city unconditionally and never anything more, so it
 * sits at the `area` floor by construction and has nothing to stage. It also
 * excludes declined and cancelled work from the calendar entirely, so the
 * relinquished case cannot arise. Nothing to consolidate — but it is covered by
 * the guard, because "emits only the floor" is a property worth keeping.
 */

/**
 * Statuses where the provider is actively working the job.
 *
 * `EN_ROUTE` and `ARRIVED` sit BETWEEN accepted and in-progress. A provider who
 * tapped "on my way" is travelling to the address, and withholding it there
 * would break the journey the disclosure exists to enable.
 */
export const OPERATIONAL_WORKER_STATUSES: ReadonlySet<string> = new Set([
  'ACCEPTED',
  'EN_ROUTE',
  'ARRIVED',
  'IN_PROGRESS',
]);

/** Statuses where the provider has no ongoing relationship to the customer. */
export const RELINQUISHED_WORKER_STATUSES: ReadonlySet<string> = new Set([
  'DECLINED',
  'CANCELED',
  'CANCELLED',
  'REASSIGNED',
]);

export type DisclosureLevel = 'full' | 'area' | 'none';

/**
 * How much this provider may see, given their assignment status.
 *
 * `COMPLETED` keeps full disclosure deliberately: the provider was authorised
 * for this customer, and earnings and history screens on both surfaces render
 * the name. Narrowing it is a separate call with its own blast radius (JM-07).
 *
 * An unrecognised status falls to `area`, not to `full`. A status this
 * platform has never seen is not evidence of an accepted job, and the failure
 * direction has to be towards less exposure.
 */
export function disclosureLevelFor(workerStatus: unknown): DisclosureLevel {
  const status = String(workerStatus ?? '').toUpperCase();
  if (RELINQUISHED_WORKER_STATUSES.has(status)) return 'none';
  if (OPERATIONAL_WORKER_STATUSES.has(status) || status === 'COMPLETED') return 'full';
  return 'area';
}

/** Convenience for call sites that only branch on "may see the street". */
export const hasFullDisclosure = (workerStatus: unknown): boolean =>
  disclosureLevelFor(workerStatus) === 'full';
