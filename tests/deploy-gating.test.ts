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
  it('finds the deploy job in deploy.yml', () => {
    // One job: the `release-gate` job is commented out while the account is out
    // of Actions credit. The reader must not count a commented job — that is
    // the property this fixture pins, and it is why this is not just `.size`.
    //
    // Worth knowing: this reader has now been validated in BOTH directions.
    // It reported two jobs when the wiring was briefly restored and reports one
    // now that it is commented again. A parser that counted commented jobs
    // would have been wrong in exactly one of those states, and right by
    // accident in the other.
    expect([...deployJobs.keys()].sort()).toEqual(['deploy']);
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
  it('the active release-gate.yml starts no billed run', () => {
    // It is manual-only at the tip. The callable trigger lives on the parked
    // copy and is asserted there.
    const head = gate.slice(0, gate.indexOf('jobs:'));
    expect(head).not.toMatch(/^\s{2}push:\s*$/m);
  });

  /**
   * The wiring is SUSPENDED and the finished files are HELD BACK — two separate
   * decisions, both deliberate, and this suite now guards the second.
   *
   * Suspended: the owner confirmed the account is out of Actions credit
   * ("WE RAN OUT OF CREDIT ACTIONS SO DON'T PUSH WITH CI FROM NOW ON"), so
   * `release-gate.yml` is manual-only. An earlier commit argued from GitHub's
   * public pricing docs that a public repo's standard runners are free and
   * restored it; that argument was accurate and still wrong, because a public
   * fact about pricing cannot settle a private fact about an account's state.
   *
   * Held back: the push credential lacks `workflow` scope, and GitHub checks the
   * resulting tree rather than intermediate commits — so the three workflow
   * files must match origin/main at the tip or 58 commits cannot land. The
   * finished versions live in `docs/pending-workflow/` with a restore command.
   *
   * These assertions therefore moved with the files. Asserting probes in
   * `.github/workflows/deploy.yml` would now fail for a reason that is not a
   * defect, and deleting them would let the held-back work rot unnoticed —
   * which is the actual risk when finished code is parked outside the build.
   */
  it('the active deploy.yml matches origin — that is what lets a push land', () => {
    // The tip must equal origin/main for these three files or the credential's
    // missing `workflow` scope strands every other commit. So the active file is
    // deliberately plain: no gate job, no probes, no reasoning. All of that is
    // in docs/pending-workflow/ and asserted below.
    expect(deployJobs.has('deploy')).toBe(true);
    expect(deployJobs.has('release-gate')).toBe(false);
  });

  it('the deploy job is NOT gated by an Actions job that cannot run', () => {
    // A `needs:` on a GitHub-hosted job with no credit does not delay the
    // deploy, it cancels it.
    expect(needsOf(deployJobs.get('deploy') ?? '')).toEqual([]);
  });

  it('NO workflow consumes GitHub-hosted minutes on a push to main', () => {
    // The operative rule. deploy.yml is self-hosted and free; every
    // ubuntu-latest workflow must be manual-only. Asserted as a PROPERTY, so a
    // new ubuntu-latest workflow with a push trigger fails on the commit that
    // adds it rather than on the invoice.
    const dir = path.join(__dirname, '..', '.github', 'workflows');
    const offenders: string[] = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      const head = text.slice(0, text.indexOf('jobs:'));
      if (/^\s{2}push:\s*$/m.test(head) && /^\s*runs-on:\s*ubuntu-latest\s*$/m.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  describe('the held-back workflow work is preserved, not lost', () => {
    const pending = path.join(__dirname, '..', 'docs', 'pending-workflow');

    it('all three files are parked with a restore note', () => {
      for (const f of ['deploy.yml', 'release-gate.yml', 'fresh-db.yml', 'README.md']) {
        expect(fs.existsSync(path.join(pending, f))).toBe(true);
      }
    });

    /**
     * The whole reason this suite still exists. Parked code is code nobody runs
     * and nobody reads, so the assertions that used to protect it now protect
     * the parked copy — otherwise the post-deploy probe and the rollback could
     * be edited away and every gate would stay green.
     */
    it('the parked deploy.yml still carries the post-deploy probe and rollback', () => {
      const parked = fs.readFileSync(path.join(pending, 'deploy.yml'), 'utf8');
      expect(parked).toMatch(/zzz-nonexistent-path/);   // routing precedes auth
      expect(parked).toMatch(/127\.0\.0\.1/);            // probe the host, not the CDN
      expect(parked).toMatch(/BUILD_INFO\.json/);        // running commit, not a /version endpoint
      expect(parked).toMatch(/Roll back to the previous build/);
      expect(parked).toMatch(/Snapshot the running build/);
      expect(parked).toMatch(/environment:\s*production/);
    });

    it('the parked release-gate.yml keeps the callable trigger and the summary fallback', () => {
      const parked = fs.readFileSync(path.join(pending, 'release-gate.yml'), 'utf8');
      expect(parked).toMatch(/workflow_call:/);
      expect(parked).toMatch(/Summary fallback/);
    });

    it('the README says how to restore it', () => {
      const readme = fs.readFileSync(path.join(pending, 'README.md'), 'utf8');
      expect(readme.length).toBeGreaterThan(200);
      expect(readme).toMatch(/cp|restore/i);
    });
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


});

