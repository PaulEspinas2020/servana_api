/**
 * The client recall lever (TAB 02).
 *
 * ## Why this exists
 *
 * A released mobile client cannot be recalled. A worker who installs a broken
 * build keeps it until they choose to update, and "choose" is doing a great deal
 * of work when the app still opens. The only recall a mobile client has is a
 * forced update: the app asks what the minimum supported version is and blocks
 * itself when it is below it. The worker app has already implemented that check.
 * It had nothing to ask.
 *
 * ## Why the configuration is a FILE and not the database
 *
 * This is the decision that matters here, and it is settled by this platform's
 * own incident history rather than by preference.
 *
 * A recall is pulled during an incident. The incident this platform has actually
 * had — for six days — was every database-backed read returning 500, with
 * configuration the leading hypothesis. A kill switch that reads the database is
 * a kill switch that is unavailable in the exact failure class this platform has
 * already lived through, and it would have been unavailable for the whole of it.
 *
 * A file also needs no migration, no restart and no deploy: an operator edits it
 * and the next read past the TTL serves it. That is the property the TAB asks
 * for, and a database table backed by an admin endpoint would additionally
 * require the admin surface to be up.
 *
 * ## Why it is re-read rather than memoised for the process lifetime
 *
 * `health.ts` reads its stamp once, correctly: a build cannot change under a
 * running process. This one must do the opposite. The whole value of the lever
 * is that it moves without a restart, so the memo carries a TTL and the file is
 * consulted again once it expires.
 *
 * ## The two failure directions, which are deliberately opposite
 *
 * The CLIENT fails closed: an unreadable answer blocks the app, because a build
 * too old to parse the response is the one most likely being recalled.
 *
 * The SERVER therefore fails OPEN: a missing or malformed config file serves a
 * permissive floor of 0.0.0, which blocks nobody. If both halves failed closed,
 * deleting one file on the host would brick every installed worker app at once —
 * a self-inflicted outage with no recovery path, since the apps that need the fix
 * are the ones refusing to run. Losing the config must degrade to "recall
 * nobody", never to "recall everybody".
 *
 * That has a real cost and it is stated rather than hidden: if the file is lost
 * while a recall is in force, the recall silently lifts. `source` in the response
 * is how an operator sees that from outside, and it is why the field is public.
 *
 * ## What it deliberately does NOT carry
 *
 * Feature flags. A config endpoint that grows into a flag service becomes a
 * second source of truth for behaviour, and this one is unauthenticated —
 * every flag put here is a flag published to the world.
 * `tests/v1-client-config.test.ts` fails when a key appears that is not one of
 * the three below, so the creep has to be argued for rather than merged.
 */

import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { ok, sendCaught } from '../envelope';
import { V1Handlers } from '../types';

/** The platforms a client may identify as. Closed: an unknown key is dropped. */
export const PLATFORMS = ['ios', 'android'] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface PlatformConfig {
  /** Below this, the client must refuse to run. */
  minimumSupported: string;
  /** The newest build in the store. Never blocks; drives a soft prompt. */
  latestAvailable: string;
  /** Shown verbatim when the client blocks, so the wording is the platform's. */
  message: string;
}

export interface ClientConfig {
  platforms: Record<Platform, PlatformConfig>;
  /**
   * Which source answered. `default` means the file was absent or unusable and
   * the permissive floor is in force — i.e. any recall configured there is NOT
   * being applied. Public because an operator confirming a recall took effect
   * is the person most likely to be reading this without a credential.
   */
  source: 'config' | 'default';
}

/**
 * `MAJOR.MINOR.PATCH`, numeric, no pre-release segment.
 *
 * Deliberately narrower than semver. A pre-release ordering rule the server and
 * the client implement separately is a rule they will implement differently, and
 * the disagreement surfaces as an app that blocks when it should not.
 */
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

export const isVersion = (v: unknown): v is string => typeof v === 'string' && VERSION.test(v);

/**
 * -1 / 0 / 1, comparing numerically per segment. Throws on a malformed input
 * rather than guessing: "1.2" and "1.2.0" are not obviously the same intent, and
 * a comparator that quietly picks one makes a recall decision on a coin flip.
 *
 * Exported because it pins the semantics the client's own check must match. The
 * four cases the client cares about — below, exactly at, above, malformed — are
 * asserted against THIS function in `tests/v1-client-config.test.ts`, so the
 * contract is a tested artefact rather than a paragraph.
 */
export const compareVersions = (a: string, b: string): -1 | 0 | 1 => {
  if (!isVersion(a) || !isVersion(b)) throw new TypeError(`not a MAJOR.MINOR.PATCH version: ${!isVersion(a) ? a : b}`);
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] > right[i]) return 1;
    if (left[i] < right[i]) return -1;
  }
  return 0;
};

/** True when `installed` may run against `minimum`. At the minimum is allowed. */
export const isSupported = (installed: string, minimum: string): boolean =>
  compareVersions(installed, minimum) >= 0;

/**
 * The permissive floor. Blocks nobody, on purpose — see the failure-direction
 * note above. `latestAvailable` matches it so a client cannot compute a
 * nonsensical "you are ahead of the newest build".
 */
