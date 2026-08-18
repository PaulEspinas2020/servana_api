/**
 * THE observability declaration (§140–§142, §151) — one file, no database.
 *
 *   1. `observability/requestLog.ts` EMITS against it.
 *   2. `observability/metrics.ts` COUNTS against it.
 *   3. `scripts/generate-release-safety-docs.ts` EXECUTES it to write
 *      `OBSERVABILITY_STANDARD.md`.
 *   4. `tests/observability-*.test.ts` ASSERT against it.
 *
 * ## Why a declaration rather than console.log at each site
 *
 * The repository already logs. It logs in about forty places, in about six
 * shapes, and the two that matter most — `[legacy-contract]` and the v1 request
 * id — agree on nothing. A log line is only useful if a person under pressure at
 * 2am can grep one field across every subsystem, and that is a property of the
 * SCHEMA, not of any individual call site.
 *
 * ## The redaction rule is deny-by-default
 *
 * §141 says redact tokens, OTPs, passwords and sensitive PII. An allow-list of
 * "safe" fields is the only version of that which survives contact with a new
 * feature: a deny-list means the next developer who adds `taxIdNumber` to a
 * payload has to remember it is sensitive, and the failure is silent and
 * permanent — the data is already in the log aggregator by the time anybody
 * notices.
 *
 * So `redact()` keeps what is named and drops everything else, and
 * `tests/observability-redaction.test.ts` throws real payloads at it.
 *
 * ## Cardinality
 *
 * Every metric label is a ROUTE TEMPLATE (`/api/v1/bookings/:bookingId`), never
 * a concrete path. A metric keyed on the actual booking id is a metric with one
 * series per booking, which is how a monitoring bill and an outage arrive
 * together.
 */

// ─── Correlation (§140) ───────────────────────────────────────────────────────

/**
 * One id, propagated end to end.
 *
 * `X-Request-Id` is already generated per request in `app.ts` and already
 * returned by the v1 envelope. What was missing is the INBOUND half: a client
 * or an upstream proxy that already has a correlation id should be able to hand
 * it in, so one trace spans the client's log and ours. Without that, a customer
 * reporting "it failed at 3:14" gives support a timestamp and nothing else.
 */
export const CORRELATION = {
  /** Returned on every v1 response, and accepted on the way in. */
  header: 'X-Request-Id',
  /** Where a caller's own trace id is read from, if they send one. */
  inboundHeaders: Object.freeze(['x-request-id', 'x-correlation-id']),
  /** Client identity, shared with the legacy telemetry vocabulary. */
  clientHeader: 'X-Servana-Client',
  clientVersionHeader: 'X-Servana-Client-Version',
  /** Carried onto async work so an event can be traced back to its request. */
  propagatedTo: Object.freeze([
    'the structured request log',
    'the v1 error envelope (`error.requestId`)',
    'domain event outbox rows, via `correlationId`',
    'the legacy-route telemetry line',
  ]),
  note:
    'An inbound id is ACCEPTED but never TRUSTED for anything but correlation: it is bounded, ' +
    'character-checked and never used as a key, because a caller controls it.',
} as const;

/** Accept a caller's correlation id only if it cannot poison a log line. */
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export const sanitizeCorrelationId = (value: unknown): string | null => {
  const candidate = String(value ?? '').trim();
  return CORRELATION_ID_PATTERN.test(candidate) ? candidate : null;
};

// ─── The log schema (§141) ────────────────────────────────────────────────────

export interface LogFieldSpec {
  field: string;
  description: string;
  /** `always` fields are what makes a line greppable; they are never dropped. */
  presence: 'always' | 'when known';
}

export const LOG_FIELDS: readonly LogFieldSpec[] = Object.freeze([
  { field: 'ts', description: 'ISO-8601 UTC with milliseconds.', presence: 'always' },
  { field: 'level', description: 'info | warn | error.', presence: 'always' },
  { field: 'msg', description: 'A stable event name, not a sentence.', presence: 'always' },
  { field: 'requestId', description: 'The correlation id (§140).', presence: 'always' },
  { field: 'method', description: 'HTTP method.', presence: 'always' },
  { field: 'route', description: 'The route TEMPLATE, never the concrete path.', presence: 'always' },
  { field: 'status', description: 'HTTP status actually sent.', presence: 'always' },
  { field: 'durationMs', description: 'Wall time from receipt to response finish.', presence: 'always' },
  { field: 'client', description: 'Coarse client label, e.g. customer-mobile@1.4.2.', presence: 'always' },
  { field: 'namespace', description: 'v1 | legacy — which contract served it.', presence: 'always' },
  { field: 'actorRole', description: 'admin | provider | customer | anonymous. A ROLE, never a uid.', presence: 'when known' },
  { field: 'domainAction', description: 'The contract id, e.g. bookings.cancel.', presence: 'when known' },
  { field: 'errorCode', description: 'The v1 error code, for failures.', presence: 'when known' },
  { field: 'entity', description: 'Safe entity ids (§141) — see SAFE_ENTITY_KEYS.', presence: 'when known' },
]);

