/**
 * Canonical v1 routes must not be touched by global field rewriting.
 *
 * ## What is being defended
 *
 * `parityMiddleware` adds cross-platform aliases to every JSON response, and
 * `requestParityMiddleware` does the same to every incoming body. They exist
 * because five clients spell the same concept five ways, and on the legacy tree
 * they are load-bearing.
 *
 * On v1 they would be a contradiction. v1 publishes an explicit DTO per
 * endpoint and an OpenAPI document generated from it; a middleware that adds
 * keys makes that document false the moment it runs. It is not hypothetical —
 * parity maps `name` → `level2`, and on the admin catalog it made a canonical
 * Service come back claiming its own name as its Subcategory, which a
 * production smoke found and a unit test could not.
 *
 * ## Why this test reads source rather than sending a request
 *
 * The exemption lives in `app.ts`, and importing `app.ts` starts a listener,
 * opens Postgres, initialises Firebase and registers cron jobs. The behavioural
 * half is covered in `v1-router.test.ts`, which mounts the real v1 router and
 * asserts the exact response shape. What can only be checked here is that the
 * middleware in `app.ts` is wired to skip the prefix — and that is a property of
 * the composition root, which is text.
 *
 * Read by lines and regex, never by byte offset: a fixed-window read over
 * source is what makes this class of test pass on LF and fail on CRLF.
 */

import fs from 'fs';
import path from 'path';
import { V1_PREFIX } from '../src/api/v1/contract';

const APP_TS = fs
  .readFileSync(path.resolve(__dirname, '..', 'src', 'app.ts'), 'utf8')
  .replace(/\r\n/g, '\n');

/** Lines between the first occurrence of `marker` and the next blank-line gap. */
const blockAfter = (marker: string, lines = 14): string => {
  const all = APP_TS.split('\n');
  const start = all.findIndex((l) => l.includes(marker));
  expect(start).toBeGreaterThan(-1);
  return all.slice(start, start + lines).join('\n');
};

describe('response parity skips the canonical namespace', () => {
  it('the exemption list names /api/v1', () => {
    const match = /CANONICAL_CONTRACT_PREFIXES\s*=\s*\[([^\]]*)\]/.exec(APP_TS);
    expect(match).not.toBeNull();
    expect(match![1]).toContain(V1_PREFIX);
  });

  it('the exemption list still covers the two catalog prefixes it already protected', () => {
    const match = /CANONICAL_CONTRACT_PREFIXES\s*=\s*\[([^\]]*)\]/.exec(APP_TS);
    expect(match![1]).toContain('/api/admin/catalog');
    expect(match![1]).toContain('/api/catalog');
  });

  it('parityMiddleware is called only after the prefix check', () => {
    const block = blockAfter('CANONICAL_CONTRACT_PREFIXES.some');
    expect(block).toMatch(/return next\(\)/);
    expect(block).toMatch(/parityMiddleware\(req, res, next\)/);
    // The guard must come first; an unconditional call would rewrite v1.
    expect(block.indexOf('return next()')).toBeLessThan(block.indexOf('parityMiddleware(req, res, next)'));
  });

  it('parityMiddleware is never mounted unconditionally', () => {
    // `app.use(parityMiddleware)` with no wrapper would apply it everywhere and
    // silently defeat the whole exemption.
    expect(APP_TS).not.toMatch(/app\.use\(\s*parityMiddleware\s*\)/);
  });
});

describe('request parity skips the canonical namespace', () => {
  it('requestParityMiddleware is guarded by a /api/v1 prefix check', () => {
    expect(APP_TS).not.toMatch(/app\.use\(\s*requestParityMiddleware\s*\)/);
    const block = blockAfter("req.path.startsWith('/api/v1')");
    expect(block).toMatch(/requestParityMiddleware\(req, res, next\)/);
  });
});

describe('the guard is honest about what it protects', () => {
  it('every implemented v1 path begins with the exempt prefix', () => {
    // The exemption is by string prefix. If a v1 route were ever mounted
    // somewhere else, it would be documented as exempt and would not be.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { IMPLEMENTED, fullPath } = require('../src/api/v1/contract');
    for (const entry of IMPLEMENTED) {
      expect(fullPath(entry).startsWith(V1_PREFIX)).toBe(true);
    }
  });

  it('app.ts mounts the v1 router at exactly the exempt prefix', () => {
    expect(APP_TS).toMatch(/app\.use\("\/api\/v1",\s*cors\(corsOptionsDelegate\),\s*v1Router\)/);
  });
});
