/**
 * Every admin route, and what is to become of it (TAB 09, F-12).
 *
 * ## The problem this solves
 *
 * A route-coverage sweep found 13 admin capabilities with no portal caller.
 * Producing that list is easy and producing it again in three months is easy;
 * what is hard is stopping it regrowing silently. A number in a report is read
 * once. A classification the build enforces is read every time somebody adds a
 * route.
 *
 * ## Two defect classes that need OPPOSITE fixes
 *
 * The 13 are not one problem. They are two, and treating them alike makes one
 * of them permanent:
 *
 *   BUILD     a working capability with no path from the UI — support-case
 *             transitions, appeal decisions, eligibility preview. The screen is
 *             missing. Build it.
 *
 *   CONVERGE  duplicate reality — two surfaces operating the same objects.
 *             Fixed by DELETING one, never by building a second screen for it.
 *             Building a UI for a duplicate entrenches it permanently, which is
 *             the single most expensive mistake available in this TAB.
 *
 * A third disposition, KEEP, exists for routes that are correct as they are and
 * simply have not been called yet, and RETIRE for routes with no caller and no
 * successor.
 *
 * ## What this file is NOT
 *
 * It is not evidence that a route is unused. "Unreachable from the portal" is
 * not "deletable" — the portal is one of six consumers, and the other five are
 * not on this machine. Every RETIRE here is a PROPOSAL that legacy telemetry
 * has to confirm before anybody deletes anything. The disposition records a
 * decision and its reason; the telemetry records the fact.
 */

export type AdminDisposition =
  /** Correct as it stands. Called, or legitimately not yet called. */
  | 'KEEP'
  /** A working capability with no way in. The screen is missing — build it. */
  | 'BUILD'
  /** Duplicate reality. One surface must go; this names which and why. */
  | 'CONVERGE'
  /** No caller and no successor. Delete once telemetry shows observed silence. */
  | 'RETIRE';

export interface AdminRouteDisposition {
  method: string;
  /** Full path as mounted, including `/api`. */
  path: string;
  disposition: AdminDisposition;
  /** Required. A classification without a reason is a guess with a label. */
  reason: string;
  /** For CONVERGE: the surface that survives. */
  canonical?: string;
}

/**
 * Only routes whose disposition is NOT the default.
 *
 * An admin route absent from this list is `KEEP` by omission — it is called by
 * the portal, or it is new and uncontroversial. The test that reads this file
 * asserts the reverse direction: every route named here still exists, so a
 * classification cannot outlive the thing it classifies.
 */
export const ADMIN_ROUTE_DISPOSITIONS: readonly AdminRouteDisposition[] = Object.freeze([
  // ── Disbursements: duplicate reality, already half-resolved by TAB 01 ──────
  ...(['get /api/admin/disbursements',
       'get /api/admin/disbursements/booking/:bookingId',
       'post /api/admin/disbursements/:id/retry',
       'post /api/admin/disbursements/trigger'] as const).map((sig) => {
    const [method, path] = sig.split(' ');
    return {
      method,
      path,
      disposition: 'CONVERGE' as const,
      canonical: '/api/admin/finance/payouts/*',
      reason:
        'The same disbursement rows as /admin/finance/payouts/*, which is permissioned, ' +
        'audited and the surface the portal actually calls. TAB 01 converged the MUTATIONS ' +
        'onto the canonical service and deleted manualRetry; the reads keep their own ' +
        'response shape because changing it is a breaking change to an unmeasured client. ' +
        'This is a duplicate surface, NOT a missing screen — building a UI for it would ' +
        'entrench the duplicate permanently.',
    };
  }),

  // ── Support cases: the screen is missing, the capability works ─────────────
  {
    method: 'patch',
    path: '/api/admin/support/cases/:caseId/state',
    disposition: 'BUILD',
    reason:
      'Case state transitions are a complete, permissioned workflow with no way in. ' +
      'Build the screen with reason capture — a state change on somebody\'s support case ' +
      'without a recorded reason is an audit row that cannot answer why.',
  },
  {
    method: 'patch',
    path: '/api/admin/support/cases/:caseId/appeals/:appealId',
    disposition: 'BUILD',
    reason:
      'Appeal decisions have no UI. An appeal a provider can file and no admin can decide ' +
      'is a promise the product does not keep.',
  },
  {
    method: 'get',
    path: '/api/admin/support/cases/:caseId/attachments/:attachmentId/preview',
    disposition: 'BUILD',
    reason:
      'Attachment preview, guarded by support.evidence.sensitive.view. Build it with the ' +
      'same signed-URL treatment provider documents get, so evidence is never served from ' +
      'a long-lived public URL.',
  },
  {
    method: 'post',
    path: '/api/admin/support/cases/sla-sweep',
    disposition: 'KEEP',
    reason:
      'RESOLVED in TAB 09. It had a permission, no caller and no schedule. It is now a ' +
      'lease-protected cron every 15 minutes (scheduler job support-sla-sweep) because an ' +
      'SLA breach is created by the passage of time, not by an operator\'s attention, and ' +
      'the sweep writes a provider-visible "Review target delayed" event. The route stays ' +
      'for on-demand runs after an incident — same function either way.',
  },

  // ── Decision-support calls with no decision screen ─────────────────────────
  {
    method: 'post',
    path: '/api/admin/providers/:uid/eligibility-preview',
    disposition: 'BUILD',
    reason:
      'A dry run of eligibility before an assignment is genuinely useful — it is the ' +
      'question an operator asks before committing. Surface it inside the assignment flow ' +
      'rather than as a standalone screen, or retire it.',
  },
  {
    method: 'post',
    path: '/api/admin/provider-availability/evaluate-booking',
    disposition: 'BUILD',
    reason:
      'Same class as eligibility-preview: a decision-support call with no decision screen. ' +
      'Belongs beside the assignment candidates view.',
  },

  // ── Duplicate reality ─────────────────────────────────────────────────────
  {
    method: 'get',
    path: '/api/admin/provider-catalog/offerings',
    disposition: 'RETIRE',
    reason:
      'Likely superseded by the canonical Catalog V2 service (/api/admin/catalog/*). ' +
      'PROPOSAL ONLY — confirm with legacy telemetry before deleting. Catalog V2 is the ' +
      'declared canonical hierarchy, so a second offerings surface is provenance the ' +
      'canonical model already carries.',
  },
  {
    method: 'get',
    path: '/api/admin/provider/reconciliation',
    disposition: 'CONVERGE',
    canonical: '/api/v1/admin/finance/reconciliation',
    reason:
      'Overlaps the v1 reconciliation endpoint the portal DOES call. Two answers to ' +
      '"reconcile this" is exactly the duplicate reality §9 forbids — pick the v1 one, ' +
      'which is permissioned (reconciliation.view) and declared on the contract.',
  },
  {
    method: 'patch',
    path: '/api/admin/workers/:uid/archive',
    disposition: 'CONVERGE',
    canonical: '/api/admin/users/:uid/archive',
    reason:
      'Two archive paths for one concept (§10). The portal archives via ' +
      '/admin/users/:uid/archive, which demands users.archive; this one demands no named ' +
      'permission at all beyond role 1 — so the duplicate is also the weaker door, the ' +
      'same shape as F-01 and F-11.',
  },
]);

export const dispositionFor = (
  method: string,
  path: string,
): AdminRouteDisposition | undefined =>
  ADMIN_ROUTE_DISPOSITIONS.find(
    (d) => d.method.toLowerCase() === method.toLowerCase() && d.path === path,
  );
