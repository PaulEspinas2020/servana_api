'use strict';

/**
 * Admin Audit System — unit + contract tests
 *
 * Tests are self-contained JS (no TS imports) to avoid needing a TS transform.
 * Pure-logic functions are re-implemented inline; DB-layer tests mock pg via
 * jest module factories; route-contract tests inspect the source files as text.
 */

var fs = require('fs');
var path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Pure-logic re-implementations (kept in sync with adminAuditService.ts)
// ─────────────────────────────────────────────────────────────────────────────

var SENSITIVE_PATTERNS = [
  'password', 'token', 'authorization', 'secret',
  'apikey', 'privatekey', 'otp', 'resettoken',
];

var HIGH_RISK_ACTIONS = [
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
];

function redactSensitiveFields(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(function (item) { return redactSensitiveFields(item); });
  }
  var result = {};
  Object.keys(obj).forEach(function (key) {
    var value = obj[key];
    var lk = key.toLowerCase();
    var isSensitive = SENSITIVE_PATTERNS.some(function (p) { return lk.indexOf(p) !== -1; });
    if (isSensitive) {
      result[key] = '[REDACTED]';
    } else if (
      typeof value === 'string' &&
      (value.indexOf('data:') === 0 ||
        (value.length > 500 && /^[A-Za-z0-9+/\r\n]+=*$/.test(value)))
    ) {
      result[key] = '[REDACTED_DATA]';
    } else if (value !== null && typeof value === 'object') {
      result[key] = redactSensitiveFields(value);
    } else {
      result[key] = value;
    }
  });
  return result;
}

function computeSeverity(action, outcome) {
  if (outcome === 'blocked') return 'warning';
  if (outcome === 'failed') return 'warning';
  if (HIGH_RISK_ACTIONS.indexOf(action) !== -1) return 'critical';
  return 'info';
}

function buildCsvLine(headers, row, escape) {
  return headers.map(function (h) { return escape(row[h]); }).join(',');
}

