/**
 * The canonical provider account state (Command 6 §5).
 *
 * One endpoint that answers every question a client has about what a provider
 * may do, so no client ever reconstructs it from unrelated calls. §1 makes the
 * backend the sole authority; this is where that authority is expressed.
 *
 * ── Why the dimensions are separate ─────────────────────────────────────────
 * Today the worker app resolves everything through
 * `providerStatus ?? workerStatus ?? applicationStatus ?? accountStatus` and
 * collapses four distinct concepts into one enum — so "application rejected"
 * and "account suspended" arrive in the same field and whichever the backend
 * populated first wins. §3 requires them separate, and they are separate here.
 *
 * ── Fail closed ─────────────────────────────────────────────────────────────
 * An unrecognised status denies everything except support. There is one
 * deliberate exception, inherited from `requireActiveProvider`: an account_status
 * that was NEVER SET is a legacy account, not a blocked one. Collapsing absent
 * and unrecognised together is what caused a production outage when every
 * pre-column account began receiving 403s. Absence means nothing was written;
 * an unrecognised value means somebody wrote something this code does not
 * understand. They are not the same.
 *
 * ── What this deliberately does NOT do ──────────────────────────────────────
 * It does not grant. Returning `canAcceptJobs: true` is a statement about
 * state, not an authorisation — every endpoint re-checks (§16). A capability
 * here that is not enforced there is a bug in the endpoint, not a licence.
 */

import dbQuery from "../db/dbQuery";
import { db } from "../config";
import { calculateReadiness } from "./adminOnboardingService";
import { isProviderRole } from "../constants/providerRoles";
import {
  previewActivationEligibility,
  getActivationRequirements,
} from "./providerActivationService";
import {
  computeCompliance,
  loadComplianceInputs,
  type ComplianceInputs,
} from "./providerProfileComplianceService";

const s = db.schema;

// ── Dimension vocabularies (§3) ───────────────────────────────────────────────

export type VerificationState = "MISSING" | "PENDING" | "VERIFIED";
export type ProfileState = "NOT_CREATED" | "INCOMPLETE" | "COMPLETE";
export type DocumentsState =
  | "NOT_STARTED"
  | "INCOMPLETE"
  | "UNDER_REVIEW"
  | "ACTION_REQUIRED"
  | "APPROVED";
export type ApplicationState =
  | "NOT_STARTED"
  | "DRAFT"
  | "SUBMITTED"
  | "UNDER_REVIEW"
  | "ADDITIONAL_INFORMATION_REQUIRED"
  | "APPROVED"
  | "REJECTED"
  | "WITHDRAWN"
  | "EXPIRED";
export type ActivationState =
  | "NOT_ELIGIBLE"
  | "PENDING_REQUIREMENTS"
  | "READY_FOR_ACTIVATION"
  | "ACTIVE"
  | "TEMPORARILY_RESTRICTED";
export type OperationalState =
  | "PENDING"
  | "ACTIVE"
  | "SUSPENDED"
  | "DISABLED"
  | "CLOSED"
  | "UNKNOWN";

/**
 * Precedence (§6). Lower rank wins. One order, shared by every client, so the
 * portal and the worker app cannot route the same provider differently — which
 * §32 requires and which they do not do today: the worker ranks `rejected`
 * first, while rejection is an application outcome rather than a security
 * state and belongs after the review states.
 */
export const PRECEDENCE = [
  "ACCOUNT_CLOSED",
  "ACCOUNT_DISABLED",
  "ACCOUNT_SUSPENDED",
  "ROLE_NOT_PERMITTED",
  "IDENTIFIER_VERIFICATION_REQUIRED",
  "PROFILE_MISSING",
  "PROFILE_INCOMPLETE",
  "DOCUMENTS_ACTION_REQUIRED",
  "APPLICATION_NOT_SUBMITTED",
  "APPLICATION_UNDER_REVIEW",
  "APPLICATION_REJECTED",
  "ACTIVATION_PENDING",
  "NO_ACTIVE_SERVICE",
  "OPERATIONAL",
] as const;
export type NextStepCode = (typeof PRECEDENCE)[number];

