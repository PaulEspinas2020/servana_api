/**
 * The client recall lever (TAB 02).
 *
 * The worker app's forced-update check fails CLOSED — an unreadable answer
 * blocks the app. That makes this endpoint's failure behaviour more load-bearing
 * than its success behaviour: a response this file lets through in a broken shape
 * is an app that will not open, on a device nobody can reach.
 *
 * So the assertions below spend most of their effort on what happens when the
 * configuration is missing, malformed, half-malformed, or hostile — and only a
 * little on the happy path.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  compareVersions,
  isSupported,
  isVersion,
  project,
  readClientConfig,
  configCandidates,
  __resetClientConfig,
  CONFIG_TTL_SECONDS,
  PLATFORMS,
} from '../src/api/v1/domains/clientConfig';
import { V1_CONTRACT } from '../src/api/v1/contract';

const write = (dir: string, body: unknown): string => {
  // Every caller passes a `mkdtempSync` directory under os.tmpdir(). Enforced
  // rather than assumed: a test that writes into the checkout is how a gate
  // starts depending on a file the next clean run does not have.
  if (!dir.startsWith(os.tmpdir())) throw new Error(`refusing to write outside os.tmpdir(): ${dir}`);
  const file = path.join(dir, 'client-config.json');
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
};

let tmp: string;
const originalPath = process.env.CLIENT_CONFIG_PATH;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'client-config-'));
  __resetClientConfig();
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.CLIENT_CONFIG_PATH;
  else process.env.CLIENT_CONFIG_PATH = originalPath;
  __resetClientConfig();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * The four cases the TAB names. They are asserted against the exported
 * comparator because that function IS the contract the client's own check must
 * match — a paragraph describing the rule would drift from it, a tested function
 * cannot.
 */
describe('the version comparison a client must implement', () => {
  const MINIMUM = '2.4.0';

  it('below the minimum is not supported', () => {
    expect(isSupported('2.3.9', MINIMUM)).toBe(false);
    expect(isSupported('1.9.9', MINIMUM)).toBe(false);
    expect(compareVersions('2.3.9', MINIMUM)).toBe(-1);
  });

  it('EXACTLY at the minimum is supported — the off-by-one that strands a whole release', () => {
    expect(isSupported('2.4.0', MINIMUM)).toBe(true);
    expect(compareVersions('2.4.0', MINIMUM)).toBe(0);
  });

  it('above the minimum is supported', () => {
    expect(isSupported('2.4.1', MINIMUM)).toBe(true);
    expect(isSupported('10.0.0', MINIMUM)).toBe(true);
  });

  it('compares segments numerically, not as strings', () => {
    // '10' < '9' as text. A lexical comparator recalls every user of v10 the day
    // v9 is the floor, and it looks correct in every single-digit test.
    expect(compareVersions('10.0.0', '9.0.0')).toBe(1);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.0.10', '1.0.9')).toBe(1);
  });

  it('throws on a malformed version rather than guessing', () => {
    for (const bad of ['1.2', '1.2.3.4', 'v1.2.3', '1.2.3-beta', '', 'latest', '01.2.3', '1.2.x']) {
      expect(isVersion(bad)).toBe(false);
      expect(() => compareVersions(bad, '1.0.0')).toThrow(TypeError);
    }
  });
});

describe('the endpoint fails OPEN, because the client fails closed', () => {
  it('serves a permissive floor when no configuration file exists', () => {
    process.env.CLIENT_CONFIG_PATH = path.join(tmp, 'nothing-here.json');
    const config = readClientConfig();
    expect(config.source).toBe('default');
    for (const p of PLATFORMS) expect(config.platforms[p].minimumSupported).toBe('0.0.0');
    // The floor must block nobody: every real version is at or above it.
    expect(isSupported('1.0.0', config.platforms.ios.minimumSupported)).toBe(true);
  });

  it.each([
    ['unparseable JSON', '{ not json'],
    ['an array', '[]'],
    ['a bare string', '"blocked"'],
    ['null', 'null'],
    ['no platforms key', '{"other":1}'],
    ['platforms is not an object', '{"platforms":"all"}'],
  ])('serves the permissive floor for %s', (_label, body) => {
    process.env.CLIENT_CONFIG_PATH = write(tmp, body);
    const config = readClientConfig();
    expect(config.source).toBe('default');
    expect(config.platforms.android.minimumSupported).toBe('0.0.0');
  });

  it('never emits a version the comparator would throw on', () => {
    // The client parses what this returns. A malformed value here is an
    // unreadable answer, and an unreadable answer blocks the app.
    process.env.CLIENT_CONFIG_PATH = write(tmp, {
      platforms: { ios: { minimumSupported: 'garbage', latestAvailable: '1.2', message: 5 } },
    });
    const config = readClientConfig();
    for (const p of PLATFORMS) {
      expect(isVersion(config.platforms[p].minimumSupported)).toBe(true);
      expect(isVersion(config.platforms[p].latestAvailable)).toBe(true);
      expect(typeof config.platforms[p].message).toBe('string');
    }
  });

  it('one malformed platform does not discard a valid recall on the other', () => {
    process.env.CLIENT_CONFIG_PATH = write(tmp, {
      platforms: {
        ios: { minimumSupported: 'nope' },
        android: { minimumSupported: '3.0.0', latestAvailable: '3.1.0', message: 'Update required.' },
      },
    });
    const config = readClientConfig();
    expect(config.source).toBe('config');
    expect(config.platforms.android.minimumSupported).toBe('3.0.0');
    expect(config.platforms.ios.minimumSupported).toBe('0.0.0');
  });
});

