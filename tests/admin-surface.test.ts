/**
 * The admin surface is documented, and stays documented.
 *
 * TAB 01 of the Admin API Master Command asks the backend to "publish the legacy
 * admin surface into the contract as it stands, before changing any of it —
 * documenting the current shape is not an endorsement of it, it is what makes
 * the next change visible."
 *
 * This suite is the "stays" half. Publishing 251 operations once is a document;
 * a gate that fails when the 252nd is added without one is a contract.
 *
 * ## What is ratcheted and what is pinned
 *
 * PINNED — must not change without a deliberate edit here:
 *   the parity-exemption list still exempts /api/v1 and does not exempt /api/admin
 *   every operation resolves to a guard this reader has a word for
 *   every `authenticated` operation carries a HANDLER_GUARDS reason
 *
 * RATCHETED — may only move in the safe direction:
 *   operations documented           may not FALL
 *   authored response schemas       may not FALL
 *   operations with no guard word   may not RISE
 *
 * A ratchet rather than an equality because TAB 01 is a multi-session job. An
 * equality assertion turns "authored two more schemas" into a red build, which
 * is how a partial landing becomes a reason not to land anything.
 */

import fs from 'fs';
import path from 'path';
import {
  buildAdminSurface,
  parityExemptPrefixes,
  HANDLER_GUARDS,
  opKey,
  localChainConsts,
  matchingBracket,
  topLevelKeys,
  localResponders,
} from '../scripts/lib/adminSurface';
import { ADMIN_RESPONSES } from '../src/api/admin/adminResponses';
import { staleFiles, toOpenApiPath, pathParams } from '../scripts/generate-admin-api-docs';

/**
 * The floor. Raise these when the real numbers rise; never lower them to make a
 * red build green — that is the one edit this file exists to make expensive.
 */
const FLOOR = {
  operations: 251,
  authoredResponses: 125,
};

/** Operations whose guard this reader cannot name. Must stay zero. */
const CEILING = {
  unguardedWords: 0,
};

describe('admin surface — derivation', () => {
  const ops = buildAdminSurface();

  it('finds every mounted admin operation', () => {
    expect(ops.length).toBeGreaterThanOrEqual(FLOOR.operations);
  });

  it('gives every operation a guard this reader has a word for', () => {
    const nameless = ops.filter(
      (o) => !['super-admin', 'permission', 'admin-role', 'authenticated'].includes(o.guard),
    );
    expect(nameless.map(opKey)).toEqual([]);
    expect(nameless.length).toBeLessThanOrEqual(CEILING.unguardedWords);
  });

  it('requires a written reason for every operation the chain does not guard', () => {
    // `authenticated` means the middleware chain proves only that somebody is
    // signed in. That is acceptable ONLY where the handler is the real
    // authority, and only when somebody has read the handler and said so.
    for (const op of ops.filter((o) => o.guard === 'authenticated')) {
      expect(HANDLER_GUARDS[opKey(op)]).toBeTruthy();
      expect(op.handlerGuard!.length).toBeGreaterThan(80);
    }
  });

  it('does not let a HANDLER_GUARDS entry outlive the route it excuses', () => {
    // An excuse for a route that no longer exists is worse than no excuse: it
    // reads as review that happened, for a chain nobody can check.
    const live = new Set(ops.map(opKey));
    for (const key of Object.keys(HANDLER_GUARDS)) expect(live.has(key)).toBe(true);
  });

  it('reads the parity exemption list from app.ts rather than keeping a copy', () => {
    const exempt = parityExemptPrefixes();
    expect(exempt).toContain('/api/v1');
    expect(exempt).toContain('/api/admin/catalog');
    // The whole reason this programme publishes a SECOND document: the admin
    // tree at large is rewritten on the way out. If this ever becomes false the
    // second document's premise is gone and it should be merged into v1.
    expect(exempt).not.toContain('/api/admin');
    expect(ops.some((o) => o.parityRewritten)).toBe(true);
  });

  it('classifies /api/admin/catalog as parity-exempt and the rest as rewritten', () => {
    for (const op of ops) {
      expect(op.parityRewritten).toBe(!op.path.startsWith('/api/admin/catalog'));
    }
  });
});

describe('admin surface — the readers that produce it', () => {
  // Every one of these fixtures is a bug this file actually had. A detector
  // with no negative fixture reports whatever its first draft happened to do.

  it('matches a bracket across a nested call — the adminOnly truncation', () => {
    // `const adminOnly = [verifyAuth, verifyRoles([1]), adminRateLimit];`
    // A `[^\]]*` scan stops inside `verifyRoles([1]`, and the truncated chain
    // no longer matches the role-1 test — which classified four role-1 routes,
    // including the admin notification list, as reachable by any signed-in user.
    const src = 'const a = [x, f([1]), y];';
    const open = src.indexOf('[');
    expect(matchingBracket(src, open)).toBe(src.lastIndexOf(']'));
    expect(src.slice(open + 1, matchingBracket(src, open))).toBe('x, f([1]), y');
  });

  it('returns -1 rather than a meaningless index for a mismatched bracket', () => {
    expect(matchingBracket('(a]', 0)).toBe(-1);
    expect(matchingBracket('nope', 0)).toBe(-1);
  });

  it('ignores brackets inside string literals', () => {
    const src = "const a = ['a]b', c];";
    const open = src.indexOf('[');
    expect(src.slice(open + 1, matchingBracket(src, open))).toBe("'a]b', c");
  });

  it('resolves a real admin router chain to role 1', () => {
    const file = path.resolve(__dirname, '..', 'src/routes/adminNotification.routes.ts');
    const consts = localChainConsts(file);
    expect(consts.adminOnly).toEqual(['verifyAuth', 'verifyRoles([1])', 'adminRateLimit']);
  });

  it('reads shorthand object keys — the always-empty payload list', () => {
    // `res.json({ status: 'success', data })` is the commonest success line in
    // this tree. A reader that required `key:` returned ['status'] for it, so
    // 239 operations reported an EMPTY payload key list while the key was
    // sitting right there. An always-empty field reads as "nothing here".
    expect(topLevelKeys("{ status: 'success', data }")).toEqual(['status', 'data']);
    expect(topLevelKeys("{ success: true, disbursements: rows }")).toEqual([
      'success',
      'disbursements',
    ]);
    expect(topLevelKeys('{ a: { b: 1 }, c }')).toEqual(['a', 'c']);
  });

  it('does not count a nested key as a top-level one', () => {
    expect(topLevelKeys('{ meta: { total: 1, page: 2 } }')).toEqual(['meta']);
  });

  it('finds a module-local responder helper', () => {
    // adminAuditController answers through `const ok = (res, data) => …`, and a
    // reader that stopped at direct `res.json` calls reported all seven of its
    // handlers as `unknown`.
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'src/controllers/adminAuditController.ts'),
      'utf8',
    );
    const responders = localResponders(src);
    expect(Object.keys(responders)).toContain('ok');
    expect(responders.ok).toMatch(/status:\s*'success'/);
  });
});

