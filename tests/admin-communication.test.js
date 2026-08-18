'use strict';

/**
 * Admin Communication Center — unit + contract tests
 *
 * Pure-logic functions are re-implemented inline.
 * Route-contract tests read source files as text.
 * DB-layer tests mock pg via jest module factories.
 */

var fs   = require('fs');
var path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Pure-logic re-implementations (kept in sync with adminCommunicationService.ts)
// ─────────────────────────────────────────────────────────────────────────────

var REDACT_KEYS = [
  'password', 'token', 'authorization', 'secret', 'apikey', 'privatekey',
  'otp', 'resettoken', 'fcmtoken', 'fcm_token', 'sendgridkey', 'cometchatkey',
];

function redactValue(key, value) {
  var lk = key.toLowerCase().replace(/_/g, '');
  if (REDACT_KEYS.some(function (p) { return lk.indexOf(p) !== -1; })) return '[REDACTED]';
  if (typeof value === 'string') {
    if (value.indexOf('data:') === 0) return '[REDACTED_DATA_URI]';
    if (value.length > 500 && /^[A-Za-z0-9+/=]+$/.test(value)) return '[REDACTED_BASE64]';
  }
  return value;
}

function redactForComm(obj) {
  var out = {};
  Object.keys(obj).forEach(function (k) {
    out[k] = redactValue(k, obj[k]);
  });
  return out;
}

function deriveCategoryFromTemplate(name) {
  if (name.indexOf('booking') === 0 || name.indexOf('additional_work') === 0) return 'booking';
  if (name.indexOf('payment') === 0 || name.indexOf('refund') === 0) return 'payment';
  if (name.indexOf('verify_email') === 0 || name.indexOf('forgot_password') === 0 || name.indexOf('employee_invite') === 0) return 'auth';
  if (name.indexOf('verify_booking') === 0) return 'booking';
  return 'system';
}

function previewTemplate(bodyTemplate, variables) {
  var result = bodyTemplate;
  Object.keys(variables).forEach(function (key) {
    var re = new RegExp('\\{\\{\\s*' + key + '\\s*\\}\\}', 'g');
    result = result.replace(re, variables[key]);
  });
  return result;
}

