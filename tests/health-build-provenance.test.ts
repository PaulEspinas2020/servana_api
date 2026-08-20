/**
 * The build must be able to name itself, and must say nothing else.
 *
 * `deploy.yml` has always stamped `dist/BUILD_INFO.json`; nothing read it, so
 * "which commit is production serving?" could only be answered with a shell.
 * That matters because a deploy whose migration step fails stops short of the
 * PM2 restart by design — the push succeeds and the old code keeps serving, and
 * from outside that is indistinguishable from a deploy that worked.
 *
 * Two properties are asserted, and the second is the one that keeps this
 * endpoint safe to leave public: it projects FOUR fields and drops everything
 * else the file happens to contain.
 */

import fs from 'fs';
import { readBuildInfo, __clearBuildInfoCache } from '../src/api/v1/domains/health';
import { V1_CONTRACT } from '../src/api/v1/contract';

const asFile = (payload: unknown) => {
  jest.spyOn(fs, 'readFileSync').mockImplementation(() => JSON.stringify(payload) as never);
};

beforeEach(() => {
  __clearBuildInfoCache();
  jest.restoreAllMocks();
});
afterEach(() => {
  __clearBuildInfoCache();
  jest.restoreAllMocks();
});

describe('the running build names its commit', () => {
  it('reports the stamped commit', () => {
    asFile({ commit: 'abc1234', ref: 'refs/heads/main', builtAt: '2026-08-19T10:00:00Z', run: '42' });
    expect(readBuildInfo()).toEqual({
      commit: 'abc1234', ref: 'refs/heads/main', builtAt: '2026-08-19T10:00:00Z', run: '42', available: true,
    });
  });

  it('projects ONLY the four fields, whatever else the file carries', () => {
    // The safety property. A stamp that grew an env dump must not become a
    // public disclosure just because it sits in the same file.
    asFile({
      commit: 'abc1234', ref: 'refs/heads/main', builtAt: 'x', run: '1',
      DB_PASSWORD: 'hunter2', env: { SECRET: 'nope' }, nodeVersion: 'v24.19.0',
    });
    const out = readBuildInfo();
    expect(Object.keys(out).sort()).toEqual(['available', 'builtAt', 'commit', 'ref', 'run']);
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).not.toContain('nodeVersion');
  });

  it('answers 200-shaped "unknown" when no stamp exists, rather than throwing', () => {
    // First deploy on a host, or a cleaned workspace. Absence is information; a
    // health endpoint that fails about itself is worse than one that says "I do
    // not know".
    jest.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('ENOENT'); });
    expect(readBuildInfo()).toEqual({ commit: null, ref: null, builtAt: null, run: null, available: false });
  });

  it('treats a malformed stamp as absent rather than propagating it', () => {
    jest.spyOn(fs, 'readFileSync').mockImplementation(() => '{not json' as never);
    expect(readBuildInfo().available).toBe(false);
  });

  it('refuses an over-long value rather than echoing it', () => {
    asFile({ commit: 'x'.repeat(500), ref: null, builtAt: null, run: null });
    expect(readBuildInfo().commit).toBeNull();
  });
});

describe('the contract entry stays public and stays narrow', () => {
  const entry = () => V1_CONTRACT.find((e) => e.id === 'health.build');

  it('is implemented, public, and needs no credential', () => {
    // A provenance check that needs a credential can only be run by someone who
    // already has one — which is the situation it exists to fix.
    expect(entry()).toBeDefined();
    expect(entry()!.auth).toBe('public');
    expect(entry()!.status).toBe('implemented');
    expect(entry()!.method).toBe('get');
    expect(entry()!.path).toBe('/health');
  });

  it('carries no capability, permission or active-provider gate', () => {
    const e = entry() as unknown as Record<string, unknown>;
    expect(e.capability).toBeUndefined();
    expect(e.permission).toBeUndefined();
    expect(e.activeProvider).toBeUndefined();
  });
});
