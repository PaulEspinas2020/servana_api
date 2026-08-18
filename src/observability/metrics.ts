/**
 * An in-process metric registry for the §142 signals.
 *
 * ## Why in-process rather than a Prometheus client
 *
 * The API runs under PM2 on a single box. Adding `prom-client` would mean a new
 * dependency, a scrape endpoint that needs a contract entry and a permission,
 * and a Prometheus to scrape it — none of which exists. This keeps the counters
 * in memory and prints them on a window, exactly as `legacyTelemetry` already
 * does, so `pm2 logs servana-prod | grep servana-metrics` is the tool and it is
 * one the team already has.
 *
 * `snapshot()` returns the whole registry as data, which is what the tests read
 * and what a future exporter would serialize. Swapping the transport later
 * touches this file and nothing else.
 *
 * ## Never throws
 *
 * Every entry point is wrapped. This is called from the request path of five
 * live clients, and a metrics bug must be a missing number rather than a 500.
 */

import {
  LATENCY_BUCKETS_MS,
  METRICS,
  METRIC_NAMES,
  type MetricSpec,
} from './observabilityPolicy';

type Labels = Record<string, string>;

const SPEC = new Map<string, MetricSpec>(METRICS.map((m) => [m.name, m]));

/** Bounded, so a mislabelled metric cannot exhaust memory before anybody notices. */
const MAX_SERIES_PER_METRIC = 2000;

interface CounterSeries { labels: Labels; value: number }
interface HistogramSeries {
  labels: Labels;
  count: number;
  sum: number;
  /** Bucket index → count. Cumulative is computed at read time. */
  buckets: number[];
}

const counters = new Map<string, Map<string, CounterSeries>>();
const histograms = new Map<string, Map<string, HistogramSeries>>();

let windowStartedAt = Date.now();
let droppedSeries = 0;

const keyOf = (labels: Labels): string =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');

/**
 * Keep only the labels the metric declares, and bound each value.
 *
 * An undeclared label is dropped rather than recorded: labels are the
 * cardinality surface, and a caller that passes a booking id as a label would
 * otherwise create one series per booking.
 */
const cleanLabels = (spec: MetricSpec, labels: Labels): Labels => {
  const out: Labels = {};
  for (const name of spec.labels) {
    const value = labels[name];
    out[name] = value === undefined || value === null || value === ''
      ? 'unknown'
      : String(value).slice(0, 120);
  }
  return out;
};

export const incr = (name: string, labels: Labels = {}, by = 1): void => {
  try {
    const spec = SPEC.get(name);
    if (!spec || spec.kind !== 'counter') return;
    const series = counters.get(name) ?? new Map<string, CounterSeries>();
    const clean = cleanLabels(spec, labels);
    const key = keyOf(clean);
    const existing = series.get(key);
    if (existing) {
      existing.value += by;
    } else {
      if (series.size >= MAX_SERIES_PER_METRIC) { droppedSeries += 1; return; }
      series.set(key, { labels: clean, value: by });
    }
    counters.set(name, series);
  } catch {
    // Observability must never take the request down.
  }
};

export const observe = (name: string, value: number, labels: Labels = {}): void => {
  try {
    const spec = SPEC.get(name);
    if (!spec || spec.kind !== 'histogram') return;
    if (!Number.isFinite(value) || value < 0) return;
    const series = histograms.get(name) ?? new Map<string, HistogramSeries>();
    const clean = cleanLabels(spec, labels);
    const key = keyOf(clean);
    let entry = series.get(key);
    if (!entry) {
      if (series.size >= MAX_SERIES_PER_METRIC) { droppedSeries += 1; return; }
      entry = { labels: clean, count: 0, sum: 0, buckets: LATENCY_BUCKETS_MS.map(() => 0) };
      series.set(key, entry);
    }
    entry.count += 1;
    entry.sum += value;
    for (let i = 0; i < LATENCY_BUCKETS_MS.length; i += 1) {
      if (value <= LATENCY_BUCKETS_MS[i]) { entry.buckets[i] += 1; break; }
    }
    histograms.set(name, series);
  } catch {
    // As above.
  }
};

// ─── Reading ──────────────────────────────────────────────────────────────────

export interface QuantileSummary {
  count: number;
  /** Bucket UPPER BOUNDS, so a reader cannot mistake these for exact values. */
  p50: number | null;
  p95: number | null;
  p99: number | null;
  meanMs: number | null;
}

/**
 * Quantiles from bucket counts.
 *
 * These are bucket upper bounds, not interpolated values, and the field names
 * say `p95` rather than `p95Exact` for that reason. A histogram cannot tell you
 * the true 95th percentile; it can tell you which bucket it falls in, and
 * pretending otherwise gives an incident a number that is precise and wrong.
 */
export const quantiles = (entry: HistogramSeries): QuantileSummary => {
  const at = (fraction: number): number | null => {
    if (!entry.count) return null;
    const target = entry.count * fraction;
    let seen = 0;
    for (let i = 0; i < LATENCY_BUCKETS_MS.length; i += 1) {
      seen += entry.buckets[i];
      if (seen >= target) return LATENCY_BUCKETS_MS[i];
    }
    return LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1];
  };
  return {
    count: entry.count,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    meanMs: entry.count ? Math.round((entry.sum / entry.count) * 10) / 10 : null,
  };
};

export interface MetricsSnapshot {
  windowStartedAt: number;
  windowMs: number;
  droppedSeries: number;
  counters: Array<{ name: string; labels: Labels; value: number }>;
  histograms: Array<{ name: string; labels: Labels } & QuantileSummary>;
}

export const snapshot = (): MetricsSnapshot => ({
  windowStartedAt,
  windowMs: Date.now() - windowStartedAt,
  droppedSeries,
  counters: [...counters.entries()].flatMap(([name, series]) =>
    [...series.values()].map((s) => ({ name, labels: s.labels, value: s.value })),
  ),
  histograms: [...histograms.entries()].flatMap(([name, series]) =>
    [...series.values()].map((s) => ({ name, labels: s.labels, ...quantiles(s) })),
  ),
});

/** One line per series. Deliberately a log line — see the module docblock. */
export const report = (): void => {
  const snap = snapshot();
  for (const counter of snap.counters) {
    // eslint-disable-next-line no-console
    console.info(
      `[servana-metrics] ${counter.name} ${keyOf(counter.labels)} value=${counter.value} window=${Math.round(snap.windowMs / 1000)}s`,
    );
  }
  for (const histogram of snap.histograms) {
    // eslint-disable-next-line no-console
    console.info(
      `[servana-metrics] ${histogram.name} ${keyOf(histogram.labels)} ` +
        `count=${histogram.count} p50=${histogram.p50} p95=${histogram.p95} p99=${histogram.p99} mean=${histogram.meanMs}`,
    );
  }
  if (snap.droppedSeries) {
    // eslint-disable-next-line no-console
    console.warn(`[servana-metrics] dropped ${snap.droppedSeries} series over the cardinality ceiling`);
  }
};

export const resetMetrics = (): void => {
  counters.clear();
  histograms.clear();
  droppedSeries = 0;
  windowStartedAt = Date.now();
};

/** Names the registry knows. A typo'd metric name is a silent no-op otherwise. */
export const knownMetrics = (): readonly string[] => METRIC_NAMES;