function escapeCsv(v) {
  var s = v == null ? '' : String(v);
  return s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1
    ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildWhereClause(filters) {
  var conditions = [];
  var params = [];
  function add(condition, value) {
    params.push(value);
    conditions.push(condition.replace('?', '$' + params.length));
  }
  if (filters.fromDate) add('occurred_at >= ?', filters.fromDate);
  if (filters.toDate) add("occurred_at < ?::date + INTERVAL '1 day'", filters.toDate);
  if (filters.action) add('action = ?', filters.action);
  if (filters.actionCategory) add('action_category = ?', filters.actionCategory);
  if (filters.outcome) add('outcome = ?', filters.outcome);
  if (filters.actorUid) add('actor_uid = ?', filters.actorUid);
  if (filters.entityType) add('entity_type = ?', filters.entityType);
  if (filters.entityId) add('entity_id = ?', filters.entityId);
  if (filters.requestId) add('request_id = ?', filters.requestId);
  if (filters.search) {
    params.push('%' + filters.search + '%');
    var p = params.length;
    conditions.push(
      '(actor_display_name ILIKE $' + p +
      ' OR actor_email ILIKE $' + p +
      ' OR entity_display_name ILIKE $' + p +
      ' OR action ILIKE $' + p +
      ' OR reason ILIKE $' + p + ')'
    );
  }
  var where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  return { where: where, params: params };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. redactSensitiveFields
// ─────────────────────────────────────────────────────────────────────────────

describe('redactSensitiveFields', function () {
  it('redacts password keys', function () {
    var result = redactSensitiveFields({ password: 'secret123', name: 'Alice' });
    expect(result.password).toBe('[REDACTED]');
    expect(result.name).toBe('Alice');
  });

  it('redacts token keys (case-insensitive substring)', function () {
    var result = redactSensitiveFields({ accessToken: 'tok', resetToken: 'rt', note: 'hi' });
    expect(result.accessToken).toBe('[REDACTED]');
    expect(result.resetToken).toBe('[REDACTED]');
    expect(result.note).toBe('hi');
  });

  it('redacts authorization keys', function () {
    var result = redactSensitiveFields({ authorization: 'Bearer xyz' });
    expect(result.authorization).toBe('[REDACTED]');
  });

  it('redacts otp keys', function () {
    var result = redactSensitiveFields({ otp: '123456', otpCode: '654321' });
    expect(result.otp).toBe('[REDACTED]');
    expect(result.otpCode).toBe('[REDACTED]');
  });

  it('redacts apiKey, privateKey, secret keys', function () {
    var result = redactSensitiveFields({ apiKey: 'k', privateKey: 'pem', secret: 's' });
    expect(result.apiKey).toBe('[REDACTED]');
    expect(result.privateKey).toBe('[REDACTED]');
    expect(result.secret).toBe('[REDACTED]');
  });

  it('redacts data: URI values', function () {
    var result = redactSensitiveFields({ photo: 'data:image/png;base64,abc' });
    expect(result.photo).toBe('[REDACTED_DATA]');
  });

  it('redacts long base64-like values (> 500 chars)', function () {
    var longB64 = 'A'.repeat(501);
    var result = redactSensitiveFields({ encoded: longB64 });
    expect(result.encoded).toBe('[REDACTED_DATA]');
  });

  it('does NOT redact short safe values', function () {
    var result = redactSensitiveFields({ status: 'approved', count: 3 });
    expect(result.status).toBe('approved');
    expect(result.count).toBe(3);
  });

  it('redacts nested sensitive fields', function () {
    var result = redactSensitiveFields({ user: { password: 'pw', email: 'a@b.com' } });
    expect(result.user.password).toBe('[REDACTED]');
    expect(result.user.email).toBe('a@b.com');
  });

  it('handles null and undefined gracefully', function () {
    expect(redactSensitiveFields(null)).toBeNull();
    expect(redactSensitiveFields(undefined)).toBeUndefined();
  });

  it('handles arrays with nested sensitive data', function () {
    var result = redactSensitiveFields([{ token: 'x', id: '1' }]);
    expect(result[0].token).toBe('[REDACTED]');
    expect(result[0].id).toBe('1');
  });

  it('self-test: does not redact ordinary fields', function () {
    var input = { reason: 'user requested', status: 'active', amount: 500 };
    var result = redactSensitiveFields(input);
    expect(result).toEqual(input);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. computeSeverity
// ─────────────────────────────────────────────────────────────────────────────

describe('computeSeverity', function () {
  it('blocked outcome → warning', function () {
    expect(computeSeverity('booking_assigned', 'blocked')).toBe('warning');
  });

  it('failed outcome → warning', function () {
    expect(computeSeverity('provider_archived', 'failed')).toBe('warning');
  });

  it('high-risk action + success → critical', function () {
    HIGH_RISK_ACTIONS.forEach(function (action) {
      expect(computeSeverity(action, 'success')).toBe('critical');
    });
  });

  it('non-high-risk action + success → info', function () {
    expect(computeSeverity('booking_note_added', 'success')).toBe('info');
    expect(computeSeverity('onboarding_note_added', 'success')).toBe('info');
    expect(computeSeverity('provider_document_uploaded', 'success')).toBe('info');
  });

  it('blocked outcome beats high-risk (still warning, not critical)', function () {
    expect(computeSeverity('booking_cancelled', 'blocked')).toBe('warning');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. buildWhereClause
// ─────────────────────────────────────────────────────────────────────────────

describe('buildWhereClause', function () {
  it('returns empty WHERE for empty filters', function () {
    var result = buildWhereClause({});
    expect(result.where).toBe('');
    expect(result.params).toHaveLength(0);
  });

  it('generates parameterized WHERE for action filter', function () {
    var result = buildWhereClause({ action: 'provider_archived' });
    expect(result.where).toContain('action = $1');
    expect(result.params[0]).toBe('provider_archived');
  });

  it('generates sequential $N params for multiple filters', function () {
    var result = buildWhereClause({
      action: 'booking_cancelled',
      outcome: 'success',
      actorUid: 'uid-1',
    });
    expect(result.where).toContain('action = $1');
    expect(result.where).toContain('outcome = $2');
    expect(result.where).toContain('actor_uid = $3');
    expect(result.params).toEqual(['booking_cancelled', 'success', 'uid-1']);
  });

  it('handles date range filters', function () {
    var result = buildWhereClause({ fromDate: '2026-01-01', toDate: '2026-12-31' });
    expect(result.where).toContain('occurred_at >= $1');
    expect(result.params).toContain('2026-01-01');
    expect(result.params).toContain('2026-12-31');
  });

  it('handles search with ILIKE across multiple columns', function () {
    var result = buildWhereClause({ search: 'maria' });
    expect(result.where).toContain('ILIKE $1');
    expect(result.params[0]).toBe('%maria%');
  });

  it('handles entity type+id filters', function () {
    var result = buildWhereClause({ entityType: 'booking', entityId: 'bk-1' });
    expect(result.params).toContain('booking');
    expect(result.params).toContain('bk-1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. CSV export logic
// ─────────────────────────────────────────────────────────────────────────────

describe('CSV export logic', function () {
  var headers = ['event_id', 'action', 'outcome', 'actor_uid'];

  it('produces a header row as first line', function () {
    // empty row → 4 empty strings joined by 3 commas
    expect(buildCsvLine(headers, {}, escapeCsv)).toBe(',,,');
    var header = headers.join(',');
    expect(header).toBe('event_id,action,outcome,actor_uid');
  });

  it('produces correct data row', function () {
    var row = { event_id: 'ev-1', action: 'booking_cancelled', outcome: 'success', actor_uid: 'uid-1' };
    var line = buildCsvLine(headers, row, escapeCsv);
    expect(line).toBe('ev-1,booking_cancelled,success,uid-1');
  });

  it('escapes values that contain commas', function () {
    var row = { event_id: 'ev-2', action: 'a,b', outcome: 'success', actor_uid: 'uid-2' };
    var line = buildCsvLine(headers, row, escapeCsv);
    expect(line).toContain('"a,b"');
  });

  it('escapes values that contain double-quotes', function () {
    var row = { event_id: 'ev-3', action: 'a"b', outcome: 'success', actor_uid: 'uid-3' };
    var line = buildCsvLine(headers, row, escapeCsv);
    expect(line).toContain('"a""b"');
  });

  it('null/undefined values produce empty fields', function () {
    var row = { event_id: 'ev-4', action: null, outcome: undefined, actor_uid: 'uid-4' };
    var line = buildCsvLine(headers, row, escapeCsv);
    expect(line).toBe('ev-4,,,uid-4');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. HIGH_RISK_ACTIONS completeness
// ─────────────────────────────────────────────────────────────────────────────

describe('HIGH_RISK_ACTIONS set', function () {
  var required = [
    'onboarding_final_approved', 'onboarding_final_rejected',
    'provider_application_approved', 'provider_application_rejected',
    'booking_cancelled', 'booking_completion_approved',
    'payment_approved', 'payment_rejected',
    'provider_archived', 'provider_restored',
    'user_role_changed', 'user_archived',
    'catalog_published', 'audit_export_requested',
  ];

  required.forEach(function (action) {
    it('includes ' + action, function () {
      expect(HIGH_RISK_ACTIONS).toContain(action);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Route file contract tests (source-text based)
// ─────────────────────────────────────────────────────────────────────────────

describe('adminAudit.routes.ts contract', function () {
  var routeSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/routes/adminAudit.routes.ts'),
    'utf8'
  );

  it('all GET/POST routes use /admin/audit-logs prefix', function () {
    var lines = routeSrc.split('\n').filter(function (l) {
      return l.trim().indexOf("router.get('/") !== -1 || l.trim().indexOf("router.post('/") !== -1;
    });
    expect(lines.length).toBeGreaterThan(0);
    lines.forEach(function (line) {
      expect(line).toContain('/admin/audit-logs');
    });
  });

  it('uses verifyAuth (authentication guard)', function () {
    expect(routeSrc).toContain('verifyAuth');
  });

  it('uses verifyRoles (authorization guard)', function () {
    expect(routeSrc).toContain('verifyRoles');
  });

  it('exports GET /admin/audit-logs (list)', function () {
    expect(routeSrc).toContain("router.get('/admin/audit-logs'");
  });

  it('exports GET /admin/audit-logs/summary', function () {
    expect(routeSrc).toContain("'/admin/audit-logs/summary'");
  });

  it('exports GET /admin/audit-logs/actions', function () {
    expect(routeSrc).toContain("'/admin/audit-logs/actions'");
  });

  it('exports GET /admin/audit-logs/:eventId (detail)', function () {
    expect(routeSrc).toContain("'/admin/audit-logs/:eventId'");
  });

  it('exports entity timeline endpoint', function () {
    expect(routeSrc).toContain("'/admin/audit-logs/entity/:entityType/:entityId'");
  });

  it('exports actor history endpoint', function () {
    expect(routeSrc).toContain("'/admin/audit-logs/actor/:actorUid'");
  });

  it('exports POST /admin/audit-logs/export', function () {
    expect(routeSrc).toContain("router.post('/admin/audit-logs/export'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Compatibility — protected route files must not import adminAuditService
// ─────────────────────────────────────────────────────────────────────────────

describe('compatibility guard — protected integrations unchanged', function () {
  var protectedRoutes = [
    '../src/routes/booking.routes.ts',
    '../src/routes/technician.routes.ts',
    '../src/routes/provider.routes.ts',
    '../src/routes/auth.route.ts',
    '../src/routes/service.route.ts',
    '../src/routes/user.route.ts',
    '../src/routes/payment.routes.ts',
    '../src/routes/location.routes.ts',
  ];

  protectedRoutes.forEach(function (rel) {
    it('does NOT import adminAuditService in ' + path.basename(rel), function () {
      var content = fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
      expect(content).not.toContain('adminAuditService');
    });
  });

  it('adminBookingController.ts imports auditFire/writeSuccess only from adminAuditService', function () {
    var src = fs.readFileSync(
      path.resolve(__dirname, '../src/controllers/adminBookingController.ts'),
      'utf8'
    );
    expect(src).toContain('adminAuditService');
    var importLine = src.split('\n').find(function (l) { return l.indexOf('adminAuditService') !== -1; });
    expect(importLine).toBeDefined();
    expect(importLine).toMatch(/auditFire|writeSuccess/);
  });

  it('adminOnboardingController.ts imports auditFire/writeSuccess from adminAuditService', function () {
    var src = fs.readFileSync(
      path.resolve(__dirname, '../src/controllers/adminOnboardingController.ts'),
      'utf8'
    );
    expect(src).toContain('adminAuditService');
    expect(src).toContain('auditFire');
    expect(src).toContain('writeSuccess');
  });

  it('adminProviderController.ts imports auditFire/writeSuccess from adminAuditService', function () {
    var src = fs.readFileSync(
      path.resolve(__dirname, '../src/controllers/adminProviderController.ts'),
      'utf8'
    );
    expect(src).toContain('adminAuditService');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Audit write integration points — action strings present in controllers
// ─────────────────────────────────────────────────────────────────────────────

describe('audit write integration points', function () {
  var onboardingSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/controllers/adminOnboardingController.ts'),
    'utf8'
  );
  var bookingSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/controllers/adminBookingController.ts'),
    'utf8'
  );
  var providerSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/controllers/adminProviderController.ts'),
    'utf8'
  );

  // Onboarding
  var onboardingActions = [
    'onboarding_case_assigned',
    'onboarding_case_priority_changed',
    'onboarding_case_moved',
    'onboarding_requirement_approved',
    'onboarding_requirement_rejected',
    'onboarding_resubmission_requested',
    'onboarding_note_added',
    'onboarding_final_approved',
    'onboarding_final_rejected',
  ];
  onboardingActions.forEach(function (action) {
    it('onboardingController writes "' + action + '"', function () {
      expect(onboardingSrc).toContain("'" + action + "'");
    });
  });

  // Booking
  var bookingActions = [
    'booking_assigned',
    'booking_reassigned',
    'booking_rescheduled',
    'booking_cancelled',
    'booking_escalated',
    'booking_completion_approved',
  ];
  bookingActions.forEach(function (action) {
    it('bookingController writes "' + action + '"', function () {
      expect(bookingSrc).toContain("'" + action + "'");
    });
  });

  // Provider
  var providerActions = [
    'provider_status_changed',
    'provider_archived',
    'provider_restored',
    'provider_document_uploaded',
    'provider_document_deleted',
    'provider_application_approved',
    'provider_application_rejected',
  ];
  providerActions.forEach(function (action) {
    it('providerController writes "' + action + '"', function () {
      expect(providerSrc).toContain("'" + action + "'");
    });
  });

  // High-risk actions use awaited writeSuccess (not fire-and-forget)
  it('finalApproveProvider uses await writeSuccess (not auditFire)', function () {
    // Find the finalApproveProvider function body
    var fnIdx = onboardingSrc.indexOf('finalApproveProvider');
    var fnBody = onboardingSrc.slice(fnIdx, fnIdx + 800);
    expect(fnBody).toContain('await writeSuccess');
  });

  it('finalRejectProvider uses await writeSuccess', function () {
    var fnIdx = onboardingSrc.indexOf('finalRejectProvider');
    var fnBody = onboardingSrc.slice(fnIdx, fnIdx + 800);
    expect(fnBody).toContain('await writeSuccess');
  });

  it('cancelBooking uses await writeSuccess', function () {
    var fnIdx = bookingSrc.indexOf('cancelBooking');
    var fnBody = bookingSrc.slice(fnIdx, fnIdx + 600);
    expect(fnBody).toContain('await writeSuccess');
  });

  it('approveCompletion uses await writeSuccess', function () {
    var fnIdx = bookingSrc.indexOf('approveCompletion');
    var fnBody = bookingSrc.slice(fnIdx, fnIdx + 600);
    expect(fnBody).toContain('await writeSuccess');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. adminAuditService.ts — structural assertions
// ─────────────────────────────────────────────────────────────────────────────

describe('adminAuditService.ts structural assertions', function () {
  var svcSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/services/adminAuditService.ts'),
    'utf8'
  );

  it('exports redactSensitiveFields', function () {
    expect(svcSrc).toContain('export function redactSensitiveFields');
  });

  it('exports writeEvent', function () {
    expect(svcSrc).toContain('export async function writeEvent');
  });

  it('exports writeSuccess, writeFailure, writeBlocked', function () {
    expect(svcSrc).toContain('export function writeSuccess');
    expect(svcSrc).toContain('export function writeFailure');
    expect(svcSrc).toContain('export function writeBlocked');
  });

  it('exports auditFire (fire-and-forget)', function () {
    expect(svcSrc).toContain('export function auditFire');
  });

  it('exports findEvents, getEventById, getSummary, exportEvents', function () {
    expect(svcSrc).toContain('export async function findEvents');
    expect(svcSrc).toContain('export async function getEventById');
    expect(svcSrc).toContain('export async function getSummary');
    expect(svcSrc).toContain('export async function exportEvents');
  });

  it('exports ensureAuditSchema', function () {
    expect(svcSrc).toContain('export async function ensureAuditSchema');
  });

  it('exports getActionRegistry', function () {
    expect(svcSrc).toContain('export function getActionRegistry');
  });

  it('creates admin_audit_events table in ensureAuditSchema', function () {
    expect(svcSrc).toContain('CREATE TABLE IF NOT EXISTS');
    expect(svcSrc).toContain('admin_audit_events');
  });

  it('defines all required schema columns', function () {
    var requiredCols = [
      'event_id', 'occurred_at', 'action', 'action_category', 'outcome',
      'actor_uid', 'entity_type', 'entity_id', 'before_json', 'after_json',
      'request_id', 'ip_address', 'user_agent', 'source',
    ];
    requiredCols.forEach(function (col) {
      expect(svcSrc).toContain(col);
    });
  });

  it('uses $N positional params (not ? placeholders) in SQL', function () {
    // The actual INSERT SQL should use $1, $2, etc.
    expect(svcSrc).toContain('$1,$2,$3');
  });

  it('uses schema prefix for table access', function () {
    expect(svcSrc).toContain('${schema}.admin_audit_events');
  });

  it('caps export at 10000 rows', function () {
    expect(svcSrc).toContain('10_000');
  });

  it('does not contain UPDATE or DELETE statements on audit table', function () {
    // Append-only: no UPDATE/DELETE paths
    var upperSrc = svcSrc.toUpperCase();
    var updateIdx = upperSrc.indexOf('UPDATE ' + 'PUBLIC.ADMIN_AUDIT_EVENTS');
    var deleteIdx = upperSrc.indexOf('DELETE FROM ' + 'PUBLIC.ADMIN_AUDIT_EVENTS');
    // Also check for generic UPDATE/DELETE against the audit table
    expect(upperSrc.indexOf('UPDATE ADMIN_AUDIT_EVENTS')).toBe(-1);
    expect(upperSrc.indexOf('DELETE FROM ADMIN_AUDIT_EVENTS')).toBe(-1);
    expect(updateIdx).toBe(-1);
    expect(deleteIdx).toBe(-1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. app.ts — audit routes registered and schema bootstrapped
// ─────────────────────────────────────────────────────────────────────────────

describe('app.ts audit integration', function () {
  var appSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/app.ts'),
    'utf8'
  );

  it('imports adminAuditRoutes', function () {
    expect(appSrc).toContain('adminAuditRoutes');
  });

  it('registers adminAuditRoutes with app.use', function () {
    expect(appSrc).toContain('app.use("/api"');
    expect(appSrc).toContain('adminAuditRoutes');
  });

  it('calls ensureAuditSchema on startup', function () {
    expect(appSrc).toContain('ensureAuditSchema');
  });

  it('stamps request IDs via middleware', function () {
    expect(appSrc).toContain('randomUUID');
    // app.ts assigns via (req as any).id = randomUUID()
    expect(appSrc).toContain('.id = randomUUID()');
  });
});