const PERMISSIVE: PlatformConfig = {
  minimumSupported: '0.0.0',
  latestAvailable: '0.0.0',
  message: 'A minimum supported version is not configured. Please continue.',
};

const DEFAULT_CONFIG: ClientConfig = {
  platforms: { ios: { ...PERMISSIVE }, android: { ...PERMISSIVE } },
  source: 'default',
};

/**
 * Where the file may live, in order.
 *
 * `CLIENT_CONFIG_PATH` first so an operator can point at a path outside the
 * checkout — a deploy that replaces the working directory must not replace the
 * recall lever with whatever the release happened to ship. The two fallbacks
 * mirror `health.ts`: the compiled handler sits at `dist/api/v1/domains/`, and
 * `cwd` covers a process started from the repository root.
 */
export const configCandidates = (): string[] =>
  /**
   * An explicitly configured path is AUTHORITATIVE and is not a first
   * preference — the list is that one entry and nothing else.
   *
   * The fall-through version of this was a real defect, caught by
   * `serves the permissive floor for unparseable JSON`. With the operator's file
   * malformed, the search continued to the next candidate and found the config
   * the RELEASE happened to ship, then reported `source: 'config'`. So a typo in
   * an emergency edit would silently hand back the shipped floor while telling
   * the operator their file had been read — which is either a recall silently
   * lifted, or a recall silently imposed, and no way to tell which from outside.
   *
   * If an operator has named the file, that file is the truth about it, including
   * when the truth is "it is broken" — which degrades to the permissive floor and
   * says `default`.
   */
  process.env.CLIENT_CONFIG_PATH
    ? [path.resolve(process.env.CLIENT_CONFIG_PATH)]
    : [
        path.resolve(__dirname, '..', '..', '..', '..', 'config', 'client-config.json'),
        path.resolve(process.cwd(), 'config', 'client-config.json'),
      ];

/** One platform's block, or null when it is absent or in any way malformed. */
const projectPlatform = (raw: unknown): PlatformConfig | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isVersion(r.minimumSupported) || !isVersion(r.latestAvailable)) return null;
  const message = typeof r.message === 'string' && r.message.length > 0 && r.message.length <= 300
    ? r.message
    : PERMISSIVE.message;
  return { minimumSupported: r.minimumSupported, latestAvailable: r.latestAvailable, message };
};

/**
 * Only the declared fields travel, whatever else the file contains.
 *
 * Per-platform rather than all-or-nothing: one malformed iOS block must not
 * discard a valid Android recall. A platform that does not project falls back to
 * the permissive floor, and `source` still reports `config` because the file WAS
 * read — the operator's edit landed, one block of it is wrong, and saying
 * `default` there would send them looking for the wrong problem.
 */
export const project = (raw: unknown): ClientConfig => {
  if (raw === null || typeof raw !== 'object') return DEFAULT_CONFIG;
  const platformsRaw = (raw as Record<string, unknown>).platforms;
  if (platformsRaw === null || typeof platformsRaw !== 'object') return DEFAULT_CONFIG;
  const source = platformsRaw as Record<string, unknown>;
  const platforms = {} as Record<Platform, PlatformConfig>;
  let any = false;
  for (const name of PLATFORMS) {
    const projected = projectPlatform(source[name]);
    if (projected) any = true;
    platforms[name] = projected ?? { ...PERMISSIVE };
  }
  return any ? { platforms, source: 'config' } : DEFAULT_CONFIG;
};

/**
 * Seconds the answer is held in-process AND advertised as cacheable.
 *
 * Minutes, not hours: this is the lever pulled in an emergency, and the number
 * here is the floor on how long a recall takes to reach a device that has
 * already asked once. 60s in-process plus 60s downstream is a ~2 minute worst
 * case, which the runbook states as the number rather than an estimate.
 */
export const CONFIG_TTL_SECONDS = 60;

let cached: { value: ClientConfig; readAt: number } | null = null;

/** Injectable clock — a TTL tested with real sleeps is a slow, flaky test. */
let now: () => number = () => Date.now();

export const readClientConfig = (): ClientConfig => {
  if (cached && now() - cached.readAt < CONFIG_TTL_SECONDS * 1000) return cached.value;
  let value = DEFAULT_CONFIG;
  for (const file of configCandidates()) {
    try {
      value = project(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (value.source === 'config') break;
    } catch {
      // Absent, unreadable or malformed all mean the same thing to a caller:
      // no recall is configured here. The permissive floor is the safe answer,
      // and `source: 'default'` is how an operator learns it happened.
    }
  }
  cached = { value, readAt: now() };
  return value;
};

/** Test seams. The memo and the clock are process-global and would leak. */
export const __resetClientConfig = (clock: () => number = () => Date.now()): void => {
  cached = null;
  now = clock;
};

export const handlers: V1Handlers = {
  'clientConfig.read': async (req: Request, res: Response) => {
    try {
      // Short and public. A recall that sits behind a stale CDN entry for an
      // hour is a recall that arrives after the incident.
      res.set('Cache-Control', `public, max-age=${CONFIG_TTL_SECONDS}`);
      return ok(res, req, readClientConfig());
    } catch (error) {
      return sendCaught(res, req, 'clientConfig.read', error as never);
    }
  },
};
