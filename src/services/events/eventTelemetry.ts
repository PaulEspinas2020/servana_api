/**
 * Counters for the event pipeline (§89's sibling for this tab).
 *
 * Same shape as `api/v1/legacyTelemetry` and `messaging/messagingTelemetry`: an
 * in-process window, one summary line per window under a greppable prefix, and a
 * `snapshot()` for tests and ops. The API runs under PM2 on one box, so
 * `pm2 logs | grep event-telemetry` is the tool that already exists.
 *
 * ## What it records, and what it refuses to record
 *
 * Event names, signal codes and counts. No uid, no booking id, no notification
 * body. A log that names who was told what is a log that has to be protected
 * like the notification it describes — and the counts are what an operator can
 * act on anyway: published-minus-dispatched is the backlog, and a backlog is a
 * platform that has quietly stopped reacting to itself.
 */

import { EVENT_SIGNAL_CODES } from './domainEvents';

const WINDOW_MS = 60 * 60 * 1000;

let counts = new Map<string, number>();
let windowStartedAt = Date.now();

const rollWindowIfDue = (): void => {
  if (Date.now() - windowStartedAt < WINDOW_MS) return;
  if (counts.size) reportWindow();
  counts = new Map();
  windowStartedAt = Date.now();
};

/** Low-cardinality, code-shaped, and never free text from a caller. */
const safeQualifier = (value: unknown): string => {
  const raw = String(value ?? '').trim();
  return /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(raw) ? raw : 'UNCLASSIFIED';
};

/**
 * Record one signal.
 *
 * An undeclared code is counted under `UNDECLARED_SIGNAL` rather than dropped or
 * thrown: losing the count would hide a producer nobody knows about, and
 * throwing would let a telemetry typo take down a request path.
 */
export const recordEventSignal = (code: string, qualifier?: unknown): void => {
  try {
    rollWindowIfDue();
    const known = EVENT_SIGNAL_CODES.includes(code);
    const key = known
      ? qualifier === undefined
        ? code
        : `${code}:${safeQualifier(qualifier)}`
      : `UNDECLARED_SIGNAL:${safeQualifier(code)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  } catch {
    // Observability must never take a request down.
  }
};

export interface EventTelemetrySnapshot {
  windowStartedAt: number;
  counts: Record<string, number>;
}

export const snapshot = (): EventTelemetrySnapshot => ({
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
  console.info(`[event-telemetry] window=${minutes}m ${body}`);
};

/**
 * Every code this module is actually asked to record, collected from the call
 * sites rather than restated. `tests/notification-policy.test.ts` compares it
 * with the declared catalog — a signal declared and never emitted is
 * documentation of a metric that does not exist, and one emitted and never
 * declared is a metric nobody knows to look at.
 */
export const EMITTED_SIGNAL_CODES: readonly string[] = Object.freeze([
  'EVENT_PUBLISHED',
  'EVENT_PUBLISH_REJECTED',
  'EVENT_DISPATCHED',
  'EVENT_DISPATCH_FAILED',
  'NOTIFICATION_DEDUPED',
  'PUSH_SUPPRESSED_BY_PREFERENCE',
  'DEVICE_TOKEN_PRUNED',
]);

export const undeclaredSignals = (): string[] =>
  EMITTED_SIGNAL_CODES.filter((code) => !EVENT_SIGNAL_CODES.includes(code));

/** Test seam. */
export const __resetEventTelemetry = (): void => {
  counts = new Map();
  windowStartedAt = Date.now();
};