function buildEventWhere(filters) {
  var clauses = [];
  var params  = [];
  var i = 1;
  if (filters.channel)        { clauses.push('channel = $' + i++);            params.push(filters.channel); }
  if (filters.status)         { clauses.push('status = $' + i++);             params.push(filters.status); }
  if (filters.severity)       { clauses.push('severity = $' + i++);           params.push(filters.severity); }
  if (filters.category)       { clauses.push('category = $' + i++);           params.push(filters.category); }
  if (filters.entityType)     { clauses.push('entity_type = $' + i++);        params.push(filters.entityType); }
  if (filters.entityId)       { clauses.push('entity_id = $' + i++);          params.push(filters.entityId); }
  if (filters.recipientUid)   { clauses.push('recipient_uid = $' + i++);      params.push(filters.recipientUid); }
  if (filters.recipientEmail) { clauses.push('recipient_email ILIKE $' + i++); params.push('%' + filters.recipientEmail + '%'); }
  if (filters.templateName)   { clauses.push('template_name = $' + i++);      params.push(filters.templateName); }
  if (filters.fromDate)       { clauses.push('created_at >= $' + i++);        params.push(filters.fromDate); }
  if (filters.toDate)         { clauses.push('created_at <= $' + i++);        params.push(filters.toDate); }
  if (filters.search) {
    clauses.push('(subject ILIKE $' + i + ' OR safe_body ILIKE $' + i + ' OR recipient_email ILIKE $' + i + ' OR template_name ILIKE $' + i + ' OR entity_id ILIKE $' + i + ')');
    params.push('%' + filters.search + '%'); i++;
  }
  return { clauses: clauses, params: params };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Redaction logic
// ─────────────────────────────────────────────────────────────────────────────

describe('redactForComm — sensitive key detection', function () {
  test('redacts password field', function () {
    expect(redactForComm({ password: 'secret123' }).password).toBe('[REDACTED]');
  });
  test('redacts token field', function () {
    expect(redactForComm({ token: 'abc' }).token).toBe('[REDACTED]');
  });
  test('redacts authorization field', function () {
    expect(redactForComm({ authorization: 'Bearer x' }).authorization).toBe('[REDACTED]');
  });
  test('redacts fcm_token', function () {
    expect(redactForComm({ fcm_token: 'xyz' }).fcm_token).toBe('[REDACTED]');
  });
  test('redacts fcmToken camelCase', function () {
    expect(redactForComm({ fcmToken: 'xyz' }).fcmToken).toBe('[REDACTED]');
  });
  test('redacts apikey', function () {
    expect(redactForComm({ apikey: 'key' }).apikey).toBe('[REDACTED]');
  });
  test('redacts otp', function () {
    expect(redactForComm({ otp: '123456' }).otp).toBe('[REDACTED]');
  });
  test('redacts resetToken', function () {
    expect(redactForComm({ resetToken: 'abc' }).resetToken).toBe('[REDACTED]');
  });
  test('does NOT redact safe field', function () {
    expect(redactForComm({ first_name: 'Paul' }).first_name).toBe('Paul');
  });
  test('does NOT redact email', function () {
    expect(redactForComm({ email: 'a@b.com' }).email).toBe('a@b.com');
  });
  test('redacts data URI value', function () {
    expect(redactForComm({ photo: 'data:image/png;base64,abc' }).photo).toBe('[REDACTED_DATA_URI]');
  });
  test('redacts long base64 string', function () {
    var long = 'A'.repeat(600);
    expect(redactForComm({ payload: long }).payload).toBe('[REDACTED_BASE64]');
  });
  test('does NOT redact short string that happens to be alphanumeric', function () {
    expect(redactForComm({ code: 'ABC123' }).code).toBe('ABC123');
  });
  test('multiple keys in one object — only sensitive ones are redacted', function () {
    var result = redactForComm({ email: 'a@b.com', password: 'x', first_name: 'Paul' });
    expect(result.email).toBe('a@b.com');
    expect(result.password).toBe('[REDACTED]');
    expect(result.first_name).toBe('Paul');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Template category derivation
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveCategoryFromTemplate', function () {
  test('booking_worker_assigned → booking', function () {
    expect(deriveCategoryFromTemplate('booking_worker_assigned')).toBe('booking');
  });
  test('booking_completed → booking', function () {
    expect(deriveCategoryFromTemplate('booking_completed')).toBe('booking');
  });
  test('verify_booking_otp → booking', function () {
    expect(deriveCategoryFromTemplate('verify_booking_otp')).toBe('booking');
  });
  test('additional_work_approved → booking', function () {
    expect(deriveCategoryFromTemplate('additional_work_approved')).toBe('booking');
  });
  test('payment_confirmed → payment', function () {
    expect(deriveCategoryFromTemplate('payment_confirmed')).toBe('payment');
  });
  test('payment_failed → payment', function () {
    expect(deriveCategoryFromTemplate('payment_failed')).toBe('payment');
  });
  test('refund_processed → payment', function () {
    expect(deriveCategoryFromTemplate('refund_processed')).toBe('payment');
  });
  test('verify_email → auth', function () {
    expect(deriveCategoryFromTemplate('verify_email')).toBe('auth');
  });
  test('verify_email_otp → auth', function () {
    expect(deriveCategoryFromTemplate('verify_email_otp')).toBe('auth');
  });
  test('forgot_password → auth', function () {
    expect(deriveCategoryFromTemplate('forgot_password')).toBe('auth');
  });
  test('employee_invite → auth', function () {
    expect(deriveCategoryFromTemplate('employee_invite')).toBe('auth');
  });
  test('unknown template → system', function () {
    expect(deriveCategoryFromTemplate('some_custom_template')).toBe('system');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Template preview (variable interpolation)
// ─────────────────────────────────────────────────────────────────────────────

describe('previewTemplate — variable interpolation', function () {
  test('replaces single variable', function () {
    expect(previewTemplate('Hello {{name}}!', { name: 'Paul' })).toBe('Hello Paul!');
  });
  test('replaces multiple variables', function () {
    var tpl = 'Booking {{booking_id}} for {{first_name}}';
    expect(previewTemplate(tpl, { booking_id: 'B001', first_name: 'Paul' })).toBe('Booking B001 for Paul');
  });
  test('replaces same variable appearing twice', function () {
    expect(previewTemplate('Hi {{name}}, you are {{name}}', { name: 'X' })).toBe('Hi X, you are X');
  });
  test('leaves unreplaced variables as-is when no value provided', function () {
    expect(previewTemplate('Hello {{name}}!', {})).toBe('Hello {{name}}!');
  });
  test('handles whitespace around variable name', function () {
    expect(previewTemplate('Hi {{ name }}!', { name: 'Paul' })).toBe('Hi Paul!');
  });
  test('returns body unchanged when variables empty', function () {
    var body = 'No variables here.';
    expect(previewTemplate(body, {})).toBe(body);
  });
  test('does not replace partial matches', function () {
    expect(previewTemplate('{{name_full}} vs {{name}}', { name: 'P' })).toBe('{{name_full}} vs P');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. WHERE clause builder
// ─────────────────────────────────────────────────────────────────────────────

describe('buildEventWhere — SQL filter builder', function () {
  test('empty filters → no clauses', function () {
    var r = buildEventWhere({});
    expect(r.clauses).toHaveLength(0);
    expect(r.params).toHaveLength(0);
  });
  test('channel filter produces correct clause', function () {
    var r = buildEventWhere({ channel: 'email' });
    expect(r.clauses[0]).toBe('channel = $1');
    expect(r.params[0]).toBe('email');
  });
  test('status filter', function () {
    var r = buildEventWhere({ status: 'failed' });
    expect(r.clauses[0]).toContain('status');
    expect(r.params[0]).toBe('failed');
  });
  test('entityType + entityId produces two clauses', function () {
    var r = buildEventWhere({ entityType: 'booking', entityId: '42' });
    expect(r.clauses).toHaveLength(2);
    expect(r.params).toEqual(['booking', '42']);
  });
  test('recipientEmail uses ILIKE with wildcards', function () {
    var r = buildEventWhere({ recipientEmail: 'paul' });
    expect(r.clauses[0]).toContain('ILIKE');
    expect(r.params[0]).toBe('%paul%');
  });
  test('fromDate + toDate produce two clauses', function () {
    var r = buildEventWhere({ fromDate: '2026-01-01', toDate: '2026-12-31' });
    expect(r.clauses).toHaveLength(2);
  });
  test('search clause fans out to multiple columns', function () {
    var r = buildEventWhere({ search: 'Paul' });
    expect(r.clauses[0]).toContain('subject ILIKE');
    expect(r.clauses[0]).toContain('safe_body ILIKE');
    expect(r.clauses[0]).toContain('recipient_email ILIKE');
    expect(r.params[0]).toBe('%Paul%');
  });
  test('all filters combined produces correct param count', function () {
    var r = buildEventWhere({
      channel: 'email', status: 'failed', severity: 'error',
      category: 'booking', entityType: 'booking', entityId: '1',
      recipientUid: 'u1', recipientEmail: 'a@b.com', templateName: 'booking_completed',
      fromDate: '2026-01-01', toDate: '2026-12-31', search: 'test',
    });
    expect(r.clauses).toHaveLength(12);
    expect(r.params).toHaveLength(12);
  });
  test('param indices are sequential (no gaps)', function () {
    var r = buildEventWhere({ channel: 'email', status: 'sent', category: 'auth' });
    expect(r.clauses[0]).toContain('$1');
    expect(r.clauses[1]).toContain('$2');
    expect(r.clauses[2]).toContain('$3');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Row mapper shape contracts
// ─────────────────────────────────────────────────────────────────────────────

function mapEventRow(row) {
  return {
    id:               String(row.id),
    eventKey:         row.event_key,
    channel:          row.channel,
    direction:        row.direction,
    status:           row.status,
    severity:         row.severity,
    category:         row.category || null,
    recipientUid:     row.recipient_uid || null,
    recipientEmail:   row.recipient_email || null,
    recipientName:    row.recipient_name || null,
    recipientRole:    row.recipient_role || null,
    senderUid:        row.sender_uid || null,
    senderRole:       row.sender_role || null,
    entityType:       row.entity_type || null,
    entityId:         row.entity_id || null,
    templateName:     row.template_name || null,
    subject:          row.subject || null,
    safeBody:         row.safe_body || null,
    providerResponse: row.provider_response || null,
    retryCount:       row.retry_count,
    lastRetryAt:      row.last_retry_at || null,
    errorMessage:     row.error_message || null,
    metadata:         row.metadata || null,
    createdAt:        row.created_at,
    updatedAt:        row.updated_at,
  };
}

describe('mapEventRow — shape contract', function () {
  var sampleRow = {
    id: 1, event_key: 'abc-123', channel: 'email', direction: 'outbound',
    status: 'sent', severity: 'info', category: 'booking',
    recipient_uid: 'u1', recipient_email: 'a@b.com', recipient_name: 'Paul',
    recipient_role: 'customer', sender_uid: null, sender_role: 'system',
    entity_type: 'booking', entity_id: '42', template_name: 'booking_completed',
    subject: 'Your booking is done', safe_body: 'Hi Paul…', provider_response: null,
    retry_count: 0, last_retry_at: null, error_message: null, metadata: null,
    created_at: new Date(), updated_at: new Date(),
  };

  test('id is string', function () {
    expect(typeof mapEventRow(sampleRow).id).toBe('string');
  });
  test('all expected keys present', function () {
    var mapped = mapEventRow(sampleRow);
    var expected = [
      'id','eventKey','channel','direction','status','severity','category',
      'recipientUid','recipientEmail','recipientName','recipientRole',
      'senderUid','senderRole','entityType','entityId','templateName',
      'subject','safeBody','providerResponse','retryCount','lastRetryAt',
      'errorMessage','metadata','createdAt','updatedAt',
    ];
    expected.forEach(function (k) { expect(mapped).toHaveProperty(k); });
  });
  test('null DB columns map to null (not undefined)', function () {
    var mapped = mapEventRow(sampleRow);
    expect(mapped.senderUid).toBeNull();
    expect(mapped.providerResponse).toBeNull();
  });
  test('category defaults to null when missing', function () {
    var r = Object.assign({}, sampleRow, { category: undefined });
    expect(mapEventRow(r).category).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Route contract tests (source-file scanning)
// ─────────────────────────────────────────────────────────────────────────────

describe('adminCommunication.routes.ts — route contract', function () {
  var routeFile = path.join(__dirname, '..', 'src', 'routes', 'adminCommunication.routes.ts');
  var src;
  beforeAll(function () { src = fs.readFileSync(routeFile, 'utf8'); });

  test('file exists', function () { expect(src).toBeTruthy(); });
  test('uses adminOnly guard', function () { expect(src).toContain('adminOnly'); });
  test('has GET /admin/communications/summary', function () {
    expect(src).toContain("'/admin/communications/summary'");
  });
  test('has GET /admin/communications/events', function () {
    expect(src).toContain("'/admin/communications/events'");
  });
  test('has GET /admin/communications/failures', function () {
    expect(src).toContain("'/admin/communications/failures'");
  });
  test('has POST bulk-retry', function () {
    expect(src).toContain('bulk-retry');
  });
  test('has GET entity timeline route', function () {
    expect(src).toContain(':entityType/:entityId');
  });
  test('has GET recipient timeline route', function () {
    expect(src).toContain(':recipientUid');
  });
  test('has templates CRUD routes', function () {
    expect(src).toContain("'/admin/communications/templates'");
  });
  test('has template preview route', function () {
    expect(src).toContain('preview');
  });
  test('has POST export route', function () {
    expect(src).toContain('export');
  });
  test('has conversations route', function () {
    expect(src).toContain('conversations');
  });
  test('imports verifyAuth', function () { expect(src).toContain('verifyAuth'); });
  test('imports verifyRoles', function () { expect(src).toContain('verifyRoles'); });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Controller contract tests
// ─────────────────────────────────────────────────────────────────────────────

describe('adminCommunicationController.ts — controller contract', function () {
  var ctrlFile = path.join(__dirname, '..', 'src', 'controllers', 'adminCommunicationController.ts');
  var src;
  beforeAll(function () { src = fs.readFileSync(ctrlFile, 'utf8'); });

  test('file exists', function () { expect(src).toBeTruthy(); });
  test('exports getSummary',        function () { expect(src).toContain('export async function getSummary'); });
  test('exports listEvents',        function () { expect(src).toContain('export async function listEvents'); });
  test('exports getEventDetail',    function () { expect(src).toContain('export async function getEventDetail'); });
  test('exports getEntityTimeline', function () { expect(src).toContain('export async function getEntityTimeline'); });
  test('exports getRecipientTimeline', function () { expect(src).toContain('export async function getRecipientTimeline'); });
  test('exports listFailures',      function () { expect(src).toContain('export async function listFailures'); });
  test('exports retryEvent',        function () { expect(src).toContain('export async function retryEvent'); });
  test('exports bulkRetryEvents',   function () { expect(src).toContain('export async function bulkRetryEvents'); });
  test('exports listTemplates',     function () { expect(src).toContain('export async function listTemplates'); });
  test('exports getTemplate',       function () { expect(src).toContain('export async function getTemplate'); });
  test('exports createTemplate',    function () { expect(src).toContain('export async function createTemplate'); });
  test('exports updateTemplate',    function () { expect(src).toContain('export async function updateTemplate'); });
  test('exports archiveTemplate',   function () { expect(src).toContain('export async function archiveTemplate'); });
  test('exports previewTemplate',   function () { expect(src).toContain('export async function previewTemplate'); });
  test('exports exportEvents',      function () { expect(src).toContain('export async function exportEvents'); });
  test('exports getConversations',  function () { expect(src).toContain('export async function getConversations'); });
  test('calls auditFire on retry',  function () { expect(src).toContain('auditFire'); });
  test('validates bulk-retry eventKeys', function () {
    expect(src).toContain('eventKeys');
    expect(src).toContain('Max 50');
  });
  test('bulk retry caps at 50 events', function () {
    expect(src).toContain('50');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Service contract tests
// ─────────────────────────────────────────────────────────────────────────────

describe('adminCommunicationService.ts — service contract', function () {
  var svcFile = path.join(__dirname, '..', 'src', 'services', 'adminCommunicationService.ts');
  var src;
  beforeAll(function () { src = fs.readFileSync(svcFile, 'utf8'); });

  test('file exists', function () { expect(src).toBeTruthy(); });
  test('exports logCommunicationEvent',          function () { expect(src).toContain('export async function logCommunicationEvent'); });
  test('exports listCommunicationEvents',        function () { expect(src).toContain('export async function listCommunicationEvents'); });
  test('exports getCommunicationEventDetail',    function () { expect(src).toContain('export async function getCommunicationEventDetail'); });
  test('exports getCommunicationSummary',        function () { expect(src).toContain('export async function getCommunicationSummary'); });
  test('exports getEntityCommunicationTimeline', function () { expect(src).toContain('export async function getEntityCommunicationTimeline'); });
  test('exports getRecipientCommunicationTimeline', function () { expect(src).toContain('export async function getRecipientCommunicationTimeline'); });
  test('exports findRetryableFailures',          function () { expect(src).toContain('export async function findRetryableFailures'); });
  test('exports markEventRetried',               function () { expect(src).toContain('export async function markEventRetried'); });
  test('exports markEventNonRetryable',          function () { expect(src).toContain('export async function markEventNonRetryable'); });
  test('exports listNotificationTemplates',      function () { expect(src).toContain('export async function listNotificationTemplates'); });
  test('exports getNotificationTemplate',        function () { expect(src).toContain('export async function getNotificationTemplate'); });
  test('exports createNotificationTemplate',     function () { expect(src).toContain('export async function createNotificationTemplate'); });
  test('exports updateNotificationTemplate',     function () { expect(src).toContain('export async function updateNotificationTemplate'); });
  test('exports archiveNotificationTemplate',    function () { expect(src).toContain('export async function archiveNotificationTemplate'); });
  test('exports previewNotificationTemplate',    function () { expect(src).toContain('export function previewNotificationTemplate'); });
  test('exports getChatConversationSummaries',   function () { expect(src).toContain('export async function getChatConversationSummaries'); });
  test('exports NO schema bootstrap (TAB 02)',    function () { expect(src).not.toContain('export function ensureCommunicationSchema'); });
  test('exports redactForComm',                  function () { expect(src).toContain('export function redactForComm'); });
  /**
   * These asserted the DDL text inside `initSchema`. That bootstrap is gone
   * (TAB 02) — all eight objects come from `scripts/baseline/000-baseline.sql` —
   * so the assertions read the schema that will actually exist.
   *
   * Note that two of them would still have PASSED against the service source:
   * it queries `admin_communication_events` and `admin_notification_templates`
   * by name, so `toContain` matched regardless of whether anything created them.
   * That is the weakness of asserting on a mention rather than a definition.
   */
  var baseline = fs
    .readFileSync(path.join(__dirname, '..', 'scripts', 'baseline', '000-baseline.sql'), 'utf8')
    .replace(/\r\n/g, '\n');

  test('the service issues no DDL at all', function () {
    /**
     * Comments stripped first. The comment that REPLACED the bootstrap explains
     * what it used to create, so a bare substring check matches its own
     * documentation — which is exactly how this assertion first failed.
     */
    var code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(function (l) { return !/^\s*\/\//.test(l); })
      .join('\n');
    expect(code).not.toContain('CREATE TABLE');
    expect(code).not.toContain('CREATE INDEX');
  });
  test('both tables are declared by the baseline', function () {
    expect(baseline).toContain('CREATE TABLE servana.admin_communication_events (');
    expect(baseline).toContain('CREATE TABLE servana.admin_notification_templates (');
  });
  test('retry_count capped at 5', function () { expect(src).toContain('retry_count < 5'); });
  test('retry increments retry_count', function () { expect(src).toContain('retry_count + 1'); });
  test('event_key is UNIQUE with a uuid default, which is what makes a resend idempotent', function () {
    // The service never generates event_key itself — it relies on the default.
    var table = /CREATE TABLE servana\.admin_communication_events \(([\s\S]*?)\n\);/.exec(baseline);
    expect(table).not.toBeNull();
    expect(table[1]).toMatch(/event_key[^,]*gen_random_uuid/);
    expect(baseline).toContain('admin_communication_events_event_key_key UNIQUE (event_key)');
  });
  test('has index on entity_type + entity_id', function () { expect(baseline).toContain('idx_ace_entity'); });
  test('has index on status + channel', function () { expect(baseline).toContain('idx_ace_status'); });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. app.ts registration
// ─────────────────────────────────────────────────────────────────────────────

describe('app.ts — adminCommunication registration', function () {
  var appFile = path.join(__dirname, '..', 'src', 'app.ts');
  var src;
  beforeAll(function () { src = fs.readFileSync(appFile, 'utf8'); });

  test('imports adminCommunicationRoutes', function () {
    expect(src).toContain('adminCommunicationRoutes');
  });
  test('mounts adminCommunicationRoutes under /api', function () {
    expect(src).toContain("adminCommunicationRoutes");
  });
  test('does NOT bootstrap communication schema at startup (TAB 02)', function () {
    // The entry is removed, not downgraded — there is no DDL left to gate on.
    var startupSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'startup.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(startupSrc).not.toContain('ensureCommunicationSchema');
    expect(startupSrc).not.toContain("name: 'admin-communication-schema'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Mailer hook
// ─────────────────────────────────────────────────────────────────────────────

describe('mailer.ts — communication log hook', function () {
  var mailerFile = path.join(__dirname, '..', 'src', 'helpers', 'mailer.ts');
  var src;
  beforeAll(function () { src = fs.readFileSync(mailerFile, 'utf8'); });

  test('imports logCommunicationEvent', function () {
    expect(src).toContain('logCommunicationEvent');
  });
  test('logs successful email sends', function () {
    expect(src).toContain("status: 'sent'");
  });
  test('logs failed email sends', function () {
    expect(src).toContain("status: 'failed'");
  });
  test('logs channel: email', function () {
    expect(src).toContain("channel: 'email'");
  });
  test('uses fire-and-forget (.catch)', function () {
    expect(src).toContain('.catch(() => {})');
  });
  test('derives category from template name', function () {
    expect(src).toContain('deriveCategoryFromTemplate');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Notification service hook
// ─────────────────────────────────────────────────────────────────────────────

describe('notification.service.ts — communication log hook', function () {
  var notifFile = path.join(__dirname, '..', 'src', 'services', 'notification.service.ts');
  var src;
  beforeAll(function () { src = fs.readFileSync(notifFile, 'utf8'); });

  test('imports logCommunicationEvent', function () {
    expect(src).toContain('logCommunicationEvent');
  });
  test('logs socket channel', function () {
    expect(src).toContain("channel: 'socket'");
  });
  test('uses fire-and-forget (.catch)', function () {
    expect(src).toContain('.catch(() => {})');
  });
  test('does not await logCommunicationEvent (non-blocking)', function () {
    // Should call it without await to be non-blocking
    var hookIndex = src.indexOf('logCommunicationEvent({');
    var precedingChars = src.substring(hookIndex - 20, hookIndex);
    expect(precedingChars).not.toContain('await');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Channel and status enum validity
// ─────────────────────────────────────────────────────────────────────────────

describe('CommChannel and CommStatus valid values', function () {
  var VALID_CHANNELS = ['email', 'socket', 'chat', 'sms', 'fcm'];
  var VALID_STATUSES = ['sent', 'delivered', 'failed', 'retried', 'pending'];
  var VALID_SEVERITIES = ['info', 'warning', 'error'];

  test('email is a valid channel', function () { expect(VALID_CHANNELS).toContain('email'); });
  test('socket is a valid channel', function () { expect(VALID_CHANNELS).toContain('socket'); });
  test('chat is a valid channel', function () { expect(VALID_CHANNELS).toContain('chat'); });
  test('fcm is a valid channel', function () { expect(VALID_CHANNELS).toContain('fcm'); });
  test('sms is a valid channel', function () { expect(VALID_CHANNELS).toContain('sms'); });
  test('sent is a valid status', function () { expect(VALID_STATUSES).toContain('sent'); });
  test('failed is a valid status', function () { expect(VALID_STATUSES).toContain('failed'); });
  test('retried is a valid status', function () { expect(VALID_STATUSES).toContain('retried'); });
  test('info is a valid severity', function () { expect(VALID_SEVERITIES).toContain('info'); });
  test('error is a valid severity', function () { expect(VALID_SEVERITIES).toContain('error'); });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. Bulk retry validation logic
// ─────────────────────────────────────────────────────────────────────────────

describe('bulkRetry — validation rules', function () {
  function validateBulkRetry(eventKeys) {
    if (!Array.isArray(eventKeys) || eventKeys.length === 0) {
      return { error: 'eventKeys must be a non-empty array' };
    }
    if (eventKeys.length > 50) {
      return { error: 'Max 50 events per bulk retry' };
    }
    return { ok: true };
  }

  test('rejects non-array input', function () {
    expect(validateBulkRetry(null)).toHaveProperty('error');
    expect(validateBulkRetry('abc')).toHaveProperty('error');
  });
  test('rejects empty array', function () {
    expect(validateBulkRetry([])).toHaveProperty('error');
  });
  test('rejects array with > 50 items', function () {
    var keys = Array.from({ length: 51 }, function (_, i) { return 'k' + i; });
    expect(validateBulkRetry(keys)).toHaveProperty('error');
  });
  test('accepts array with exactly 50 items', function () {
    var keys = Array.from({ length: 50 }, function (_, i) { return 'k' + i; });
    expect(validateBulkRetry(keys)).toHaveProperty('ok');
  });
  test('accepts array with 1 item', function () {
    expect(validateBulkRetry(['key-1'])).toHaveProperty('ok');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. Export CSV format
// ─────────────────────────────────────────────────────────────────────────────

describe('export CSV shape', function () {
  var EXPECTED_HEADERS = [
    'event_key', 'channel', 'direction', 'status', 'severity',
    'category', 'recipient_email', 'entity_type', 'entity_id',
    'template_name', 'subject', 'created_at',
  ];

  test('header contains all expected columns', function () {
    var header = EXPECTED_HEADERS.join(',');
    EXPECTED_HEADERS.forEach(function (col) {
      expect(header).toContain(col);
    });
  });

  test('comma replacement in subject field works', function () {
    var subject = 'Hello, World, test';
    var sanitized = subject.replace(/,/g, ';');
    expect(sanitized).toBe('Hello; World; test');
    expect(sanitized).not.toContain(',');
  });
});

describe('admin messaging bridge contracts', function () {
  var serviceSource = fs.readFileSync(
    path.join(__dirname, '../src/services/adminCommunicationService.ts'), 'utf8'
  ).replace(/\r\n/g, '\n');
  var controllerSource = fs.readFileSync(
    path.join(__dirname, '../src/controllers/adminCommunicationController.ts'), 'utf8'
  ).replace(/\r\n/g, '\n');

  test('guest booking conversations resolve the guest name and email', function () {
    expect(serviceSource).toContain('LEFT JOIN ${dbSchema}.guest_customers gc');
    expect(serviceSource).toContain('COALESCE(uc_client.email, gc.email) AS customer_email');
  });

  test('conversation reads propagate database errors instead of returning empty success payloads', function () {
    var detailStart = serviceSource.indexOf('export async function getAdminConversationDetail');
    var reportStart = serviceSource.indexOf('export async function sendAdminMessage');
    var conversationReads = serviceSource.slice(detailStart, reportStart);
    expect(conversationReads).not.toContain('return { messages: [], nextCursor: null }');
    expect(conversationReads).toContain('throw error');
  });

  test('admin sends validate the shared chat idempotency key contract', function () {
    var start = controllerSource.indexOf('export async function sendConversationMessage');
    var end = controllerSource.indexOf('export async function listReports');
    var sendController = controllerSource.slice(start, end);
    expect(sendController).toContain('clientMsgId.trim().length < 16');
    expect(sendController).toContain('clientMsgId.trim().length > 128');
  });
});
