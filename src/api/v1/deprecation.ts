/**
 * Deprecation signalling for legacy aliases (§149).
 *
 * ## What this adds, and what it very deliberately does not
 *
 * It adds three RESPONSE HEADERS to legacy routes that have a canonical
 * successor: `Deprecation`, `Link rel="successor-version"`, and — only where a
 * date can honestly be given — `Sunset`. RFC 8594 and RFC 8288, so a client
 * generator or an HTTP proxy already knows how to read them.
 *
 * It does NOT change any status code, body, or behaviour. A legacy route
 * answers exactly as it did before; the headers are additive metadata a client
 * may ignore forever. That is the whole point: five live clients depend on
 * these paths, and a deprecation notice that changes a response is not a notice,
 * it is a breakage.
 *
 * ## Why almost nothing carries a Sunset date
 *
 * `Sunset` means "this WILL stop working then". Emitting a date the platform
 * cannot keep is worse than emitting none: a client team plans a release around
 * it, the date passes because the retirement gate was not met, and the header
 * stops being believed — at which point the one route that really is going away
 * gets ignored too.
 *
 * A date is emitted only when `deprecationPlan()` says the alias is retirable —
 * canonical successor mounted, every caller migrated — and then it is
 * `now + the observed-traffic window` for the slowest client still on it. Today
 * that is zero routes, and the honest signal is `Deprecation: true` with a
 * successor link and no date.
 */

import { NextFunction, Request, Response } from 'express';
import { V1_CONTRACT, V1_PREFIX, type HttpMethod } from './contract';
import { deprecationPlan } from './convergence';

