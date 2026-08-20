/**
 * The ratchet on tests that run, pass, and assert NOTHING.
 *
 * ## Why a ratchet and not a rule (TAB 11)
 *
 * A per-test assertion census on 2026-08-19 found 26 of 6,434 backend tests
 * making zero assertions. Reading all 26 was the point: almost none were
 * defects.
 *
 *   - `tests/support/callerMatrix.ts` asserts by THROWING, so a passing check
 *     registers no expect() call and still cannot pass while wrong.
 *   - `catalog-semantic-guards` runs a rule over 11 migrations and returns
 *     early for the 9 that create no objects. That is correct, and the suite
 *     now carries a companion test proving the rule is still reached by one.
 *   - `migration-checksum` skips a CRLF assertion on an LF checkout, and says
 *     so in a comment.
 *
 * So "every test must assert" is the wrong rule: enforced, it would push each
 * of those toward a decorative expect(true).toBe(true) that proves less than
 * the early return did. What is worth catching is a NEW one — a test written
 * today that asserts nothing because its author believed it did.
 *
 * That is a ratchet. The list may SHRINK freely; a name not on it is a red run.
 *
 * ## What this cannot see
 *
 * Whether an assertion is any GOOD. A test can call expect() and still be
 * decoration — this repository has a recorded instance where reverting the fix
 * left the assertion green because the fake over-supplied the row. Counting is
 * not proving. This closes one specific hole: the assertion that is not there
 * at all.
 *
 * Accurate only over a FULL run, which is why it is wired into `test:ci` and
 * not `jest`. A subset run simply sees fewer names, and since only additions
 * fail, a subset can never fail it spuriously.
 *
 * Re-freeze deliberately:  VACUOUS_FREEZE=1 npm run test:ci
 */

const fs = require('fs');
const path = require('path');

const FROZEN = path.join(__dirname, '..', 'tests', 'zero-assertion.frozen.json');
const key = (relPath, fullName) => `${relPath} :: ${fullName}`;

class VacuousRatchet {
  constructor() {
    this._zero = [];
    this._failed = false;
  }

  onTestCaseResult(test, result) {
    // Only PASSING tests matter. A failing test is already reported, and a
    // skipped one never ran to assert anything.
    if (result.status !== 'passed') return;
    if (result.numPassingAsserts > 0) return;
    // Normalise separators BEFORE stripping the root. On Windows `test.path`
    // uses backslashes while `process.cwd() + '/'` appends a forward slash, so
    // this replace silently matched nothing and every key stayed a full
    // absolute path. The frozen list holds relative POSIX keys, so nothing
    // ever aligned: all frozen entries read as 'no longer on the list' and
    // every current one as new. The gate could not pass on Windows at all --
    // which now matters, because with CI off this is where it runs.
    const root = process.cwd().replace(/\\/g, '/');
    const rel = (test.path || '')
      .replace(/\\/g, '/')
      .replace(root + '/', '');
    this._zero.push(key(rel, result.fullName || result.title));
  }

  onRunComplete() {
    const found = [...new Set(this._zero)].sort();

    if (process.env.VACUOUS_FREEZE === '1') {
      fs.writeFileSync(FROZEN, JSON.stringify(found, null, 2) + '\n');
      console.log(`\n[vacuous-ratchet] froze ${found.length} zero-assertion tests.`);
      return;
    }

    if (!fs.existsSync(FROZEN)) {
      console.warn('\n[vacuous-ratchet] no frozen list — run with VACUOUS_FREEZE=1 once.');
      return;
    }

    const frozen = new Set(JSON.parse(fs.readFileSync(FROZEN, 'utf8')));
    const added = found.filter((k) => !frozen.has(k));
    const fixed = [...frozen].filter((k) => !found.includes(k));

    console.log(
      `\n[vacuous-ratchet] ${found.length} zero-assertion tests (frozen ${frozen.size})` +
        `${fixed.length ? `, ${fixed.length} no longer on the list` : ''}.`,
    );

    if (added.length) {
      this._failed = true;
      console.error(
        `\n[vacuous-ratchet] FAIL: ${added.length} test(s) pass without asserting anything:\n` +
          added.map((k) => `  ${k}`).join('\n') +
          '\n\nA test that asserts nothing passes whether the code works or not.\n' +
          'Add the assertion, or — if the test genuinely delegates its check to a\n' +
          'helper that throws, or returns early on a condition that does not hold\n' +
          'here — say so in a comment and re-freeze:\n' +
          '    VACUOUS_FREEZE=1 npm run test:ci',
      );
    }
  }

  /** Jest fails the run when a reporter reports an error. */
  getLastError() {
    if (this._failed) return new Error('[vacuous-ratchet] new zero-assertion test(s)');
    return undefined;
  }
}

module.exports = VacuousRatchet;
