/**
 * The machine-readable release summary (TAB 01).
 *
 * ## Why a summary needs its own script
 *
 * `npm run verify` already decides whether the tree is releasable. What it does
 * not do is say so in a form a CI job, a dashboard, or a reviewer three weeks
 * later can read: the answer lives in scrollback, and scrollback is where "252
 * suites passed" becomes "the gate was green" without anyone checking which 252.
 *
 * ## What it refuses to do
 *
 * It does not re-implement the gate. Every number here comes from EXECUTING the
 * real commands and reading their output — a summary that computed its own
 * verdict would be a second source of truth about releasability, and the whole
 * point of TAB 01 is that there is exactly one.
 *
 * It also never reports a step it did not run. A step that could not execute is
 * recorded as `not_run` with the reason, never folded into a pass.
 *
 * Run: npm run release:summary
 */

import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'reports');
const OUT_FILE = path.join(OUT_DIR, 'release-summary.json');

type Outcome = 'pass' | 'fail' | 'not_run';

interface StepResult {
  step: string;
  command: string;
  outcome: Outcome;
  durationMs: number;
  /** Present when the step failed or could not run. */
  detail?: string;
  /** Jest's own counts, so a `pass` says what it ran rather than only that it did. */
  suites?: number;
  tests?: number;
}

/**
 * Test classification (TAB 01: "classify integration tests explicitly").
 *
 * The partition is declared rather than inferred, and asserted exhaustive by
 * `tests/release-gate-hermeticity.test.ts` — an unclassified suite is how a
 * credentialed test ends up described as part of a hermetic gate.
 */
export const SUITE_CLASSES = Object.freeze({
  /** Runs anywhere, needs nothing. The gate proper. */
  hermetic: 'no external dependency; runs on a clean checkout',
  /** Needs a disposable PostgreSQL. Skips loudly, never silently. */
  database_rehearsal: 'needs a disposable PostgreSQL; reports BLOCKED, never PASS',
  /** Needs real credentials. Never part of the gate. */
  credentialed_smoke: 'needs production-shaped credentials; run deliberately',
});

/** Suites that are NOT hermetic, with the class they belong to. */
export const NON_HERMETIC: Readonly<Record<string, keyof typeof SUITE_CLASSES>> =
  Object.freeze({
    'booking-postgres-races.test.ts': 'database_rehearsal',
  });

/**
 * Every step runs as `node <entrypoint>`, never through npm.
 *
 * Two Windows constraints meet here and only this satisfies both. Spawning
 * `npm.cmd` without a shell throws `EINVAL` — Node stopped allowing it in the
 * fix for CVE-2024-27980 — and spawning it WITH a shell concatenates arguments
 * instead of escaping them, which is the injection vector DEP0190 warns about.
 *
 * Resolving the JS entrypoints directly sidesteps both, and has the better
 * property anyway: it is the same command on every platform, so what CI runs and
 * what a developer runs cannot drift.
 */
const NODE = process.execPath;

const ENTRYPOINTS = {
  tsc: path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
  jest: path.join(REPO_ROOT, 'node_modules', 'jest', 'bin', 'jest.js'),
  guard: path.join(REPO_ROOT, 'scripts', 'guard-protected-contracts.mjs'),
} as const;

/** Jest's own summary lines, so a `pass` carries what it actually ran. */
const parseCounts = (output: string): { suites?: number; tests?: number } => {
  const suites = /Test Suites:.*?(\d+) total/.exec(output);
  const tests = /Tests:.*?(\d+) total/.exec(output);
  return {
    suites: suites ? Number(suites[1]) : undefined,
    tests: tests ? Number(tests[1]) : undefined,
  };
};