export const LOG_FIELD_NAMES: readonly string[] = Object.freeze(LOG_FIELDS.map((f) => f.field));

/**
 * Roles, as a closed vocabulary.
 *
 * A ROLE is loggable and a uid is not. "A provider failed to accept a job" is an
 * operational fact; "provider FbX9…  failed to accept job 84213" is a record of
 * a named person's working day, and a log that accumulates those has to be
 * protected like the database it describes.
 */
export type ActorRole = 'admin' | 'provider' | 'customer' | 'anonymous';

export const ACTOR_ROLES: readonly ActorRole[] = Object.freeze([
  'admin', 'provider', 'customer', 'anonymous',
]);

/**
 * The only entity identifiers that may appear in a log line.
 *
 * All of them are opaque platform integers that mean nothing outside this
 * system and cannot be reversed into a person. A uid, an email, a phone number
 * or an address is not on this list and cannot be added by accident, because
 * `redact()` drops what it does not recognise.
 */
export const SAFE_ENTITY_KEYS: readonly string[] = Object.freeze([
  'bookingId',
  'conversationId',
  'serviceId',
  'categoryId',
  'subcategoryId',
  'reviewId',
  'caseId',
  'notificationKey',
  'eventId',
  'payoutId',
  'paymentId',
]);

/**
 * Keys whose VALUE must never be logged even if somebody adds them to the
 * allow-list by mistake.
 *
 * Belt and braces over the allow-list: two mechanisms disagreeing is how a leak
 * survives review, so this one wins. Matched case-insensitively on substrings
 * because the same secret arrives as `token`, `accessToken`, `access_token` and
 * `Authorization` depending on which layer produced it.
 */
export const FORBIDDEN_KEY_FRAGMENTS: readonly string[] = Object.freeze([
  'password', 'passwd', 'secret', 'token', 'authorization', 'auth',
  'otp', 'code', 'pin', 'credential', 'apikey', 'api_key',
  'email', 'phone', 'mobile', 'address', 'lat', 'lng', 'longitude', 'latitude',
  'firstname', 'lastname', 'fullname', 'birth', 'ssn', 'tax',
  'card', 'cvv', 'iban', 'account_number', 'accountnumber',
  'fcm', 'devicetoken', 'device_token', 'cookie', 'session',
]);

export const REDACTION_PLACEHOLDER = '[redacted]';

const isForbidden = (key: string): boolean => {
  const lower = key.toLowerCase();
  return FORBIDDEN_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment));
};

/**
 * Keep what is explicitly safe, drop everything else.
 *
 * Deny-by-default. A new field is invisible until somebody adds it to
 * `SAFE_ENTITY_KEYS`, which is a code change that arrives at review — the
 * opposite of a deny-list, where a new sensitive field is logged until somebody
 * notices, and by then it is already in the aggregator.
 */
export const redact = (input: unknown): Record<string, unknown> => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isForbidden(key)) {
      out[key] = REDACTION_PLACEHOLDER;
      continue;
    }
    if (!SAFE_ENTITY_KEYS.includes(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'string' && value.length <= 128) out[key] = value;
  }
  return out;
};

/**
 * Collapse a concrete path to its route template.
 *
 * `/api/v1/bookings/84213/timeline` → `/api/v1/bookings/:id/timeline`.
 *
 * Cardinality is the reason, and so is privacy: a metric label or a log field
 * carrying real ids is a metric with one series per booking and a log that
 * records which bookings exist.
 */
export const routeTemplate = (path: string): string => {
  const segments = path.split('?')[0].split('/').filter(Boolean);
  const templated = segments.map((segment) => {
    if (/^\d+$/.test(segment)) return ':id';
    // Firebase uids, UUIDs and opaque keys: long, mixed, not a word.
    if (/^[A-Za-z0-9_-]{20,}$/.test(segment) && /\d/.test(segment)) return ':id';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ':id';
    return segment;
  });
  return `/${templated.join('/')}`;
};

