/**
 * Something has to WRITE the stamp, and until 2026-08-19 nothing did.
 *
 * `tests/health-build-provenance.test.ts` proves the reader: given a
 * `BUILD_INFO.json`, `GET /api/v1/health` reports the four fields and refuses a
 * malformed one. `tests/deploy-gating.test.ts` proves the PARKED workflow
 * mentions the file. Between them they describe a complete loop that did not
 * exist — the live `.github/workflows/deploy.yml` has no stamping step, so the
 * endpoint answered `available: false` in production and would have answered it
 * after any deploy.
 *
 * A reader tested against a fixture is not evidence that anything produces the
 * fixture. That is the same shape as a redaction unit test that never sees an
 * emitted log line, and it is why this file asserts the WRITE.
 *
 * The stamp now happens in `npm run build`, not in the deploy, so a manual
 * `git pull && npm run build && pm2 restart` on the host stamps itself too —
 * which is how production was last assembled.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const STAMPER = path.join(ROOT, 'scripts', 'stamp-build-info.mjs');
const OUT = path.join(ROOT, 'dist', 'BUILD_INFO.json');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('the build stamps its own provenance', () => {
  it('the build script invokes the stamper', () => {
    /**
     * Asserted on the SCRIPT rather than on the artefact, because a `dist/`
     * left over from an earlier build would make an artefact check pass
     * without the current build doing anything.
     */
    expect(pkg.scripts.build).toContain('stamp-build-info');
  });

  it('the stamper exists and is executable by node', () => {
    expect(fs.existsSync(STAMPER)).toBe(true);
  });

  it('running it writes the four fields the contract declares', () => {
    execFileSync('node', [STAMPER], { cwd: ROOT, stdio: 'pipe' });
    const raw = JSON.parse(fs.readFileSync(OUT, 'utf8')) as Record<string, unknown>;

    expect(Object.keys(raw).sort()).toEqual(['builtAt', 'commit', 'ref', 'run']);
    expect(typeof raw.commit).toBe('string');
    expect((raw.commit as string).length).toBeGreaterThanOrEqual(7);
    expect(Date.parse(raw.builtAt as string)).not.toBeNaN();
  });

  it('reports the commit that is actually checked out', () => {
    // Not merely "a commit" — the RIGHT one. A stamp reporting the wrong
    // commit is worse than none, because it is believed.
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    execFileSync('node', [STAMPER], { cwd: ROOT, stdio: 'pipe' });
    const raw = JSON.parse(fs.readFileSync(OUT, 'utf8')) as { commit: string };
    expect(raw.commit).toBe(head);
  });

  it('says so when the tree is dirty rather than reporting a clean commit', () => {
    /**
     * A build from a modified tree does not contain the commit it names. The
     * marker rides in `ref`, because the contract's `BuildInfo` schema fixes
     * four fields and the handler projects exactly those — a fifth would be
     * dropped on the way out, which is the sort of detail that turns a
     * correct-looking design into a silent one.
     */
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '';
    execFileSync('node', [STAMPER], { cwd: ROOT, stdio: 'pipe' });
    const raw = JSON.parse(fs.readFileSync(OUT, 'utf8')) as { ref: string | null };

    if (dirty) {
      expect(raw.ref).toContain('+dirty');
    } else {
      expect(raw.ref ?? '').not.toContain('+dirty');
    }
  });

  it('prefers the workflow SHA when one is present', () => {
    // The deploy checks out a specific commit; GITHUB_SHA is what it asked for,
    // and it is the value the run list can be joined against.
    execFileSync('node', [STAMPER], {
      cwd: ROOT,
      stdio: 'pipe',
      env: { ...process.env, GITHUB_SHA: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', GITHUB_RUN_ID: '12345' },
    });
    const raw = JSON.parse(fs.readFileSync(OUT, 'utf8')) as { commit: string; run: string };
    expect(raw.commit).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(raw.run).toBe('12345');
  });

  it('never fails the build when git is unavailable', () => {
    /**
     * A missing stamp degrades one diagnostic endpoint. A build that dies
     * because git was not on PATH takes down a deploy, which is a far worse
     * trade for the same information.
     */
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
    fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
    fs.copyFileSync(STAMPER, path.join(sandbox, 'scripts', 'stamp-build-info.mjs'));

    // No .git here, and PATH stripped so `git` cannot resolve. Node is invoked
    // through `process.execPath` rather than by name — the first version of
    // this test emptied PATH and stopped `node` resolving too, so it failed on
    // its own setup rather than on the thing under test.
    expect(() =>
      execFileSync(process.execPath, [path.join(sandbox, 'scripts', 'stamp-build-info.mjs')], {
        cwd: sandbox,
        stdio: 'pipe',
        env: { PATH: '/nonexistent', HOME: sandbox },
      }),
    ).not.toThrow();

    const raw = JSON.parse(fs.readFileSync(path.join(sandbox, 'dist', 'BUILD_INFO.json'), 'utf8')) as {
      commit: string | null;
    };
    expect(raw.commit).toBeNull();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
});
