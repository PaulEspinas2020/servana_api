import { actionsForWorkerStatus } from "./bookingActions";

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
const OPERATIONAL_WORKER_STATUSES = new Set([
  "ACCEPTED",
  // EN_ROUTE and ARRIVED sit BETWEEN accepted and in-progress. A provider who
  // tapped "on my way" is travelling to the address — withholding it there
  // would break the journey the disclosure is meant to enable.
  "EN_ROUTE",
  "ARRIVED",
  "IN_PROGRESS",
]);

/// Statuses where the provider has no ongoing relationship to the customer.
const RELINQUISHED_WORKER_STATUSES = new Set([
  "DECLINED",
  "CANCELED",
  "CANCELLED",
]);

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
  const operational = OPERATIONAL_WORKER_STATUSES.has(workerStatus);
  const relinquished = RELINQUISHED_WORKER_STATUSES.has(workerStatus);

  // COMPLETED keeps full detail deliberately: the provider was authorised for
  // this customer, and earnings/history screens on both surfaces render the
  // name. Narrowing it is a separate call with its own blast radius (JM-07).
  const fullDisclosure = operational || workerStatus === "COMPLETED";

  const customer = fullDisclosure
    ? { uid: job.customer_id, name: `${job.first_name} ${job.last_name}`, phone: job.phone_number }
    : {
        uid: relinquished ? null : job.customer_id,
        name: relinquished ? "" : maskCustomerName(job.first_name, job.last_name),
        phone: null,
      };

  // Pre-acceptance the provider gets the AREA, which is what a travel decision
  // needs. After declining they get nothing.
  const address = fullDisclosure
    ? { addressOne: job.address_one, addressTwo: job.address_two, city: job.post_town, zipCode: job.zip_code, country: job.country, label: job.label, instructions: job.delivery_instructions ?? null }
    : relinquished
      ? { addressOne: null, addressTwo: null, city: null, zipCode: null, country: null, label: null, instructions: null }
      : { addressOne: null, addressTwo: null, city: job.post_town, zipCode: null, country: job.country, label: job.label, instructions: null };

  return {
    bookingId:    job.booking_id,
    workerId:     job.worker_uid ?? null,
    status:       job.status,
    scheduleAt:   job.schedule,
    paymentMethod: job.payment_method,
    paymentStatus: job.payment_status,
    customer,
    address,
    service:      { name: job.service_name, type: job.service_type },
    addOns:       job.pricing_breakdown,
    workerStatus: job.worker_status,
    assignedAt:   job.assigned_at,
    startedAt:    job.started_at,
    completedAt:  job.completed_at,
    // C18 §5. Authorized actions, decided server-side. Purely additive — a
    // client that ignores it behaves exactly as before, and one that reads it
    // stops inferring actions from status labels (§1 forbids that).
    availableActions: actionsForWorkerStatus(job.worker_status),
  };
}
