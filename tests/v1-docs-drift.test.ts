/**
 * The hand-written API documents may not contradict the contract.
 *
 * `tests/v1-contract.test.ts` already proves the GENERATED documents are
 * current. The generated ones were never the problem. The prose was:
 * `API_V1_CONTRACT.md` said "Six planned entries exist today" and named
 * `/auth/refresh` and `/search` among them months after both went live, and
 * `CROSS_CLIENT_MIGRATION_PLAN.md` claimed "18 canonical endpoints" when there
 * were 42 and "22 aliases" when there were 42. Every gate was green the whole
 * time, because nothing derived a countable claim from the contract.
 *
 * Two defences, and this file is the second half of both.
 *
 *   1. Countable claims moved INSIDE `<!-- BEGIN GENERATED: ... -->` regions
 *      that `npm run api:docs` rewrites. This file asserts the regions exist,
 *      are non-empty, and are current — a marker whose body was never rendered
 *      is the worst of both worlds, because the document reads as machine-kept
 *      and is not.
 *
 *   2. Every `/api/v1/...` path NAMED anywhere in `docs/api` must resolve to a
 *      contract entry. That catches the other rot: prose that invents a path,
 *      keeps one after it is renamed, or promises one that was never built.
 *
 * What it deliberately does not do is grade the prose. Whether a sentence is
 * still good advice is a human judgement; whether the path it names exists is
 * not, and only the second is worth a test.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));

import fs from 'fs';
import path from 'path';
import { V1_CONTRACT, fullPath } from '../src/api/v1/contract';
import { EXPECTED_REGIONS, renderRegions } from '../scripts/generate-api-docs';
import { tempWorkspace } from './support/tempWorkspace';

const REPO_ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs', 'api');

const read = (relPath: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8').replace(/\r\n/g, '\n');

const markdownFiles = (): string[] =>
  fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => `docs/api/${f}`);

/**
 * Path shapes the contract and the prose spell differently but mean the same.
 *
 * A parameter's NAME is not part of the route — `/reviews/providers/:uid` and
 * `/reviews/providers/:providerUid` are one endpoint, and failing a document
 * over that would train people to stop trusting the test.
 */
const normalise = (p: string): string =>
  p
    .replace(/\{[^}]+\}/g, ':x') // OpenAPI brace form
    .replace(/:[A-Za-z0-9_]+/g, ':x')
    .replace(/\/$/, '');

const CONTRACT_PATHS = new Set(V1_CONTRACT.map((e) => normalise(fullPath(e))));

/**
 * Every `/api/v1/...` a document names as an ENDPOINT.
 *
 * Excluded: source-file links (`../../src/api/v1/contract.ts`, and the
 * `file.ts:143` form the matrix cites — the same substring, a different kind of
 * thing), and namespace mentions that end in a slash or a wildcard
 * (`/api/v1/auth/*`), which name a family rather than a route.
 */
function citedPaths(markdown: string): string[] {
  const found = markdown.match(/\/api\/v1\/[A-Za-z0-9_:{}./*-]*/g) ?? [];
  return [...new Set(found)]
    .map((raw) => raw.replace(/[.,;:)]+$/, ''))
    .filter((p) => !/\.(ts|json|ya?ml|js)(:\d+)?$/.test(p))
    .filter((p) => !p.endsWith('/') && !p.endsWith('*'))
    .filter((p) => p !== '/api/v1');
}

describe('every v1 path the documents name exists in the contract', () => {
  for (const relPath of markdownFiles()) {
    it(`${relPath} cites no endpoint that does not exist`, () => {
      const unknown = citedPaths(read(relPath)).filter((p) => !CONTRACT_PATHS.has(normalise(p)));
      expect(unknown).toEqual([]);
    });
  }

  it('the check can actually fail — a renamed path is caught', () => {
    const unknown = citedPaths('See `GET /api/v1/catalog/servicez` for details.').filter(
      (p) => !CONTRACT_PATHS.has(normalise(p)),
    );
    expect(unknown).toEqual(['/api/v1/catalog/servicez']);
  });

  it('a differently-named path parameter is not a failure', () => {
    expect(normalise('/api/v1/reviews/providers/:uid')).toBe(
      normalise('/api/v1/reviews/providers/:providerUid'),
    );
  });

  it('a source-file link is not read as an endpoint', () => {
    expect(citedPaths('[`contract.ts`](../../src/api/v1/contract.ts)')).toEqual([]);
  });
});

describe('the generated regions inside the hand-written documents', () => {
  for (const [relPath, regions] of Object.entries(EXPECTED_REGIONS)) {
    describe(relPath, () => {
      const source = read(relPath);

      for (const name of regions) {
        it(`has a "${name}" region, opened and closed`, () => {
          expect(source).toContain(`<!-- BEGIN GENERATED: ${name} -->`);
          expect(source).toContain(`<!-- END GENERATED: ${name} -->`);
        });

        it(`"${name}" has a rendered body`, () => {
          const begin = source.indexOf(`<!-- BEGIN GENERATED: ${name} -->`);
          const end = source.indexOf(`<!-- END GENERATED: ${name} -->`);
          expect(begin).toBeGreaterThan(-1);
          expect(end).toBeGreaterThan(begin);
          const body = source.slice(begin, end).split('\n').slice(1).join('\n').trim();
          expect(body.length).toBeGreaterThan(0);
        });
      }

      it('is current — every region matches what the contract renders', () => {
        expect(renderRegions(relPath)).toBe(source);
      });

      it('carries no marker outside the expected set', () => {
        // Line-anchored, exactly like the parser in generate-api-docs.ts. A
        // marker quoted mid-sentence — this document explains the mechanism
        // and so contains one — is prose, not a region, and both must agree
        // about that or the check disagrees with the thing it is checking.
        const names = [...source.matchAll(/^[ \t]*<!-- BEGIN GENERATED: ([^\s]+) -->[ \t]*$/gm)].map((m) => m[1]);
        expect(names.sort()).toEqual([...regions].sort());
      });
    });
  }

  it('a malformed marker is a throw, not a silent pass-through', () => {
    // The bug this test exists for: the first parser accepted only lowercase
    // region names, so `v1-moves:providerWeb` was copied through as ordinary
    // text with an empty body, and `--check` stayed green.
    // Written to an untracked scratch directory, not into `docs/api/`. An
    // interrupted run used to leave a fixture inside a tracked directory.
    const workspace = tempWorkspace('drift-malformed-marker');
    try {
      const fixture = workspace.write(
        'fixture.md',
        '<!-- BEGIN GENERATED: not a region name -->\n<!-- END GENERATED -->\n',
      );
      expect(() => renderRegions(fixture.relative)).toThrow(/malformed region marker/);
    } finally {
      workspace.cleanup();
    }
  });

  it('an unknown region name is a throw', () => {
    const workspace = tempWorkspace('drift-unknown-region');
    try {
      const fixture = workspace.write(
        'fixture.md',
        '<!-- BEGIN GENERATED: v1-nonexistent -->\n<!-- END GENERATED: v1-nonexistent -->\n',
      );
      expect(() => renderRegions(fixture.relative)).toThrow(/unknown generated region/);
    } finally {
      workspace.cleanup();
    }
  });
});