describe('raising the minimum takes effect without a deploy or a restart', () => {
  it('serves the new floor once the TTL expires, in ONE process', () => {
    let clock = 1_000_000;
    __resetClientConfig(() => clock);
    const file = write(tmp, {
      platforms: {
        ios: { minimumSupported: '1.0.0', latestAvailable: '1.0.0', message: 'ok' },
        android: { minimumSupported: '1.0.0', latestAvailable: '1.0.0', message: 'ok' },
      },
    });
    process.env.CLIENT_CONFIG_PATH = file;

    expect(readClientConfig().platforms.ios.minimumSupported).toBe('1.0.0');
    expect(isSupported('1.0.0', readClientConfig().platforms.ios.minimumSupported)).toBe(true);

    // The operator edits the file. No restart, no deploy, no import re-evaluated.
    write(tmp, {
      platforms: {
        ios: { minimumSupported: '2.0.0', latestAvailable: '2.0.0', message: 'Update required.' },
        android: { minimumSupported: '2.0.0', latestAvailable: '2.0.0', message: 'Update required.' },
      },
    });

    // Within the TTL the old answer still stands — that IS the recall latency,
    // and it is asserted rather than assumed so the runbook's number is real.
    expect(readClientConfig().platforms.ios.minimumSupported).toBe('1.0.0');

    clock += CONFIG_TTL_SECONDS * 1000 + 1;
    expect(readClientConfig().platforms.ios.minimumSupported).toBe('2.0.0');
    expect(isSupported('1.0.0', readClientConfig().platforms.ios.minimumSupported)).toBe(false);
    expect(readClientConfig().platforms.ios.message).toBe('Update required.');
  });

  it('holds the answer within the TTL rather than reading the file per request', () => {
    let clock = 5_000;
    __resetClientConfig(() => clock);
    process.env.CLIENT_CONFIG_PATH = write(tmp, {
      platforms: { ios: { minimumSupported: '1.2.3', latestAvailable: '1.2.3', message: 'ok' } },
    });
    expect(readClientConfig().platforms.ios.minimumSupported).toBe('1.2.3');
    fs.rmSync(process.env.CLIENT_CONFIG_PATH as string);
    clock += CONFIG_TTL_SECONDS * 1000 - 1;
    expect(readClientConfig().platforms.ios.minimumSupported).toBe('1.2.3');
  });

  it('is a short TTL — minutes, not hours', () => {
    expect(CONFIG_TTL_SECONDS).toBeLessThanOrEqual(300);
    expect(CONFIG_TTL_SECONDS).toBeGreaterThan(0);
  });

  it('prefers an operator-supplied path over anything the release shipped', () => {
    process.env.CLIENT_CONFIG_PATH = '/etc/servana/client-config.json';
    expect(configCandidates()[0]).toBe('/etc/servana/client-config.json');
  });
});

describe('it is not a feature-flag service', () => {
  /**
   * The refusal the TAB names, made checkable. This endpoint is
   * UNAUTHENTICATED, so every key added here is published to the world and
   * becomes a second source of truth for behaviour. Adding one has to be
   * argued for, not merged.
   */
  it('carries only the declared keys, whatever the file contains', () => {
    process.env.CLIENT_CONFIG_PATH = write(tmp, {
      platforms: {
        ios: {
          minimumSupported: '1.0.0',
          latestAvailable: '1.0.0',
          message: 'ok',
          enableNewPayments: true,
          apiSecret: 'sk_live_should_never_travel',
        },
      },
      featureFlags: { betaChat: true },
    });
    const config = readClientConfig();
    expect(Object.keys(config).sort()).toEqual(['platforms', 'source']);
    expect(Object.keys(config.platforms).sort()).toEqual(['android', 'ios']);
    for (const p of PLATFORMS) {
      expect(Object.keys(config.platforms[p]).sort()).toEqual(['latestAvailable', 'message', 'minimumSupported']);
    }
    expect(JSON.stringify(config)).not.toContain('sk_live');
    expect(JSON.stringify(config)).not.toContain('betaChat');
  });
});

describe('the contract entry', () => {
  const entry = V1_CONTRACT.find((e) => e.id === 'clientConfig.read');

  it('exists and is mounted', () => {
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('implemented');
  });

  it('is reachable without a credential — the client being recalled may not have one', () => {
    expect(entry?.auth).toBe('public');
  });

  it('is idempotent and cacheable', () => {
    expect(entry?.idempotent).toBe(true);
    expect(entry?.method).toBe('get');
  });

  it('is named for the worker app, which is the client that needs it', () => {
    expect(entry?.callers.providerMobile).toBe('planned');
  });
});