export interface DeprecationNotice {
  method: HttpMethod;
  /** The legacy path, as mounted. */
  path: string;
  matcher: RegExp;
  /** Canonical successor, fully qualified. */
  successor: string;
  /** Contract id of the successor. */
  canonical: string;
  /** Days of observed silence still required, for the client that needs longest. */
  windowDays: number;
  /** Only set when the alias has met every non-traffic condition. */
  sunsetEligible: boolean;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Literal segments that some OTHER legacy route claims at the same position.
 *
 * `GET /api/:id` compiles to a pattern for one segment under `/api`, and
 * `/api/catalog` is one segment under `/api`. Without this, the booking-detail
 * alias answers for the catalog, and production told four of the busiest public
 * paths that their successor was `/api/v1/bookings/:bookingId`. The catalog is
 * not superseded by a booking read, and neither is pricing.
 *
 * Derived from the contract array, never from a hand-maintained list. A
 * string-keyed guard drifts the moment somebody adds a route; a derived one
 * cannot, because the same array mounts the router.
 */
const literalsAt = (index: number): Set<string> => {
  const out = new Set<string>();
  for (const entry of V1_CONTRACT) {
    for (const l of entry.legacy) {
      const seg = l.path.split('/').filter(Boolean)[index];
      if (seg && !seg.startsWith(':')) out.add(seg);
    }
  }
  return out;
};

/**
 * Positional param types, read off the successor entry.
 *
 * A legacy path names its parameter whatever it named it — `/api/:id` — while
 * the canonical successor declares `bookingId` with `type: 'integer'`. The
 * names differ and the positions do not, so the type is taken positionally.
 * Booking and service ids are integers everywhere on this platform, so a
 * digits-only pattern makes even a future literal route safe by construction
 * rather than by remembering to add it to a list.
 */
const paramTypesOf = (successorParams: ReadonlyArray<{ type: string }> | undefined): string[] =>
  (successorParams ?? []).map((p) => p.type);

const toMatcher = (path: string, paramTypes: string[] = []): RegExp => {
  let paramIndex = 0;
  const body = path
    .split('/')
    .filter(Boolean)
    .map((segment, index) => {
      if (!segment.startsWith(':')) return escape(segment);

      const type = paramTypes[paramIndex++];
      // Constraint 1: an integer id cannot be the word `catalog`.
      if (type === 'integer') return '\\d+';

      // Constraint 2, independent of the first: whatever the type, a parameter
      // must not swallow a literal another route claims at this position. Kept
      // even when constraint 1 already applies, because the two fail
      // differently — one on a type change, the other on a new route.
      const reserved = [...literalsAt(index)].filter(Boolean).sort();
      if (reserved.length === 0) return '[^/]+';
      return `(?!(?:${reserved.map(escape).join('|')})(?:/|$))[^/]+`;
    })
    .map((s) => '/' + s)
    .join('');
  return new RegExp(`^${body}/?$`);
};

/**
 * The notice list, derived from the contract.
 *
 * Same source as the telemetry watch list and the deprecation schedule, so a
 * route cannot be announced as deprecated without also being counted, or
 * counted without being announced.
 */
export const buildDeprecationNotices = (): DeprecationNotice[] => {
  const plan = deprecationPlan();
  const notices: DeprecationNotice[] = [];
  const seen = new Set<string>();

  for (const row of plan) {
    // CANONICALIZE means this path is still the canonical one for its callers.
    // Announcing it as deprecated would be telling a client to move to a route
    // that does not supersede what they are doing.
    if (row.legacy.disposition !== 'ALIAS_TEMPORARILY') continue;

    const key = `${row.legacy.method} ${row.legacy.path}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const successor = V1_CONTRACT.find((e) => e.id === row.canonical.id);
    if (!successor || successor.status !== 'implemented') continue;

    notices.push({
      method: row.legacy.method,
      path: row.legacy.path,
      matcher: toMatcher(row.legacy.path, paramTypesOf(successor.params)),
      successor: `${V1_PREFIX}${successor.path}`,
      canonical: successor.id,
      windowDays: row.earliestWindowDays,
      sunsetEligible: row.retirable,
    });
  }

  // Constraint 3: order. `findNotice` takes the first match, so a route whose
  // segments are all literal must be tested before one that can match a
  // parameter — otherwise a greedy alias answers for a sibling that named
  // itself exactly. Most literal segments first; ties broken by path so the
  // compiled order is stable and diffable rather than dependent on contract
  // array order.
  const literalCount = (p: string) =>
    p.split('/').filter((s) => s && !s.startsWith(':')).length;
  const paramCount = (p: string) => p.split('/').filter((s) => s.startsWith(':')).length;

  notices.sort(
    (a, b) =>
      paramCount(a.path) - paramCount(b.path) ||
      literalCount(b.path) - literalCount(a.path) ||
      a.path.localeCompare(b.path),
  );

  return notices;
};

const NOTICES = buildDeprecationNotices();

export const findNotice = (method: string, path: string): DeprecationNotice | null =>
  NOTICES.find((n) => n.method === method.toLowerCase() && n.matcher.test(path)) ?? null;

/**
 * `Sunset` per RFC 8594 is an HTTP-date.
 *
 * Computed from the retirement window rather than typed, and only for an alias
 * that has already met every other condition — see the module docblock.
 */
export const sunsetDate = (notice: DeprecationNotice, from: Date = new Date()): string | null => {
  if (!notice.sunsetEligible) return null;
  const at = new Date(from.getTime() + notice.windowDays * 24 * 60 * 60 * 1000);
  return at.toUTCString();
};

/**
 * The middleware. Additive headers only.
 *
 * Mounted beside `legacyContractTelemetry` so the route that is counted is the
 * route that is announced.
 */
export const deprecationHeaders = (req: Request, res: Response, next: NextFunction) => {
  try {
    const notice = findNotice(req.method, req.path);
    if (notice) {
      // RFC 8594: the field value `true` means deprecated with no stated date.
      res.set('Deprecation', 'true');
      res.set('Link', `<${notice.successor}>; rel="successor-version"`);
      const sunset = sunsetDate(notice);
      if (sunset) res.set('Sunset', sunset);
    }
  } catch {
    // A header must never take a live route down.
  }
  next();
};

/** Test seam — the compiled notice list. */
export const __notices = NOTICES;

/**
 * The no-removal rule (§149), stated where the code that implements it lives.
 *
 * Announcing a deprecation and removing a route are different decisions with
 * different evidence. This module does the first. The second is gated by
 * `deprecationPlan()` in `convergence.ts`, and every condition must hold.
 */
export const NO_REMOVAL_RULE = {
  statement:
    'A legacy route is never removed while any supported client still calls it, and never on a ' +
    'schedule. Removal requires observed zero traffic for the full window, every caller cell ' +
    'reading migrated, the canonical successor mounted, and a rollback that restores the alias ' +
    'without a data change.',
  evidence: Object.freeze([
    '`legacy_route_hits_total` reads zero for the window (14d web / 90d any mobile caller)',
    '`V1_CONTRACT[].callers` shows no `legacy` or `planned` cell for the successor',
    'the successor entry is `status: implemented`',
    'the removal is its own commit, so reverting it restores the route and nothing else',
  ]),
  whyNotADate:
    'A Sunset date the platform cannot keep teaches client teams to ignore the header, and then ' +
    'the one route that really is going away is ignored too.',
} as const;
