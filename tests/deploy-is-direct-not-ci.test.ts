/**
 * Deployment is direct, and there is no CI. Both halves are asserted here.
 *
 * ## What changed, and why this file replaces two others
 *
 * `tests/deploy-gating.test.ts` and `tests/workflow-startup-validity.test.ts`
 * existed to police `.github/workflows/*.yml` — that a red gate could not ship
 * (F-03), that a job-level `hashFiles()` did not silently abort every run
 * (F-05). Both defects are properties of a file that no longer exists: this
 * platform does not use GitHub Actions on any repository, and Actions credit is
 * not being topped up. Tests that read a deleted file are not a gate, so they
 * were deleted with it.
 *
 * What must NOT be lost is the part that was never about CI: something has to
 * stop bad code reaching production, and something has to describe the deploy.
 * Those are `scripts/hooks/pre-push` and `scripts/deploy-prod.sh`, and this
 * file asserts both, plus the rule itself.
 *
 * ## Why the absence of CI is asserted rather than trusted
 *
 * "We do not use CI any more" is a note, and a note is what the last three
 * defects in this area were made of. A single `.github/workflows/ci.yml` added
 * by habit — or restored by a merge from a stale branch — reinstates the
 * billing and the second definition of "releasable" in one commit, with nothing
 * to say so. Asserted from git's index, which is what actually travels.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');

const read = (...parts: string[]): string =>
  fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');

/** git's index, not the filesystem — see the exec-bit note below. */
const tracked = (): string[] =>
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

const indexMode = (file: string): string =>
  execFileSync('git', ['ls-files', '-s', file], { cwd: ROOT, encoding: 'utf8' }).slice(0, 6);

describe('this repository has no CI, and cannot quietly regrow it', () => {
  it('no workflow file is tracked, anywhere in the tree', () => {
    const workflows = tracked().filter((f) => /(^|\/)\.github\/workflows\/.+\.(yml|yaml)$/.test(f));
    expect(workflows).toEqual([]);
  });

  it('no .github/workflows directory exists on disk either', () => {
    expect(fs.existsSync(path.join(ROOT, '.github', 'workflows'))).toBe(false);
  });

  /**
   * The parked copies under `docs/pending-workflow/` were the same thing with a
   * different extension — a workflow waiting for a credential, plus a README
   * explaining how to land it. Restoring them is the same regression.
   */
  it('no parked workflow is waiting to be restored', () => {
    expect(fs.existsSync(path.join(ROOT, 'docs', 'pending-workflow'))).toBe(false);
  });
});

describe('the pre-push hook is the gate, because nothing else is', () => {
  const hook = read('scripts', 'hooks', 'pre-push');

  it('is executable in the index, which is what travels with the clone', () => {
    /*
     * Asserted against git's INDEX rather than the filesystem. NTFS carries no
     * POSIX exec bit, so `statSync().mode & 0o111` is 0 on Windows for a file
     * git considers executable — the filesystem form of this assertion could
     * never pass on a Windows dev machine while passing on Linux. With CI gone
     * that machine IS the gate, and a gate that cannot pass where it runs is
     * not a gate.
     */
    expect(indexMode('scripts/hooks/pre-push')).toBe('100755');
  });

  it('runs the FULL verify on the branch that ships', () => {
    expect(hook).toMatch(/npm run verify/);
    expect(hook).toMatch(/refs\/heads\/main/);
    // verify, not verify:quick, on the deploying branch. A quick check there is
    // the same class of defect as no check.
    const mainBranch = hook.slice(hook.indexOf('remote_ref_is_main" -eq 1'));
    expect(mainBranch).toMatch(/npm run verify </);
  });
});

describe('the deploy is a script an operator runs, and its order is load-bearing', () => {
  const deploy = read('scripts', 'deploy-prod.sh');
  const at = (needle: string): number => {
    const i = deploy.indexOf(needle);
    expect(i).toBeGreaterThan(-1);
    return i;
  };

  it('is executable in the index', () => {
    expect(indexMode('scripts/deploy-prod.sh')).toBe('100755');
  });

  it('builds BEFORE it migrates, and migrates BEFORE it restarts', () => {
    /*
     * This ordering is the whole reason the step positions were argued over. It
     * used to be the reverse: migrations ran before Node was even installed, so
     * schema changes reached the production database before the code that needs
     * them had been compiled. A failed build then left production running old
     * code against a migrated schema, and nothing said so.
     *
     * A failing check touches nothing; a failing migration stops short of the
     * restart, so the old code keeps serving.
     */
    expect(at('npm run build')).toBeLessThan(at('npm run migrations:plan'));
    expect(at('npm run migrations:plan')).toBeLessThan(at('npm run migrations:apply'));
    expect(at('npm run migrations:apply')).toBeLessThan(at('$PM2 start'));
  });

  it('proves the build serves before retaining it as the rollback target', () => {
    /*
     * `snapshot-build.sh` must run only after the probe accepted the build.
     * Retaining one the probe rejected would make the NEXT rollback restore the
     * very build this deploy just rolled back from, and it would look like a
     * recovery.
     */
    expect(at('post-deploy-readiness.sh')).toBeLessThan(at('snapshot-build.sh'));
    expect(at('rollback.sh')).toBeLessThan(at('snapshot-build.sh'));
  });

  it('rolls back when the probe fails, and still reports failure', () => {
    const afterProbe = deploy.slice(at('PROBE_OK'));
    expect(afterProbe).toMatch(/rollback\.sh/);
    // A rollback is a recovered incident, not a successful deploy. Exiting 0
    // would hide it.
    expect(afterProbe).toMatch(/exit 1/);
  });

  it('says out loud that a rollback does NOT undo the migrations', () => {
    expect(deploy).toMatch(/Applied migrations stay applied/);
  });

  it('asks for a STRICT build stamp, since no CI variable sets it any more', () => {
    /*
     * `verify-build-info.mjs` turns STRICT on for `CI`, `GITHUB_ACTIONS`,
     * `NODE_ENV=production` or an explicit `--strict`. The first two are gone
     * with the workflows. Without this flag a build that cannot name its own
     * commit would start reaching production silently — the exact failure the
     * stamp exists to prevent, reintroduced by deleting CI rather than by any
     * code change.
     */
    expect(deploy).toMatch(/verify-build-info\.mjs --strict/);
  });
});
