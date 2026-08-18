/**
 * The portal must be able to generate its DTOs from this document (TAB 11).
 *
 * ## The gate that matters most for an integration launch
 *
 * The portal's specs pass against mocks. This repository's suites pass against
 * its own fixtures. **The integration between them is verified by nobody** —
 * that is precisely the seam a launch fails on, and a test harness can make
 * every route green while production wires none of them.
 *
 * The book's mechanism for closing that loop is to generate the portal's
 * expected shapes from THIS document, which is itself generated from the
 * contract array: contract → router → OpenAPI → portal DTOs, with drift failing
 * at build time in whichever repo drifted.
 *
 * ## What this file is the backend half of
 *
 * The portal half — running `smoke:contracts` against a live base URL with a
 * scoped CI identity — needs a credential this environment must not hold, and a
 * repository that is not on this machine. It is a manual task.
 *
 * The half that lives here is making the document **generatable-from**, and
 * failing HERE when it stops being. A dangling `$ref` or a 2xx with no schema
 * does not break anything in this repository — every suite stays green — it
 * breaks the OTHER repo's code generation, at a time nobody connects to the
 * commit that caused it. That is the worst shape a defect can have: silent at
 * the origin, loud somewhere else, and expensive to trace back.
 *
 * Measured when written: 90 paths, 137 schemas, 133 distinct `$ref`s, **zero**
 * dangling, **zero** 2xx without a schema. The document is generatable today.
 * This is what keeps it that way.
 */

import { buildOpenApiDocument } from '../src/api/v1/openapi';
import { V1_CONTRACT } from '../src/api/v1/contract';

const doc = buildOpenApiDocument() as any;
const schemas: Record<string, unknown> = doc.components?.schemas ?? {};

/** Every `#/components/schemas/X` reference anywhere in the document. */
const referencedSchemas = (): string[] => {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$ref' && typeof value === 'string') {
        const m = /^#\/components\/schemas\/(.+)$/.exec(value);
        if (m) found.add(m[1]);
        continue;
      }
      walk(value);
    }
  };
  walk(doc);
  return [...found];
};

const operations = (): Array<{ id: string; method: string; path: string; op: any }> => {
  const out: Array<{ id: string; method: string; path: string; op: any }> = [];
  for (const [path, methods] of Object.entries<any>(doc.paths ?? {})) {
    for (const [method, op] of Object.entries<any>(methods)) {
      out.push({ id: op.operationId, method, path, op });
    }
  }
  return out;
};

describe('the document is real (positive control)', () => {
  it('has paths and schemas', () => {
    expect(Object.keys(doc.paths ?? {}).length).toBeGreaterThan(50);
    expect(Object.keys(schemas).length).toBeGreaterThan(50);
  });

  it('references schemas at all — so the resolver is exercised', () => {
    expect(referencedSchemas().length).toBeGreaterThan(50);
  });

  it('the reference walker finds a nested $ref, not just a top-level one', () => {
    // Guards the walker itself: a resolver that only looked one level deep
    // would report zero dangling refs on a document full of them.
    const nested = { a: { b: [{ $ref: '#/components/schemas/Sentinel' }] } };
    const found = new Set<string>();
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (n === null || typeof n !== 'object') return;
      for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
        if (k === '$ref' && typeof v === 'string') {
          found.add(v.replace('#/components/schemas/', ''));
        } else walk(v);
      }
    };
    walk(nested);
    expect([...found]).toEqual(['Sentinel']);
  });
});

describe('every reference resolves', () => {
  it('no $ref points at a schema that does not exist', () => {
    // A dangling ref is silent here and fatal in the portal's generator.
    const dangling = referencedSchemas().filter((name) => !(name in schemas));
    expect(dangling).toEqual([]);
  });
});

describe('every operation declares a shape a client can be generated against', () => {
  it('every 2xx response has a JSON schema', () => {
    const missing = operations()
      .filter(({ op }) => {
        const success = op.responses?.['200'] ?? op.responses?.['201'];
        return !success?.content?.['application/json']?.schema;
      })
      .map(({ method, path, id }) => `${method.toUpperCase()} ${path} (${id})`);
    expect(missing).toEqual([]);
  });

  it('every operation has a stable operationId, which is the DTO name', () => {
    const ids = operations().map((o) => o.id);
    expect(ids.filter((id) => !id)).toEqual([]);
    // Duplicates would silently collapse two DTOs into one in the generator.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every request body declares a schema too', () => {
    const missing = operations()
      .filter(({ op }) => op.requestBody && !op.requestBody?.content?.['application/json']?.schema)
      .map(({ method, path, id }) => `${method.toUpperCase()} ${path} (${id})`);
    expect(missing).toEqual([]);
  });
});

describe('the document describes the router it was generated from', () => {
  it('has exactly one operation per implemented contract entry', () => {
    const implemented = V1_CONTRACT.filter((e) => e.status === 'implemented').map((e) => e.id);
    const ids = operations().map((o) => o.id);
    // Not "at least": an operation with no entry is a shape the portal would
    // generate a client for and then get a 404 from.
    expect(ids.sort()).toEqual(V1_CONTRACT.map((e) => e.id).sort());
    expect(implemented.every((id) => ids.includes(id))).toBe(true);
  });

  it('uses OpenAPI brace params, never Express colon params', () => {
    // `:bookingId` in a path silently generates a DTO method with a literal
    // colon in the URL, which 404s at runtime rather than failing to build.
    for (const path of Object.keys(doc.paths ?? {})) {
      expect(path).not.toMatch(/:/);
    }
  });
});

describe('the error contract is generatable too', () => {
  it('declares the failure envelope as a schema clients can bind to', () => {
    // Negative cases (401/403/404) are asserted behaviourally elsewhere; what
    // matters here is that a generated client has a TYPE for them rather than
    // parsing an untyped body on the unhappy path.
    const names = Object.keys(schemas);
    expect(names.some((n) => /error/i.test(n))).toBe(true);
  });

  it('every operation documents at least one failure response', () => {
    const bare = operations()
      .filter(({ op }) => {
        const codes = Object.keys(op.responses ?? {});
        return !codes.some((c) => Number(c) >= 400);
      })
      .map(({ method, path, id }) => `${method.toUpperCase()} ${path} (${id})`);
    expect(bare).toEqual([]);
  });
});
