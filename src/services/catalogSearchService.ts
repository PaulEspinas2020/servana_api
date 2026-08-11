/**
 * Canonical catalog search — Category, Subcategory and Service in one result set.
 *
 * ## Why this exists at all
 *
 * There has never been a backend search on this platform. ServanaClient
 * searches **client-side** over the `/api/services/full` payload, and that is
 * not a stylistic choice with a cost — it is a defect generator. When
 * `getFullServiceCatalog` shipped every option group NAMELESS (`level2`
 * undefined, so `JSON.stringify` dropped the key entirely),
 * `search_repository.dart` discarded every group with an empty `level2`, the
 * cache was always empty, and every query rendered "No services match your
 * search." A total data-layer failure presented as a legitimate empty result.
 *
 * Search that lives on the client can only ever find what the client already
 * downloaded, in the shape the client happened to parse.
 *
 * ## Ranking, and why it is a small explicit ladder
 *
 * Nothing here uses Postgres full-text search. `to_tsvector` brings stemming,
 * dictionaries and a configuration that has to be chosen per language, and the
 * catalog is 3 categories, 12 subcategories and 95 services of Philippine
 * consumer-service names. A deterministic prefix/substring ladder over 110 rows
 * is faster to run, far easier to explain to somebody looking at a wrong
 * result, and does not silently change behaviour when a Postgres upgrade
 * changes a dictionary.
 *
 * The ladder, highest first:
 *
 *   4  exact name match
 *   3  name starts with the query
 *   2  a word inside the name starts with the query
 *   1  the query appears anywhere in name, description or an alias
 *
 * Ties break on entity type (Service before Subcategory before Category — the
 * bookable thing first), then `display_order`, then name. Deterministic all the
 * way down, so two identical queries never return two different orders.
 *
 * ## Aliases, without duplicating Services
 *
 * "aircon" must find "Air Conditioning Cleaning"; "massage" must find
 * "Swedish Massage". The wrong fix is a second Service row per synonym, which
 * §30 forbids and which would make one real-world service bookable under two
 * canonical ids — the exact ambiguity Catalog V2 exists to remove.
 *
 * Aliases live HERE, as a query-expansion table. They widen what a search term
 * matches; they never widen what exists. A search for "aircon" and a search for
 * "air conditioning" return the same Services with the same ids.
 */

import dbQuery from '../db/dbQuery';
import { db } from '../config';
import { makeRef, type RefType } from './catalogPublicService';

const s = db.schema;
const VISIBLE_STATUS = 'active';

/**
 * Query expansion. Key is what somebody types; values are additional terms to
 * match against.
 *
 * Deliberately a plain table rather than a database row: it is product copy
 * about how Filipinos say things, it changes when somebody notices a miss, and
 * it belongs in review with the code that uses it. A `catalog_search_aliases`
 * table would move it out of review and into an admin screen nobody would open.
 *
 * Bidirectional by construction — `expand` also matches a value back to its
 * key, so "air conditioning" finds anything tagged "aircon" too.
 */
export const SEARCH_ALIASES: Record<string, string[]> = {
  aircon: ['air conditioning', 'air-con', 'airconditioning', 'ac'],
  cleaning: ['clean', 'housekeeping', 'linis'],
  massage: ['masahe', 'spa', 'therapy'],
  plumbing: ['plumber', 'tubero', 'pipe', 'leak'],
  electrical: ['electrician', 'wiring', 'kuryente'],
  carpentry: ['carpenter', 'karpintero', 'woodwork'],
  nails: ['manicure', 'pedicure', 'nail'],
  hair: ['haircut', 'salon', 'gupit'],
  beauty: ['facial', 'skincare', 'aesthetics'],
  laundry: ['labada', 'wash'],
  pest: ['pest control', 'exterminator', 'peste'],
  disinfection: ['sanitize', 'sanitation', 'disinfect'],
};

/**
 * Does `haystack` contain `needle` as a WHOLE WORD?
 *
 * ## Why not a substring test
 *
 * The first version of this used `includes` in both directions, and the alias
 * `ac` (for "aircon") is a substring of "f**ac**ial". Searching "facial"
 * expanded to the entire air-conditioning alias group and returned
 * "Air Conditioning Cleaning" above half the facial results.
 *
 * A short alias is not the problem — "ac" is genuinely how people write it —
 * so the fix is the matching rule rather than the vocabulary. Whole-word
 * matching keeps "ac cleaning" working and stops "facial" reaching it.
 */
