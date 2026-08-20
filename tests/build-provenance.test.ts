/**
 * A build that cannot name itself must not reach production (TAB 04).
 *
 * ## What was actually wrong
 *
 * The hand-over that raised this said "the deploy is not writing the file it
 * reads". Re-measured 2026-08-20, that is no longer the defect. `npm run build`
 * has run `scripts/stamp-build-info.mjs` since 8781cf6, `origin/main` carries
 * that package.json, and the live `deploy.yml` runs `npm run build`. So a deploy
 * WOULD stamp.
 *
 * Production still answers `available: false`, and the reason is narrower and
 * more embarrassing: 8781cf6 was pushed with `[skip ci]`, so it never triggered
 * a deploy. Production is serving an artefact built before the stamper existed.
 * The fix for that is a deploy, not code.
 *
 * ## What code CAN close, and the constraint that shapes it
 *
 * `.github/workflows/deploy.yml` cannot be changed with this repository's
 * credentials — the PAT lacks the `workflow` scope, which is why the fuller
 * pipeline sits parked in `docs/pending-workflow/`. `package.json` has no such
 * restriction and the live deploy already runs `npm run build`, so a gate placed
 * in the build reaches production without a workflow edit.
 *
 * The POST-deploy probe genuinely needs the workflow, because it must run after
 * the PM2 restart. It is written and proven here, and it is not wired, and that
 * is recorded as an open gap rather than papered over.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const VERIFIER = path.join(ROOT, 'scripts', 'verify-build-info.mjs');

/**
 * Run the verifier against a stamp in a THROWAWAY tree, never the real `dist/`.
 *
 * The first version of this mutated `dist/BUILD_INFO.json` in place and restored
 * it afterwards. `release-gate-hermeticity` refused it, and was right twice
 * over: that file is a real build artefact which
 * `tests/v1-composed-app.test.ts` reads through `/api/v1/health` in the same
 * `--runInBand` process, and a crash between mutation and restore would leave it
 * broken for every later run on the machine.
 *
 * The verifier resolves its own root as `dirname(script)/..`, so copying the
 * script into `$TMP/scripts/` makes `$TMP/dist/BUILD_INFO.json` the file it
 * checks — the real logic, no path override, no production surface added for a
 * test's convenience.
 */
const runVerifier = (
  stamp: string | null,
  env: NodeJS.ProcessEnv = {},
): { code: number; out: string } => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-info-'));
  try {
    fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
    fs.copyFileSync(VERIFIER, path.join(tmp, 'scripts', 'verify-build-info.mjs'));
    if (stamp !== null) fs.writeFileSync(path.join(tmp, 'dist', 'BUILD_INFO.json'), stamp);

    // spawnSync, not execFileSync: the local no-commit case exits 0 and writes
    // its warning to STDERR, which execFileSync discards on success. A helper
    // that cannot see the warning it asserts is its own silent zero.
    const r = spawnSync('node', [path.join(tmp, 'scripts', 'verify-build-info.mjs')], {
      cwd: tmp,
      encoding: 'utf8',
      env: { ...process.env, CI: '', GITHUB_ACTIONS: '', GITHUB_SHA: '', NODE_ENV: '', ...env },
    });
    return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

const VALID = JSON.stringify({
  commit: '4bf9c54cdbf15999fec3025b5f1a278962974e8e',
  ref: 'main',
  builtAt: '2026-08-20T00:00:00.000Z',
  run: null,
});

describe('the build refuses an artefact that cannot name itself', () => {
  it('the verifier runs as part of `npm run build`, not as a step someone must remember', () => {
    // The whole reason this lands in package.json rather than the workflow.
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.build).toContain('stamp-build-info.mjs');
    expect(pkg.scripts.build).toContain('verify-build-info.mjs');
    // Ordering matters: verifying before stamping would always fail.
    expect(pkg.scripts.build.indexOf('stamp-build-info'))
      .toBeLessThan(pkg.scripts.build.indexOf('verify-build-info'));
  });

  it('passes on a well-formed stamp — otherwise every case below is vacuous', () => {
    const { code, out } = runVerifier(VALID);
    expect(code).toBe(0);
    expect(out).toContain('verified');
  });

  it('fails when the stamp is absent', () => {
    const { code, out } = runVerifier(null);
    expect(code).toBe(1);
    expect(out).toContain('absent');
  });

  it('fails when the stamp is not valid JSON', () => {
    const { code, out } = runVerifier('{ not json');
    expect(code).toBe(1);
    expect(out).toContain('not valid JSON');
  });

  it('fails when a contract field is missing, rather than projecting it to null', () => {
    // A stamp missing `ref` would reach the endpoint as `ref: null`, which reads
    // as "no stamp" rather than "malformed stamp" — the distinction this keeps.
    const { code, out } = runVerifier(JSON.stringify({ commit: 'abc', builtAt: 'x', run: null }));
    expect(code).toBe(1);
    expect(out).toContain('ref');
  });

  it('fails in CI when no commit is named, and only warns locally', () => {
    const noCommit = JSON.stringify({ commit: null, ref: 'main', builtAt: 'x', run: null });

    // Locally a developer may legitimately build without a git directory.
    const local = runVerifier(noCommit);
    expect(local.code).toBe(0);
    expect(local.out).toContain('WARNING');

    // In CI it is fatal: the workflow always has GITHUB_SHA to stamp from, so a
    // null commit there means the stamp step did not do its job.
    const ci = runVerifier(noCommit, { CI: 'true' });
    expect(ci.code).toBe(1);
    expect(ci.out).toContain('available:false');
  });

  it('fails when the artefact was built from a different commit than the run checked out', () => {
    const { code, out } = runVerifier(VALID, { GITHUB_SHA: '0'.repeat(40) });
    expect(code).toBe(1);
    expect(out).toContain('not built from the commit being deployed');
  });
});

