/**
 * Counters for the four messaging failures that are otherwise invisible (§89).
 *
 * ## Why counters and not logs
 *
 * Every one of these already produces a log line somewhere, and that is exactly
 * the problem: one `console.error` per event looks identical on the first
 * occurrence and the ten-thousandth, so a send path that is broken for one
 * client reads the same as a user who lost signal once. A count per window
 * turns "it happened" into "it is happening", which is the only form of this
 * information anybody can act on.
 *
 * Same shape as `api/v1/legacyTelemetry`: an in-process window, a summary line
 * per window under a greppable prefix, and a `snapshot()` for tests and ops. The
 * API runs under PM2 on one box, so `pm2 logs | grep messaging-telemetry` is the
 * tool that already exists.
 *
 * ## What it records, and what it refuses to record
 *
 * Codes, counts, and coarse reasons. No uid, no conversation id, no message
 * body, no path parameter. §58 applies to telemetry exactly as it applies to a
 * response: a log that names who was talking to whom is a log that has to be
 * protected like the conversation it describes.
 *
 * The one exception is the reconnect detector, which needs to know that the SAME
 * subject came back. It keeps a SHA-256 prefix of the uid, never the uid, and
 * drops it as soon as the window rolls.
 */

import { createHash } from 'crypto';
import { MESSAGING_SIGNAL_CODES } from './messagingPolicy';

const WINDOW_MS = 60 * 60 * 1000;

/** A window's counts, keyed `CODE` or `CODE:reason`. */
let counts = new Map<string, number>();
let windowStartedAt = Date.now();

/**
 * Recently-seen connection subjects, for the reconnect signal.
 *
 * A hash prefix, not a uid — the question is "is this the same subject as a
 * moment ago", which a one-way digest answers, and the identity itself is not
 * needed to answer it.
 */
const RECONNECT_WINDOW_MS = 2 * 60 * 1000;
let recentSubjects = new Map<string, number>();

const subjectKey = (uid: string): string =>
  createHash('sha256').update(String(uid)).digest('hex').slice(0, 16);

const rollWindowIfDue = (): void => {
  if (Date.now() - windowStartedAt < WINDOW_MS) return;
  if (counts.size) reportWindow();
  counts = new Map();
  recentSubjects = new Map();
  windowStartedAt = Date.now();
};

/** A refusal reason, reduced to something safe and low-cardinality. */
const safeReason = (reason: unknown): string => {
  const raw = String(reason ?? 'unknown').trim();
  // Codes only. A free-text message can carry a body fragment, a filename or an
  // address, and a cardinality explosion makes the counter useless besides.
  return /^[A-Z][A-Z0-9_]{1,47}$/.test(raw) ? raw : 'UNCLASSIFIED';
};

const bump = (code: string, reason?: unknown): void => {
  try {
    rollWindowIfDue();
    const key = reason === undefined ? code : `${code}:${safeReason(reason)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  } catch {
    // Observability must never take a request down.
  }
};

// ─── The signals ──────────────────────────────────────────────────────────────

/**
 * A send was refused or threw. `reason` should be an upper-case code — an HTTP
 * status is not a reason, and a driver message is not one either.
 */
export const recordSendFailure = (reason: unknown): void =>
  bump('MESSAGE_SEND_FAILED', reason);

/**
 * A send matched an existing `clientMsgId` and returned the original message.
 *
 * Not an error — this is the retry path working. It is counted because a spike
 * means clients are timing out on writes that are in fact succeeding, which is a
 * latency problem that presents as a reliability one.
 */
export const recordDuplicateSuppressed = (): void => bump('MESSAGE_DUPLICATE_SUPPRESSED');

/** A socket completed the handshake. Also the denominator for the two below. */
export const recordRealtimeConnected = (uid: string): void => {
  bump('REALTIME_CONNECTED');
  try {
    const key = subjectKey(uid);
    const last = recentSubjects.get(key);
    if (last !== undefined && Date.now() - last < RECONNECT_WINDOW_MS) {
      bump('REALTIME_RECONNECTED');
    }
    recentSubjects.set(key, Date.now());
    if (recentSubjects.size > 20_000) {
      const cutoff = Date.now() - RECONNECT_WINDOW_MS;
      for (const [k, at] of recentSubjects) if (at < cutoff) recentSubjects.delete(k);
    }
  } catch {
    // As above.
  }
};

/** A socket dropped. `reason` is Socket.IO's disconnect reason. */
export const recordRealtimeDisconnected = (reason: unknown): void => {
  // Socket.IO's reasons are lower-case with spaces ("transport close"). Fold
  // them into the code shape the counter accepts rather than losing them.
  const folded = String(reason ?? 'unknown').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  bump('REALTIME_DISCONNECTED', folded || 'UNKNOWN');
};

/**
 * The unread count a list query returned disagreed with the count recomputed
 * from the messages themselves.
 *
 * This is the signal that says the badge is decoration. It fires at most once
 * per conversation per read, and it is deliberately NOT self-healing: silently
 * correcting the number would hide the fact that two queries over one table
 * disagree, which is the only interesting part.
 */
export const recordUnreadDrift = (delta: number): void =>
  bump('UNREAD_COUNT_DRIFT', delta > 0 ? 'OVERCOUNT' : 'UNDERCOUNT');

// ─── Reporting ────────────────────────────────────────────────────────────────

export interface MessagingSnapshot {
  windowStartedAt: number;
  counts: Record<string, number>;
}

export const snapshot = (): MessagingSnapshot => ({
  windowStartedAt,
  counts: Object.fromEntries(counts),
});

export const reportWindow = (): void => {
  if (!counts.size) return;
  const minutes = Math.round((Date.now() - windowStartedAt) / 60000);
  const body = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `${key}=${n}`)
    .join(' ');
  // eslint-disable-next-line no-console
  console.info(`[messaging-telemetry] window=${minutes}m ${body}`);
};

/**
 * Every code this module can emit, so a test can assert the declared catalog and
 * the implementation name the same things. A signal declared in the policy and
 * never recorded is documentation of a metric that does not exist.
 */
export const EMITTED_SIGNAL_CODES: readonly string[] = Object.freeze([
  'MESSAGE_SEND_FAILED',
  'MESSAGE_DUPLICATE_SUPPRESSED',
  'REALTIME_CONNECTED',
  'REALTIME_DISCONNECTED',
  'REALTIME_RECONNECTED',
  'UNREAD_COUNT_DRIFT',
]);

/** Declared-vs-emitted, computed here so the test cannot restate the list. */
export const undeclaredSignals = (): string[] =>
  EMITTED_SIGNAL_CODES.filter((code) => !MESSAGING_SIGNAL_CODES.includes(code));

/** Test seam. */
export const __resetMessagingTelemetry = (): void => {
  counts = new Map();
  recentSubjects = new Map();
  windowStartedAt = Date.now();
};