const hasWord = (haystack: string, needle: string): boolean => {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
};

/** Two terms are related if either contains the other as a whole word. */
const related = (a: string, b: string): boolean => a === b || hasWord(a, b) || hasWord(b, a);

/** Every term a query should also match. Includes the query itself. */
export function expandQuery(raw: string): string[] {
  const q = String(raw ?? '').trim().toLowerCase();
  if (!q) return [];
  const terms = new Set<string>([q]);

  for (const [key, values] of Object.entries(SEARCH_ALIASES)) {
    const group = [key, ...values];
    // One decision per GROUP, not per member: matching any member pulls in the
    // whole group, which is what makes the relation symmetric — "masahe" finds
    // "massage" and "massage" finds "masahe".
    if (group.some((member) => related(q, member))) {
      for (const member of group) terms.add(member);
    }
  }
  return [...terms];
}

export type SearchEntityType = Extract<RefType, 'category' | 'subcategory' | 'service'>;

export interface SearchHit {
  /** Qualified canonical reference — `service:180`, never a bare integer. */
  ref: string;
  type: SearchEntityType;
  id: number;
  name: string;
  slug: string;
  /** One line of context: the parent path, e.g. "Personal Care › Facial". */
  context: string | null;
  imageUrl: string | null;
  /** Present only on a Service. A Category cannot be booked. */
  bookable: boolean | null;
  status: string;
  displayOrder: number;
  basePrice: number | null;
  categoryId: number | null;
  subcategoryId: number | null;
  /** 4 exact · 3 name-prefix · 2 word-prefix · 1 contains. */
  score: number;
  /** Which term produced the hit — the query itself, or the alias that widened it. */
  matchedTerm: string;
}

export interface SearchResult {
  query: string;
  /** Every term the query was widened to, so a surprising hit is explainable. */
  expandedTerms: string[];
  total: number;
  hits: SearchHit[];
  counts: Record<SearchEntityType, number>;
}

/** 4 exact · 3 name-prefix · 2 word-prefix · 1 contains · 0 no match. */
export function scoreOf(name: string, haystack: string, term: string): number {
  const n = name.toLowerCase();
  const t = term.toLowerCase();
  if (n === t) return 4;
  if (n.startsWith(t)) return 3;
  if (n.split(/[\s/&,-]+/).some((word) => word.startsWith(t))) return 2;
  if (haystack.toLowerCase().includes(t)) return 1;
  return 0;
}

const TYPE_RANK: Record<SearchEntityType, number> = {
  // The bookable thing first. Somebody typing "facial" wants to book a facial,
  // not to browse the category that contains facials.
  service: 0,
  subcategory: 1,
  category: 2,
};

/** Minimum query length. One character matches most of the catalog. */
export const MIN_QUERY_LENGTH = 2;

/**
 * Search the visible catalog.
 *
 * Three statements — one per level — then scored and merged in memory. On 110
 * rows that is cheaper than the SQL needed to score three different shapes in
 * one query, and it keeps the ranking readable by anybody debugging a bad
 * result.
 *
 * Only `active` rows at every level, matching browse. A Service whose
 * Subcategory is deactivated is not findable, because it is not bookable —
 * returning it would produce a search result that dead-ends.
 */
