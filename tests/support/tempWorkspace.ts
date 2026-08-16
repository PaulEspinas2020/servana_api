/**
 * An isolated scratch area for tests that must write a fixture file.
 *
 * ## Why this exists
 *
 * The release gate has to be runnable from a clean checkout without writing
 * into tracked directories. Two tests did: the generated-document drift suite
 * wrote `.drift-fixture.md` into `docs/api/`, deleting it in a `finally`. That
 * is fine until a run is interrupted, and then a tracked directory carries an
 * untracked artifact that the next `git status` reports and the next commit can
 * absorb.
 *
 * ## Why not just `os.tmpdir()`
 *
 * Some things under test take REPO-RELATIVE paths — `renderRegions('docs/api/…')`
 * resolves against the repository root by design, because that is how the real
 * generator addresses its documents. A fixture for it has to live inside the
 * repo. So this provides an in-repo location that is nonetheless untracked:
 * `.test-tmp/`, gitignored, one unique directory per call.
 *
 * `os.tmpdir()` remains correct for anything that takes an absolute path, and
 * `absolute()` is here so a caller can use one abstraction either way.
 */

import fs from 'fs';
import path from 'path';

export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Untracked, and listed in `.gitignore`. Asserted by the gate. */
export const SCRATCH_ROOT = path.join(REPO_ROOT, '.test-tmp');

let counter = 0;

export interface TempWorkspace {
  /** Absolute path to the directory. */
  dir: string;
  /** Repo-relative, for APIs that resolve against the repository root. */
  relative: string;
  /** Write a file and return both forms of its path. */
  write(name: string, contents: string): { absolute: string; relative: string };
  /** Remove the whole workspace. Safe to call twice. */
  cleanup(): void;
}

/**
 * Create a unique scratch directory inside the repository.
 *
 * The name carries the caller's label so an artifact left behind by a crashed
 * run says which test to look at, rather than being an anonymous hex string.
 */
export const tempWorkspace = (label: string): TempWorkspace => {
  const safe = label.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40);
  counter += 1;
  const dir = path.join(SCRATCH_ROOT, `${safe}-${process.pid}-${counter}`);
  fs.mkdirSync(dir, { recursive: true });

  const relative = path.relative(REPO_ROOT, dir).split(path.sep).join('/');

  return {
    dir,
    relative,
    write(name, contents) {
      const absolute = path.join(dir, name);
      fs.writeFileSync(absolute, contents, 'utf8');
      return { absolute, relative: `${relative}/${name}` };
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
};
