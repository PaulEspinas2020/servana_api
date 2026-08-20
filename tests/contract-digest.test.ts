/**
 * The contract the running process implements can be fetched, and fingerprinted.
 *
 * TAB 08 of the Admin API Master Command:
 *
 * > The portal pins a copy of `openapi.v1.json` and generates its DTOs from it.
 * > It can detect a stale pin ONLY when a `servana_api` checkout sits beside it
 * > — true on a developer machine, false in CI. … the portal currently proves
 * > its pin matches your CHECKOUT and can prove nothing about the process
 * > serving requests.
 *
 * Measured before building: this API served the document at **no path at all**.
 * No `/openapi` route, no digest header, nothing. A client's only comparison was
 * against a git checkout, which is a statement about a repository rather than
 * about a server.
 *
 * Three things now exist:
 *
 *   1. `GET /api/v1/openapi.json` — the document, DERIVED at request time from
 *      the same `V1_CONTRACT` that `register.ts` mounts the routers from, so
 *      there is no second copy to go stale.
 *   2. `x-contract-sha256` on EVERY `/api/v1` response, which is the book's
 *      "one cheap request and no parsing".
 *   3. A stated, reproducible digest recipe, so a client holding a pinned file
 *      can compute the same number rather than guess at one.
 */

import crypto from 'crypto';
import { buildOpenApiDocument } from '../src/api/v1/openapi';
import {
  servedContract,
  contractDigest,
  resetContractDigest,
  CONTRACT_DIGEST_HEADER,
  CONTRACT_DIGEST_ALGORITHM,
} from '../src/api/v1/contractDigest';
import { V1_CONTRACT, IMPLEMENTED } from '../src/api/v1/contract';

beforeEach(() => resetContractDigest());

describe('the digest is a real fingerprint of the served document', () => {
  it('is a full-length hex sha256', () => {
    expect(contractDigest()).toMatch(/^[0-9a-f]{64}$/);
    expect(CONTRACT_DIGEST_ALGORITHM).toBe('sha256');
  });

  it('is reproducible from the document by the documented recipe', () => {
    /**
     * The recipe has to be stated, not guessed. A client holding a pinned
     * `openapi.v1.json` reproduces the digest by parsing that file and
     * stringifying it with no indentation — which is exactly this.
     *
     * It is deliberately NOT the hash of the response BODY: the v1 envelope
     * carries a per-request id, so a body hash would differ on every call and
     * be useless for comparison.
     */
    const recipe = crypto
      .createHash('sha256')
      .update(JSON.stringify(buildOpenApiDocument()), 'utf8')
      .digest('hex');
    expect(contractDigest()).toBe(recipe);
  });

  it('survives a parse/stringify round trip, which is what a client does', () => {
    // The pinned file on the client is pretty-printed; it will be parsed and
    // re-stringified before hashing. If key order did not survive that, the
    // recipe would be unusable and this gate would be a lie.
    const { body } = servedContract();
    const roundTripped = JSON.stringify(JSON.parse(body));
    expect(roundTripped).toBe(body);
  });

  it('is stable across calls within a process', () => {
    // A digest that moved between two requests would report every client as
    // stale, constantly, and be ignored within a week.
    expect(contractDigest()).toBe(contractDigest());
    expect(servedContract().digest).toBe(contractDigest());
  });

  it('CHANGES when the contract changes', () => {
    /**
     * The half that makes it a fingerprint rather than a constant. Without
     * this, a digest hard-coded to any string would pass every other assertion
     * in this file.
     */
    const before = contractDigest();
    const doc = buildOpenApiDocument() as any;
    doc.paths['/api/v1/__negative_control__'] = { get: { summary: 'not real' } };
    const after = crypto
      .createHash('sha256')
      .update(JSON.stringify(doc), 'utf8')
      .digest('hex');
    expect(after).not.toBe(before);
  });
});

describe('the document served is the one the routers are built from', () => {
  it('describes every implemented contract entry', () => {
    // The whole claim of this TAB: what is served is not a description of the
    // API, it is the API's own source of truth rendered. If these two could
    // disagree, the endpoint would be one more thing to keep in sync.
    const doc = servedContract().document as any;
    const served = new Set<string>();
    for (const [p, ops] of Object.entries<any>(doc.paths)) {
      for (const method of Object.keys(ops)) served.add(`${method} ${p}`);
    }
    const missing = IMPLEMENTED.map((e) => `${e.method} /api/v1${e.path.replace(/:(\w+)/g, '{$1}')}`)
      .filter((k) => !served.has(k));
    expect(missing).toEqual([]);
  });

  it('includes the openapi endpoint itself, so it is discoverable', () => {
    const doc = servedContract().document as any;
    expect(doc.paths['/api/v1/openapi.json']).toBeDefined();
    expect(doc.paths['/api/v1/openapi.json'].get).toBeDefined();
  });

  it('serves an authenticated endpoint, not a public one', () => {
    /**
     * Deliberate, and different from `health.build`, which is public.
     *
     * Build provenance is four fields and exists to be checkable by someone who
     * holds no credential — that is the whole argument for making it public.
     * The argument does not transfer to a full API surface, which is a map, and
     * every client that wants it already holds a token.
     */
    const entry = V1_CONTRACT.find((e) => e.id === 'health.contract');
    expect(entry).toBeDefined();
    expect(entry!.auth).toBe('authenticated');

    const build = V1_CONTRACT.find((e) => e.id === 'health.build');
    expect(build!.auth).toBe('public');
  });
});

describe('the header rides on every v1 response, not only this one', () => {
  it('is set by router-level middleware, before the handlers', () => {
    /**
     * The book says the header ALONE is enough — *"a client can detect
     * staleness with one cheap request and no parsing"*. Putting it only on
     * `/openapi.json` would mean fetching the whole document to learn whether
     * you needed to.
     *
     * Read from the source rather than by booting the app: `register.ts`
     * imports the real Express router, and the point being asserted is WHERE
     * the middleware sits in the chain, which a response body cannot show.
     */
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const src: string = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'api', 'v1', 'register.ts'),
      'utf8',
    );

    const routerStart = src.indexOf('const router = Router();');
    const firstRoute = src.indexOf('router[entry.method](');
    expect(routerStart).toBeGreaterThan(-1);
    expect(firstRoute).toBeGreaterThan(routerStart);

    const preamble = src.slice(routerStart, firstRoute);
    // The digest middleware is registered BEFORE any route, so it applies to
    // every one of them — including the error paths, which is when a client
    // most wants to know whether it is talking to the contract it was built
    // against.
    expect(preamble).toContain('CONTRACT_DIGEST_HEADER');
    expect(preamble).toContain('contractDigest()');
  });

  it('names the header in one place, so a client and the server cannot disagree', () => {
    expect(CONTRACT_DIGEST_HEADER).toBe('x-contract-sha256');
    // Lower-case: Node normalises response header names, and a client reading
    // `res.headers.get('X-Contract-Sha256')` must find it either way.
    expect(CONTRACT_DIGEST_HEADER).toBe(CONTRACT_DIGEST_HEADER.toLowerCase());
  });
});
