/**
 * The rollback exists, has been executed, and cannot regress to the shape that
 * made it inoperative (TAB 05).
 *
 * ## Measured state — the gap is now CLOSED
 *
 * This used to record a gap nothing in the repository could close: the workflow
 * that actually ran carried ZERO rollback references, and the parked copy that
 * would have fixed it could not be landed because the PAT lacked the `workflow`
 * scope. So the rollback was absent from production rather than merely
 * unrehearsed.
 *
 * Deleting CI closed it. `scripts/deploy-prod.sh` is the deploy now, a script
 * carries no workflow-scope restriction, and it calls the probe, this rollback
 * and the retention in the order the parked file described. The assertions
 * below moved from that parked YAML onto the script, unchanged in substance.
 *
 * ## The defect rehearsal found
 *
 * The parked workflow snapshotted the RUNNING build after checkout and before
 * `npm run build` overwrote `dist/`. That could never have worked:
 *
 *   - `dist` is gitignored (.gitignore:109)
 *   - `actions/checkout@v4` defaults to `clean: true` → `git clean -ffdx`, and
 *     `-x` removes ignored files. `git clean -ffdxn -- dist` prints
 *     "Would remove dist/".
 *   - the snapshot ran at line 169; checkout at line 70.
 *
 * So it would have taken its "no dist/ to snapshot" branch every deploy, and the
 * rollback beneath it would have found nothing to restore every time it was
 * needed. A rollback that reads as present and is absent is worse than a missing
 * one, because nobody goes looking.
 *
 * These assertions exist so that ordering cannot quietly revert.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const DEPLOY = read('scripts', 'deploy-prod.sh');
const ROLLBACK = read('scripts', 'rollback.sh');
const SNAPSHOT = read('scripts', 'snapshot-build.sh');

describe('the rollback is a runnable artefact, not only a YAML fragment', () => {
  it('exists as a script, which is the part that CAN land', () => {
    // scripts/ carries no workflow-scope restriction. Moving the logic here is
    // what changes "there is no rollback" into "there is one an operator can run".
    expect(fs.existsSync(path.join(ROOT, 'scripts', 'rollback.sh'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'scripts', 'snapshot-build.sh'))).toBe(true);
  });

  it('refuses when there is nothing to restore, WITHOUT stopping the running process', () => {
    /**
     * The safety property that matters most. Discovering there is no snapshot
     * after stopping the process turns a bad deploy into an outage.
     */
    const guardIdx = ROLLBACK.indexOf('NO PREVIOUS BUILD AT');
    const stopIdx = ROLLBACK.indexOf('$PM2 stop');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(stopIdx);
    expect(ROLLBACK).toContain('Do not stop the running process');
  });

  it('verifies recovery by asking the running process, not by reading a file', () => {
    // Disk and process differ exactly when the restart did not take, which is
    // the failure this path exists for.
    expect(ROLLBACK).toContain('/api/v1/health');
    expect(ROLLBACK).toContain('ROLLBACK_DURATION_SECONDS');
  });

  it('is injectable, because a procedure nobody has executed is a hypothesis', () => {
    for (const knob of ['RELEASES', 'APP_DIR', 'PM2', 'PM2_NAME', 'PORT', 'DEADLINE']) {
      expect(ROLLBACK).toContain(`${knob}:-`);
    }
  });

  it('says what it cannot restore', () => {
    expect(ROLLBACK).toContain('migrations stay applied');
    expect(ROLLBACK).toContain('.env');
  });
});

describe('retention happens after the probe, never after checkout', () => {
  it('the deploy retains only after the probe accepted the build, as the last step', () => {
    const probeIdx = DEPLOY.indexOf('post-deploy-readiness.sh');
    const retainIdx = DEPLOY.indexOf('snapshot-build.sh');
    expect(probeIdx).toBeGreaterThan(-1);
    expect(retainIdx).toBeGreaterThan(probeIdx);
    // And it is genuinely last: nothing runs after the retention.
    expect(DEPLOY.slice(retainIdx)).not.toMatch(/\$PM2 start|npm run migrations/);
  });

  it('no snapshot is taken before the build — the ordering that never worked', () => {
    /**
     * The workflow form of this bug was structural: `actions/checkout` runs
     * `git clean -ffdx`, `dist` is ignored, so the snapshot step found nothing
     * to copy on every single run. A script does no checkout, so the bug can
     * only return as a reordering — snapshotting while `dist/` still holds the
     * build being replaced, or before `npm run build` has written the new one.
     */
    const buildIdx = DEPLOY.indexOf('npm run build');
    const retainIdx = DEPLOY.indexOf('snapshot-build.sh');
    expect(buildIdx).toBeGreaterThan(-1);
    expect(retainIdx).toBeGreaterThan(buildIdx);
  });

  it('dist really is ignored, which is why the old ordering failed', () => {
    // The premise of the whole finding, asserted rather than remembered.
    const ignore = read('.gitignore');
    expect(ignore.split(/\r?\n/)).toContain('dist');
  });

  it('the snapshot refuses to retain a build that cannot name itself', () => {
    // Restoring onto an unidentifiable build leaves you mid-incident with no way
    // to say what you rolled back onto.
    expect(SNAPSHOT).toContain('Refusing to retain an unidentifiable build');
  });

  it('prunes with a portable head, not the GNU-only negative count', () => {
    /**
     * `head -n -N` is a GNU extension. BSD/macOS rejects it with "illegal line
     * count", the error scrolls past, and pruning silently does nothing while
     * the retention directory grows without bound. The deploy host is Linux, so
     * this would have shipped and only ever bitten whoever tried to rehearse it
     * on a laptop — found by rehearsing, not by reading.
     */
    // Comments stripped first: this script's own docblock quotes the broken form
    // to explain it, and matching that would make the assertion unsatisfiable.
    // The same trap caught tests/reconciler-honesty.test.ts one TAB ago.
    const code = SNAPSHOT.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code).not.toMatch(/head -n -/);
    expect(code).toContain('drop=$(( total - KEEP ))');
  });
});

describe('the live deploy path now HAS the rollback it used to lack', () => {
  /**
   * The previous version of this block asserted the gap as a known state,
   * because nothing in the repository could close it — the workflow needed a
   * PAT scope this repository does not have. Removing CI removed the blocker
   * along with the workflow: the deploy is a script, and a script can carry the
   * probe and the recovery.
   */
  it('the deploy calls the probe, the rollback and the retention', () => {
    expect(DEPLOY).toContain('scripts/post-deploy-readiness.sh');
    expect(DEPLOY).toContain('scripts/rollback.sh');
    expect(DEPLOY).toContain('scripts/snapshot-build.sh');
  });

  it('a rollback still reports failure, so a recovered incident is not read as a deploy', () => {
    const afterRollback = DEPLOY.slice(DEPLOY.indexOf('scripts/rollback.sh'));
    expect(afterRollback).toMatch(/exit 1/);
  });
});
