/**
 * The rollback exists, has been executed, and cannot regress to the shape that
 * made it inoperative (TAB 05).
 *
 * ## Measured state
 *
 * `.github/workflows/deploy.yml` — the workflow that actually runs — contains
 * ZERO rollback references, and there is no retained previous build. The
 * rollback is absent from production, not merely unrehearsed, and it is blocked
 * on a credential: the PAT lacks the `workflow` scope, so
 * `docs/pending-workflow/deploy.yml` cannot be landed.
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
 * These assertions exist so that ordering cannot quietly revert when somebody
 * finally has the scope to land the file.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const LIVE = read('.github', 'workflows', 'deploy.yml');
const PARKED = read('docs', 'pending-workflow', 'deploy.yml');
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
  it('the parked workflow retains only on success, as the last step', () => {
    const probeIdx = PARKED.indexOf('id: probe');
    const retainIdx = PARKED.indexOf('snapshot-build.sh');
    expect(probeIdx).toBeGreaterThan(-1);
    expect(retainIdx).toBeGreaterThan(probeIdx);
    expect(PARKED).toContain("if: success()");
  });

  it('no snapshot is taken between checkout and build — the ordering that never worked', () => {
    const checkoutIdx = PARKED.indexOf('actions/checkout');
    const buildIdx = PARKED.indexOf('- name: Build');
    const between = PARKED.slice(checkoutIdx, buildIdx);
    // The explanatory comment may mention it; an actual copy step may not.
    expect(between).not.toContain('cp -a dist');
    expect(between).not.toContain('cp -a "$DIST"');
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

describe('the live pipeline still has no rollback, and this says so', () => {
  /**
   * Asserted as a KNOWN STATE rather than as a passing gate, because nothing in
   * this repository can change it: `.github/workflows/deploy.yml` needs a PAT
   * scope this repository does not have. When somebody lands the parked file,
   * this test turns red and gets deleted — which is the correct outcome and the
   * point of writing it this way.
   */
  it('names the gap instead of implying it is closed', () => {
    expect(LIVE.toLowerCase()).not.toContain('rollback');
    expect(LIVE).not.toContain('snapshot-build.sh');
    expect(LIVE).not.toContain('post-deploy-readiness');
  });

  it('the parked file that WOULD close it is complete', () => {
    expect(PARKED).toContain('scripts/rollback.sh');
    expect(PARKED).toContain('scripts/snapshot-build.sh');
    expect(PARKED.toLowerCase()).toContain('rollback');
  });
});
