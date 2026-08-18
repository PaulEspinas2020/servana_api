/**
 * Peak-heap accounting for the test suite, and the guard that keeps it bounded.
 *
 * ## Why this exists (TAB 01)
 *
 * Deploy run 32114087151 died on the self-hosted runner with exit 134 —
 * SIGABRT, "Ineffective mark-compacts near heap limit", last GC near 476 MB —
 * and 120 commits went undeployed for six days without anyone being told. The
 * suite runs `--runInBand`, so all 276 suites share ONE V8 heap and a single
 * module that never releases its state accumulates across every one of them.
 *
 * The immediate cause was capacity: that host has 961 MB of RAM. The mandate's
 * suggested unblock — `--max-old-space-size=4096` — is NOT applied, and
 * deliberately: a heap ceiling above physical memory converts a clean V8 abort
 * into a kernel OOM-kill, which is strictly harder to diagnose. The suite was
 * moved to a GitHub-hosted runner instead (`release-gate.yml`).
 *
 * What was missing either way is a measurement. This reporter is it:
 *
 *   - it records heap-after-suite for every suite, so "which module leaks" is a
 *     lookup rather than an argument;
 *   - it fails the run when peak heap crosses a share of the configured limit,
 *     so the next 100 MB of growth surfaces as a red test run rather than as a
 *     production stall six days later.
 *
 * ## Reading the numbers
 *
 * `memoryUsage` is heap AFTER each suite, under `--runInBand` — so it is
 * cumulative occupancy, not that suite's own cost. The useful signal is the
 * DELTA column: a suite with a large positive delta added state that survived
 * it. A large absolute value with a small delta is just a late position in the
 * run.
 *
 * Requires `--logHeapUsage`; without it Jest reports no memory and this
 * reporter says so rather than silently passing.
 */

const DEFAULT_THRESHOLD = 0.7;

/** V8's old-space limit for THIS process, in bytes. */
function heapLimitBytes() {
  // Prefer an explicit --max-old-space-size, because that is the number the
  // guard is a percentage OF. Fall back to what V8 actually reports.
  const flag = /--max-old-space-size=(\d+)/.exec(process.env.NODE_OPTIONS || '');
  if (flag) return Number(flag[1]) * 1024 * 1024;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('v8').getHeapStatistics().heap_size_limit;
}

const MB = (bytes) => bytes / 1024 / 1024;

class HeapGuard {
  constructor(globalConfig, options = {}) {
    this._globalConfig = globalConfig;
    this._threshold = Number(
      process.env.SERVANA_HEAP_THRESHOLD ?? options.threshold ?? DEFAULT_THRESHOLD,
    );
    this._rows = [];
    this._previous = 0;
    this._failed = false;
  }

  onTestResult(_test, testResult) {
    // Jest only populates this when --logHeapUsage is passed.
    const used = testResult.memoryUsage;
    if (typeof used !== 'number') return;
    const relative = (testResult.testFilePath || '').replace(process.cwd() + '/', '');
    this._rows.push({ path: relative, used, delta: used - this._previous });
    this._previous = used;
  }

  onRunComplete() {
    if (this._rows.length === 0) {
      console.warn(
        '[heap-guard] no memory readings — run with --logHeapUsage or this guard measures nothing.',
      );
      return;
    }

    const limit = heapLimitBytes();
    const peak = Math.max(...this._rows.map((r) => r.used));
    const ceiling = limit * this._threshold;
    const headroom = ((1 - peak / limit) * 100).toFixed(1);

    const byDelta = [...this._rows].sort((a, b) => b.delta - a.delta).slice(0, 10);
    console.log('\n[heap-guard] top 10 suites by heap retained after the suite ran:');
    for (const row of byDelta) {
      console.log(
        `  ${(MB(row.delta) >= 0 ? '+' : '') + MB(row.delta).toFixed(1)} MB` +
          `  (cumulative ${MB(row.used).toFixed(1)} MB)  ${row.path}`,
      );
    }
    console.log(
      `\n[heap-guard] peak ${MB(peak).toFixed(1)} MB of a ${MB(limit).toFixed(0)} MB limit` +
        ` — ${headroom}% headroom (threshold ${(this._threshold * 100).toFixed(0)}%).`,
    );

    if (peak > ceiling) {
      this._failed = true;
      console.error(
        `\n[heap-guard] FAIL: peak heap ${MB(peak).toFixed(1)} MB exceeds ` +
          `${(this._threshold * 100).toFixed(0)}% of the ${MB(limit).toFixed(0)} MB limit ` +
          `(${MB(ceiling).toFixed(1)} MB).\n` +
          'This is the failure mode that stalled production for six days: the suite grew ' +
          'until it aborted the deploy runner. Release module-level state in afterAll for ' +
          'the suites listed above, or raise the ceiling deliberately — but never above the ' +
          "host's physical memory, which turns a V8 abort into an OOM-kill.",
      );
    }
  }

  /** Jest fails the run when a reporter reports an error. */
  getLastError() {
    if (this._failed) return new Error('[heap-guard] peak heap exceeded its threshold');
    return undefined;
  }
}

module.exports = HeapGuard;