describe('admin surface — response envelopes', () => {
  const ops = buildAdminSurface();

  it('resolves an envelope for every operation', () => {
    const unresolved = ops.filter((o) => o.envelope === 'unknown');
    expect(unresolved.map(opKey)).toEqual([]);
  });

  it('reports no handler writing two different success wrappers', () => {
    // 37 operations once reported `mixed` here. Every one was a detector
    // artifact: `res.status(500).json({ status: 'failed' })` was being counted
    // as a competing SUCCESS shape. A fabricated warning in front of five
    // client teams is worse than no warning.
    const mixed = ops.filter((o) => o.envelope === 'mixed');
    expect(mixed.map(opKey)).toEqual([]);
  });

  it('names every acknowledgement-only response, rather than allowing any', () => {
    // `res.json({ status: 'success' })` with no payload is a legitimate answer
    // for "mark read" — there is nothing to return. But it is also exactly what
    // a handler that FORGOT to return its data looks like, and the two are
    // indistinguishable from outside. So the set is pinned by name: a new
    // payload-less admin response fails here and someone decides which it is.
    const ackOnly = ops
      .filter((o) => o.envelope === 'status-success' && o.payloadKeys.length === 0)
      .map(opKey)
      .sort();
    expect(ackOnly).toEqual([
      'PATCH /api/admin/notifications/:id/read',
      'PATCH /api/admin/notifications/read-all',
    ]);
  });

  it('names the operations that answer with a boolean success flag', () => {
    // Not a defect to fix here — a fact to publish. A client unwrapping
    // `body.data` reads undefined from all of these, and three do not use
    // `data` as the payload key at all.
    const flagged = ops.filter((o) => o.envelope === 'success-flag');
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.map(opKey)).toContain('GET /api/admin/disbursements');
    expect(
      ops.find((o) => opKey(o) === 'GET /api/admin/disbursements')!.payloadKeys,
    ).toEqual(['disbursements']);
  });
});

describe('admin surface — authored schemas', () => {
  const ops = buildAdminSurface();

  it('ratchets the authored response count', () => {
    const authored = ops.filter((o) => ADMIN_RESPONSES[opKey(o)]).length;
    expect(authored).toBeGreaterThanOrEqual(FLOOR.authoredResponses);
  });

  it('keys every authored schema to a route that exists', () => {
    // The failure this prevents: a route is renamed, the schema keyed to the
    // old path stops being emitted, and the count silently falls back to
    // "unspecified" with the gate green because the ratchet only reads a total.
    const live = new Set(ops.map(opKey));
    for (const key of Object.keys(ADMIN_RESPONSES)) expect(live.has(key)).toBe(true);
  });

  it('makes every authored schema name the service it was read from', () => {
    /**
     * `module.function`, not merely "contains a dot".
     *
     * The looser form caught three entries of mine that named a module and no
     * function — "technicianService - SELECT * FROM ...", "adminGuestService -
     * duplicate detection", "providerCatalogService - the publish DRY RUN".
     * Each was detected, which is the gate working; but a check that only
     * demands SOME dot will pass the next one that has a dot somewhere in its
     * prose.
     *
     * The point of `derivedFrom` is that a reader can open the function and
     * re-check the schema against it. A name they cannot resolve to a function
     * is a citation that does not cite.
     */
    const NAMES_A_FUNCTION = /[A-Za-z][\w]*\.[a-z][\w]*/;
    const vague: string[] = [];
    for (const [key, entry] of Object.entries(ADMIN_RESPONSES)) {
      expect(entry.derivedFrom).toBeTruthy();
      if (!NAMES_A_FUNCTION.test(entry.derivedFrom)) vague.push(key);
    }
    // Named, not counted: whoever trips this needs the operation.
    expect(vague).toEqual([]);
  });
});

describe('admin surface — generated documents', () => {
  it('converts an express path to an OpenAPI one', () => {
    expect(toOpenApiPath('/api/admin/providers/:uid/requirements/:id')).toBe(
      '/api/admin/providers/{uid}/requirements/{id}',
    );
    expect(pathParams('/api/admin/providers/:uid/requirements/:id')).toEqual(['uid', 'id']);
  });

  it('has committed documents that match the generator', () => {
    // The same discipline `npm run api:docs:check` applies to the v1 registry:
    // an admin route added without a regenerate fails here rather than shipping
    // undocumented.
    expect(staleFiles()).toEqual([]);
  });
});
