/**
 * `PageMeta.total` is a number. Decided, and now enforced.
 *
 * TAB 06 of the Admin API Master Command puts the choice plainly:
 *
 * > Choose one, and say which in the schema description … What is not
 * > acceptable is leaving it undecided: the portal is currently correct only by
 * > luck.
 *
 * The contract said `integer | null` with the note *"null when the total is not
 * cheaply knowable"*. Every client that used it declared plain `number`, and no
 * client rendered anything for null. The book asks the backend to decide which
 * side is right.
 *
 * ## It was measured before it was decided
 *
 * Four call sites build a `PageMeta`, and none of them can produce null:
 *
 *     bookings.listMine       rows.length
 *     notifications.list      all.length
 *     provider.jobs.list      jobs.length
 *     reviews.provider.list   listProviderReviews -> COUNT(*)::int
 *
 * Only the last one even had a null branch, and the `::int` cast is what makes
 * it safe: int4 parses to a JS number, where a bare `COUNT(*)` is bigint and
 * node-postgres hands back a STRING. Verified against PGlite rather than
 * assumed — `COUNT(*)::int` returns `3`, and `0` on an empty set, both
 * `typeof number`.
 *
 * So the nullable half was never reachable. It was a hedge against a cost
 * nothing in this API pays, and it obliged every client to render an empty
 * state for a case that never occurs. Decision: **always send a number.**
 *
 * ## What this suite stops
 *
 * The reintroduction. Not by asserting the current shape is present — that
 * passes with a null branch sitting beside it — but by asserting the null is
 * GONE from the type, the builder and the four handlers.
 */

import fs from 'fs';
import path from 'path';
import { pageMeta, readPage } from '../src/api/v1/envelope';
import { buildOpenApiDocument } from '../src/api/v1/openapi';

const SRC = path.join(__dirname, '..', 'src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

/**
 * Source with block and line comments removed.
 *
 * A detector that searches prose finds the sentence explaining the defect and
 * reports the defect. Strings are deliberately NOT stripped — a pattern living
 * in a string literal is still shipped code.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

describe('the contract declares a total that is always there', () => {
  const doc = buildOpenApiDocument() as any;
  const total = doc.components.schemas.PageMeta.properties.total;

  it('declares total as a plain integer, not a nullable one', () => {
    expect(total.type).toBe('integer');
    // Belt and braces: the array form would also be a regression.
    expect(Array.isArray(total.type)).toBe(false);
  });

  it('bounds it at zero, because an empty set is a real answer', () => {
    expect(total.minimum).toBe(0);
  });

  it('keeps total required', () => {
    // Optional-and-not-null is the same problem wearing a different hat: the
    // client still has to handle its absence.
    expect(doc.components.schemas.PageMeta.required).toEqual(
      expect.arrayContaining(['limit', 'offset', 'total', 'hasMore']),
    );
  });

  it('says what to do if a total ever becomes expensive', () => {
    // The decision has to survive the next person who meets a slow COUNT. The
    // schema names the alternative so the answer is not rediscovered as null.
    expect(total.description).toMatch(/totalIsEstimate/);
    expect(total.description).toMatch(/do not reintroduce null/i);
  });
});

describe('pageMeta computes hasMore from the total alone', () => {
  const page = (limit: number, offset: number) => ({ limit, offset });

  it('reports more when the window ends before the total', () => {
    expect(pageMeta(page(20, 0), 20, 57).hasMore).toBe(true);
    expect(pageMeta(page(20, 40), 17, 57).hasMore).toBe(false);
  });

  it('is correct for a set whose size is an EXACT multiple of the limit', () => {
    /**
     * The case the removed null branch got wrong. It inferred `hasMore` from
     * `returned === page.limit` — a full page — which is true for the last page
     * of a 40-row set read 20 at a time. A client would have asked for page 3
     * and been handed an empty one.
     *
     * It never ran, because no caller passed null. Pinned anyway, because the
     * reason to delete a heuristic is that it is wrong, not that it is unused.
     */
    expect(pageMeta(page(20, 20), 20, 40).hasMore).toBe(false);
    expect(pageMeta(page(20, 0), 20, 40).hasMore).toBe(true);
  });

  it('handles an empty set without claiming there is more', () => {
    const meta = pageMeta(page(20, 0), 0, 0);
    expect(meta.total).toBe(0);
    expect(meta.hasMore).toBe(false);
  });

  it('echoes the clamped limit and offset it was given', () => {
    const meta = pageMeta(page(50, 100), 50, 500);
    expect(meta.limit).toBe(50);
    expect(meta.offset).toBe(100);
  });
});

