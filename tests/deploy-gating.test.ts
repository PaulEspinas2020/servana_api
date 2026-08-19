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
 * ## The gate MOVED at the origin/main merge, and this file moved with it
 *
 * origin/main 463f963 made release-gate.yml manual-only: the repo's GitHub
 * Actions credit is exhausted and is not being topped up (owner decision,
 * 2026-08-19). The gate job is `runs-on: ubuntu-latest`, so `needs:
 * [release-gate]` in deploy.yml stopped meaning "wait for the gate" and started
 * meaning "never deploy again". The wiring is commented out in deploy.yml, not
 * deleted.
 *
 * These assertions were NOT deleted with it, because an enforcement point that
 * disappears when it becomes inconvenient was never an enforcement point. They
 * were re-pointed at where the gate actually lives now — scripts/hooks/pre-push,
 * which runs the full `npm run verify` before a push to main leaves the machine —
 * and at the restore path, so the Actions wiring cannot be quietly deleted while
 * it is switched off.
 *
 * Two things this can NOT prove, stated rather than implied. The hook is
 * per-clone (`git config core.hooksPath scripts/hooks`), so a fresh clone is
 * ungated until somebody runs that; and any hook is bypassable with
 * `--no-verify`. The Actions gate had neither weakness. This is a weaker gate
 * being honestly labelled, not an equivalent one.
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

import fs from 'fs';
import path from 'path';

import { readWorkflow, jobsOf, needsOf } from '../scripts/lib/workflowFile';

const deploy = readWorkflow('deploy.yml');
const gate = readWorkflow('release-gate.yml');

const deployJobs = jobsOf(deploy);

describe('the reader sees the workflows at all (positive fixture)', () => {
  it('finds both jobs in deploy.yml', () => {
    // Two jobs again since the gate was restored (V2 TAB 03). The reader must
    // still not count a COMMENTED job — that is the property this fixture pins,
    // and the reason it is not just `.size`. It was verified against the
    // suspended state, where the same reader correctly reported one.
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

  /**
   * RESTORED (V2 TAB 03), and the reason is measured rather than preferred.
   *
   * The wiring was suspended on the premise that this repo's Actions credit was
   * exhausted. `servana_api` is a PUBLIC repository, and GitHub's billing
   * documentation states that standard GitHub-hosted runners are free in public
   * repositories. `ubuntu-latest` is a standard runner, so these jobs cost this
   * repository nothing and cannot be starved by credit consumed elsewhere in
   * the account.
   *
   * Self-hosting the gate was the other candidate and was rejected on evidence:
   * the self-hosted runner is the production host at 961 MB of RAM, where
   * `npm run verify` has already died twice with exit 134 against a measured
   * ~1.1 GB peak — and a gate exists to stop bad code REACHING the host, which
   * a gate running on the host cannot do.
   */
  it('the gate is wired as a job again, not left as a comment', () => {
    const gateJob = deployJobs.get('release-gate');
    expect(gateJob).toBeDefined();
    expect(gateJob).toMatch(/uses:\s*\.\/\.github\/workflows\/release-gate\.yml/);
  });

  it('the deploy job DEPENDS on it — the whole point of the TAB', () => {
    expect(needsOf(deployJobs.get('deploy') ?? '')).toContain('release-gate');
  });

  it('the gate runs automatically, not only when somebody remembers', () => {
    // workflow_dispatch alone is a gate nobody runs. `push` is what makes it a
    // gate rather than a report; `workflow_call` is what lets deploy need it.
    expect(gate).toMatch(/^\s*push:\s*$/m);
    expect(gate).toMatch(/^\s*workflow_call:\s*$/m);
  });

  it('the evidence for restoring it is recorded in the file, not just in a commit', () => {
    // A future reader finding an owner decision reversed deserves the reason in
    // the same place as the change.
    expect(gate).toMatch(/PUBLIC repository/);
    expect(gate).toMatch(/standard GitHub-hosted runners is free/);
  });

  it('the gate that replaced it is real, runs verify, and runs it on main', () => {
    const hook = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'hooks', 'pre-push'), 'utf8');
    // Executable, or git silently ignores it and reports nothing.
    // eslint-disable-next-line no-bitwise
    expect(fs.statSync(path.join(__dirname, '..', 'scripts', 'hooks', 'pre-push')).mode & 0o111).not.toBe(0);
    expect(hook).toMatch(/npm run verify/);
    expect(hook).toMatch(/refs\/heads\/main/);
    // verify, not verify:quick, on the branch that deploys. A quick check on
    // the deploying branch is the same class of defect as no check.
    const mainBranch = hook.slice(hook.indexOf('remote_ref_is_main" -eq 1'));
    expect(mainBranch).toMatch(/npm run verify </);
  });

  /**
   * The property that actually matters, stated so it survives a new job being
   * added: anything that touches the production host must be gated. A future
   * job on the self-hosted runner with no `needs:` is the exact defect F-03
   * describes, arriving by a different door.
   */
  it('exactly one job touches the production host, and it is the one the hook gates', () => {
    // The original form of this test asserted every self-hosted job carried a
    // `needs:`. That property is currently false BY DESIGN and asserting it
    // would just stay red, so it is restated rather than dropped: the hook
    // gates a push, and a push gates every self-hosted job in this file. That
    // holds only while there is exactly one such job. A second one — a cron
    // job, a manual maintenance job — would run without a push and so without
    // any gate at all, which is the F-03 defect arriving by a different door.
    const selfHosted = [...deployJobs].filter(([, body]) => /runs-on:.*self-hosted/.test(body));
    expect(selfHosted.map(([name]) => name)).toEqual(['deploy']);
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
