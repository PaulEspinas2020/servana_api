/**
 * Observability for every legacy route that has a canonical v1 successor.
 *
 * ## Why this exists
 *
 * The migration matrix marks routes ALIAS_TEMPORARILY, and "temporarily" is a
 * promise nobody can keep without numbers. The existing
 * `middleware/legacyRouteTelemetry` proved the shape on the `/api/workers/*`
 * family — its docblock says the retirement date should be a measurement rather
 * than a guess — but it covers one family and is mounted by hand.
 *
 * This one derives its watch list FROM `V1_CONTRACT.legacy`, so a route can
 * only be documented as superseded if it is also being counted. Add a legacy
 * mapping to the contract and it starts reporting on the next boot; there is no
 * second list to keep in step.
 *
 * ## What it records, and what it refuses to record
 *
 * Per legacy route, per window: hit count, distinct client identifiers, and
 * whether the caller presented a bearer token. Client identity comes from the
 * `X-Servana-Client` / `X-Servana-Client-Version` headers when a client sends
 * them, and otherwise from a coarse User-Agent family — never the raw
 * User-Agent, which on mobile carries device and OS build.
 *
 * No uid, no path parameter value, no query string, no body. §58 applies to
 * telemetry exactly as it applies to a response: a log that names who called is
 * a log that has to be protected like the data it describes.
 *
 * ## Never blocks
 *
 * This sits in front of routes five live clients depend on. Every path through
 * it is wrapped so a bug here is a missing log line, not an outage.
 */

import { Request, Response, NextFunction } from 'express';
import { V1_CONTRACT, HttpMethod, Disposition } from './contract';

// ─── Retirement criteria ──────────────────────────────────────────────────────

/**
 * What has to be true before a legacy alias is deleted.
 *
 * Written down because "we think nobody calls it" is how the customer app's
 * `/api/services/:id/options-with-addons` came to 404 in production for months:
 * a path can look dead from the server and be the only thing a shipped build
 * knows how to call.
 *
 * A mobile alias additionally needs the *installed base* to have moved, not
 * just the current build — an unupdated app keeps calling the old path for as
 * long as the customer leaves it installed. That is why the window is stated in
 * days of observed zero traffic rather than in releases.
 */
export const RETIREMENT_CRITERIA = {
  /** Consecutive days of zero recorded hits before a web-only alias may go. */
  webZeroTrafficDays: 14,
  /** Consecutive days of zero recorded hits before a mobile alias may go. */
  mobileZeroTrafficDays: 90,
  /** Every client the matrix lists for the route must read 'migrated'. */
  requireAllCallersMigrated: true,
  /** The canonical successor must be `status: 'implemented'`, not 'planned'. */
  requireCanonicalImplemented: true,
} as const;

// ─── Watch list, derived from the contract ────────────────────────────────────

export interface LegacyWatch {
  method: HttpMethod;
  path: string;
  disposition: Disposition;
  /** Contract id of the canonical successor. */
  canonical: string;
  matcher: RegExp;
}

const toMatcher = (path: string): RegExp => {
  const body = path
    .split('/')
    .filter(Boolean)
    .map((segment) =>
      segment.startsWith(':')
        ? '[^/]+'
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .map((s) => '/' + s)
    .join('');
  return new RegExp(`^${body}/?$`);
};

export const buildWatchList = (): LegacyWatch[] => {
  const out: LegacyWatch[] = [];
  const seen = new Set<string>();
  for (const entry of V1_CONTRACT) {
    for (const legacy of entry.legacy) {
      const key = `${legacy.method} ${legacy.path}`;
      // A legacy path can supersede into more than one canonical entry
      // (/api/user/notifications feeds both the list and its count). Count it
      // once, and attribute it to the first successor that claims it.
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        method: legacy.method,
        path: legacy.path,
        disposition: legacy.disposition,
        canonical: entry.id,
        matcher: toMatcher(legacy.path),
      });
    }
  }
  return out;
};

const WATCH = buildWatchList();

// ─── Counters ─────────────────────────────────────────────────────────────────

interface Bucket {
  hits: number;
  withBearer: number;
  clients: Map<string, number>;
}

const WINDOW_MS = 60 * 60 * 1000;

let buckets = new Map<string, Bucket>();
let windowStartedAt = Date.now();