describe('no handler can put a null into total', () => {
  it('has no null branch left in the pagination builder', () => {
    /**
     * Asserting the defect is GONE rather than that the fix is present. The
     * second phrasing passes with the old branch still sitting beside the new
     * one — which is how a removed heuristic comes back.
     *
     * Comments are stripped first. The docblock on `PageMeta.total` EXPLAINS the
     * branch that was removed and therefore contains the very pattern this
     * searches for — the same trap TAB 05 hit, where a cautionary example in a
     * string tripped the hardcode detector. A detector must read code, not
     * prose; the alternative is teaching it to ignore a pattern, and then it
     * ignores the next real one.
     */
    const envelope = stripComments(read(path.join('api', 'v1', 'envelope.ts')));

    /**
     * The BODY of pageMeta must not mention null at all.
     *
     * The first version of this matched `/total\s*===\s*null/`, and a negative
     * control walked straight past it: reinstating the branch as
     * `(total as number | null) === null` still compiled, still restored the
     * heuristic, and still passed. A detector pinned to one spelling of a
     * defect only ever finds that spelling.
     *
     * Extracting the function and forbidding the word outright has no spelling
     * to evade. It is narrow enough to stay honest — this function has exactly
     * four lines and no legitimate use for null.
     */
    const body = /export function pageMeta\([\s\S]*?\n\}/.exec(envelope);
    expect(body).not.toBeNull();
    expect(body![0]).not.toMatch(/\bnull\b/);

    expect(envelope).toMatch(/total:\s*number(?!\s*\|)/);
  });

  it('has no handler coercing a total to null', () => {
    const handlers = [
      path.join('api', 'v1', 'domains', 'bookings.ts'),
      path.join('api', 'v1', 'domains', 'notifications.ts'),
      path.join('api', 'v1', 'domains', 'providerJobs.ts'),
      path.join('api', 'v1', 'domains', 'reviews.ts'),
    ];
    const offenders: string[] = [];
    for (const rel of handlers) {
      // Comments stripped for the same reason as above: the sentence explaining
      // the removed branch is not the branch.
      stripComments(read(rel)).split('\n').forEach((line, i) => {
        const code = line;
        if (/const total\b/.test(code) && /\bnull\b/.test(code)) {
          offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('still finds all four pageMeta call sites, so the sweep is not vacuous', () => {
    // A search that matches nothing proves nothing. If a fifth list endpoint is
    // added, this count changes and somebody checks its total too.
    const files = [
      path.join('api', 'v1', 'domains', 'bookings.ts'),
      path.join('api', 'v1', 'domains', 'notifications.ts'),
      path.join('api', 'v1', 'domains', 'providerJobs.ts'),
      path.join('api', 'v1', 'domains', 'reviews.ts'),
    ];
    const calls = files.reduce(
      (n, rel) => n + (read(rel).match(/pageMeta\(/g) ?? []).length,
      0,
    );
    expect(calls).toBe(4);
  });
});

describe('readPage still refuses the input that made this endpoint 500', () => {
  const req = (query: Record<string, unknown>) => ({ query } as any);

  it('clamps a negative offset to zero', () => {
    // `?offset=-1` reaching pg is how the public review list turned a typo into
    // a 500 — and the review list is the one endpoint whose total was nullable.
    expect(readPage(req({ offset: '-1' })).offset).toBe(0);
  });

  it('clamps a limit above the endpoint ceiling', () => {
    expect(readPage(req({ limit: '9999' }), { maxLimit: 50 }).limit).toBe(50);
  });

  it('falls back to the default for junk rather than producing NaN', () => {
    const p = readPage(req({ limit: 'abc', offset: 'xyz' }), { defaultLimit: 20 });
    expect(p.limit).toBe(20);
    expect(p.offset).toBe(0);
  });
});