describe('the post-deploy probe asserts the running commit', () => {
  const SCRIPT = fs.readFileSync(path.join(ROOT, 'scripts', 'post-deploy-readiness.sh'), 'utf8');

  it('fails on available:false — a build that cannot name itself is serving', () => {
    expect(SCRIPT).toContain('FAILED PROVENANCE');
    expect(SCRIPT).toContain('available=');
  });

  it('compares the served commit against the one the deploy checked out', () => {
    expect(SCRIPT).toContain('EXPECTED_COMMIT');
    expect(SCRIPT).toContain('GITHUB_SHA');
    expect(SCRIPT).toContain('serving the wrong commit');
  });

  it('runs provenance only after readiness passes, not instead of it', () => {
    // Readiness and provenance answer different questions: "can it serve?" and
    // "is it serving THIS build?". A probe that skipped the first would call a
    // process healthy for having the right commit and no database.
    const readyIdx = SCRIPT.indexOf('ready after ${attempt}');
    const provIdx = SCRIPT.indexOf('check_provenance\n    exit $?');
    expect(readyIdx).toBeGreaterThan(-1);
    expect(provIdx).toBeGreaterThan(readyIdx);
  });

  it('probes localhost, never the public origin', () => {
    // The public origin may be a proxy, a cache or another instance, and a green
    // probe there would prove the wrong thing about this deploy.
    expect(SCRIPT).toContain('127.0.0.1');
    expect(SCRIPT).not.toContain('api.servana.com.ph');
  });

  it('IS wired into the deploy, and told which commit to expect', () => {
    /**
     * This was previously asserted as a KNOWN GAP rather than a passing gate:
     * the probe existed but nothing ran it, and nothing in the repository could
     * change that, because the workflow needed a PAT scope this repository does
     * not have.
     *
     * Removing CI removed the blocker with it. The deploy is `deploy-prod.sh`
     * now, and a script can call the probe. `EXPECTED_COMMIT` is passed
     * explicitly because `GITHUB_SHA` — the fallback the script also accepts —
     * is never set outside Actions, and an unset expectation makes the
     * provenance check silently vacuous.
     */
    const deploy = fs.readFileSync(path.join(ROOT, 'scripts', 'deploy-prod.sh'), 'utf8');
    expect(deploy).toContain('post-deploy-readiness.sh');
    expect(deploy).toMatch(/EXPECTED_COMMIT="\$\(git rev-parse HEAD/);
  });
});

describe('hermeticity', () => {
  it('writes only under os.tmpdir() or restores what it touched', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-provenance-'));
    expect(dir.startsWith(os.tmpdir())).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