const KNOWN_CLIENTS = new Set([
  'customer-mobile',
  'customer-web',
  'provider-mobile',
  'provider-web',
  'admin',
]);

/**
 * A coarse, non-identifying client label.
 *
 * Prefers the explicit header a client can set. Falls back to a User-Agent
 * FAMILY — "dart", "browser", "other" — and never the User-Agent itself, which
 * carries device model and OS build on mobile.
 */
export const clientLabel = (req: Request): string => {
  const declared = String(req.get('x-servana-client') ?? '').toLowerCase().trim();
  if (KNOWN_CLIENTS.has(declared)) {
    const version = String(req.get('x-servana-client-version') ?? '').trim();
    return version && /^[\w.+-]{1,32}$/.test(version) ? `${declared}@${version}` : declared;
  }
  const ua = String(req.get('user-agent') ?? '').toLowerCase();
  if (!ua) return 'unknown';
  if (ua.includes('dart') || ua.includes('flutter')) return 'ua:dart';
  if (ua.includes('mozilla') || ua.includes('chrome') || ua.includes('safari')) return 'ua:browser';
  if (ua.includes('curl') || ua.includes('wget') || ua.includes('postman')) return 'ua:tool';
  return 'ua:other';
};

const rollWindowIfDue = () => {
  if (Date.now() - windowStartedAt < WINDOW_MS) return;
  if (buckets.size) reportWindow();
  buckets = new Map();
  windowStartedAt = Date.now();
};

/**
 * One summary line per legacy route per window.
 *
 * Deliberately a log line rather than a metrics endpoint. The API runs under
 * PM2 on a single box, so `pm2 logs servana-prod | grep legacy-contract` is the
 * tool that already exists and that anyone on the team can already use. A new
 * `/admin/telemetry` route would need a contract entry, a permission and a
 * portal screen before it told anybody anything.
 */
export const reportWindow = () => {
  const minutes = Math.round((Date.now() - windowStartedAt) / 60000);
  for (const [key, bucket] of buckets) {
    const clients = [...bucket.clients.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `${name}=${n}`)
      .join(' ');
    // eslint-disable-next-line no-console
    console.info(
      `[legacy-contract] ${key} hits=${bucket.hits} bearer=${bucket.withBearer} ` +
        `window=${minutes}m clients=[${clients}]`,
    );
  }
};

export interface LegacySnapshot {
  windowStartedAt: number;
  routes: Array<{
    key: string;
    canonical: string;
    disposition: Disposition;
    hits: number;
    withBearer: number;
    clients: Record<string, number>;
  }>;
}

/** Machine-readable view of the current window. Used by tests and by ops. */
export const snapshot = (): LegacySnapshot => ({
  windowStartedAt,
  routes: [...buckets.entries()].map(([key, bucket]) => {
    const watch = WATCH.find((w) => `${w.method.toUpperCase()} ${w.path}` === key);
    return {
      key,
      canonical: watch?.canonical ?? 'unknown',
      disposition: watch?.disposition ?? 'KEEP',
      hits: bucket.hits,
      withBearer: bucket.withBearer,
      clients: Object.fromEntries(bucket.clients),
    };
  }),
});

// ─── The middleware ───────────────────────────────────────────────────────────

export const legacyContractTelemetry = (req: Request, _res: Response, next: NextFunction) => {
  try {
    rollWindowIfDue();

    const method = req.method.toLowerCase();
    const match = WATCH.find((w) => w.method === method && w.matcher.test(req.path));
    if (match) {
      const key = `${match.method.toUpperCase()} ${match.path}`;
      const bucket = buckets.get(key) ?? { hits: 0, withBearer: 0, clients: new Map() };
      bucket.hits += 1;
      if (req.headers.authorization) bucket.withBearer += 1;
      const label = clientLabel(req);
      bucket.clients.set(label, (bucket.clients.get(label) ?? 0) + 1);
      buckets.set(key, bucket);
    }
  } catch {
    // Observability must never take the request down.
  }
  next();
};

/** Test seam. */
export const __resetLegacyContractTelemetry = () => {
  buckets = new Map();
  windowStartedAt = Date.now();
};

/** Test seam — the compiled watch list. */
export const __watchList = WATCH;
