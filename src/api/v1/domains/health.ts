/**
 * Build provenance, served publicly (TAB 04).
 *
 * ## Why this exists
 *
 * `deploy.yml` already stamps `dist/BUILD_INFO.json` with the commit, ref, build
 * time and run id on every deploy. Nothing read it. So the provenance existed on
 * the host and the question it answers — *which commit is production serving?* —
 * could only be answered by someone with a shell.
 *
 * That gap is not academic. A deploy whose migration step fails stops short of
 * the PM2 restart by design, so the push succeeds, the workflow goes green in
 * the parts that ran, and the old code keeps serving. From outside, a deploy
 * that silently did not restart is indistinguishable from one that did. This
 * endpoint is the difference.
 *
 * ## Why public
 *
 * A provenance check that needs a credential can only be run by someone who
 * already has one, which is the situation it exists to fix. Anyone may ask what
 * commit is deployed; nobody may learn anything else from asking.
 *
 * ## What it deliberately does NOT carry
 *
 * No environment variables, no dependency or database liveness, no versions of
 * anything internal, no uptime. Those turn a provenance endpoint into a status
 * page, and a public status page is a map of what to attack. The four fields
 * below are the whole contract.
 *
 * ## Absence is an answer
 *
 * A missing file means the first deploy on a host, or a cleaned workspace. That
 * is information, not an error, so it answers 200 with nulls and
 * `available: false` rather than 500 — a health endpoint that 500s is a health
 * endpoint that pages somebody at 3am about itself.
 *
 * Read once per process. The file cannot change under a running build: a new
 * build is a new process, which is exactly the event this reports.
 */

import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { ok, sendCaught } from '../envelope';
import { V1Handlers } from '../types';

export interface BuildInfo {
  commit: string | null;
  ref: string | null;
  builtAt: string | null;
  run: string | null;
  /** False when no stamp was found. The four fields above are then null. */
  available: boolean;
}

const UNKNOWN: BuildInfo = { commit: null, ref: null, builtAt: null, run: null, available: false };

/**
 * Candidate locations, in order.
 *
 * The compiled handler lives at `dist/api/v1/domains/`, so the stamp is three
 * levels up. `cwd` is the fallback for a process started from the repository
 * root. Both are tried because the deploy writes the file relative to the build
 * and PM2 starts the process relative to the checkout, and those are not
 * guaranteed to be the same place forever.
 */
const CANDIDATES = [
  path.resolve(__dirname, '..', '..', '..', 'BUILD_INFO.json'),
  path.resolve(process.cwd(), 'dist', 'BUILD_INFO.json'),
];

/** Only these four fields travel, whatever else the file happens to contain. */
const project = (raw: unknown): BuildInfo => {
  if (raw === null || typeof raw !== 'object') return UNKNOWN;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null);
  const info: BuildInfo = {
    commit: str(r.commit),
    ref: str(r.ref),
    builtAt: str(r.builtAt),
    run: str(r.run),
    available: false,
  };
  info.available = info.commit !== null;
  return info;
};

let cached: BuildInfo | null = null;

export const readBuildInfo = (): BuildInfo => {
  if (cached) return cached;
  for (const file of CANDIDATES) {
    try {
      cached = project(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (cached.available) return cached;
    } catch {
      // Unreadable or malformed is the same as absent: the caller learns the
      // build cannot name itself, which is the honest answer either way.
    }
  }
  cached = cached ?? UNKNOWN;
  return cached;
};

/** Test seam — the memo is process-global and would otherwise leak between tests. */
export const __clearBuildInfoCache = (): void => { cached = null; };

export const handlers: V1Handlers = {
  'health.build': async (req: Request, res: Response) => {
    try {
      return ok(res, req, readBuildInfo());
    } catch (error) {
      return sendCaught(res, req, 'health.build', error as never);
    }
  },
};
