export const PROVIDER_CASE_STATES = [
  'SUBMITTED', 'RECEIVED', 'WAITING_FOR_SERVANA', 'WAITING_FOR_PROVIDER',
  'UNDER_REVIEW', 'ESCALATED', 'RESOLUTION_PROPOSED', 'RESOLVED', 'CLOSED',
  'REOPENED', 'CANCELLED',
] as const;

export const INTERNAL_CASE_STATES = [
  'NEW', 'TRIAGED', 'ASSIGNED', 'INVESTIGATING', 'AWAITING_EVIDENCE',
  'AWAITING_EXTERNAL_PARTY', 'AWAITING_FINANCIAL_RECONCILIATION',
  'AWAITING_BOOKING_OPERATIONS', 'AWAITING_MODERATION',
  'AWAITING_COMPLIANCE_REVIEW', 'ESCALATED', 'RESOLUTION_APPROVAL_REQUIRED',
  'RESOLVED', 'QUALITY_REVIEW', 'CLOSED',
] as const;

export const CASE_DOMAINS = [
  'GENERAL', 'TECHNICAL', 'BOOKING_OPERATIONS', 'BOOKING_DISPUTE', 'FINANCE',
  'SAFETY', 'COMPLIANCE', 'SERVICES', 'REVIEWS',
] as const;

export const RESOLUTION_CODES = [
  'GUIDANCE_PROVIDED', 'ISSUE_RESOLVED_NO_SOURCE_CHANGE', 'ADDITIONAL_INFORMATION_REQUIRED',
  'BOOKING_RECORD_CONFIRMED', 'BOOKING_RECORD_CORRECTED',
  'CANCELLATION_ATTRIBUTION_CORRECTED', 'PROVIDER_EARNING_POSTED',
  'FINANCIAL_ADJUSTMENT_APPLIED', 'PAYOUT_ISSUE_RESOLVED', 'REVIEW_RETAINED',
  'REVIEW_REMOVED', 'REVIEW_REDACTED', 'SERVICE_RESTORED',
  'SERVICE_RESTRICTION_MAINTAINED', 'SAFETY_CASE_TRANSFERRED',
  'EXTERNAL_FOLLOW_UP_REQUIRED', 'UNABLE_TO_DETERMINE',
] as const;

export const APPEAL_GROUNDS = [
  'NEW_MATERIAL_EVIDENCE', 'SOURCE_RECORD_INCORRECT', 'POLICY_MISAPPLIED',
  'PROCEDURAL_ERROR', 'RESOLUTION_INCOMPLETE',
] as const;

const STATE_LABELS: Record<string, string> = {
  SUBMITTED: 'Submitted', RECEIVED: 'Received', WAITING_FOR_SERVANA: 'Waiting for Servana',
  WAITING_FOR_PROVIDER: 'Action required', UNDER_REVIEW: 'Under review', ESCALATED: 'Escalated',
  RESOLUTION_PROPOSED: 'Resolution proposed', RESOLVED: 'Resolved', CLOSED: 'Closed',
  REOPENED: 'Reopened', CANCELLED: 'Withdrawn',
};

export const providerStateLabel = (state: unknown): string =>
  STATE_LABELS[String(state)] ?? 'Status unavailable';

export const providerCaseActions = (row: Record<string, any>): string[] => {
  const state = String(row.provider_state);
  const actions = ['VIEW'];
  if (!['RESOLVED', 'CLOSED', 'CANCELLED'].includes(state)) actions.push('REPLY', 'ADD_EVIDENCE');
  if (row.provider_action_required && !['RESOLVED', 'CLOSED', 'CANCELLED'].includes(state)) actions.push('PROVIDE_INFORMATION');
  if (row.domain !== 'SAFETY' && !['RESOLVED', 'CLOSED', 'CANCELLED'].includes(state)) actions.push('WITHDRAW');
  if (['RESOLVED', 'CLOSED'].includes(state) && row.reopen_deadline_at && new Date(row.reopen_deadline_at).getTime() >= Date.now()) actions.push('REOPEN');
  if (row.appeal_eligible && row.appeal_deadline_at && new Date(row.appeal_deadline_at).getTime() >= Date.now() && !row.appeal_id) actions.push('APPEAL');
  return actions;
};

export const normalizeProviderState = (state: unknown): string =>
  (PROVIDER_CASE_STATES as readonly string[]).includes(String(state).toUpperCase())
    ? String(state).toUpperCase() : 'RECEIVED';

export const slaTargets = (policyCode: string, severity: string, now = new Date()) => {
  const hours = severity === 'CRITICAL' ? { first: 1, escalation: 1, resolution: 24 }
    : severity === 'HIGH' ? { first: 4, escalation: 6, resolution: 48 }
    : policyCode === 'FINANCE_REVIEW' ? { first: 24, escalation: 48, resolution: 168 }
    : { first: 24, escalation: 48, resolution: 120 };
  const plus = (value: number) => new Date(now.getTime() + value * 3_600_000);
  return { firstResponseTargetAt: plus(hours.first), escalationDueAt: plus(hours.escalation), resolutionTargetAt: plus(hours.resolution) };
};

export const providerTimeExpectation = (row: Record<string, any>): string => {
  if (row.provider_action_required) return 'Servana is waiting for information from you.';
  if (row.severity === 'CRITICAL') return 'This safety report is prioritized for urgent review. Contact emergency services for immediate danger.';
  if (row.escalation_state === 'SLA_BREACHED') return 'This case is taking longer than its review target. Its priority has been preserved.';
  return 'Servana will provide an update after the assigned team reviews the case.';
};
