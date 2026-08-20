<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-release-safety-docs.ts, derived from
    src/observability/observabilityPolicy.ts  (schema, redaction, metrics, alerts)
    src/observability/requestLog.ts           (the middleware)
    src/observability/metrics.ts              (the registry)
  Regenerate: npm run safety:docs
-->

# Observability standard

> One log schema, one correlation id, one metric vocabulary. The redaction
> example below is produced by RUNNING the real redactor, so it is evidence
> rather than description.

## 1. Correlation (§140)

One id, end to end.

| | |
| --- | --- |
| Returned as | `X-Request-Id` on every response |
| Accepted from | `x-request-id`, `x-correlation-id` |
| Client identity | `X-Servana-Client`, `X-Servana-Client-Version` |

Propagated to:

- the structured request log
- the v1 error envelope (`error.requestId`)
- domain event outbox rows, via `correlationId`
- the legacy-route telemetry line

An inbound id is ACCEPTED but never TRUSTED for anything but correlation: it is bounded, character-checked and never used as a key, because a caller controls it.

An inbound id must match `[A-Za-z0-9._:-]{8,128}`. That is not fussiness: a
caller-controlled value that reaches a line-delimited log can inject an entire
forged entry, and the same value ends up in the error envelope the client
displays.

## 2. The log line (§141)

One JSON object per request, emitted on `res.finish` so the status and latency
are the real ones.

| Field | Presence | Meaning |
| --- | --- | --- |
| `ts` | always | ISO-8601 UTC with milliseconds. |
| `level` | always | info | warn | error. |
| `msg` | always | A stable event name, not a sentence. |
| `requestId` | always | The correlation id (§140). |
| `method` | always | HTTP method. |
| `route` | always | The route TEMPLATE, never the concrete path. |
| `status` | always | HTTP status actually sent. |
| `durationMs` | always | Wall time from receipt to response finish. |
| `client` | always | Coarse client label, e.g. customer-mobile@1.4.2. |
| `namespace` | always | v1 | legacy — which contract served it. |
| `actorRole` | when known | admin | provider | customer | anonymous. A ROLE, never a uid. |
| `domainAction` | when known | The contract id, e.g. bookings.cancel. |
| `errorCode` | when known | The v1 error code, for failures. |
| `entity` | when known | Safe entity ids (§141) — see SAFE_ENTITY_KEYS. |

### What is never logged

The middleware does not read request bodies, response bodies, query strings or
headers beyond the client label. Not "reads them and redacts" — does not read
them.

Entity ids come from route parameters through a **deny-by-default allow-list**:

- kept: `bookingId`, `conversationId`, `serviceId`, `categoryId`, `subcategoryId`, `reviewId`, `caseId`, `notificationKey`, `eventId`, `payoutId`, `paymentId`
- everything else is dropped
- these fragments are additionally replaced wherever they appear:
  `password`, `passwd`, `secret`, `token`, `authorization`, `auth`, `otp`, `code`, `pin`, `credential`, `apikey`, `api_key`, …

An allow-list is the only design where a NEW sensitive field is safe by default.
Under a deny-list, the next developer who adds `taxIdNumber` to a payload has
to remember it is sensitive, and the failure is silent, permanent, and already
in the aggregator by the time anybody notices.

### The redactor, run

Input:

```json
{
  "bookingId": 84213, "serviceId": 180,
  "customerEmail": "dana@example.com", "addressOne": "14 Mabini Street",
  "otp": "482913", "accessToken": "eyJhbGciOiJIUzI1NiJ9.abc"
}
```

Output:

```json
{
  "bookingId": 84213,
  "serviceId": 180,
  "customerEmail": "[redacted]",
  "addressOne": "[redacted]",
  "otp": "[redacted]",
  "accessToken": "[redacted]"
}
```

### A ROLE, never a person

`actorRole` is one of `admin`, `provider`, `customer`, `anonymous`. There is no
uid field and one cannot be added by accident.

"A provider failed to accept a job" is an operational fact. "Provider FbX9… failed
to accept job 84213" is a record of a named person's working day, and a log that
accumulates those has to be protected like the database it describes.

## 3. Cardinality

