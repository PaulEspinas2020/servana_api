/**
 * Structured request logging and correlation (§140, §141, §142).
 *
 * One line per request, one schema, emitted on `res.finish` so the status and
 * the latency are the real ones rather than the intended ones.
 *
 * ## What it deliberately does not do
 *
 * It does not log request bodies, response bodies, query strings or headers. Not
 * "logs them redacted" — does not read them. The safe entity ids it reports come
 * from `req.params`, which are route parameters the contract already declares,
 * passed through `redact()`; everything else is dropped by an allow-list.
 *
 * A log that carries a booking's address because somebody logged `req.body` on a
 * create endpoint is a data breach with a six-month retention period, and it is
 * invisible until somebody reads the aggregator.
 *
 * ## Sampling
 *
 * 2xx and 3xx on hot read routes are sampled; everything else is always logged.
 * A 4xx or 5xx is why somebody opens the log, so it is never the line that was
 * dropped. Sampling is off in tests and can be turned off by env for an
 * incident.
 */

import { NextFunction, Request, Response } from 'express';
import {
  CORRELATION,
  redact,
  routeTemplate,
  sanitizeCorrelationId,
  statusClass,
  type ActorRole,
} from './observabilityPolicy';
import { incr, observe } from './metrics';

// ─── Actor and client ─────────────────────────────────────────────────────────

/**
 * The caller's ROLE, never their identity.
 *
 * Role numbers come from `servana_role_map`: 1 is admin, 2 and 4 are provider
 * roles. Anything authenticated that is neither is a customer.
 */
export const actorRoleOf = (req: Request): ActorRole => {
  const user = (req as any).user;
  if (!user) return 'anonymous';
  const role = Number(user.role ?? user.roleId ?? NaN);
  if (role === 1) return 'admin';
  if (role === 2 || role === 4) return 'provider';
  return 'customer';
};

const KNOWN_CLIENTS = new Set([
  'customer-mobile', 'customer-web', 'provider-mobile', 'provider-web', 'admin',
]);

/**
 * A coarse, non-identifying client label.
 *
 * Same vocabulary `legacyTelemetry.clientLabel` uses, and for the same reason:
 * two labels for one client means two dashboards that disagree about whether it
 * has migrated. Falls back to a User-Agent FAMILY, never the User-Agent, which
 * on mobile carries the device model and OS build.
 */
export const clientLabelOf = (req: Request): string => {
  const declared = String(req.get(CORRELATION.clientHeader) ?? '').toLowerCase().trim();
  if (KNOWN_CLIENTS.has(declared)) {
    const version = String(req.get(CORRELATION.clientVersionHeader) ?? '').trim();
    return version && /^[\w.+-]{1,32}$/.test(version) ? `${declared}@${version}` : declared;
  }
  const ua = String(req.get('user-agent') ?? '').toLowerCase();
  if (!ua) return 'unknown';
  if (ua.includes('dart') || ua.includes('flutter')) return 'ua:dart';
  if (ua.includes('mozilla') || ua.includes('chrome') || ua.includes('safari')) return 'ua:browser';
  if (ua.includes('curl') || ua.includes('wget') || ua.includes('postman')) return 'ua:tool';
  return 'ua:other';
};

const namespaceOf = (path: string): 'v1' | 'legacy' =>
  path.startsWith('/api/v1') ? 'v1' : 'legacy';

// ─── Correlation (§140) ───────────────────────────────────────────────────────

/**
 * Adopt the caller's correlation id when they send a usable one.
 *
 * `app.ts` already stamps `req.id` with a fresh UUID. This runs after it and
 * REPLACES that id when an inbound header carries one, so a client's trace and
 * ours are one trace. The value is pattern-checked before it is accepted —
 * a caller controls it, and an unbounded string from the network ends up in
 * every log line and every error envelope.
 */
export const correlationMiddleware = (req: Request, res: Response, next: NextFunction) => {
  try {
    for (const header of CORRELATION.inboundHeaders) {
      const candidate = sanitizeCorrelationId(req.get(header));
      if (candidate) {
        (req as any).id = candidate;
        (req as any).correlationAdopted = true;
        break;
      }
    }
    res.set(CORRELATION.header, String((req as any).id ?? 'unknown'));
  } catch {
    // Never block a request over a header.
  }
  next();
};