// ─── Metrics (§142) ───────────────────────────────────────────────────────────

export type MetricKind = 'counter' | 'histogram';

export interface MetricSpec {
  name: string;
  kind: MetricKind;
  description: string;
  /** Label names. Every one must be bounded — see the cardinality note above. */
  labels: readonly string[];
  /** Why this signal is worth paging somebody about, or not. */
  why: string;
}

/**
 * The signals §142 names, each with the reason it exists.
 *
 * A metric nobody can act on is a dashboard tile that makes an incident longer,
 * so each one names the decision it informs.
 */
export const METRICS: readonly MetricSpec[] = Object.freeze([
  {
    name: 'http_requests_total',
    kind: 'counter',
    description: 'Every request, by route template, method, status class, namespace and client.',
    labels: Object.freeze(['route', 'method', 'statusClass', 'namespace', 'client']),
    why: 'Request rate and error rate come from one series, so they cannot disagree about the denominator.',
  },
  {
    name: 'http_request_duration_ms',
    kind: 'histogram',
    description: 'Latency, for p50/p95/p99 by route.',
    labels: Object.freeze(['route', 'method', 'namespace']),
    why: 'A mean hides the tail, and the tail is what a customer on a Philippine mobile network experiences.',
  },
  {
    name: 'auth_failures_total',
    kind: 'counter',
    description: 'Rejected authentication and authorization, by reason.',
    labels: Object.freeze(['reason', 'route', 'client']),
    why: 'Separates "a client shipped a bad token refresh" from "somebody is trying uids", which look identical in an error-rate chart.',
  },
  {
    name: 'public_path_auth_failures_total',
    kind: 'counter',
    description:
      'A request to a path the v1 contract declares auth: \'public\' that was answered '
      + '401 or 403. Labelled by route template only — the caller is anonymous by definition.',
    labels: Object.freeze(['route', 'namespace']),
    why:
      'This is not a rate, it is an INVARIANT: a public entry refusing an anonymous caller '
      + 'means the request never reached the router that would have allowed it. On 2026-08-18 '
      + 'production answered 401 to every path including ones that do not exist, because auth '
      + 'ran before routing — and no existing signal named it. api-error-rate is 5xx only, so a '
      + '401 storm is invisible to it; auth-failure-spike is relative to a 24h median, so once '
      + 'the broken state persists past a day it BECOMES the median and the alert goes quiet '
      + 'while production stays broken.',
  },
  {
    name: 'contract_mismatch_total',
    kind: 'counter',
    description: 'Requests for a namespaced path this build does not serve.',
    labels: ['namespace', 'client', 'method'],
    why:
      'An ordinary 404 is a client asking for something that never existed. This is a client ' +
      'asking for something that was PROMISED — it holds a contract naming the route and the ' +
      'running build does not serve it. A spike on the v1 namespace is the signature of a ' +
      'portal deployed against a backend that has not shipped, which has happened here and ' +
      'presented as "the API is down" rather than as a version mismatch. The operator response ' +
      'is a deploy or a rollback, never a code change, which is why it must not be buried in ' +
      'the general 404 rate.',
  },
  {
    name: 'legacy_route_hits_total',
    kind: 'counter',
    description: 'Calls to a legacy route that has a canonical successor.',
    labels: Object.freeze(['route', 'client', 'canonical']),
    why: 'The retirement gate. An alias may only be deleted after this reads zero for the whole window.',
  },
  {
    name: 'booking_transition_failures_total',
    kind: 'counter',
    description: 'Refused booking state transitions, by actor verb and refusal.',
    labels: Object.freeze(['action', 'refusal', 'fromState']),
    why: 'A provider unable to complete a job is a customer waiting in their home. This is the P0 signal of the booking domain.',
  },
  {
    name: 'matching_zero_candidates_total',
    kind: 'counter',
    description: 'Assignment attempts that found no eligible provider.',
    labels: Object.freeze(['reason']),
    why: 'A booking nobody can be assigned to is a paid job that silently never happens; it produces no error and no alert otherwise.',
  },
  {
    name: 'message_failures_total',
    kind: 'counter',
    description: 'Message sends and realtime deliveries that failed.',
    labels: Object.freeze(['stage']),
    why: 'A customer and a provider unable to reach each other mid-job is the failure that generates the support call.',
  },
  {
    name: 'notification_delivery_total',
    kind: 'counter',
    description: 'Notification projections attempted, by channel and outcome.',
    labels: Object.freeze(['channel', 'outcome']),
    why: 'Distinguishes suppressed-by-preference from failed-to-send, which an aggregate count conflates into "notifications are down".',
  },
]);

