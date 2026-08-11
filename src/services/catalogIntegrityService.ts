/**
 * Hierarchy integrity for Catalog V2.
 *
 * ## What this checks, and why each one
 *
 * The migration promoted 95 `service_options` rows into `services` and hung
 * them under a new two-level taxonomy. Every check here corresponds to a way
 * that promotion, or a later admin edit, can leave the catalog internally
 * consistent-looking but wrong:
 *
 *   ORPHAN            a Service whose subcategory_id names no Subcategory, or a
 *                     Subcategory whose category_id names no Category. The row
 *                     is unreachable by browse and invisible to anybody
 *                     checking counts.
 *   DUPLICATE_SLUG    two Categories, or two Subcategories within one Category,
 *                     sharing a slug. Slug uniqueness is NOT uniform — category
 *                     and service slugs are global, subcategory slugs are
 *                     per-category — so a single global check would report
 *                     false positives and a single per-parent check would miss
 *                     real collisions.
 *   DUPLICATE_NAME    the same, for display names. Not fatal, but two
 *                     "Facial" subcategories under one category is a content
 *                     error somebody has to resolve.
 *   DANGLING_LEGACY   a Service whose `legacy_service_option_id` points at no
 *                     `service_options` row. Add-ons are read through that
 *                     column, so a dangling one silently produces a Service
 *                     with no add-ons rather than an error.
 *   VISIBLE_UNDER_HIDDEN  an `active` Service under an inactive Subcategory or
 *                     Category. Browse filters all three levels, so the row is
 *                     invisible — but `available` on detail says false while
 *                     `status` says active, which reads as a bug.
 *   MISSING_TIMESTAMP a NULL `updated_at`. The public summary derives
 *                     `lastUpdatedAt` from `MAX(services.updated_at)`, which
 *                     drives the client's ETag; a NULL contributes nothing and
 *                     an all-NULL table would disable cache validation.
 *
 * ## Why the rules are pure functions
 *
 * `evaluate` takes rows and returns findings. It needs no database, so the
 * rules are unit-tested against fixtures that DELIBERATELY contain each defect
 * — a checker only ever run against healthy data is a checker nobody knows
 * works. `runIntegrityReport` is the thin part that fetches and calls it.
 */

import dbQuery from '../db/dbQuery';
import { db } from '../config';

const s = db.schema;

export type IntegrityCode =
  | 'ORPHAN_SUBCATEGORY'
  | 'ORPHAN_SERVICE'
  | 'DUPLICATE_CATEGORY_SLUG'
  | 'DUPLICATE_SUBCATEGORY_SLUG'
  | 'DUPLICATE_SERVICE_SLUG'
  | 'DUPLICATE_SUBCATEGORY_NAME'
  | 'DANGLING_LEGACY_OPTION'
  | 'VISIBLE_UNDER_HIDDEN'
  | 'MISSING_TIMESTAMP';

export type Severity = 'error' | 'warning';

export interface Finding {
  code: IntegrityCode;
  severity: Severity;
  /** Qualified reference of the offending row. */
  ref: string;
  detail: string;
}

export interface CategoryRow { id: number; name: string; slug: string; status: string }
export interface SubcategoryRow { id: number; category_id: number; name: string; slug: string; status: string }
export interface ServiceRow {
  id: number;
  subcategory_id: number;
  name: string;
  slug: string;
  status: string;
  updated_at: unknown;
  legacy_service_option_id: number | null;
}

export interface CatalogSnapshot {
  categories: CategoryRow[];
  subcategories: SubcategoryRow[];
  services: ServiceRow[];
  /** Ids present in `service_options`. Used only for the dangling-legacy check. */
  knownOptionIds: number[];
}

export interface IntegrityReport {
  checkedAt: string;
  counts: { categories: number; subcategories: number; services: number };
  findings: Finding[];
  errors: number;
  warnings: number;
  healthy: boolean;
}

const ACTIVE = 'active';