const ROUTES: Record<NextStepCode, string> = {
  ACCOUNT_CLOSED: "account-closed",
  ACCOUNT_DISABLED: "account-disabled",
  ACCOUNT_SUSPENDED: "account-suspended",
  ROLE_NOT_PERMITTED: "role-not-permitted",
  IDENTIFIER_VERIFICATION_REQUIRED: "verify-identifier",
  PROFILE_MISSING: "profile-create",
  PROFILE_INCOMPLETE: "profile-complete",
  DOCUMENTS_ACTION_REQUIRED: "provider-documents",
  APPLICATION_NOT_SUBMITTED: "application",
  APPLICATION_UNDER_REVIEW: "application-review",
  APPLICATION_REJECTED: "application-rejected",
  ACTIVATION_PENDING: "activation",
  NO_ACTIVE_SERVICE: "services",
  OPERATIONAL: "dashboard",
};

export type Capabilities = {
  canViewDashboard: boolean;
  canEditProfile: boolean;
  canUploadDocuments: boolean;
  canSubmitApplication: boolean;
  canBrowseJobs: boolean;
  canAcceptJobs: boolean;
  canViewBookings: boolean;
  canMessageCustomers: boolean;
  canManageAvailability: boolean;
  canViewEarnings: boolean;
  canRequestWithdrawal: boolean;
  canOpenSupportCase: boolean;
  canGoOnline: boolean;
  canGoOffline: boolean;
};

/** Everything denied. The base every state builds up from, never down to. */
const DENY_ALL: Capabilities = {
  canViewDashboard: false,
  canEditProfile: false,
  canUploadDocuments: false,
  canSubmitApplication: false,
  canBrowseJobs: false,
  canAcceptJobs: false,
  canViewBookings: false,
  canMessageCustomers: false,
  canManageAvailability: false,
  canViewEarnings: false,
  canRequestWithdrawal: false,
  canOpenSupportCase: false,
  canGoOnline: false,
  // Never trap a provider online: going offline survives every restriction.
  canGoOffline: true,
};

// Both 2 and 4 are provider roles; the set lives in one file so this endpoint
// and the route guard that enforces its answer cannot drift apart.

const BLOCKED_OPERATIONAL: Record<string, OperationalState> = {
  suspended: "SUSPENDED",
  disabled: "DISABLED",
  deactivated: "DISABLED",
  blocked: "DISABLED",
  closed: "CLOSED",
  deleted: "CLOSED",
  rejected: "PENDING", // an application outcome; D5 carries the detail
  under_review: "PENDING",
  pending: "PENDING",
};

/**
 * Blockers that describe SERVANA's backlog rather than the provider's
 * obligations. They correctly stop an admin approving, and must never be shown
 * to a provider as something to fix.
 */
const INTERNAL_ONLY_BLOCKERS = new Set([
  "requirement_pending_review",
  "service_application_pending",
  "catalog_unmapped",
  "catalog_partially_mapped",
  "requirement_legacy_ambiguous",
]);

export type ProviderAccountState = {
  account: { status: OperationalState; role: string | null };
  verification: {
    email: VerificationState;
    mobile: VerificationState;
    minimumRequirementMet: boolean;
  };
  profile: { status: ProfileState; completionPercent: number; missingFields: string[] };
  documents: {
    status: DocumentsState;
    required: number;
    approved: number;
    actionRequired: number;
  };
  application: {
    status: ApplicationState;
    submittedAt: string | null;
    reviewReference: string | null;
  };
  activation: { status: ActivationState };
  access: Capabilities;
  /**
   * The server-driven checklist (§9). Both phases in one list, each item
   * tagged, so a client renders progress without deciding what counts.
   *
   * Contains only what the PROVIDER can act on. Servana's own review backlog is
   * excluded — see INTERNAL_ONLY_BLOCKERS.
   */
  checklist: ChecklistItem[];
  nextStep: { code: NextStepCode; route: string; blocking: boolean };
};