export async function searchCatalog(
  rawQuery: string,
  opts: { limit?: number; types?: SearchEntityType[] } = {},
): Promise<SearchResult> {
  const query = String(rawQuery ?? '').trim();
  const limit = Math.min(50, Math.max(1, Math.trunc(opts.limit ?? 20)));
  const wanted = new Set<SearchEntityType>(
    opts.types?.length ? opts.types : (['service', 'subcategory', 'category'] as const),
  );

  const empty: SearchResult = {
    query,
    expandedTerms: [],
    total: 0,
    hits: [],
    counts: { category: 0, subcategory: 0, service: 0 },
  };
  if (query.length < MIN_QUERY_LENGTH) return empty;

  const terms = expandQuery(query);
  if (!terms.length) return empty;

  const hits: SearchHit[] = [];

  const consider = (
    type: SearchEntityType,
    row: {
      id: number;
      name: string;
      slug: string;
      haystack: string;
      context: string | null;
      imageUrl: string | null;
      bookable: boolean | null;
      status: string;
      displayOrder: number;
      basePrice: number | null;
      categoryId: number | null;
      subcategoryId: number | null;
    },
  ) => {
    let best = 0;
    let matchedTerm = query;
    for (const term of terms) {
      const score = scoreOf(row.name, row.haystack, term);
      // Prefer the higher score; on a tie prefer the term the person actually
      // typed, so `matchedTerm` explains the hit rather than naming an alias
      // that happened to sort first.
      if (score > best || (score === best && score > 0 && term === query)) {
        best = score;
        matchedTerm = term;
      }
    }
    if (best > 0) {
      hits.push({ ref: makeRef(type, row.id), type, ...row, score: best, matchedTerm });
    }
  };

  if (wanted.has('service')) {
    const res = await dbQuery.query(
      `SELECT sv.id, sv.name, sv.slug, sv.short_description, sv.image_url, sv.status,
              sv.display_order, sv.bookable, sv.base_price, sv.subcategory_id,
              sc.name AS subcategory_name, c.id AS category_id, c.name AS category_name
         FROM ${s}.services sv
         JOIN ${s}.catalog_subcategories sc ON sc.id = sv.subcategory_id
         JOIN ${s}.catalog_categories c ON c.id = sc.category_id
        WHERE sv.status = $1 AND sc.status = $1 AND c.status = $1`,
      [VISIBLE_STATUS],
    );
    for (const r of res.rows) {
      consider('service', {
        id: Number(r.id),
        name: r.name,
        slug: r.slug,
        haystack: `${r.name} ${r.short_description ?? ''} ${r.subcategory_name} ${r.category_name}`,
        context: `${r.category_name} › ${r.subcategory_name}`,
        imageUrl: r.image_url ?? null,
        bookable: Boolean(r.bookable),
        status: r.status,
        displayOrder: Number(r.display_order),
        basePrice: r.base_price === null || r.base_price === undefined ? null : Number(r.base_price),
        categoryId: Number(r.category_id),
        subcategoryId: Number(r.subcategory_id),
      });
    }
  }

  if (wanted.has('subcategory')) {
    const res = await dbQuery.query(
      `SELECT sc.id, sc.name, sc.slug, sc.description, sc.image_url, sc.status,
              sc.display_order, sc.category_id, c.name AS category_name
         FROM ${s}.catalog_subcategories sc
         JOIN ${s}.catalog_categories c ON c.id = sc.category_id
        WHERE sc.status = $1 AND c.status = $1`,
      [VISIBLE_STATUS],
    );
    for (const r of res.rows) {
      consider('subcategory', {
        id: Number(r.id),
        name: r.name,
        slug: r.slug,
        haystack: `${r.name} ${r.description ?? ''} ${r.category_name}`,
        context: r.category_name,
        imageUrl: r.image_url ?? null,
        bookable: null,
        status: r.status,
        displayOrder: Number(r.display_order),
        basePrice: null,
        categoryId: Number(r.category_id),
        subcategoryId: Number(r.id),
      });
    }
  }

  if (wanted.has('category')) {
    const res = await dbQuery.query(
      `SELECT id, name, slug, description, image_url, status, display_order
         FROM ${s}.catalog_categories
        WHERE status = $1`,
      [VISIBLE_STATUS],
    );
    for (const r of res.rows) {
      consider('category', {
        id: Number(r.id),
        name: r.name,
        slug: r.slug,
        haystack: `${r.name} ${r.description ?? ''}`,
        context: null,
        imageUrl: r.image_url ?? null,
        bookable: null,
        status: r.status,
        displayOrder: Number(r.display_order),
        basePrice: null,
        categoryId: Number(r.id),
        subcategoryId: null,
      });
    }
  }

  hits.sort(
    (a, b) =>
      b.score - a.score ||
      TYPE_RANK[a.type] - TYPE_RANK[b.type] ||
      a.displayOrder - b.displayOrder ||
      a.name.localeCompare(b.name),
  );

  const counts: Record<SearchEntityType, number> = { category: 0, subcategory: 0, service: 0 };
  for (const hit of hits) counts[hit.type] += 1;

  return {
    query,
    expandedTerms: terms,
    total: hits.length,
    hits: hits.slice(0, limit),
    counts,
  };
}

export const __test__ = { TYPE_RANK };
