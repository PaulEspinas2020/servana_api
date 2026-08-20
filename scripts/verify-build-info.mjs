#!/usr/bin/env node
/**
 * A build that cannot name itself must not reach production.
 *
 * ## Why this is separate from the stamper
 *
 * `stamp-build-info.mjs` deliberately NEVER fails: a build that dies because
 * git was unavailable takes down a deploy, and a missing stamp only degrades one
 * diagnostic endpoint. That reasoning is right and is left alone.
 *
 * It is also not the whole story. "git was unavailable so `commit` is null" and
 * "the stamp was never written at all" are different events with the same
 * symptom at the endpoint — `available: false` — and only the second is a broken
 * build. This script draws that line:
 *
 *   file absent or unparseable  -> ALWAYS fatal. The stamper writes it
 *                                  unconditionally, so its absence means the
 *                                  build did not run the step at all.
 *   commit null                 -> fatal in CI and production, a warning
 *                                  locally, where a developer may reasonably
 *                                  build a tarball with no git directory.
 *
 * ## Why it runs in `npm run build` rather than in the deploy workflow
 *
 * `.github/workflows/deploy.yml` cannot be changed with the credentials this
 * repository has: the PAT lacks the `workflow` scope, which is why the fuller
 * pipeline still sits parked in `docs/pending-workflow/`. `package.json` has no
 * such restriction and the live deploy already runs `npm run build`, so a gate
 * placed here reaches production without a workflow edit.
 *
 * That is a real constraint shaping a real design, not a preference. The part
 * of TAB 04 that genuinely needs the workflow — the POST-deploy probe, which
 * must run after the PM2 restart — cannot be landed this way and is named as an
 * open gap rather than faked here.
 *
 * ## What it deliberately does not do
 *
 * It does not compare against a remote. Whether the running process serves this
 * commit is a question for after the restart, and answering it here would be
 * asserting an outcome rather than verifying one.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'dist', 'BUILD_INFO.json');

/** CI or an explicit production build. Locally, `commit` may honestly be null. */
const STRICT =
  process.env.CI === 'true' ||
  process.env.GITHUB_ACTIONS === 'true' ||
  process.env.NODE_ENV === 'production' ||
  process.argv.includes('--strict');

const die = (message) => {
  console.error(`[build-info] FATAL: ${message}`);
  console.error('[build-info] A build that cannot name itself must not reach production.');
  console.error(`[build-info] expected: ${FILE}`);
  process.exit(1);
};

let raw;
try {
  raw = fs.readFileSync(FILE, 'utf8');
} catch {
  die('dist/BUILD_INFO.json is absent. `npm run build` writes it unconditionally, so this means the stamp step did not run.');
}

let info;
try {
  info = JSON.parse(raw);
} catch (err) {
  die(`dist/BUILD_INFO.json is not valid JSON (${err.message}). The endpoint that reads it would report available:false and hide the reason.`);
}

if (info === null || typeof info !== 'object' || Array.isArray(info)) {
  die('dist/BUILD_INFO.json does not contain an object.');
}

// The four fields the BuildInfo contract declares. A stamp missing a key would
// project to null at the endpoint, which reads as "no stamp" rather than as
// "malformed stamp" — the distinction this script exists to keep.
for (const field of ['commit', 'ref', 'builtAt', 'run']) {
  if (!(field in info)) die(`dist/BUILD_INFO.json has no \`${field}\` field.`);
}

if (typeof info.commit !== 'string' || info.commit.length === 0) {
  const message = 'dist/BUILD_INFO.json names no commit, so `/api/v1/health` would answer available:false.';
  if (STRICT) die(message);
  console.warn(`[build-info] WARNING: ${message}`);
  console.warn('[build-info] Not fatal here because this is not a CI or production build. It WOULD be.');
  process.exit(0);
}

// `GITHUB_SHA` is what the workflow checked out. If the stamp disagrees with it,
// the artefact was built from something other than what this run believes it is
// deploying — which is precisely the confusion provenance exists to end.
if (process.env.GITHUB_SHA && info.commit !== process.env.GITHUB_SHA) {
  die(
    `the stamp names ${info.commit} but this run checked out ${process.env.GITHUB_SHA}. ` +
    'The artefact is not built from the commit being deployed.',
  );
}

console.log(`[build-info] verified ${info.commit} ${info.ref ?? ''} ${info.builtAt}${STRICT ? ' (strict)' : ''}`);