Every route label is a TEMPLATE. `/api/v1/bookings/:id/timeline`,
never the concrete path.

A metric keyed on a real booking id is one series per booking, which is how a
monitoring bill and an outage arrive on the same afternoon. It is also a record
of which bookings exist, held somewhere with weaker access control than the
database.

## 4. Metrics (§142)

Latency buckets (ms): 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000.

Quantiles are reported as bucket UPPER BOUNDS. A histogram cannot tell you the
true 95th percentile; pretending otherwise gives an incident a number that is
precise and wrong.

### `http_requests_total` (counter)

Every request, by route template, method, status class, namespace and client.

- labels: `route`, `method`, `statusClass`, `namespace`, `client`
- **why:** Request rate and error rate come from one series, so they cannot disagree about the denominator.

### `http_request_duration_ms` (histogram)

Latency, for p50/p95/p99 by route.

- labels: `route`, `method`, `namespace`
- **why:** A mean hides the tail, and the tail is what a customer on a Philippine mobile network experiences.

### `auth_failures_total` (counter)

Rejected authentication and authorization, by reason.

- labels: `reason`, `route`, `client`
- **why:** Separates "a client shipped a bad token refresh" from "somebody is trying uids", which look identical in an error-rate chart.

### `public_path_auth_failures_total` (counter)

A request to a path the v1 contract declares auth: 'public' that was answered 401 or 403. Labelled by route template only — the caller is anonymous by definition.

- labels: `route`, `namespace`
- **why:** This is not a rate, it is an INVARIANT: a public entry refusing an anonymous caller means the request never reached the router that would have allowed it. On 2026-08-18 production answered 401 to every path including ones that do not exist, because auth ran before routing — and no existing signal named it. api-error-rate is 5xx only, so a 401 storm is invisible to it; auth-failure-spike is relative to a 24h median, so once the broken state persists past a day it BECOMES the median and the alert goes quiet while production stays broken.

### `contract_mismatch_total` (counter)

Requests for a namespaced path this build does not serve.

- labels: `namespace`, `client`, `method`
- **why:** An ordinary 404 is a client asking for something that never existed. This is a client asking for something that was PROMISED — it holds a contract naming the route and the running build does not serve it. A spike on the v1 namespace is the signature of a portal deployed against a backend that has not shipped, which has happened here and presented as "the API is down" rather than as a version mismatch. The operator response is a deploy or a rollback, never a code change, which is why it must not be buried in the general 404 rate.

### `legacy_route_hits_total` (counter)

Calls to a legacy route that has a canonical successor.

- labels: `route`, `client`, `canonical`
- **why:** The retirement gate. An alias may only be deleted after this reads zero for the whole window.

### `booking_transition_failures_total` (counter)

Refused booking state transitions, by actor verb and refusal.

- labels: `action`, `refusal`, `fromState`
- **why:** A provider unable to complete a job is a customer waiting in their home. This is the P0 signal of the booking domain.

### `matching_zero_candidates_total` (counter)

Assignment attempts that found no eligible provider.

- labels: `reason`
- **why:** A booking nobody can be assigned to is a paid job that silently never happens; it produces no error and no alert otherwise.

### `message_failures_total` (counter)

Message sends and realtime deliveries that failed.

- labels: `stage`
- **why:** A customer and a provider unable to reach each other mid-job is the failure that generates the support call.

### `notification_delivery_total` (counter)

Notification projections attempted, by channel and outcome.

- labels: `channel`, `outcome`
- **why:** Distinguishes suppressed-by-preference from failed-to-send, which an aggregate count conflates into "notifications are down".

### `worker_telemetry_events_total` (counter)

Scrubbed worker-app events accepted by the ingest endpoint, by event name and build flavor.

- labels: `event`, `flavor`
- **why:** The worker app's failures are silent by nature. A job offer that never arrives produces no error anywhere — the provider simply does not get the work, and the first report is somebody asking why they had a quiet week. This is the only series that can notice it.

### `worker_telemetry_dropped_keys_total` (counter)

Payload keys the server refused. Names are counted, values never leave the request.

- labels: 
- **why:** The client scrubs and the server scrubs again, from separately maintained lists. A rising value is not an attack — it is the two lists having drifted, which means a client is sending something nobody will be able to query. Better as a number than as a surprise.