export const METRIC_NAMES: readonly string[] = Object.freeze(METRICS.map((m) => m.name));

/** Latency buckets, in milliseconds. */
export const LATENCY_BUCKETS_MS: readonly number[] = Object.freeze([
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
]);

export const statusClass = (status: number): string => `${Math.floor(status / 100)}xx`;

// ─── Alerts (§151) ────────────────────────────────────────────────────────────

export interface AlertSpec {
  name: string;
  metric: string;
  severity: 'P0' | 'P1' | 'P2';
  condition: string;
  /** What the person woken up should actually do. */
  firstAction: string;
}

export const ALERTS: readonly AlertSpec[] = Object.freeze([
  {
    name: 'api-error-rate',
    metric: 'http_requests_total',
    severity: 'P0',
    condition: '5xx share of all requests > 2% over 5 minutes',
    firstAction: 'Group by route and namespace. One route means a deploy; every route means the database or the process.',
  },
  {
    name: 'public-path-auth-failure',
    metric: 'public_path_auth_failures_total',
    severity: 'P0',
    condition:
      'rate > 10x the 24h median. Absolute, deliberately — not a rate, not a share, and not relative to '
      + 'a baseline, because the correct value is zero and a threshold relative to history '
      + 'stops firing once the broken state becomes the history.',
    firstAction:
      'Do NOT start with credentials. A contract-public entry refusing an anonymous caller '
      + 'means the request did not reach the v1 router. Probe three paths and compare: a public '
      + 'one, a guarded one, and one that cannot exist. If all three answer alike, authentication '
      + 'is running before routing — check the middleware mounted above app.use("/api/v1") and '
      + 'whether the process restarted on the commit it claims.',
  },
  {
    name: 'v1-contract-mismatch',
    metric: 'contract_mismatch_total',
    severity: 'P1',
    condition: 'any sustained rate on the v1 namespace — more than 10/minute for 5 minutes',
    firstAction:
      'Compare the deployed commit against the client build. This is almost never a bug in a ' +
      'route: it is a client asking for an endpoint this build does not have, so the fix is a ' +
      'deploy or a rollback, not a code change. Group by client to see which one is ahead.',
  },
  {
    name: 'auth-failure-spike',
    metric: 'auth_failures_total',
    severity: 'P0',
    condition: 'rate > 10× the 24h median over 10 minutes',
    firstAction: 'Group by client. One client version is a bad release; many clients is credential stuffing.',
  },
  {
    name: 'booking-transitions-failing',
    metric: 'booking_transition_failures_total',
    severity: 'P0',
    condition: 'any refusal other than a normal guard exceeds 5/minute',
    firstAction: 'Group by action and fromState. A provider who cannot complete leaves a customer waiting at home.',
  },
  {
    name: 'zero-candidate-matching',
    metric: 'matching_zero_candidates_total',
    severity: 'P1',
    condition: '> 20% of assignment attempts in an hour',
    firstAction: 'Check provider availability and the eligibility pipeline before assuming demand moved.',
  },
  {
    name: 'p99-latency',
    metric: 'http_request_duration_ms',
    severity: 'P1',
    condition: 'p99 > 5s for any route over 15 minutes',
    firstAction: 'Compare against p50. A moved p99 with a flat p50 is a slow query on a subset of rows.',
  },
  {
    name: 'notification-delivery-failure',
    metric: 'notification_delivery_total',
    severity: 'P1',
    condition: 'failure outcome > 10% over 15 minutes',
    firstAction: 'Check the FCM credential first; a rotated key fails every send identically.',
  },
  {
    name: 'legacy-traffic-regression',
    metric: 'legacy_route_hits_total',
    severity: 'P2',
    condition: 'a route recorded zero for 7 days starts reporting again',
    firstAction: 'A client rolled back, or an old build woke up. Do NOT retire that alias.',
  },
  {
    name: 'message-send-failures',
    metric: 'message_failures_total',
    severity: 'P1',
    condition: '> 2% of sends over 10 minutes',
    firstAction: 'Split persistence from realtime; a socket outage still leaves messages readable on reload.',
  },
]);

export const P0_ALERTS = Object.freeze(ALERTS.filter((a) => a.severity === 'P0'));
