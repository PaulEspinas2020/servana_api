/**
 * Every suite that should run, ran.
 *
 * ## Why a test count is not enough
 *
 * A suite that fails to COMPILE does not fail its assertions — it never runs.
 * Jest reports one failed suite and the headline test count silently drops,
 * so a summary read by test count looks like a smaller green run rather than
 * a guard that stopped guarding. That happened in this repository:
 * `tests/v1-legacy-telemetry.test.ts` referenced an undefined identifier,
 * `npx tsc --noEmit` passed (the project tsconfig excludes `tests/`), and the
 * only visible symptom was 3645 → 3629.
 *
 * Two things close that. `npm run typecheck:tests` compiles the test tree, so
 * the fault is caught before jest runs at all. This file is the second: it
 * pins the INVENTORY, so a suite that is deleted, renamed or newly ignored has
 * to be acknowledged in a diff rather than absorbed into a smaller number.
 *
 * ## What to do when this fails
 *
 * Adding a suite: raise the number. That is the expected, frequent case, and
 * the point is that it appears in the commit that adds it.
 *
 * Losing one: find out why before changing anything. A drop is either a
 * deliberate deletion or a guard that quietly stopped running.
 */

import fs from 'fs';
import path from 'path';

const TESTS = __dirname;

/**
 * Mirrors `jest.config.js`. Kept in sync by the assertions below rather than
 * by hope: the pattern and the ignore list are both read from the config.
 */
const jestConfig = require('../jest.config.js') as {
  testMatch: string[];
  testPathIgnorePatterns: string[];
};

const isIgnored = (file: string): boolean =>
  jestConfig.testPathIgnorePatterns.some((pattern) => new RegExp(pattern).test(file));

const suiteFiles = (): string[] =>
  fs
    .readdirSync(TESTS)
    .filter((f) => /\.test\.(ts|js)$/.test(f))
    .filter((f) => !isIgnored(path.join(TESTS, f)))
    .sort();

/**
 * The number of suites jest is expected to run.
 *
 * Raise it in the same commit that adds a suite. Never lower it without
 * naming, in the commit message, which suite went and why.
 */
const EXPECTED_SUITE_COUNT = 263;

describe('the suite inventory is pinned', () => {
  const files = suiteFiles();

  it(`runs exactly ${EXPECTED_SUITE_COUNT} suites`, () => {
    // The message carries the delta, because "expected 181, got 180" without
    // the names is the start of a search rather than the end of one.
    expect({ count: files.length, files }).toMatchObject({ count: EXPECTED_SUITE_COUNT });
  });

  it('finds suites at all (positive fixture)', () => {
    // A broken pattern would report zero and pass a `<=` style check forever.
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('booking-raw-write-guard.test.ts');
  });

  it('respects the ignore list rather than reimplementing it', () => {
    // The two suites jest is configured to skip must not be counted, and the
    // list must not silently grow.
    expect(jestConfig.testPathIgnorePatterns).toEqual([
      '/node_modules/',
      'admin-dedup\\.test\\.ts$',
      'catalog-service\\.test\\.ts$',
    ]);
    expect(files).not.toContain('admin-dedup.test.ts');
    expect(files).not.toContain('catalog-service.test.ts');
  });

  it('the ignored suites still EXIST — ignoring is not deleting', () => {
    // If one were removed outright, the ignore entry would become a dead
    // pattern that hides nothing and explains nothing.
    for (const name of ['admin-dedup.test.ts', 'catalog-service.test.ts']) {
      expect(fs.existsSync(path.join(TESTS, name))).toBe(true);
    }
  });

  it('support HELPERS are not mistaken for suites', () => {
    // `tests/support/*.ts` are helpers, not suites. jest.config matches only
    // `tests/*.test.ts` — one directory level, `.test` required — so they
    // cannot be counted. Asserted so a future glob widening does not quietly
    // inflate the number.
    //
    // NOT a filename-prefix check: `support-case-policy.test.ts` and
    // `support-case-route-boundary.test.ts` are real suites about support
    // cases, and a naive `startsWith('support')` excluded them. Checking the
    // helper files by name is the thing actually meant.
    expect(jestConfig.testMatch).toEqual(['**/tests/*.test.js', '**/tests/*.test.ts']);
    expect(fs.existsSync(path.join(TESTS, 'support'))).toBe(true);

    for (const helper of fs.readdirSync(path.join(TESTS, 'support'))) {
      expect(files).not.toContain(helper);
      expect(files).not.toContain(`support/${helper}`);
    }
    // And the real support-case suites ARE counted.
    expect(files).toContain('support-case-policy.test.ts');
  });
});

/**
 * The test tree is compiled by an explicit gate, not inferred.
 *
 * `tsconfig.json` sets `rootDir: ./src` and includes only `src/**`, so
 * `npm run typecheck` proves nothing about this directory. These assertions
 * fail if that separate gate is removed or quietly narrowed.
 */
describe('test code has its own typecheck gate', () => {
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  it('tsconfig.tests.json exists and covers tests/', () => {
    const cfg = fs.readFileSync(path.join(root, 'tsconfig.tests.json'), 'utf8');
    expect(cfg).toContain('tests/**/*.ts');
    expect(cfg).toContain('"noEmit": true');
  });

  it('it is a SEPARATE config — tests must not enter the build', () => {
    const prod = JSON.parse(
      fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8').replace(/\/\/[^\n]*/g, ''),
    );
    expect(prod.include).toEqual(['src/**/*.ts']);
    expect(prod.compilerOptions.rootDir).toBe('./src');
  });

  it('npm run verify requires it', () => {
    expect(pkg.scripts['typecheck:tests']).toBe('tsc -p tsconfig.tests.json');
    expect(pkg.scripts.verify).toContain('npm run typecheck:tests');
    expect(pkg.scripts['verify:quick']).toContain('npm run typecheck:tests');
  });
});
