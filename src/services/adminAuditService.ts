import { randomUUID } from 'crypto';
import dbQuery from '../db/dbQuery';
import { db } from '../config';

// ── Types ─────────────��───────────────────────────────────────────────────────

export type AuditOutcome = 'success' | 'failed' | 'blocked';
export type AuditCategory =
  | 'auth' | 'provider' | 'onboarding' | 'booking' | 'payment'
  | 'catalog' | 'customer' | 'user' | 'admin' | 'settings'
  | 'notification' | 'file' | 'system' | 'finance';
export type AuditEntityType =
  | 'provider' | 'booking' | 'customer' | 'user' | 'service'
  | 'service_option' | 'addon' | 'provider_application' | 'provider_requirement'
  | 'onboarding_case' | 'payment' | 'notification' | 'settings' | 'admin_role' | 'system'
  | 'catalog_offering' | 'catalog_mapping' | 'catalog_service_option' | 'catalog_addon'
  | 'disbursement' | 'refund_review' | 'reconciliation_exception' | 'ledger_entry'
  | 'admin_user' | 'permission_grant' | 'permission_profile';

export interface AuditWriteOpts {
  action: string;
  actionCategory: AuditCategory;
  outcome: AuditOutcome;
  actorUid?: string | null;
  actorType?: 'admin' | 'system' | 'customer' | 'provider';
  actorRole?: string | number | null;
  actorDisplayName?: string | null;
  actorEmail?: string | null;
  entityType: AuditEntityType;
  entityId: string;
  entityDisplayName?: string | null;
  relatedEntities?: Array<{ entityType: string; entityId: string; entityDisplayName?: string | null }>;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  changedFields?: string[];
  reason?: string | null;
  note?: string | null;
  requestId?: string | null;
  clientRequestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  source?: 'admin_portal' | 'backend_job' | 'api' | 'system';
  metadata?: Record<string, unknown>;
}

export interface AuditFilters {
  fromDate?: string;
  toDate?: string;
  action?: string;
  actionCategory?: string;
  outcome?: string;
  actorUid?: string;
  entityType?: string;
  entityId?: string;
  requestId?: string;
  search?: string;
  page?: number;
  limit?: number;
}

// ── Sensitive key patterns ──────��─────────────────────────────────────────────

const SENSITIVE_PATTERNS = [
  'password', 'token', 'authorization', 'secret',
  'apikey', 'privatekey', 'otp', 'resettoken',
];

// ── High-risk actions (used for summary counts and severity) ──────────────────

const HIGH_RISK_ACTIONS: string[] = [
  'onboarding_final_approved', 'onboarding_final_rejected',
  'provider_application_approved', 'provider_application_rejected',
  'booking_cancelled', 'booking_completion_approved',
  'payment_approved', 'payment_rejected',
  'provider_archived', 'provider_restored',
  'provider_suspended', 'provider_unsuspended',
  'provider_status_changed', 'catalog_published',
  'user_role_changed', 'user_archived',
  'admin_role_created', 'admin_role_deleted',
  'admin_permission_granted', 'admin_permission_revoked',
  'audit_export_requested',
  // Finance high-risk
  'finance_payment_gcash_approved', 'finance_payment_gcash_rejected',
  'finance_payout_retry_triggered', 'finance_refund_approved',
  'finance_reconciliation_run', 'finance_internal_fixer_tagged',
  // Permission high-risk
  'super_admin_granted', 'super_admin_revoked',
  'admin_user_created', 'admin_user_deactivated',
  'admin_permissions_updated',
];