### `worker_telemetry_write_failures_total` (counter)

Telemetry rows that could not be stored. The request still succeeded.

- labels: 
- **why:** Ingest deliberately swallows write failures, because telemetry that can 500 a client gets switched off in the build that most needed it. Swallowed is not the same as unnoticed, and this is the difference.

## 5. Alerts (§151)

4 P0 signals. A P0 wakes somebody; the rest wait for the morning.

| Severity | Alert | Metric | Condition | First action |
| --- | --- | --- | --- | --- |
| P0 | `api-error-rate` | `http_requests_total` | 5xx share of all requests > 2% over 5 minutes | Group by route and namespace. One route means a deploy; every route means the database or the process. |
| P0 | `public-path-auth-failure` | `public_path_auth_failures_total` | ANY occurrence. Absolute, deliberately — not a rate, not a share, and not relative to a baseline, because the correct value is zero and a threshold relative to history stops firing once the broken state becomes the history. | Do NOT start with credentials. A contract-public entry refusing an anonymous caller means the request did not reach the v1 router. Probe three paths and compare: a public one, a guarded one, and one that cannot exist. If all three answer alike, authentication is running before routing — check the middleware mounted above app.use("/api/v1") and whether the process restarted on the commit it claims. |
| P1 | `v1-contract-mismatch` | `contract_mismatch_total` | any sustained rate on the v1 namespace — more than 10/minute for 5 minutes | Compare the deployed commit against the client build. This is almost never a bug in a route: it is a client asking for an endpoint this build does not have, so the fix is a deploy or a rollback, not a code change. Group by client to see which one is ahead. |
| P0 | `auth-failure-spike` | `auth_failures_total` | rate > 10× the 24h median over 10 minutes | Group by client. One client version is a bad release; many clients is credential stuffing. |
| P0 | `booking-transitions-failing` | `booking_transition_failures_total` | any refusal other than a normal guard exceeds 5/minute | Group by action and fromState. A provider who cannot complete leaves a customer waiting at home. |
| P1 | `zero-candidate-matching` | `matching_zero_candidates_total` | > 20% of assignment attempts in an hour | Check provider availability and the eligibility pipeline before assuming demand moved. |
| P1 | `worker-activation-stall` | `worker_telemetry_events_total` | activationStarted > 0 and activationCompleted == 0 over 24 hours. Absolute rather than a rate: at launch the denominator is single digits, and a percentage of three providers is noise. What matters is the SHAPE — people beginning activation and nobody finishing. | Walk the activation path yourself against production before touching code. Every endpoint in it returns 200 and none had been carried end to end by a person as of 2026-08-20, so the likely failure is a step that refuses with a message a provider cannot act on rather than a route that errors. Compare activationStarted against the completion checklist. |
| P1 | `p99-latency` | `http_request_duration_ms` | p99 > 5s for any route over 15 minutes | Compare against p50. A moved p99 with a flat p50 is a slow query on a subset of rows. |
| P1 | `notification-delivery-failure` | `notification_delivery_total` | failure outcome > 10% over 15 minutes | Check the FCM credential first; a rotated key fails every send identically. |
| P2 | `legacy-traffic-regression` | `legacy_route_hits_total` | a route recorded zero for 7 days starts reporting again | A client rolled back, or an old build woke up. Do NOT retire that alias. |
| P1 | `message-send-failures` | `message_failures_total` | > 2% of sends over 10 minutes | Split persistence from realtime; a socket outage still leaves messages readable on reload. |

Each alert names a FIRST ACTION, because an alert that says only "error rate is
high" makes an incident longer than no alert at all.

## 6. Where it goes

`console.info` with a JSON payload, and `[servana-metrics]` lines on a window.

Deliberately log lines rather than a metrics endpoint. The API runs under PM2 on
a single box, so `pm2 logs servana-prod` is the tool the team already has. A
`/admin/telemetry` route would need a contract entry, a permission and a portal
screen before it told anybody anything.

`snapshot()` returns the registry as data — that is what the tests read, and
what a future exporter would serialize. Swapping the transport touches one file.
