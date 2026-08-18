/**
 * A workflow that cannot start is a gate that does not exist (TAB 04, F-05).
 *
 * ## The defect
 *
 * `.github/workflows/fresh-db.yml` guarded its `fresh` job with
 *
 *     if: hashFiles('scripts/baseline/000-baseline.sql') != ''
 *
 * `hashFiles` is not available in a job-level `if`. GitHub's context reference
 * lists `jobs.<job_id>.if` as accepting the functions `always`, `cancelled`,
 * `success` and `failure`; `hashFiles` appears only under
 * `jobs.<job_id>.steps.if`, because it hashes files in the runner workspace and
 * no workspace exists when job conditions are evaluated.
 *
 * An unrecognised function in a job condition fails the workflow at PARSE time,
 * before a runner is assigned. GitHub reports "This run likely failed because of
 * a workflow file issue", 0s duration, **no log** — there is no log because
 * nothing started.
 *
 * ## Why this is worse than an ordinary red build
 *
 * The three jobs in that workflow are the zero-to-current database guarantee.
 * `fresh` in particular is the only one that can catch an ownership defect —
 * PGlite runs as a single bundled superuser, so role separation is invisible to
 * the embedded job — and ownership is exactly the defect that once left 29 of
 * 116 production tables unusable by the application.
 *
 * So the workflow was not failing loudly. It was absent, while appearing in the
 * checks list. Two migrations reached production in the meantime.
 *
 * ## Why the assertion is over ALL workflows
 *
 * Fixing the one line closes the instance. A test that reads every workflow
 * closes the class: the next job-level condition that reaches for a step-only
 * function fails here, locally, in seconds — instead of silently producing runs
 * nobody can read.
 */

import {
  workflowFiles,
  readWorkflow,
  jobsOf,
  jobLevelIf,
  startupFaults,
  STEP_ONLY_FUNCTIONS,
} from '../scripts/lib/workflowFile';

describe('the reader sees the workflows (positive fixture)', () => {
  it('finds every workflow file', () => {
    expect(workflowFiles()).toEqual(
      expect.arrayContaining(['deploy.yml', 'fresh-db.yml', 'release-gate.yml']),
    );
  });

  it('finds the three jobs of the fresh-db workflow', () => {
    expect([...jobsOf(readWorkflow('fresh-db.yml')).keys()]).toEqual([
      'static',
      'embedded',
      'fresh',
    ]);
  });

  it('reads a job-level if at the job key indentation', () => {
    expect(jobLevelIf('    if: success()\n    runs-on: x\n')).toBe('success()');
  });

  it('does NOT mistake a step-level if for a job-level one', () => {
    // This is the distinction that keeps the gate from banning a legitimate
    // `hashFiles` in a cache step.
    const body = '    runs-on: x\n    steps:\n      - name: a\n        if: hashFiles(\'x\') != \'\'\n';
    expect(jobLevelIf(body)).toBeNull();
  });

  it('ignores a condition that is only present in a comment', () => {
    expect(jobLevelIf("    # if: hashFiles('x') != ''\n    runs-on: x\n")).toBeNull();
  });
});

describe('no workflow can fail at startup', () => {
  it('no job-level condition uses a step-only function', () => {
    const faults = startupFaults().map(
      (f) => `${f.file} job "${f.job}" uses ${f.fn}() in a job-level if: ${f.condition}`,
    );
    expect(faults).toEqual([]);
  });

  it('the fresh job in particular has no job-level condition at all', () => {
    // It was skipped pending a baseline. The baseline is now the declared
    // schema authority, so the condition is obsolete as well as invalid —
    // reintroducing it as a step guard would restore the skipping.
    const fresh = jobsOf(readWorkflow('fresh-db.yml')).get('fresh');
    expect(fresh).toBeDefined();
    expect(jobLevelIf(fresh as string)).toBeNull();
  });

  it('names hashFiles as step-only, so the rule is stated not implied', () => {
    expect(STEP_ONLY_FUNCTIONS).toContain('hashFiles');
  });
});

describe('the detector would notice the defect returning (positive control)', () => {
  it('flags a job-level hashFiles condition', () => {
    // Reproduces the exact line that stopped fresh-db.yml from ever running.
    // Asserted against the real detector so weakening it fails here.
    const body =
      "    name: zero-to-current on a real engine\n" +
      "    runs-on: ubuntu-latest\n" +
      "    if: hashFiles('scripts/baseline/000-baseline.sql') != ''\n";
    const condition = jobLevelIf(body);
    expect(condition).toBe("hashFiles('scripts/baseline/000-baseline.sql') != ''");
    expect(
      STEP_ONLY_FUNCTIONS.some((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(condition as string)),
    ).toBe(true);
  });
});