// ─── The log line ─────────────────────────────────────────────────────────────

export interface RequestLogLine {
  ts: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
  requestId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  client: string;
  namespace: 'v1' | 'legacy';
  actorRole: ActorRole;
  domainAction?: string;
  errorCode?: string;
  entity?: Record<string, unknown>;
}

const levelFor = (status: number): RequestLogLine['level'] =>
  status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';

/** Hot read routes whose 2xx lines are sampled. */
const SAMPLE_RATE = Number(process.env.LOG_SAMPLE_RATE ?? '1');

const shouldLog = (status: number): boolean => {
  // A failure is why somebody opens the log. Never sample those away.
  if (status >= 400) return true;
  if (!Number.isFinite(SAMPLE_RATE) || SAMPLE_RATE >= 1) return true;
  return Math.random() < SAMPLE_RATE;
};

/** Test seam: the last line emitted, so a suite can assert on the real shape. */
let lastLine: RequestLogLine | null = null;
export const __lastRequestLogLine = (): RequestLogLine | null => lastLine;
export const __resetRequestLog = (): void => { lastLine = null; };

export const buildLogLine = (
  req: Request,
  res: Response,
  durationMs: number,
): RequestLogLine => {
  const path = `${req.baseUrl ?? ''}${req.path ?? ''}` || req.originalUrl || '/';
  const route = routeTemplate(path);
  const status = res.statusCode;
  const entity = redact((req as any).params ?? {});

  const line: RequestLogLine = {
    ts: new Date().toISOString(),
    level: levelFor(status),
    msg: 'http_request',
    requestId: String((req as any).id ?? 'unknown'),
    method: req.method,
    route,
    status,
    durationMs,
    client: clientLabelOf(req),
    namespace: namespaceOf(path),
    actorRole: actorRoleOf(req),
  };

  const domainAction = (res as any).locals?.domainAction ?? (req as any).v1ContractId;
  if (typeof domainAction === 'string' && domainAction) line.domainAction = domainAction;

  const errorCode = (res as any).locals?.errorCode;
  if (typeof errorCode === 'string' && errorCode) line.errorCode = errorCode;

  if (Object.keys(entity).length) line.entity = entity;

  return line;
};

/**
 * The middleware. Mounted once, in front of everything.
 *
 * Records the metric for EVERY request and emits the log line subject to
 * sampling — the count must be complete even when the lines are not, or the
 * error rate is computed against a denominator that was thinned.
 */
export const requestLogMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    try {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const rounded = Math.round(durationMs * 10) / 10;
      const line = buildLogLine(req, res, rounded);
      lastLine = line;

      incr('http_requests_total', {
        route: line.route,
        method: line.method,
        statusClass: statusClass(line.status),
        namespace: line.namespace,
        client: line.client,
      });
      observe('http_request_duration_ms', rounded, {
        route: line.route,
        method: line.method,
        namespace: line.namespace,
      });
      if (line.status === 401 || line.status === 403) {
        incr('auth_failures_total', {
          reason: line.status === 401 ? 'unauthenticated' : 'forbidden',
          route: line.route,
          client: line.client,
        });
      }

      /**
       * A 404 on a namespaced API is not an ordinary 404 (TAB 13).
       *
       * An ordinary 404 is a client asking for something that never existed.
       * This is a client asking for something that was PROMISED — it holds a
       * contract naming the route and the running build does not serve it.
       *
       * Counted separately because the operator response is completely
       * different: no route needs fixing, a build needs deploying or rolling
       * back. Production has already shown this failure once, when it answered
       * 401 to every path including unknown ones and the symptom read as "the
       * API is down" rather than as a version mismatch.
       *
       * Without this counter an alert on it is impossible, which is why it is
       * here rather than in a dashboard query: the signal has to exist before
       * anybody can watch it.
       */
      if (line.status === 404 && line.namespace && line.namespace !== 'legacy') {
        incr('contract_mismatch_total', {
          namespace: line.namespace,
          client: line.client,
          method: line.method,
        });
      }

      if (shouldLog(line.status)) {
        // eslint-disable-next-line no-console
        console.info(JSON.stringify(line));
      }
    } catch {
      // A logging bug is a missing line, not an outage.
    }
  });

  next();
};
