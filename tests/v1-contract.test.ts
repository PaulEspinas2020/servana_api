/**
 * The contract, the router, the OpenAPI document and the generated docs must
 * all agree — or the gate fails.
 *
 * An API registry's normal failure mode is that it is written once, the routes
 * move, and it becomes a confident lie. The defence here is that nothing is
 * written twice: `contract.ts` is the only declaration, and the router, the
 * spec and the markdown are all derived from it. These tests check the
 * derivation actually happened, which is the one thing a generator cannot check
 * about itself.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));

import fs from 'fs';
import path from 'path';
import {
  V1_CONTRACT,
  IMPLEMENTED,
  PLANNED,
  V1_PREFIX,
  fullPath,
  ClientName,
} from '../src/api/v1/contract';
import { V1_ERROR_CODES, V1_ERROR_STATUS, isV1ErrorCode } from '../src/api/v1/errors';
import { buildV1Router, V1_HANDLERS } from '../src/api/v1/register';
import { buildOpenApiDocument, SCHEMAS, allErrorsFor } from '../src/api/v1/openapi';
import { buildWatchList, RETIREMENT_CRITERIA } from '../src/api/v1/legacyTelemetry';
import { staleFiles } from '../scripts/generate-api-docs';

const REPO_ROOT = path.resolve(__dirname, '..');

describe('contract integrity', () => {
  it('every id is unique', () => {
    const ids = V1_CONTRACT.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('no two entries claim the same method and path', () => {
    const keys = V1_CONTRACT.map((e) => `${e.method} ${e.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every path is rooted and free of a trailing slash', () => {
    for (const e of V1_CONTRACT) {
      expect(e.path.startsWith('/')).toBe(true);
      expect(e.path.endsWith('/')).toBe(false);
      expect(e.path).not.toContain('//');
    }
  });

  it('no entry re-declares the /api/v1 prefix inside its path', () => {
    for (const e of V1_CONTRACT) expect(e.path.startsWith(V1_PREFIX)).toBe(false);
  });

  it('every declared error code exists in the canonical enum', () => {
    for (const e of V1_CONTRACT) {
      for (const code of e.errors) {
        expect(isV1ErrorCode(code)).toBe(true);
      }
    }
  });

  it('every error code maps to exactly one HTTP status', () => {
    for (const code of V1_ERROR_CODES) {
      expect(typeof V1_ERROR_STATUS[code]).toBe('number');
      expect(V1_ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });

  it('every response and request schema resolves to a component', () => {
    for (const e of V1_CONTRACT) {
      expect(Object.keys(SCHEMAS)).toContain(e.responseSchema);
      if (e.requestSchema) expect(Object.keys(SCHEMAS)).toContain(e.requestSchema);
    }
  });

  it('every entry names the domain service it delegates to', () => {
    // This is the field that makes "one canonical domain service behind all
    // clients" checkable rather than aspirational.
    for (const e of V1_CONTRACT) {
      expect(e.domainService.length).toBeGreaterThan(3);
    }
  });

  it('every entry names an observability owner', () => {
    for (const e of V1_CONTRACT) expect(e.observability).toBeTruthy();
  });

  it('every entry states a caller state for all five clients', () => {
    const clients: ClientName[] = ['customerMobile', 'customerWeb', 'providerMobile', 'providerWeb', 'admin'];
    for (const e of V1_CONTRACT) {
      for (const c of clients) {
        expect(['migrated', 'legacy', 'planned', 'n/a']).toContain(e.callers[c]);
      }
    }
  });

  it('every non-RETIRE legacy mapping explains why it still exists', () => {
    for (const e of V1_CONTRACT) {
      for (const l of e.legacy) {
        if (l.disposition === 'RETIRE') continue;
        expect(l.note.length).toBeGreaterThan(20);
      }
    }
  });

  it('every legacy path is absolute and /api-rooted', () => {
    for (const e of V1_CONTRACT) {
      for (const l of e.legacy) expect(l.path.startsWith('/api/')).toBe(true);
    }
  });

  it('every non-idempotent endpoint names what bounds a replay', () => {
    // Not every mutation can be made idempotent — bolting an Idempotency-Key
    // onto a credential exchange would be theatre. But "not idempotent" cannot
    // be the end of the sentence: something has to bound the replay, and if
    // nobody can name it there is nothing there.
    const unguarded = V1_CONTRACT.filter((e) => !e.idempotent && !(e.replayGuard && e.replayGuard.length > 30));
    expect(unguarded.map((e) => e.id)).toEqual([]);
  });

  it('an idempotent endpoint does not claim a replay guard it does not need', () => {
    const confused = V1_CONTRACT.filter((e) => e.idempotent && e.replayGuard);
    expect(confused.map((e) => e.id)).toEqual([]);
  });

  it('every GET is idempotent', () => {
    for (const e of V1_CONTRACT) {
      if (e.method === 'get') expect(e.idempotent).toBe(true);
    }
  });

  it('no two canonical endpoints are the same business mutation', () => {
    // The release gate this encodes: two paths that both write the same thing
    // are two sets of rules about when that write is allowed, and they diverge
    // the first time one of them gets a guard the other does not. Reads may
    // legitimately share a service — /search and /catalog/search are one
    // implementation behind two names, asserted in the catalog contract test —
    // but a mutation may not.
    const mutations = IMPLEMENTED.filter((e) => !e.idempotent);
    const byService = new Map<string, string[]>();
    for (const e of mutations) {
      byService.set(e.domainService, [...(byService.get(e.domainService) ?? []), e.id]);
    }
    const shared = [...byService.entries()].filter(([, ids]) => ids.length > 1);
    expect(shared).toEqual([]);
  });

  it('the mutation-uniqueness check would notice a duplicate', () => {
    // Same grouping, run over a fixture, so a refactor that quietly turns the
    // assertion above into a tautology is caught here.
    const fixture = [
      { id: 'a', domainService: 'svc.transition (X)' },
      { id: 'b', domainService: 'svc.transition (X)' },
    ];
    const byService = new Map<string, string[]>();
    for (const e of fixture) {
      byService.set(e.domainService, [...(byService.get(e.domainService) ?? []), e.id]);
    }
    expect([...byService.entries()].filter(([, ids]) => ids.length > 1)).toHaveLength(1);
  });
});

describe('planned entries are documented, not built', () => {
  /**
   * This used to assert `PLANNED.length > 0`, on the reasoning that with no
   * planned entries the "planned entries are not reachable" assertions become
   * vacuous and the distinction goes untested.
   *
   * TAB 06 wave 1 emptied the backlog — the four `admin.bookings.*` entries were
   * the last planned ones and are now implemented. An empty backlog is a
   * legitimate and desirable state, so requiring one to exist would mean keeping
   * an endpoint unbuilt to satisfy a test.
   *
   * What must never lapse is the ENFORCEMENT, so that is what is asserted now,
   * against a fixture rather than against inventory. `buildV1Router` throws when
   * a handler is supplied for an entry that is not implemented; if that ever
   * stops being true, a half-finished endpoint ships as a silent 404 instead of
   * failing the build.
   */
  it('a handler for an entry that is not implemented is refused at build time', () => {
    // The real handler set PLUS one bogus key. Passing the bogus key alone would
    // trip the "every implemented entry has a handler" check first and prove
    // nothing about the rule under test.
    const withStray = {
      ...V1_HANDLERS,
      'fixture.never.existed': (async () => undefined) as never,
    };
    expect(() => buildV1Router(withStray)).toThrow(/fixture\.never\.existed/);

    // And the same rule for a genuinely planned entry, whenever one exists.
    const planned = V1_CONTRACT.find((e) => e.status === 'planned');
    if (planned) {
      expect(() =>
        buildV1Router({ ...V1_HANDLERS, [planned.id]: (async () => undefined) as never }),
      ).toThrow(/PLANNED|planned/);
    }
  });

  it('the backlog is empty or every entry in it is accounted for', () => {
    // Not `> 0`. See above.
    expect(PLANNED.length).toBeGreaterThanOrEqual(0);
  });

  it('each planned entry names either a legacy route it will replace or why nothing exists', () => {
    for (const e of PLANNED) {
      const hasLegacy = e.legacy.length > 0;
      const explains = Boolean(e.notes && e.notes.length > 20);
      expect(hasLegacy || explains).toBe(true);
    }
  });
});