export type ChecklistItem = {
  code: string;
  label: string;
  phase: "approval" | "activation";
  satisfied: boolean;
  blocking: boolean;
  route: string;
};

/**
 * Where a provider goes to satisfy each approval blocker. A checklist item
 * without a destination is a complaint, not a task.
 */
const BLOCKER_ROUTES: Record<string, string> = {
  missing_email_verification: "verify-identifier",
  missing_required_requirement: "provider-documents",
  requirement_rejected: "provider-documents",
  no_active_service: "services",
  service_application_rejected: "services",
};

const APPLICATION_FROM_CASE: Record<string, ApplicationState> = {
  not_started: "NOT_STARTED",
  in_progress: "DRAFT",
  submitted: "SUBMITTED",
  queued: "UNDER_REVIEW",
  in_review: "UNDER_REVIEW",
  waiting_for_internal_review: "UNDER_REVIEW",
  escalated: "UNDER_REVIEW",
  ready_for_final_review: "UNDER_REVIEW",
  waiting_for_provider: "ADDITIONAL_INFORMATION_REQUIRED",
  approved: "APPROVED",
  rejected: "REJECTED",
  withdrawn: "WITHDRAWN",
  expired: "EXPIRED",
  reopened: "UNDER_REVIEW",
  suspended: "UNDER_REVIEW",
};

/**
 * The account state PLUS the compliance inputs the computation already loaded.
 *
 * ## Why this exists
 *
 * `getProviderAccountState` has always called `calculateCompliance` — it needs
 * `complianceCurrent` to decide four capabilities — and then discarded
 * everything except that one boolean. The canonical activation projection needs
 * the compliance verdict, the document list and the certification list, all of
 * which that call already loaded and threw away.
 *
 * Without this, the projection would call `calculateCompliance` a second time,
 * and since that function fans out to `listDocuments` and `listCertifications`,
 * one activation read would issue six queries to answer questions the first
 * three already answered. Returning what was loaded is cheaper than loading it
 * again, and — the part that matters more — it makes it IMPOSSIBLE for the
 * projection's document summary to disagree with the compliance verdict printed
 * beside it, because both are computed from one array.
 *
 * `getProviderAccountState` below is unchanged on the wire: it returns
 * `.state` and nothing else, so `/api/provider/account-state` and every one of
 * its five clients see exactly the response they saw before.
 */
export interface ProviderAccountStateDetailed {
  state: ProviderAccountState;
  /**
   * The compliance verdict, or null when it could not be computed — a denied
   * account, or a compliance projection that threw. Null is not "compliant";
   * every reader must treat it as unknown.
   */
  compliance: ReturnType<typeof computeCompliance> | null;
  /**
   * The rows the verdict was computed from, or null on a denied account where
   * nothing was loaded. Deliberately not defaulted to empty arrays: an empty
   * document list and an unloaded one mean different things, and a projection
   * that confuses them reports "no documents required" to a provider it never
   * looked up.
   */
  inputs: ComplianceInputs | null;
}

export async function getProviderAccountState(
  uid: string
): Promise<ProviderAccountState> {
  return (await getProviderAccountStateDetailed(uid)).state;
}