// ── Action label map ──────────────────────────────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  // Auth
  admin_login_success: 'Admin Login',
  admin_login_failed: 'Login Failed',
  admin_logout: 'Admin Logout',
  admin_session_expired: 'Session Expired',
  admin_password_reset_requested: 'Password Reset Requested',
  admin_password_reset_completed: 'Password Reset Completed',
  admin_token_refresh_failed: 'Token Refresh Failed',
  // Provider
  provider_created: 'Provider Created',
  provider_profile_updated: 'Provider Profile Updated',
  provider_status_changed: 'Provider Status Changed',
  provider_archived: 'Provider Archived',
  provider_restored: 'Provider Restored',
  provider_suspended: 'Provider Suspended',
  provider_unsuspended: 'Provider Unsuspended',
  provider_service_area_updated: 'Service Area Updated',
  provider_availability_updated: 'Availability Updated',
  // Documents / requirements
  provider_document_uploaded: 'Document Uploaded',
  provider_document_deleted: 'Document Deleted',
  provider_document_approved: 'Document Approved',
  provider_document_rejected: 'Document Rejected',
  provider_document_resubmission_requested: 'Resubmission Requested',
  provider_requirement_status_changed: 'Requirement Status Changed',
  // Service applications
  provider_application_submitted: 'Application Submitted',
  provider_application_approved: 'Application Approved',
  provider_application_rejected: 'Application Rejected',
  provider_application_cancelled: 'Application Cancelled',
  // Onboarding
  onboarding_case_created: 'Case Created',
  onboarding_case_assigned: 'Case Assigned',
  onboarding_case_priority_changed: 'Priority Changed',
  onboarding_case_moved: 'Case Moved',
  onboarding_requirement_approved: 'Requirement Approved',
  onboarding_requirement_rejected: 'Requirement Rejected',
  onboarding_resubmission_requested: 'Resubmission Requested',
  onboarding_note_added: 'Note Added',
  onboarding_final_approved: 'Provider Final Approved',
  onboarding_final_rejected: 'Provider Final Rejected',
  // Booking
  booking_created: 'Booking Created',
  booking_status_changed: 'Booking Status Changed',
  booking_assigned: 'Booking Assigned',
  booking_reassigned: 'Booking Reassigned',
  booking_rescheduled: 'Booking Rescheduled',
  booking_cancelled: 'Booking Cancelled',
  booking_escalated: 'Booking Escalated',
  booking_completion_approved: 'Completion Approved',
  booking_note_added: 'Note Added',
  // Payment
  payment_submitted: 'Payment Submitted',
  payment_approved: 'Payment Approved',
  payment_rejected: 'Payment Rejected',
  cash_payment_marked_paid: 'Cash Payment Marked Paid',
  // Finance operations
  finance_payment_gcash_approved: 'GCash Payment Approved',
  finance_payment_gcash_rejected: 'GCash Payment Rejected',
  finance_payment_cash_confirmed: 'Cash Payment Confirmed',
  finance_payout_held: 'Payout Held',
  finance_payout_hold_released: 'Payout Hold Released',
  finance_payout_retry_triggered: 'Payout Retry Triggered',
  finance_refund_opened: 'Refund Review Opened',
  finance_refund_approved: 'Refund Approved',
  finance_refund_rejected: 'Refund Rejected',
  finance_refund_processed: 'Refund Processed',
  finance_reconciliation_run: 'Reconciliation Run',
  finance_exception_resolved: 'Exception Resolved',
  finance_exception_ignored: 'Exception Ignored',
  finance_ledger_entry_created: 'Ledger Entry Created',
  finance_internal_fixer_tagged: 'Provider Tagged as Internal Fixer',
  // Catalog
  catalog_offering_created: 'Offering Created',
  catalog_offering_updated: 'Offering Updated',
  catalog_offering_archived: 'Offering Archived',
  catalog_published: 'Catalog Published',
  specific_service_created: 'Service Created',
  specific_service_updated: 'Service Updated',
  specific_service_archived: 'Service Archived',
  // Users / customers
  customer_profile_updated_by_admin: 'Customer Profile Updated',
  customer_archived: 'Customer Archived',
  customer_restored: 'Customer Restored',
  user_created: 'User Created',
  user_updated: 'User Updated',
  user_archived: 'User Archived',
  user_restored: 'User Restored',
  user_role_changed: 'User Role Changed',
  user_account_status_changed: 'Account Status Changed',
  // Admin users / permissions
  admin_role_created: 'Role Created',
  admin_role_updated: 'Role Updated',
  admin_role_deleted: 'Role Deleted',
  admin_permission_granted: 'Permission Granted',
  admin_permission_revoked: 'Permission Revoked',
  admin_user_created: 'Admin User Created',
  admin_user_updated: 'Admin User Updated',
  admin_user_deactivated: 'Admin User Deactivated',
  admin_user_reactivated: 'Admin User Reactivated',
  admin_permissions_updated: 'Admin Permissions Updated',
  admin_permissions_previewed: 'Permissions Previewed',
  super_admin_granted: 'Super Admin Granted',
  super_admin_revoked: 'Super Admin Revoked',
  admin_permission_change_blocked: 'Permission Change Blocked',
  admin_access_denied: 'Admin Access Denied',
  settings_updated: 'Settings Updated',
  // System
  audit_export_requested: 'Audit Export Requested',
};