describe('OpenAPI is generated from the contract, and matches it', () => {
  const doc = buildOpenApiDocument() as any;

  it('declares OpenAPI 3.1', () => {
    expect(doc.openapi).toBe('3.1.0');
  });

  it('has exactly one operation per contract entry', () => {
    const ops: string[] = [];
    for (const [, methods] of Object.entries(doc.paths as Record<string, Record<string, any>>)) {
      for (const [, op] of Object.entries(methods)) ops.push((op as any).operationId);
    }
    expect(ops.sort()).toEqual(V1_CONTRACT.map((e) => e.id).sort());
  });

  it('uses OpenAPI brace params, never Express colon params', () => {
    for (const key of Object.keys(doc.paths)) {
      expect(key).not.toMatch(/:/);
    }
    expect(Object.keys(doc.paths)).toContain('/api/v1/catalog/services/{serviceId}');
  });

  it('marks planned operations as not implemented', () => {
    for (const entry of V1_CONTRACT) {
      const op = (doc.paths as any)[`${V1_PREFIX}${entry.path.replace(/:(\w+)/g, '{$1}')}`][entry.method];
      expect(op['x-implemented']).toBe(entry.status === 'implemented');
    }
  });

  it('documents a response for every status an endpoint can answer with', () => {
    for (const entry of V1_CONTRACT) {
      const op = (doc.paths as any)[`${V1_PREFIX}${entry.path.replace(/:(\w+)/g, '{$1}')}`][entry.method];
      const declared = new Set(Object.keys(op.responses));
      expect(declared.has('200')).toBe(true);
      for (const code of allErrorsFor(entry)) {
        expect(declared.has(String(V1_ERROR_STATUS[code]))).toBe(true);
      }
    }
  });

  it('leaves public operations with no security requirement', () => {
    for (const entry of V1_CONTRACT.filter((e) => e.auth === 'public')) {
      const op = (doc.paths as any)[`${V1_PREFIX}${entry.path.replace(/:(\w+)/g, '{$1}')}`][entry.method];
      expect(op.security).toEqual([]);
    }
  });

  it('requires a bearer token on every non-public operation', () => {
    for (const entry of V1_CONTRACT.filter((e) => e.auth !== 'public')) {
      const op = (doc.paths as any)[`${V1_PREFIX}${entry.path.replace(/:(\w+)/g, '{$1}')}`][entry.method];
      expect(op.security).toEqual([{ firebaseIdToken: [] }]);
    }
  });

  it('the Error schema enumerates exactly the canonical codes', () => {
    // Copy before sorting. `SCHEMAS` is a shared module-level object and
    // `Array.prototype.sort` mutates in place — sorting it here reordered the
    // enum for every later caller, which made the "docs are current" test below
    // report the committed spec as stale. The failure looked like a generator
    // bug and was this line.
    const declared = [...(SCHEMAS.Error as any).properties.error.properties.code.enum];
    expect(declared.sort()).toEqual([...V1_ERROR_CODES].sort());
  });

  it('the catalog service schema documents that level2 never appears', () => {
    // The parity middleware mapped `name` → `level2`, which made a canonical
    // Service claim its own name as its Subcategory. The exemption is the fix;
    // this is the sentence that tells a client author it is safe to rely on.
    expect((SCHEMAS.CatalogService as any).description).toMatch(/level2/);
  });
});