export async function getProviderAccountStateDetailed(
  uid: string
): Promise<ProviderAccountStateDetailed> {
  const { rows } = await dbQuery.query(
    `SELECT uid, role, account_status, email, email_normalized,
            phone_number, phone_normalized,
            COALESCE(is_email_verified, false)  AS is_email_verified,
            COALESCE(is_mobile_verified, false) AS is_mobile_verified
       FROM ${s}.user_credentials
      WHERE uid = $1
      LIMIT 1`,
    [uid]
  );

  // No row is a genuinely unknown actor. Deny everything but support.
  if (!rows.length) {
    return bare(denied("UNKNOWN", null, "ROLE_NOT_PERMITTED"));
  }

  const row = rows[0];
  const role: string | null = row.role == null ? null : String(row.role);

  // ── D7 operational ────────────────────────────────────────────────────────
  const rawStatus = row.account_status;
  const absent =
    rawStatus === null || rawStatus === undefined || String(rawStatus).trim() === "";
  const statusKey = absent ? null : String(rawStatus).toLowerCase();

  let operational: OperationalState;
  if (absent) {
    // Legacy account — see the header note. Absence is not a verdict.
    operational = "ACTIVE";
  } else if (statusKey === "active" || statusKey === "approved") {
    operational = "ACTIVE";
  } else if (statusKey && statusKey in BLOCKED_OPERATIONAL) {
    operational = BLOCKED_OPERATIONAL[statusKey];
  } else {
    operational = "UNKNOWN"; // somebody wrote a value we do not understand
  }

  if (operational === "CLOSED") return bare(denied(operational, role, "ACCOUNT_CLOSED"));
  if (operational === "DISABLED") return bare(denied(operational, role, "ACCOUNT_DISABLED"));
  if (operational === "UNKNOWN") return bare(denied(operational, role, "ACCOUNT_DISABLED"));
  if (!isProviderRole(role)) {
    return bare(denied(operational, role, "ROLE_NOT_PERMITTED"));
  }

  // ── D2 verification ───────────────────────────────────────────────────────
  const hasEmail = !!(row.email && String(row.email).trim());
  const hasMobile = !!(row.phone_number && String(row.phone_number).trim());
  const email: VerificationState = !hasEmail
    ? "MISSING"
    : row.is_email_verified
      ? "VERIFIED"
      : "PENDING";
  const mobile: VerificationState = !hasMobile
    ? "MISSING"
    : row.is_mobile_verified
      ? "VERIFIED"
      : "PENDING";
  // At least one verified identifier. Absence of data is never verification.
  const minimumRequirementMet = email === "VERIFIED" || mobile === "VERIFIED";

  // ── Readiness (reused, not reimplemented) ─────────────────────────────────
  const readiness = await calculateReadiness(uid).catch(() => null);
  const blockers: Array<{ code: string; severity: string; label: string }> =
    readiness?.blockers ?? [];
  const providerFacing = blockers.filter((b) => !INTERNAL_ONLY_BLOCKERS.has(b.code));
  const has = (code: string) => blockers.some((b) => b.code === code);

  const summary: any = readiness?.summary ?? {};
  const requirementsUploaded = Number(summary.requirementsUploaded ?? 0);
  const requirementsApproved = Number(summary.requirementsApproved ?? 0);
  const activeServices = Number(summary.activeServices ?? 0);

  // ── D4 documents ──────────────────────────────────────────────────────────
  const docActionRequired = has("requirement_rejected") ? 1 : 0;
  const documentsStatus: DocumentsState =
    requirementsUploaded === 0
      ? "NOT_STARTED"
      : docActionRequired > 0
        ? "ACTION_REQUIRED"
        : has("requirement_pending_review")
          ? "UNDER_REVIEW"
          : has("missing_required_requirement")
            ? "INCOMPLETE"
            : "APPROVED";

  // ── D5 application ────────────────────────────────────────────────────────
  const caseRes = await dbQuery.query(
    `SELECT onboarding_status, submitted_at, id
       FROM ${s}.provider_onboarding_cases
      WHERE provider_uid = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [uid]
  ).catch(() => ({ rows: [] as any[] }));

  const caseRow = caseRes.rows[0];
  const application: ApplicationState = caseRow
    ? (APPLICATION_FROM_CASE[String(caseRow.onboarding_status)] ?? "NOT_STARTED")
    : "NOT_STARTED";

  // ── D3 profile ────────────────────────────────────────────────────────────
  const missingFields = providerFacing
    .filter((b) => b.code.startsWith("missing_") && b.code !== "missing_required_requirement")
    .map((b) => b.code.replace(/^missing_/, ""));
  const profileStatus: ProfileState = missingFields.length ? "INCOMPLETE" : "COMPLETE";

  // Percentage over REQUIRED, provider-actionable items only (§9). Servana's
  // own backlog must not stall a provider's progress bar.
  const requiredCount = providerFacing.filter((b) => b.severity === "blocking").length;
  const completionPercent =
    requiredCount === 0 ? 100 : Math.max(0, Math.round((1 - requiredCount / (requiredCount + 4)) * 100));

  // ── D6 activation ─────────────────────────────────────────────────────────
  /**
   * Read the STORED activation state; never derive it here.
   *
   * Approval starts activation, it does not complete it (§8), and the move into
   * ACTIVE is an explicit transition somebody asks for. Computing it in a read
   * path would reintroduce exactly the defect D6 exists to remove — a
   * completeness calculation quietly granting operational access.
   *
   * `previewActivationEligibility` reports what the state is WITHOUT recording
   * anything. It used to be `refreshActivationEligibility`, which persists: this
   * endpoint would then create a provider_activation row, bump a version and
   * write an audit event for every provider who merely opened a page. A read
   * must not modify an existing provider's record, and manufactured activation
   * history is worse than none — it reads as a decision somebody took.
   */
  let activation: ActivationState;
  try {
    activation = (await previewActivationEligibility(
      uid,
      application === "APPROVED"
    )) as ActivationState;
  } catch {
    // Unreadable activation is not permission.
    activation = "NOT_ELIGIBLE";
  }

  // A suspension outranks whatever activation says.
  if (operational === "SUSPENDED" && activation === "ACTIVE") {
    activation = "TEMPORARILY_RESTRICTED";
  }

  // ── Next step, by precedence ──────────────────────────────────────────────
  let next: NextStepCode;
  if (operational === "SUSPENDED") next = "ACCOUNT_SUSPENDED";
  else if (!minimumRequirementMet) next = "IDENTIFIER_VERIFICATION_REQUIRED";
  else if (profileStatus === "INCOMPLETE") next = "PROFILE_INCOMPLETE";
  else if (documentsStatus === "ACTION_REQUIRED" || documentsStatus === "NOT_STARTED")
    next = "DOCUMENTS_ACTION_REQUIRED";
  else if (application === "NOT_STARTED" || application === "DRAFT")
    next = "APPLICATION_NOT_SUBMITTED";
  else if (application === "ADDITIONAL_INFORMATION_REQUIRED")
    next = "DOCUMENTS_ACTION_REQUIRED";
  else if (application === "SUBMITTED" || application === "UNDER_REVIEW")
    next = "APPLICATION_UNDER_REVIEW";
  else if (application === "REJECTED") next = "APPLICATION_REJECTED";
  else if (activation === "PENDING_REQUIREMENTS" || activation === "READY_FOR_ACTIVATION")
    next = "ACTIVATION_PENDING";
  else if (activeServices === 0) next = "NO_ACTIVE_SERVICE";
  else next = "OPERATIONAL";

  // ── Capabilities ──────────────────────────────────────────────────────────
  const suspended = operational === "SUSPENDED";
  const fullyActive = activation === "ACTIVE" && operational === "ACTIVE";
  const complianceInputs = await loadComplianceInputs(uid).catch(() => null);
  const compliance = complianceInputs === null ? null : computeCompliance(complianceInputs);
  // This endpoint is an advisory UI contract used by both provider clients.
  // During the controlled 009 migration rollout, an unavailable Command 24
  // projection must not make the existing portal appear suspended. Actual
  // assignment and auto-online authorization remain fail-closed in their own
  // engines. Once the schema exists, a real non-current result is enforced.
  const complianceProjectionUnavailable =
    compliance === null ||
    (compliance.state === "restricted" &&
      compliance.blockingRequirements?.length === 1 &&
      compliance.blockingRequirements[0]?.code === "PROVIDER_NOT_FOUND");
  const complianceCurrent =
    complianceProjectionUnavailable ||
    compliance.state === "compliant" ||
    compliance.state === "expiring_soon";

  const access: Capabilities = {
    ...DENY_ALL,
    canOpenSupportCase: true,
    canViewDashboard: true,
    canUploadDocuments: !suspended,
    canEditProfile: !suspended,
    canSubmitApplication:
      !suspended &&
      (application === "NOT_STARTED" ||
        application === "DRAFT" ||
        application === "ADDITIONAL_INFORMATION_REQUIRED"),
    // Readable while suspended by design: withholding what someone is owed is
    // punitive, not protective.
    canViewEarnings: application === "APPROVED" || fullyActive || suspended,
    canViewBookings: application === "APPROVED" || fullyActive || suspended,
    canManageAvailability: !suspended && application === "APPROVED",
    canBrowseJobs: fullyActive && complianceCurrent,
    canAcceptJobs: fullyActive && complianceCurrent,
    canMessageCustomers: fullyActive,
    canRequestWithdrawal: fullyActive && complianceCurrent,
    canGoOnline: fullyActive && complianceCurrent,
  };

  // ── Checklist (§9) ────────────────────────────────────────────────────────
  // Approval items come from the readiness blockers a provider can act on;
  // activation items from the activation service. An unsatisfied item always
  // carries somewhere to go.
  const approvalItems: ChecklistItem[] = providerFacing
    .filter((b) => b.severity === "blocking")
    .map((b) => ({
      code: b.code,
      label: b.label,
      phase: "approval" as const,
      satisfied: false,
      blocking: true,
      route: BLOCKER_ROUTES[b.code] ?? "profile-complete",
    }));

  const activationItems: ChecklistItem[] = await getActivationRequirements(uid)
    .then((reqs) =>
      reqs.map((r) => ({
        code: r.code,
        label: r.label,
        phase: "activation" as const,
        satisfied: r.satisfied,
        blocking: r.blocking,
        route: r.route,
      }))
    )
    // Unreadable requirements are not satisfied requirements, but they must not
    // take the whole response down either.
    .catch(() => []);

  const state: ProviderAccountState = {
    account: { status: operational, role },
    verification: { email, mobile, minimumRequirementMet },
    profile: { status: profileStatus, completionPercent, missingFields },
    documents: {
      status: documentsStatus,
      required: Number(summary.requirementsRequired ?? requirementsUploaded),
      approved: requirementsApproved,
      actionRequired: docActionRequired,
    },
    application: {
      status: application,
      submittedAt: caseRow?.submitted_at ? new Date(caseRow.submitted_at).toISOString() : null,
      // A safe reference, never the internal case id.
      reviewReference: caseRow?.id ? `SR-${String(caseRow.id).slice(0, 8).toUpperCase()}` : null,
    },
    activation: { status: activation },
    access,
    checklist: [...approvalItems, ...activationItems],
    nextStep: { code: next, route: ROUTES[next], blocking: next !== "OPERATIONAL" },
  };

  return { state, compliance, inputs: complianceInputs };
}

/**
 * A denial carries no compliance and no inputs, because none were loaded.
 *
 * Null rather than an empty verdict: "we did not look" and "we looked and found
 * nothing outstanding" are different answers, and a projection that renders the
 * first as the second tells a refused provider they are compliant.
 */
const bare = (state: ProviderAccountState): ProviderAccountStateDetailed =>
  ({ state, compliance: null, inputs: null });

/** Terminal denial. Support stays reachable — §19 forbids dead ends. */
function denied(
  status: OperationalState,
  role: string | null,
  code: NextStepCode
): ProviderAccountState {
  return {
    account: { status, role },
    verification: { email: "MISSING", mobile: "MISSING", minimumRequirementMet: false },
    profile: { status: "NOT_CREATED", completionPercent: 0, missingFields: [] },
    documents: { status: "NOT_STARTED", required: 0, approved: 0, actionRequired: 0 },
    application: { status: "NOT_STARTED", submittedAt: null, reviewReference: null },
    activation: { status: "NOT_ELIGIBLE" },
    access: { ...DENY_ALL, canOpenSupportCase: true },
    // Nothing to work through: the account itself is the blocker.
    checklist: [],
    nextStep: { code, route: ROUTES[code], blocking: true },
  };
}
