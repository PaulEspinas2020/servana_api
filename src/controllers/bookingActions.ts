/**
 * What the provider may actually do with a booking, decided server-side.
 *
 * Command 18 §5. The client currently infers actions from status labels, which
 * §1 forbids outright: "The frontend must not infer allowed actions from status
 * labels alone." This is the authoritative answer instead.
 *
 * ── Every action here maps to a real endpoint ──────────────────────────────
 * §5 requires that the UI never display an unsupported action, so this list is
 * derived from routes that exist today, not from the aspirational set in the
 * command. Deliberately ABSENT, because they have no backend:
 *
 *   REQUEST_RESCHEDULE, RESPOND_TO_RESCHEDULE  — no reschedule endpoint
 *   REQUEST_CANCELLATION                       — no provider-cancel endpoint
 *   OPEN_DISPUTE                               — no dispute endpoint
 *   PAUSE_JOB / RESUME_JOB                     — no pause endpoint
 *   UPLOAD_EVIDENCE                            — Command 19
 *   REPORT_NO_SHOW                             — no endpoint
 *
 * Adding any of them here before its endpoint exists would put a button in the
 * app that cannot work, which is exactly what §5 is trying to prevent.
 */

export type BookingActionCode =
  | "VIEW_DETAILS"
  | "ACCEPT_ASSIGNMENT"
  | "DECLINE_ASSIGNMENT"
  | "MARK_EN_ROUTE"
  | "MARK_ARRIVED"
  | "START_JOB"
  | "COMPLETE_JOB"
  | "OPEN_DIRECTIONS"
  | "VIEW_EARNINGS";

export interface BookingAction {
  code: BookingActionCode;
  /** The client must confirm deliberately before calling. */
  requiresConfirmation: boolean;
  /** A code the provider must supply — today only the job-start worker code. */
  requiresCode: boolean;
}

const action = (
  code: BookingActionCode,
  requiresConfirmation = false,
  requiresCode = false
): BookingAction => ({ code, requiresConfirmation, requiresCode });

/**
 * The real transition graph, read out of `technicianService`:
 *
 *   ASSIGNED --accept--> ACCEPTED --enRoute--> EN_ROUTE --arrived--> ARRIVED
 *      |                     \____________________|__________________/
 *      |                                   startJob (any of the three)
 *   DECLINED                                      |
 *                                            IN_PROGRESS --complete--> COMPLETED
 *
 * `markEnRoute` requires exactly ACCEPTED and `markArrived` requires exactly
 * EN_ROUTE, so neither is offered out of order.
 */
export function actionsForWorkerStatus(
  rawStatus: string | null | undefined
): BookingAction[] {
  const status = String(rawStatus ?? "").toUpperCase();

  switch (status) {
    case "ASSIGNED":
      // Directions are absent on purpose: the address is not disclosed before
      // acceptance, so offering navigation would promise data we withhold.
      return [
        action("VIEW_DETAILS"),
        action("ACCEPT_ASSIGNMENT", true),
        action("DECLINE_ASSIGNMENT", true),
      ];

    case "ACCEPTED":
      return [
        action("VIEW_DETAILS"),
        action("OPEN_DIRECTIONS"),
        action("MARK_EN_ROUTE", true),
        // startJob accepts ACCEPTED, EN_ROUTE and ARRIVED — the arrival stages
        // are optional, so a provider may start without tapping either.
        action("START_JOB", true, true),
      ];

    case "EN_ROUTE":
      return [
        action("VIEW_DETAILS"),
        action("OPEN_DIRECTIONS"),
        action("MARK_ARRIVED", true),
        action("START_JOB", true, true),
      ];

    case "ARRIVED":
      // markArrived requires EN_ROUTE, so MARK_ARRIVED is not offered again.
      return [
        action("VIEW_DETAILS"),
        action("OPEN_DIRECTIONS"),
        action("START_JOB", true, true),
      ];

    case "IN_PROGRESS":
      return [
        action("VIEW_DETAILS"),
        action("OPEN_DIRECTIONS"),
        action("COMPLETE_JOB", true),
      ];

    case "COMPLETED":
      return [action("VIEW_DETAILS"), action("VIEW_EARNINGS")];

    case "DECLINED":
    case "CANCELED":
    case "CANCELLED":
      return [action("VIEW_DETAILS")];

    default:
      // Unknown or missing status fails closed to read-only. A status added
      // server-side later must never grant an action by default.
      return [action("VIEW_DETAILS")];
  }
}
