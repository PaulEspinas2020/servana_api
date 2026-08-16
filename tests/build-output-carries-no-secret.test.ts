/**
 * The build output must carry no credential (TAB 12).
 *
 * ## What was there
 *
 * ```
 * "build": "tsc && cp servana-serviceAccountKey.json ./dist"
 * ```
 *
 * A Firebase Admin service-account key — a production credential — copied into
 * the build output on every build.
 *
 * Two things made it worse than redundant:
 *
 *   1. **Nothing read it.** `firebaseApp.ts` resolves
 *      `'./servana-serviceAccountKey.json'` against `process.cwd()`, and its own
 *      error message says "in the repository root". `node dist/app.js` runs with
 *      cwd at the app root, so the copy in `dist/` was never opened.
 *   2. **It was less protected than the one that is used.** `deploy.yml` copies
 *      the key to the app root and follows it with `chmod 600`. The build copy
 *      inherited default permissions.
 *
 * `dist` is gitignored, so this never reached the repository — the exposure was
 * any artifact, image layer or backup taken of a built tree.
 *
 * This repository has been here before: two Firebase Admin keys reached git
 * history and had to be rotated.
 */

import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST = path.join(REPO_ROOT, 'dist');

/** Filenames that are credentials whatever else is true of them. */
const SECRET_NAMES = [/serviceAccountKey.*\.json$/i, /^\.env$/i, /\.pem$/i, /\.p12$/i, /\.key$/i];

const walk = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
};

describe('the build output carries no credential', () => {
  it('the build script does not copy a key into dist', () => {
    /**
     * Asserted against the SCRIPT, so it fails on a clean checkout where
     * nothing has been built yet — which is exactly when a reviewer would be
     * reading it.
     */
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.build).not.toMatch(/serviceAccountKey/i);
    expect(pkg.scripts.build).not.toMatch(/\.env/);
  });

  it('no credential-shaped file exists in dist, when dist exists', () => {
    const offenders = walk(DIST)
      .map((f) => path.relative(REPO_ROOT, f))
      .filter((f) => SECRET_NAMES.some((re) => re.test(path.basename(f))));
    expect(offenders).toEqual([]);
  });

  it('the key is still gitignored, and only the example is tracked', () => {
    // The build copy was never the git exposure; this is the guard that was.
    const ignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    expect(ignore).toMatch(/serviceAccountKey\.json/);
    expect(fs.existsSync(path.join(REPO_ROOT, 'servana-serviceAccountKey.json.example'))).toBe(true);
  });

  it('the detector recognises a credential filename (negative fixture)', () => {
    // Without this, a broken pattern list would pass the check above forever.
    const matches = (name: string) => SECRET_NAMES.some((re) => re.test(name));
    expect(matches('servana-serviceAccountKey.json')).toBe(true);
    expect(matches('.env')).toBe(true);
    expect(matches('private.pem')).toBe(true);
    expect(matches('app.js')).toBe(false);
  });
});
