/**
 * The release gate must be runnable from a clean checkout.
 *
 * TAB 01's acceptance criterion is "one clean checkout can run the gate without
 * writing into tracked directories". That was not true: the generated-document
 * drift suite wrote `.drift-fixture.md` into `docs/api/` and removed it in a
 * `finally`, which holds until a run is interrupted — and then a tracked
 * directory carries an untracked artifact that the next commit can absorb.
 *
 * A criterion in a document is a claim. This is the check.
 */

import fs from 'fs';
import path from 'path';
import { SCRATCH_ROOT, REPO_ROOT, tempWorkspace } from './support/tempWorkspace';

const TESTS_DIR = __dirname;

/** Filesystem calls that create or modify something on disk. */
const WRITE_CALL = /\b(writeFileSync|appendFileSync|mkdirSync|mkdtempSync|copyFileSync|renameSync|createWriteStream)\s*\(/;

/**
 * Sanctioned destinations. A write is fine when its path is built from one of
 * these, because neither is tracked.
 */
const SANCTIONED = /\b(tempWorkspace|SCRATCH_ROOT|os\.tmpdir\(\)|tmpdir\(\))/;

const testSources = (): Array<{ file: string; text: string }> =>
  fs
    .readdirSync(TESTS_DIR)
    .filter((f) => /\.test\.(ts|js)$/.test(f))
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(TESTS_DIR, f), 'utf8') }));

describe('the gate does not write into tracked directories', () => {
  it('finds test sources at all (positive fixture)', () => {
    // A broken read would find none and pass the real check forever.
    expect(testSources().length).toBeGreaterThan(100);
  });

  it('every test that writes to disk writes somewhere untracked', () => {
    const offenders: string[] = [];

    for (const { file, text } of testSources()) {
      const lines = text.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!WRITE_CALL.test(line)) return;
        // The write may name its destination on an earlier line, so allow a
        // small window rather than demanding it all be on one.
        const window = lines.slice(Math.max(0, i - 6), i + 3).join('\n');
        if (!SANCTIONED.test(window)) offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 80)}`);
      });
    }

    expect(offenders).toEqual([]);
  });

  it('the scratch root is gitignored', () => {
    /**
     * The scratch directory lives INSIDE the repository on purpose — some
     * things under test take repo-relative paths — so the only thing keeping it
     * out of a commit is `.gitignore`. Asserted, because that is a one-line
     * deletion away from silently untrue.
     */
    const ignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    expect(ignore).toMatch(/^\.test-tmp\/?$/m);
    expect(SCRATCH_ROOT.startsWith(REPO_ROOT)).toBe(true);
  });

  it('a workspace cleans up after itself', () => {
    const workspace = tempWorkspace('self-check');
    const written = workspace.write('probe.txt', 'x');
    expect(fs.existsSync(written.absolute)).toBe(true);
    workspace.cleanup();
    expect(fs.existsSync(workspace.dir)).toBe(false);
  });

  it('hands back a repo-relative path for repo-relative APIs', () => {
    // `renderRegions('docs/api/…')` resolves against the repository root by
    // design; a fixture for it cannot live in os.tmpdir().
    const workspace = tempWorkspace('relative-check');
    try {
      const written = workspace.write('f.md', 'x');
      expect(written.relative.startsWith('.test-tmp/')).toBe(true);
      expect(path.resolve(REPO_ROOT, written.relative)).toBe(written.absolute);
    } finally {
      workspace.cleanup();
    }
  });
});