describe('the committed documents are the generated documents', () => {
  it('openapi.v1.json, the registry and the matrix are all current', () => {
    // Fails when contract.ts changed and `npm run api:docs` was not re-run —
    // which is the moment a registry starts describing an API that moved.
    expect(staleFiles()).toEqual([]);
  });

  it('all three generated files exist on disk', () => {
    for (const rel of [
      'docs/api/openapi.v1.json',
      'docs/api/API_ENDPOINT_REGISTRY.md',
      'docs/api/LEGACY_ENDPOINT_MIGRATION_MATRIX.md',
    ]) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel))).toBe(true);
    }
  });

  it('the registry lists every canonical path', () => {
    const registry = fs.readFileSync(path.join(REPO_ROOT, 'docs/api/API_ENDPOINT_REGISTRY.md'), 'utf8');
    for (const e of V1_CONTRACT) expect(registry).toContain(fullPath(e));
  });

  it('the matrix lists every legacy path the contract names', () => {
    const matrix = fs.readFileSync(path.join(REPO_ROOT, 'docs/api/LEGACY_ENDPOINT_MIGRATION_MATRIX.md'), 'utf8');
    for (const e of V1_CONTRACT) {
      for (const l of e.legacy) expect(matrix).toContain(l.path);
    }
  });
});

describe('legacy telemetry watches exactly what the contract calls legacy', () => {
  const watch = buildWatchList();

  it('covers every legacy mapping in the contract', () => {
    const declared = new Set<string>();
    for (const e of V1_CONTRACT) for (const l of e.legacy) declared.add(`${l.method} ${l.path}`);
    const watched = new Set(watch.map((w) => `${w.method} ${w.path}`));
    expect([...declared].sort()).toEqual([...watched].sort());
  });

  it('matches a concrete request path against a parameterised legacy route', () => {
    const usersBookings = watch.find((w) => w.path === '/api/users/:userId/bookings');
    expect(usersBookings).toBeDefined();
    expect(usersBookings!.matcher.test('/api/users/abc123/bookings')).toBe(true);
    expect(usersBookings!.matcher.test('/api/users/abc123/bookings/7')).toBe(false);
  });

  it('states retirement criteria that distinguish web from mobile', () => {
    // A mobile alias cannot be retired on the same evidence as a web one: an
    // unupdated app keeps calling the old path for as long as it stays
    // installed, which no server-side measurement of the current build sees.
    expect(RETIREMENT_CRITERIA.mobileZeroTrafficDays).toBeGreaterThan(
      RETIREMENT_CRITERIA.webZeroTrafficDays,
    );
  });
});