/** Every rule, applied to a snapshot. Pure — no database, no clock. */
export function evaluate(snapshot: CatalogSnapshot): Finding[] {
  const findings: Finding[] = [];
  const categoryById = new Map(snapshot.categories.map((c) => [Number(c.id), c]));
  const subcategoryById = new Map(snapshot.subcategories.map((sc) => [Number(sc.id), sc]));
  const optionIds = new Set(snapshot.knownOptionIds.map(Number));

  // ── Orphans ────────────────────────────────────────────────────────────────
  for (const sc of snapshot.subcategories) {
    if (!categoryById.has(Number(sc.category_id))) {
      findings.push({
        code: 'ORPHAN_SUBCATEGORY',
        severity: 'error',
        ref: `subcategory:${sc.id}`,
        detail: `category_id ${sc.category_id} does not exist`,
      });
    }
  }
  for (const sv of snapshot.services) {
    if (!subcategoryById.has(Number(sv.subcategory_id))) {
      findings.push({
        code: 'ORPHAN_SERVICE',
        severity: 'error',
        ref: `service:${sv.id}`,
        detail: `subcategory_id ${sv.subcategory_id} does not exist`,
      });
    }
  }

  // ── Duplicate slugs ────────────────────────────────────────────────────────
  //
  // Scope differs per level and that is not an oversight: category and service
  // slugs are global, subcategory slugs are unique PER CATEGORY. Checking them
  // all globally would flag two legitimately-named subcategories under
  // different parents.
  const seenCategorySlug = new Map<string, number>();
  for (const c of snapshot.categories) {
    const key = String(c.slug).toLowerCase();
    if (seenCategorySlug.has(key)) {
      findings.push({
        code: 'DUPLICATE_CATEGORY_SLUG',
        severity: 'error',
        ref: `category:${c.id}`,
        detail: `slug "${c.slug}" also on category:${seenCategorySlug.get(key)}`,
      });
    } else seenCategorySlug.set(key, Number(c.id));
  }

  const seenSubSlug = new Map<string, number>();
  const seenSubName = new Map<string, number>();
  for (const sc of snapshot.subcategories) {
    const slugKey = `${sc.category_id}::${String(sc.slug).toLowerCase()}`;
    if (seenSubSlug.has(slugKey)) {
      findings.push({
        code: 'DUPLICATE_SUBCATEGORY_SLUG',
        severity: 'error',
        ref: `subcategory:${sc.id}`,
        detail: `slug "${sc.slug}" also on subcategory:${seenSubSlug.get(slugKey)} in the same category`,
      });
    } else seenSubSlug.set(slugKey, Number(sc.id));

    const nameKey = `${sc.category_id}::${String(sc.name).trim().toLowerCase()}`;
    if (seenSubName.has(nameKey)) {
      findings.push({
        code: 'DUPLICATE_SUBCATEGORY_NAME',
        severity: 'warning',
        ref: `subcategory:${sc.id}`,
        detail: `name "${sc.name}" also on subcategory:${seenSubName.get(nameKey)} in the same category`,
      });
    } else seenSubName.set(nameKey, Number(sc.id));
  }

  const seenServiceSlug = new Map<string, number>();
  for (const sv of snapshot.services) {
    const key = String(sv.slug).toLowerCase();
    if (seenServiceSlug.has(key)) {
      findings.push({
        code: 'DUPLICATE_SERVICE_SLUG',
        severity: 'error',
        ref: `service:${sv.id}`,
        detail: `slug "${sv.slug}" also on service:${seenServiceSlug.get(key)}`,
      });
    } else seenServiceSlug.set(key, Number(sv.id));
  }

  // ── Legacy linkage, visibility, timestamps ─────────────────────────────────
  for (const sv of snapshot.services) {
    if (
      sv.legacy_service_option_id !== null &&
      sv.legacy_service_option_id !== undefined &&
      !optionIds.has(Number(sv.legacy_service_option_id))
    ) {
      findings.push({
        code: 'DANGLING_LEGACY_OPTION',
        severity: 'error',
        ref: `service:${sv.id}`,
        detail:
          `legacy_service_option_id ${sv.legacy_service_option_id} has no service_options row — ` +
          'add-ons join through this column, so the Service silently shows none',
      });
    }

    const sub = subcategoryById.get(Number(sv.subcategory_id));
    const cat = sub ? categoryById.get(Number(sub.category_id)) : undefined;
    if (sv.status === ACTIVE && sub && cat && (sub.status !== ACTIVE || cat.status !== ACTIVE)) {
      findings.push({
        code: 'VISIBLE_UNDER_HIDDEN',
        severity: 'warning',
        ref: `service:${sv.id}`,
        detail:
          `active service under ${sub.status !== ACTIVE ? `inactive subcategory:${sub.id}` : `inactive category:${cat.id}`}` +
          ' — invisible to browse while its own status says active',
      });
    }

    if (sv.updated_at === null || sv.updated_at === undefined) {
      findings.push({
        code: 'MISSING_TIMESTAMP',
        severity: 'warning',
        ref: `service:${sv.id}`,
        detail: 'updated_at is NULL — contributes nothing to the catalog ETag',
      });
    }
  }

  return findings;
}

/** Reads the whole catalog and evaluates it. Requires a database. */
export async function fetchSnapshot(): Promise<CatalogSnapshot> {
  const [categories, subcategories, services, options] = await Promise.all([
    dbQuery.query(`SELECT id, name, slug, status FROM ${s}.catalog_categories`, []),
    dbQuery.query(`SELECT id, category_id, name, slug, status FROM ${s}.catalog_subcategories`, []),
    dbQuery.query(
      `SELECT id, subcategory_id, name, slug, status, updated_at, legacy_service_option_id
         FROM ${s}.services`,
      [],
    ),
    dbQuery.query(`SELECT id FROM ${s}.service_options`, []),
  ]);

  return {
    categories: categories.rows,
    subcategories: subcategories.rows,
    services: services.rows,
    knownOptionIds: options.rows.map((r: any) => Number(r.id)),
  };
}

export function buildReport(snapshot: CatalogSnapshot, checkedAt: string): IntegrityReport {
  const findings = evaluate(snapshot);
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.length - errors;
  return {
    checkedAt,
    counts: {
      categories: snapshot.categories.length,
      subcategories: snapshot.subcategories.length,
      services: snapshot.services.length,
    },
    findings,
    errors,
    warnings,
    healthy: errors === 0,
  };
}
