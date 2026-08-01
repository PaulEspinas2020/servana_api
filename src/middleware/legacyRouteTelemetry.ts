import { Request, Response, NextFunction } from "express";

/**
 * Observability for the unauthenticated legacy `/api/workers/*` family.
 *
 * Those 36 routes cannot take `verifyAuth` yet: the live ServanaWorker app
 * sends no JWT on them, so flipping them breaks a protected client (§2, §63).
 * The migration in docs/WORKER_ROUTE_MIGRATION.md is the real fix, and step 4
 * of it — deleting the legacy block — is gated on the traffic reaching zero.
 *
 * Nobody can make that call without numbers. This produces them:
 *
 *  - how much traffic the legacy family still carries, so the retirement date
 *    is a measurement rather than a guess, and
 *  - whether the routes are being abused today. `?workerUid=` is never checked
 *    against a token, so a caller supplying many different worker uids from one
 *    address is doing something no legitimate app does — a real worker app only
 *    ever sends its own uid.
 *
 * Deliberately not a rate limiter. Throttling by IP would slow bulk enumeration
 * but also risks degrading a genuine worker behind a shared mobile NAT, which
 * on this app means someone standing in a customer's house unable to start a
 * job. Measure first; throttle once the traffic shape is known.
 *
 * Logs no PII (§58): uid values are counted and hashed, never written out.
 */

/** Distinct worker uids seen per source, within the current window. */
const uidsBySource = new Map<string, Set<string>>();
let windowStartedAt = Date.now();

const WINDOW_MS = 15 * 60 * 1000;

/** More than this many distinct uids from one source looks like enumeration. */
const SUSPICIOUS_DISTINCT_UIDS = 5;

/** Short, non-reversible tag so repeat offenders are correlatable across lines. */
const tag = (value: string): string => {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (h * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 6);
};

const sourceOf = (req: Request): string => {
  const fwd = req.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : (fwd ?? req.socket?.remoteAddress ?? "");
  return String(raw).split(",")[0].trim() || "unknown";
};

const rollWindowIfDue = () => {
  if (Date.now() - windowStartedAt < WINDOW_MS) return;
  uidsBySource.clear();
  windowStartedAt = Date.now();
};

/**
 * Records one call against the legacy family.
 *
 * Never blocks and never throws — this sits in front of routes a live app
 * depends on, so a bug here must not become an outage.
 */
export const legacyRouteTelemetry = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  try {
    rollWindowIfDue();

    const claimedUid =
      (req.query?.workerUid as string) ||
      (req.params?.uid as string) ||
      (req.params?.workerId as string) ||
      "";

    const source = sourceOf(req);
    const authenticated = Boolean(req.headers.authorization);

    if (claimedUid) {
      const seen = uidsBySource.get(source) ?? new Set<string>();
      seen.add(claimedUid);
      uidsBySource.set(source, seen);

      if (seen.size === SUSPICIOUS_DISTINCT_UIDS) {
        // Fires once per source per window, on the threshold crossing, so a
        // scanner produces one line rather than thousands.
        console.warn(
          `[legacy-routes] source=${tag(source)} has claimed ` +
            `${seen.size} distinct workerUids in this window — a legitimate ` +
            `worker app only ever sends its own`,
        );
      }
    }

    console.info(
      `[legacy-routes] ${req.method} ${req.path} ` +
        `source=${tag(source)} ` +
        `claimsUid=${claimedUid ? tag(claimedUid) : "no"} ` +
        `bearer=${authenticated ? "yes" : "no"}`,
    );
  } catch {
    // Observability must never take the request down.
  }
  next();
};

/** Test seam — resets the window so cases do not bleed into each other. */
export const __resetLegacyTelemetry = () => {
  uidsBySource.clear();
  windowStartedAt = Date.now();
};

/** Test seam — how many distinct uids a source has claimed this window. */
export const __distinctUidsFor = (source: string): number =>
  uidsBySource.get(source)?.size ?? 0;
