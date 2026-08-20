#!/usr/bin/env node
/**
 * Write `dist/BUILD_INFO.json` so a running process can say which commit it is.
 *
 * ## Why this is in the BUILD rather than in the deploy
 *
 * `GET /api/v1/health` exists to answer "what is actually serving?", and on
 * 2026-08-19 it could not: it answered `available: false`, and the reason was
 * not a careless deploy. The step that writes the stamp lives only in the
 * PARKED workflow at `docs/pending-workflow/deploy.yml` — the live
 * `.github/workflows/deploy.yml` has no such step and never had one. So the
 * endpoint was built, contracted, documented, and fed by nothing.
 *
 * The parked step cannot be pushed: it is a workflow file and this PAT lacks
 * the `workflow` scope. `npm run build` is not, so the stamp moves into the
 * build. That is a better home anyway — every build stamps itself, including a
 * manual `git pull && npm run build && pm2 restart` on the host, which is
 * exactly how production was last assembled and exactly the case a
 * deploy-time-only stamp cannot cover.
 *
 * ## Reads git, never the environment first
 *
 * `GITHUB_SHA` is used when present because it is what the workflow checked
 * out, but git is the fallback and the local truth. A build from a dirty tree
 * says so in `ref` rather than reporting a commit whose content is not what was
 * compiled — a stamp that quietly lies is worse than one that says "unknown".
 *
 * ## Never fails the build
 *
 * A missing stamp degrades one diagnostic endpoint. A build that fails because
 * git was unavailable takes down a deploy. So every failure here is caught and
 * the file is written with what is known.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist', 'BUILD_INFO.json');

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

const commit = process.env.GITHUB_SHA || git(['rev-parse', 'HEAD']) || null;
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const dirty = git(['status', '--porcelain']) !== '';

/**
 * `ref` carries the dirty marker rather than a separate field.
 *
 * The four fields are fixed by the contract's `BuildInfo` schema and the
 * handler projects exactly those, so a fifth would be dropped on the way out.
 * Saying `main+dirty` inside `ref` is honest and survives the projection.
 */
const ref = process.env.GITHUB_REF || (branch ? `${branch}${dirty ? '+dirty' : ''}` : null);

const info = {
  commit,
  ref,
  builtAt: new Date().toISOString(),
  run: process.env.GITHUB_RUN_ID || null,
};

try {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(info)}\n`);
  console.log(`[build-info] ${info.commit ?? 'unknown'} ${info.ref ?? ''} ${info.builtAt}`);
} catch (err) {
  // Deliberately not fatal — see the docblock.
  console.warn(`[build-info] could not write ${OUT}: ${err.message}`);
}