// ── Redaction ─────────────────────────────────────────────────────────────────

export function redactSensitiveFields<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj as T;
  if (Array.isArray(obj)) {
    return (obj as unknown[]).map((item) => redactSensitiveFields(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lk = key.toLowerCase();
    const isSensitive = SENSITIVE_PATTERNS.some((p) => lk.includes(p));

    if (isSensitive) {
      result[key] = '[REDACTED]';
    } else if (
      typeof value === 'string' &&
      (value.startsWith('data:') ||
        (value.length > 500 && /^[A-Za-z0-9+/\r\n]+=*$/.test(value)))
    ) {
      result[key] = '[REDACTED_DATA]';
    } else if (value !== null && typeof value === 'object') {
      result[key] = redactSensitiveFields(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result as unknown as T;
}

// ── Severity computation ────────────��─────────────────────────────────────────

function computeSeverity(action: string, outcome: string): 'info' | 'warning' | 'critical' {
  if (outcome === 'blocked') return 'warning';
  if (outcome === 'failed') return 'warning';
  if (HIGH_RISK_ACTIONS.includes(action)) return 'critical';
  return 'info';
}

// ── Display time (Asia/Manila) ────────────���───────────────────────────────────

function toManilaTime(isoString: string | Date): string {
  try {
    const d = isoString instanceof Date ? isoString : new Date(isoString);
    return new Intl.DateTimeFormat('en-PH', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(d);
  } catch {
    return String(isoString);
  }
}

// ── Action summary builder ─��──────────────────────────────────────────────────

function buildSummary(action: string, outcome: string, entityType: string, entityId: string, actorDisplay: string | null): string {
  const label = ACTION_LABELS[action] ?? action;
  const actor = actorDisplay ?? 'System';
  const ot = outcome === 'success' ? '' : ` [${outcome.toUpperCase()}]`;
  return `${actor} performed "${label}" on ${entityType}:${entityId}${ot}`;
}

// ── Schema bootstrap ──────────────────────────────────────────��───────────────

export async function ensureAuditSchema(): Promise<void> {
  const schema = db.schema;
  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.admin_audit_events (
      id              SERIAL PRIMARY KEY,
      event_id        TEXT NOT NULL UNIQUE,
      occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      action          VARCHAR(100) NOT NULL,
      action_category VARCHAR(30)  NOT NULL,
      outcome         VARCHAR(20)  NOT NULL DEFAULT 'success',
      actor_uid       TEXT,
      actor_type      VARCHAR(20)  NOT NULL DEFAULT 'admin',
      actor_role      VARCHAR(20),
      actor_display_name TEXT,
      actor_email     TEXT,
      entity_type     VARCHAR(50)  NOT NULL,
      entity_id       TEXT         NOT NULL,
      entity_display_name TEXT,
      related_entities JSONB,
      before_json     JSONB,
      after_json      JSONB,
      changed_fields  TEXT[],
      reason          TEXT,
      note            TEXT,
      request_id      TEXT,
      client_request_id TEXT,
      ip_address      TEXT,
      user_agent      TEXT,
      source          VARCHAR(30)  NOT NULL DEFAULT 'admin_portal',
      metadata        JSONB,
      schema_version  INTEGER      NOT NULL DEFAULT 1,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  // Indexes for efficient querying
  const indexes: Array<[string, string]> = [
    ['admin_audit_events_occurred_at_idx',    'occurred_at DESC'],
    ['admin_audit_events_action_idx',          'action'],
    ['admin_audit_events_category_idx',        'action_category'],
    ['admin_audit_events_outcome_idx',         'outcome'],
    ['admin_audit_events_actor_uid_idx',       'actor_uid'],
    ['admin_audit_events_entity_idx',          'entity_type, entity_id'],
    ['admin_audit_events_request_id_idx',      'request_id'],
  ];

  for (const [name, cols] of indexes) {
    await dbQuery.query(
      `CREATE INDEX IF NOT EXISTS ${name} ON ${schema}.admin_audit_events (${cols})`
    );
  }
}

// ── Write ─────────────���─────────────────────────────���─────────────────────────

export async function writeEvent(opts: AuditWriteOpts): Promise<void> {
  const schema = db.schema;
  const eventId = randomUUID();

  const before = opts.before ? redactSensitiveFields(opts.before) : null;
  const after = opts.after ? redactSensitiveFields(opts.after) : null;

  await dbQuery.query(
    `INSERT INTO ${schema}.admin_audit_events
      (event_id, action, action_category, outcome,
       actor_uid, actor_type, actor_role, actor_display_name, actor_email,
       entity_type, entity_id, entity_display_name,
       related_entities, before_json, after_json, changed_fields,
       reason, note, request_id, client_request_id, ip_address, user_agent,
       source, metadata, schema_version)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,1)`,
    [
      eventId,
      opts.action,
      opts.actionCategory,
      opts.outcome,
      opts.actorUid ?? null,
      opts.actorType ?? 'admin',
      opts.actorRole != null ? String(opts.actorRole) : null,
      opts.actorDisplayName ?? null,
      opts.actorEmail ?? null,
      opts.entityType,
      opts.entityId,
      opts.entityDisplayName ?? null,
      opts.relatedEntities ? JSON.stringify(opts.relatedEntities) : null,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      opts.changedFields ?? null,
      opts.reason ?? null,
      opts.note ?? null,
      opts.requestId ?? null,
      opts.clientRequestId ?? null,
      opts.ipAddress ?? null,
      opts.userAgent ?? null,
      opts.source ?? 'admin_portal',
      opts.metadata ? JSON.stringify(opts.metadata) : null,
    ]
  );
}

export function writeSuccess(opts: Omit<AuditWriteOpts, 'outcome'>): Promise<void> {
  return writeEvent({ ...opts, outcome: 'success' });
}

export function writeFailure(opts: Omit<AuditWriteOpts, 'outcome'>): Promise<void> {
  return writeEvent({ ...opts, outcome: 'failed' });
}

export function writeBlocked(opts: Omit<AuditWriteOpts, 'outcome'>): Promise<void> {
  return writeEvent({ ...opts, outcome: 'blocked' });
}

// Fire-and-forget helper: logs errors but does not throw
export function auditFire(opts: AuditWriteOpts): void {
  writeEvent(opts).catch((e: unknown) => console.error('[audit-fire]', e));
}

// ── Query helpers ─────────────────────────────────────────────────────────────

function buildWhereClause(filters: AuditFilters): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  const add = (condition: string, value: unknown) => {
    params.push(value);
    conditions.push(condition.replace('?', `$${params.length}`));
  };

  if (filters.fromDate) add(`occurred_at >= ?`, filters.fromDate);
  if (filters.toDate) add(`occurred_at < ?::date + INTERVAL '1 day'`, filters.toDate);
  if (filters.action) add(`action = ?`, filters.action);
  if (filters.actionCategory) add(`action_category = ?`, filters.actionCategory);
  if (filters.outcome) add(`outcome = ?`, filters.outcome);
  if (filters.actorUid) add(`actor_uid = ?`, filters.actorUid);
  if (filters.entityType) add(`entity_type = ?`, filters.entityType);
  if (filters.entityId) add(`entity_id = ?`, filters.entityId);
  if (filters.requestId) add(`request_id = ?`, filters.requestId);
  if (filters.search) {
    params.push(`%${filters.search}%`);
    const p = params.length;
    conditions.push(
      `(actor_display_name ILIKE $${p} OR actor_email ILIKE $${p} OR entity_display_name ILIKE $${p} OR action ILIKE $${p} OR reason ILIKE $${p})`
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

function rowToListItem(r: Record<string, unknown>) {
  const occurredAt = String(r['occurred_at'] ?? '');
  const action = String(r['action'] ?? '');
  const outcome = String(r['outcome'] ?? 'success');
  const actorDisplay = r['actor_display_name'] ? String(r['actor_display_name']) : null;
  const entityType = String(r['entity_type'] ?? '');
  const entityId = String(r['entity_id'] ?? '');

  return {
    eventId:            String(r['event_id'] ?? ''),
    occurredAt,
    displayTime:        toManilaTime(occurredAt),
    action,
    actionLabel:        ACTION_LABELS[action] ?? action,
    actionCategory:     String(r['action_category'] ?? ''),
    outcome,
    actorUid:           r['actor_uid'] ? String(r['actor_uid']) : null,
    actorDisplayName:   actorDisplay,
    actorRole:          r['actor_role'] ? String(r['actor_role']) : null,
    entityType,
    entityId,
    entityDisplayName:  r['entity_display_name'] ? String(r['entity_display_name']) : null,
    summary:            buildSummary(action, outcome, entityType, entityId, actorDisplay),
    severity:           computeSeverity(action, outcome),
    requestId:          r['request_id'] ? String(r['request_id']) : null,
  };
}

// ── findEvents ────────────────────────────────────────────────────────────────

export async function findEvents(filters: AuditFilters): Promise<{
  rows: ReturnType<typeof rowToListItem>[];
  total: number;
  page: number;
  limit: number;
}> {
  const schema = db.schema;
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(200, filters.limit ?? 50);
  const offset = (page - 1) * limit;

  const { where, params } = buildWhereClause(filters);

  const countRes = await dbQuery.query(
    `SELECT COUNT(*) FROM ${schema}.admin_audit_events ${where}`,
    params
  );
  const total = Number(countRes.rows[0]?.count ?? 0);

  const dataParams = [...params, limit, offset];
  const dataRes = await dbQuery.query(
    `SELECT event_id, occurred_at, action, action_category, outcome,
            actor_uid, actor_type, actor_role, actor_display_name, actor_email,
            entity_type, entity_id, entity_display_name,
            reason, request_id
     FROM ${schema}.admin_audit_events
     ${where}
     ORDER BY occurred_at DESC
     LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
    dataParams
  );

  return {
    rows: dataRes.rows.map(rowToListItem),
    total,
    page,
    limit,
  };
}

// ── getEventById ────────────���─────────────────────────────────────────────────

export async function getEventById(eventId: string): Promise<Record<string, unknown> | null> {
  const schema = db.schema;
  const res = await dbQuery.query(
    `SELECT * FROM ${schema}.admin_audit_events WHERE event_id = $1 LIMIT 1`,
    [eventId]
  );
  if (!res.rows.length) return null;

  const r = res.rows[0];
  const action = String(r.action ?? '');
  const outcome = String(r.outcome ?? 'success');
  const occurredAt = String(r.occurred_at ?? '');
  const actorDisplay = r.actor_display_name ? String(r.actor_display_name) : null;
  const entityType = String(r.entity_type ?? '');
  const entityId = String(r.entity_id ?? '');

  return {
    eventId:           String(r.event_id ?? ''),
    occurredAt,
    displayTime:       toManilaTime(occurredAt),
    action,
    actionLabel:       ACTION_LABELS[action] ?? action,
    actionCategory:    String(r.action_category ?? ''),
    outcome,
    actor: {
      actorUid:          r.actor_uid ?? null,
      actorType:         String(r.actor_type ?? 'admin'),
      actorRole:         r.actor_role ?? null,
      actorDisplayName:  actorDisplay,
      actorEmail:        r.actor_email ?? null,
    },
    entity: {
      entityType,
      entityId,
      entityDisplayName: r.entity_display_name ?? null,
    },
    relatedEntities:   r.related_entities ?? null,
    before:            r.before_json ?? null,
    after:             r.after_json ?? null,
    changedFields:     r.changed_fields ?? [],
    reason:            r.reason ?? null,
    note:              r.note ?? null,
    request: {
      requestId:       r.request_id ?? null,
      clientRequestId: r.client_request_id ?? null,
      ipAddress:       r.ip_address ?? null,
      userAgent:       r.user_agent ?? null,
      source:          String(r.source ?? 'admin_portal'),
    },
    metadata:          r.metadata ?? null,
    severity:          computeSeverity(action, outcome),
    display: {
      title:      ACTION_LABELS[action] ?? action,
      summary:    buildSummary(action, outcome, entityType, entityId, actorDisplay),
      actorLabel: actorDisplay ?? (r.actor_uid ? String(r.actor_uid) : 'System'),
      entityLabel: `${entityType}:${entityId}`,
      changedFieldsSummary: Array.isArray(r.changed_fields) ? r.changed_fields as string[] : [],
    },
  };
}

// ── findEntityTimeline ────────────────────────────────────────────────────────

export async function findEntityTimeline(
  entityType: string,
  entityId: string,
  opts: { limit?: number; page?: number } = {}
): Promise<{ rows: ReturnType<typeof rowToListItem>[]; total: number }> {
  const schema = db.schema;
  const limit = Math.min(200, opts.limit ?? 50);
  const page = Math.max(1, opts.page ?? 1);
  const offset = (page - 1) * limit;

  const countRes = await dbQuery.query(
    `SELECT COUNT(*) FROM ${schema}.admin_audit_events WHERE entity_type = $1 AND entity_id = $2`,
    [entityType, entityId]
  );
  const total = Number(countRes.rows[0]?.count ?? 0);

  const dataRes = await dbQuery.query(
    `SELECT event_id, occurred_at, action, action_category, outcome,
            actor_uid, actor_type, actor_role, actor_display_name, actor_email,
            entity_type, entity_id, entity_display_name, reason, request_id
     FROM ${schema}.admin_audit_events
     WHERE entity_type = $1 AND entity_id = $2
     ORDER BY occurred_at DESC
     LIMIT $3 OFFSET $4`,
    [entityType, entityId, limit, offset]
  );

  return { rows: dataRes.rows.map(rowToListItem), total };
}

// ── findActorTimeline ───────────��─────────────────────────────────────────────

export async function findActorTimeline(
  actorUid: string,
  opts: { limit?: number; page?: number } = {}
): Promise<{ rows: ReturnType<typeof rowToListItem>[]; total: number }> {
  const schema = db.schema;
  const limit = Math.min(200, opts.limit ?? 50);
  const page = Math.max(1, opts.page ?? 1);
  const offset = (page - 1) * limit;

  const countRes = await dbQuery.query(
    `SELECT COUNT(*) FROM ${schema}.admin_audit_events WHERE actor_uid = $1`,
    [actorUid]
  );
  const total = Number(countRes.rows[0]?.count ?? 0);

  const dataRes = await dbQuery.query(
    `SELECT event_id, occurred_at, action, action_category, outcome,
            actor_uid, actor_type, actor_role, actor_display_name, actor_email,
            entity_type, entity_id, entity_display_name, reason, request_id
     FROM ${schema}.admin_audit_events
     WHERE actor_uid = $1
     ORDER BY occurred_at DESC
     LIMIT $2 OFFSET $3`,
    [actorUid, limit, offset]
  );

  return { rows: dataRes.rows.map(rowToListItem), total };
}

// ── getSummary ─────────────────────────────────────────────���──────────────────

export async function getSummary(filters: Omit<AuditFilters, 'page' | 'limit'>): Promise<{
  total: number;
  failed: number;
  blocked: number;
  highRisk: number;
  payment: number;
  booking: number;
  provider: number;
  catalog: number;
}> {
  const schema = db.schema;
  const { where, params } = buildWhereClause(filters);
  const hrParam = params.length + 1;

  const res = await dbQuery.query(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE outcome = 'failed')  AS failed,
       COUNT(*) FILTER (WHERE outcome = 'blocked') AS blocked,
       COUNT(*) FILTER (WHERE action = ANY($${hrParam})) AS high_risk,
       COUNT(*) FILTER (WHERE action_category = 'payment')  AS payment,
       COUNT(*) FILTER (WHERE action_category = 'booking')  AS booking,
       COUNT(*) FILTER (WHERE action_category IN ('provider','onboarding')) AS provider,
       COUNT(*) FILTER (WHERE action_category = 'catalog')  AS catalog
     FROM ${schema}.admin_audit_events
     ${where}`,
    [...params, HIGH_RISK_ACTIONS]
  );

  const row = res.rows[0] ?? {};
  return {
    total:    Number(row.total    ?? 0),
    failed:   Number(row.failed   ?? 0),
    blocked:  Number(row.blocked  ?? 0),
    highRisk: Number(row.high_risk ?? 0),
    payment:  Number(row.payment  ?? 0),
    booking:  Number(row.booking  ?? 0),
    provider: Number(row.provider ?? 0),
    catalog:  Number(row.catalog  ?? 0),
  };
}

// ── Export ────────────────────────────────────────────────────────────────────

const EXPORT_LIMIT = 10_000;

export async function exportEvents(
  filters: AuditFilters,
  format: 'csv' | 'json',
  reason: string,
  actorUid: string,
  requestId: string | null
): Promise<{ content: string; format: 'csv' | 'json'; count: number }> {
  const schema = db.schema;
  const { where, params } = buildWhereClause(filters);

  const dataParams = [...params, EXPORT_LIMIT];
  const dataRes = await dbQuery.query(
    `SELECT event_id, occurred_at, action, action_category, outcome,
            actor_uid, actor_display_name, actor_email,
            entity_type, entity_id, entity_display_name,
            reason, request_id, source
     FROM ${schema}.admin_audit_events
     ${where}
     ORDER BY occurred_at DESC
     LIMIT $${dataParams.length}`,
    dataParams
  );

  const rows = dataRes.rows;

  // Write audit event for this export
  auditFire({
    action: 'audit_export_requested',
    actionCategory: 'admin',
    outcome: 'success',
    actorUid,
    entityType: 'system',
    entityId: 'audit_logs',
    reason,
    requestId,
    metadata: { rowCount: rows.length, format, filters },
  });

  if (format === 'json') {
    return { content: JSON.stringify(rows, null, 2), format, count: rows.length };
  }

  // CSV
  const headers = [
    'event_id', 'occurred_at', 'action', 'action_category', 'outcome',
    'actor_uid', 'actor_display_name', 'actor_email',
    'entity_type', 'entity_id', 'entity_display_name',
    'reason', 'request_id', 'source',
  ];
  const escape = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    headers.join(','),
    ...rows.map((r: Record<string, unknown>) =>
      headers.map((h) => escape(r[h])).join(',')
    ),
  ];

  return { content: lines.join('\n'), format, count: rows.length };
}

// ── Action registry for filter dropdown ────��─────────────────────────────────

export function getActionRegistry(): Array<{
  action: string;
  label: string;
  category: string;
}> {
  return Object.entries(ACTION_LABELS).map(([action, label]) => {
    const categoryMap: Record<string, string> = {
      admin_login: 'auth', admin_logout: 'auth', admin_session: 'auth',
      admin_password: 'auth', admin_token: 'auth',
      provider_: 'provider',
      onboarding_: 'onboarding',
      booking_: 'booking',
      payment_: 'payment', cash_: 'payment',
      catalog_: 'catalog', specific_service: 'catalog',
      customer_: 'customer',
      user_: 'user',
      audit_: 'admin', settings_: 'settings',
    };
    let category = 'system';
    for (const [prefix, cat] of Object.entries(categoryMap)) {
      if (action.startsWith(prefix)) { category = cat; break; }
    }
    return { action, label, category };
  });
}
