/**
 * The release gate actually gates the release (TAB 03, F-03).
 *
 * ## What went wrong
 *
 * `deploy.yml` and `release-gate.yml` both triggered on `push: main` as
 * INDEPENDENT workflows. Two workflows on one trigger run in parallel and can
 * never express a dependency between them, so on commit d4b0150 the gate failed
 * (run 32119165094) and the deploy succeeded (run 32119165101). The red gate
 * shipped to production and nothing in the pipeline objected.
 *
 * The gate's own failure was trivial — `reports/release-summary.json` was never
 * written, so `upload-artifact` with `if-no-files-found: error` failed the job.
 * That triviality is the danger, not a mitigation: a gate that fails for
 * cosmetic reasons trains everybody to ignore it, and then it fails for a real
 * reason and is ignored too.
 *
 * ## Why this test exists when the book asks for a demonstration
 *
 * The book's gate is "push a commit with a failing test, observe deploy
 * SKIPPED". That is the right proof and it cannot be produced here: this
 * repository is worked on without push or deploy authorisation, and a push to
 * `main` IS the production deploy. It is queued as manual task 03.1.
 *
 * What CAN be proven locally is the structural property the demonstration would
 * exercise — that the dependency exists in the file at all. A demonstration
 * proves it worked once; this proves it has not been quietly removed since,
 * which is the failure mode that actually recurs. They are complements, and
 * neither replaces the other.
 *
 * ## Why it does not use a YAML parser
 *
 * `js-yaml` is present only as a transitive dependency. A gate whose own
 * correctness rests on an undeclared package is a gate with a silent expiry
 * date. The reader lives in `scripts/lib/workflowFile.ts` — shared with
 * `tests/workflow-startup-validity.test.ts` (TAB 04) rather than written twice,
 * because two readers of one file format is the duplicate reality §9 is about.
 * It is deliberately not a general YAML parser, in the same spirit as
 * `scripts/lib/routeTable.ts`.
 */

import { readWorkflow, jobsOf, needsOf } from '../scripts/lib/workflowFile';

const deploy = readWorkflow('deploy.yml');
const gate = readWorkflow('release-gate.yml');

const deployJobs = jobsOf(deploy);

describe('the reader sees the workflows at all (positive fixture)', () => {
  it('finds both jobs in deploy.yml', () => {
    expect([...deployJobs.keys()].sort()).toEqual(['deploy', 'release-gate']);
  });

  it('parses an inline needs list', () => {
    expect(needsOf('    needs: [release-gate]\n')).toEqual(['release-gate']);
  });

  it('parses a block needs list', () => {
    expect(needsOf('    needs:\n      - a\n      - b\n')).toEqual(['a', 'b']);
  });

  it('ignores a needs that is only mentioned in a comment', () => {
    expect(needsOf('    # needs: [release-gate]\n    runs-on: x\n')).toEqual([]);
  });
});

describe('the deploy cannot run ahead of its gate', () => {
  it('release-gate.yml is callable as a reusable workflow', () => {
    expect(gate).toMatch(/^\s*workflow_call:\s*$/m);
  });

  it('deploy.yml calls the gate as a job rather than hoping it ran', () => {
    const gateJob = deployJobs.get('release-gate');
    expect(gateJob).toBeDefined();
    expect(gateJob).toMatch(/uses:\s*\.\/\.github\/workflows\/release-gate\.yml/);
  });

  it('the deploy job DEPENDS on that gate job', () => {
    expect(needsOf(deployJobs.get('deploy') ?? '')).toContain('release-gate');
  });

  /**
   * The property that actually matters, stated so it survives a new job being
   * added: anything that touches the production host must be gated. A future
   * job on the self-hosted runner with no `needs:` is the exact defect F-03
   * describes, arriving by a different door.
   */
  it('every job that runs on the production host is gated', () => {
    const ungated: string[] = [];
    for (const [name, body] of deployJobs) {
      if (!/runs-on:.*self-hosted/.test(body)) continue;
      if (needsOf(body).length === 0) ungated.push(name);
    }
    expect(ungated).toEqual([]);
  });

  it('the deploy is bound to a named environment, so it produces a record', () => {
    expect(deployJobs.get('deploy')).toMatch(/^\s*environment:\s*production\s*$/m);
  });
});

describe('the gate fails only for reasons that matter', () => {
  it('a summary always exists before the artifact step demands one', () => {
    const fallbackAt = gate.indexOf('Summary fallback');
    const uploadAt = gate.indexOf('Retain the summary');
    expect(fallbackAt).toBeGreaterThan(-1);
    expect(uploadAt).toBeGreaterThan(-1);
    // Ordering is the whole point: a fallback after the upload guarantees
    // nothing.
    expect(fallbackAt).toBeLessThan(uploadAt);
  });

  it('the fallback runs even when an earlier step failed', () => {
    const block = gate.slice(gate.indexOf('Summary fallback'), gate.indexOf('Retain the summary'));
    expect(block).toMatch(/if:\s*always\(\)/);
  });
});

describe('a deploy proves itself before it is called a success', () => {
  const deployBody = deployJobs.get('deploy') ?? '';

  it('probes liveness, v1, auth and an unknown path', () => {
    expect(deployBody).toMatch(/\/healthz/);
    expect(deployBody).toMatch(/\/api\/v1\/catalog/);
    expect(deployBody).toMatch(/\/api\/v1\/bookings/);
    // The assertion that caught the real incident: a 404 proves the ROUTER
    // answered, where a blanket 401 proved auth ran before routing.
    expect(deployBody).toMatch(/zzz-nonexistent-path/);
  });

  it('probes the host locally, never the public origin', () => {
    // A probe through the CDN or proxy tests DNS and nginx, not the process
    // this job just restarted.
    expect(deployBody).toMatch(/127\.0\.0\.1/);
    expect(deployBody).not.toMatch(/https:\/\/api\.servana\.com\.ph/);
  });

  it('asserts the running build is the commit this run built', () => {
    expect(deployBody).toMatch(/BUILD_INFO\.json/);
    expect(deployBody).toMatch(/GITHUB_SHA/);
  });

  it('rolls back only when the probe failed', () => {
    expect(deployBody).toMatch(/if:\s*failure\(\)\s*&&\s*steps\.probe\.outcome\s*==\s*'failure'/);
  });

  it('snapshots the running build BEFORE the build overwrites it', () => {
    const snapshotAt = deployBody.indexOf('Snapshot the running build');
    const buildAt = deployBody.indexOf('name: Build');
    expect(snapshotAt).toBeGreaterThan(-1);
    expect(buildAt).toBeGreaterThan(-1);
    expect(snapshotAt).toBeLessThan(buildAt);
  });

  it('a rollback still fails the run, because a recovered incident is not a success', () => {
    const rollback = deployBody.slice(deployBody.indexOf('Roll back to the previous build'));
    expect(rollback).toMatch(/exit 1/);
  });
});