const run = (step: string, args: string[]): StepResult => {
  const started = Date.now();
  const command = `node ${args.map((a) => path.relative(REPO_ROOT, a) || a).join(' ')}`;
  /**
   * `spawnSync`, not `execFileSync`.
   *
   * Jest prints its summary to STDERR, and `execFileSync` returns only stdout
   * on success — so a PASSING gate reported no counts at all. A "pass" with
   * nothing behind it is precisely what this file exists to stop producing.
   */
  const result = spawnSync(NODE, args, { cwd: REPO_ROOT, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();

  if (result.error) {
    // Could not execute at all — never folded into a pass or a fail.
    return {
      step,
      command,
      outcome: 'not_run',
      durationMs: Date.now() - started,
      detail: result.error.message,
    };
  }

  return {
    step,
    command,
    outcome: result.status === 0 ? 'pass' : 'fail',
    durationMs: Date.now() - started,
    ...parseCounts(output),
    // Last lines only: the whole log belongs in the retained artifact.
    ...(result.status === 0 ? {} : { detail: output.split('\n').slice(-12).join('\n') }),
  };
};

const gitValue = (args: string[]): string | null => {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, stdio: 'pipe' }).toString().trim();
  } catch {
    return null;
  }
};

const main = (): void => {
  const steps: StepResult[] = [
    run('typecheck', [ENTRYPOINTS.tsc, '--noEmit']),
    run('typecheck:tests', [ENTRYPOINTS.tsc, '-p', 'tsconfig.tests.json']),
    run('guard:protected-contracts', [ENTRYPOINTS.guard]),
    run('tests', [ENTRYPOINTS.jest, '--runInBand', '--ci']),
  ];

  // Counted from the inventory the suite already pins, not re-derived here.
  const testsDir = path.join(REPO_ROOT, 'tests');
  // Mirrors jest.config's ignore list, so the classification counts what
  // actually RUNS. Counting the ignored suites made hermetic read 256 when the
  // gate executes 255.
  const jestConfig = require(path.join(REPO_ROOT, 'jest.config.js')) as {
    testPathIgnorePatterns: string[];
  };
  const ignored = (file: string): boolean =>
    jestConfig.testPathIgnorePatterns.some((pattern) =>
      new RegExp(pattern).test(path.join(testsDir, file)),
    );

  const suites = fs
    .readdirSync(testsDir)
    .filter((f) => /\.test\.(ts|js)$/.test(f))
    .filter((f) => !ignored(f))
    .sort();

  const classified = suites.map((file) => ({
    suite: file,
    class: NON_HERMETIC[file] ?? ('hermetic' as const),
  }));

  const failed = steps.filter((s) => s.outcome === 'fail');

  const summary = {
    schema: 'servana.release-summary/1',
    generatedAt: new Date().toISOString(),
    git: {
      branch: gitValue(['rev-parse', '--abbrev-ref', 'HEAD']),
      commit: gitValue(['rev-parse', 'HEAD']),
      // A dirty tree means the summary describes something not committed.
      clean: gitValue(['status', '--porcelain']) === '',
    },
    verdict: failed.length === 0 ? 'RELEASABLE' : 'BLOCKED',
    steps,
    suites: {
      total: suites.length,
      byClass: {
        hermetic: classified.filter((c) => c.class === 'hermetic').length,
        database_rehearsal: classified.filter((c) => c.class === 'database_rehearsal').length,
        credentialed_smoke: classified.filter((c) => c.class === 'credentialed_smoke').length,
      },
      nonHermetic: classified.filter((c) => c.class !== 'hermetic'),
    },
    classes: SUITE_CLASSES,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  for (const step of steps) {
    const mark = step.outcome === 'pass' ? 'pass' : step.outcome === 'fail' ? 'FAIL' : 'not run';
    // eslint-disable-next-line no-console
    const counts = step.tests ? `  ${step.suites} suites, ${step.tests} tests` : '';
    console.log(`  ${mark.padEnd(8)} ${step.step.padEnd(26)} ${(step.durationMs / 1000).toFixed(1)}s${counts}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\n  VERDICT: ${summary.verdict}`);
  // eslint-disable-next-line no-console
  console.log(`  written: ${path.relative(REPO_ROOT, OUT_FILE)}`);

  if (!summary.git.clean) {
    // eslint-disable-next-line no-console
    console.log('  NOTE: working tree is dirty — this summary describes uncommitted code.');
  }

  process.exitCode = failed.length === 0 ? 0 : 1;
};

if (require.main === module) main();
