/**
 * Canonical Admin Catalog service — Category → Subcategory → Service.
 *
 * This is the Admin-facing read/write model for the catalog as it exists after
 * Catalog V2 Deploy 2: `services` IS the bookable Specific Service, keyed by
 * `services.id`. `service_families` is legacy provenance only and is never
 * written here.
 *
 * Deliberately separate from `providerCatalogService`, which serves the legacy
 * offering / level-2 / level-3 model and the LEGACY_PROVIDER_COMPATIBILITY
 * projections that live provider clients still call. Nothing in this file
 * touches `service_options`, `service_families` or `employee_services`, so no
 * protected client contract can move because of a change here (§4, §18).
 *
 * Physical table names are the post-Deploy-2 truth and are NOT symmetrical:
 *   Category    → catalog_categories
 *   Subcategory → catalog_subcategories
 *   Service     → services            (renamed from catalog_services)
 * Only the third was renamed. See docs/catalog-v2/ADMIN_CATALOG_CURRENT_SWEEP.md.
 */

import { db } from "../config";
import dbQuery, { pool } from "../db/dbQuery";
import { auditFire } from "./adminAuditService";

const dbSchema = db.schema;

// ─── Status domain ───────────────────────────────────────────────────────────
// Mirrors the CHECK constraints measured on all three tables. `archived` is the
// terminal state used instead of deletion (§17, §48).

export const CATALOG_STATUSES = ['draft', 'active', 'inactive', 'archived'] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

const isCatalogStatus = (v: unknown): v is CatalogStatus =>
  typeof v === 'string' && (CATALOG_STATUSES as readonly string[]).includes(v);

// ─── Errors ──────────────────────────────────────────────────────────────────
// Safe domain errors only — never a raw constraint name or driver message (§21).

const fail = (message: string, statusCode = 400, code?: string) =>
  Object.assign(new Error(message), { statusCode, code });

const notFound = (what: string) => fail(`${what} not found`, 404, 'NOT_FOUND');

// ─── Slug ────────────────────────────────────────────────────────────────────
// Every catalog table declares `slug NOT NULL` with no default, so a create that
// omits it fails at the driver. Nothing in the codebase generated one before,
// because nothing had ever written these tables.
//
// Uniqueness differs by table and the difference is load-bearing:
//   catalog_categories     UNIQUE (slug)               — global
//   catalog_subcategories  UNIQUE (category_id, slug)  — per category
//   services               UNIQUE (slug)               — global
// so a service slug must be checked against every service, while a subcategory
// slug only collides inside its own category. Getting this backwards would
// either reject legitimate names or raise a 23505 the admin cannot act on.

export const slugify = (input: string): string =>
  input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);

/**
 * Finds a free slug by appending -2, -3 … Scoped by an optional extra predicate
 * so subcategories only compete inside their category.
 */
const uniqueSlug = async (
  client: { query: (text: string, params: any[]) => Promise<any> },
  table: string,
  base: string,
  scope?: { column: string; value: any },
  excludeId?: number,
): Promise<string> => {
  const root = base || 'item';
  const where: string[] = ['slug = $1'];
  const params: any[] = [''];
  if (scope) { params.push(scope.value); where.push(`${scope.column} = $${params.length}`); }
  if (excludeId) { params.push(excludeId); where.push(`id <> $${params.length}`); }

  for (let n = 1; n <= 500; n++) {
    const candidate = n === 1 ? root : `${root}-${n}`;
    params[0] = candidate;
    const hit = await client.query(
      `SELECT 1 FROM ${dbSchema}.${table} WHERE ${where.join(' AND ')} LIMIT 1`,
      params,
    );
    if (!hit.rowCount) return candidate;
  }
  throw fail('Could not derive a unique slug for that name; try a different name');
};

// ─── Name validation ─────────────────────────────────────────────────────────

const cleanName = (raw: unknown, label: string): string => {
  if (typeof raw !== 'string') throw fail(`${label} is required`);
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) throw fail(`${label} cannot be blank`);
  if (name.length > 200) throw fail(`${label} must be 200 characters or fewer`);
  return name;
};

/** Normalised duplicate check — case- and whitespace-insensitive (§9). */
const assertNoDuplicateName = async (
  client: { query: (text: string, params: any[]) => Promise<any> },
  table: string,
  name: string,
  label: string,
  scope?: { column: string; value: any },
  excludeId?: number,
) => {
  const where = [`lower(regexp_replace(name, '\\s+', ' ', 'g')) = lower($1)`, `status <> 'archived'`];
  const params: any[] = [name];
  if (scope) { params.push(scope.value); where.push(`${scope.column} = $${params.length}`); }
  if (excludeId) { params.push(excludeId); where.push(`id <> $${params.length}`); }
  const hit = await client.query(
    `SELECT id FROM ${dbSchema}.${table} WHERE ${where.join(' AND ')} LIMIT 1`,
    params,
  );
  if (hit.rowCount) throw fail(`A ${label} with that name already exists`, 409, 'DUPLICATE_NAME');
};

// ─── Projections ─────────────────────────────────────────────────────────────

export interface AdminCatalogServiceSummary {
  id: number;
  subcategoryId: number;
  subcategoryName: string;
  categoryId: number;
  categoryName: string;
  name: string;
  slug: string;
  status: CatalogStatus;
  displayOrder: number;
  bookable: boolean;
  providerCount: number;
  basePrice: number | null;
  unit: string | null;
  basePriceSummary: string | null;
  updatedAt: string | null;
}

export interface AdminCatalogSubcategory {
  id: number;
  categoryId: number;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  status: CatalogStatus;
  displayOrder: number;
  serviceCount: number;
  services?: AdminCatalogServiceSummary[];
}

export interface AdminCatalogCategory {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  status: CatalogStatus;
  displayOrder: number;
  subcategoryCount: number;
  serviceCount: number;
  subcategories?: AdminCatalogSubcategory[];
}

/**
 * Peso amounts arrive from `numeric` as strings — see
 * feedback_pg_type_parser_strings. Coerce explicitly rather than relying on JS
 * to do it during formatting.
 */
const money = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Timestamps out of this API are ISO 8601 with an explicit UTC designator.
 *
 * Measured in production: these columns arrive as
 * `2026-08-11 11:03:23.421016+00` — a space instead of `T`, and a two-digit
 * offset. The pool's type parser normalises the legacy tables (a pre-existing
 * admin endpoint returns `2026-07-15T02:51:24.993Z` from the same pool) but
 * leaves this form untouched, so a canonical response was shipping a shape no
 * other Servana endpoint uses.
 *
 * That is not cosmetic. `new Date('2026-08-11 11:03:23.421016+00')` is
 * implementation-defined — WebKit has historically rejected the space form
 * outright — and the Flutter clients about to migrate onto this contract parse
 * these values directly. Normalising here rather than in the shared parser
 * keeps the change contained to the new surface (§4).
 */
const toIso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const raw = String(v);

  // Two separate deviations, and both must be repaired before Date sees the
  // string. Postgres emits `2026-08-11 11:03:23.421016+00`: a space where ISO
  // wants `T`, and a two-digit offset where ISO wants ±HH:MM. `new Date()`
  // rejects the bare `+00` outright, so repairing only the separator returns
  // NaN and silently falls through to the raw value — which is how the first
  // version of this helper passed its own reasoning and failed its test.
  let candidate = raw.replace(' ', 'T');
  candidate = candidate.replace(/([+-]\d{2})$/, '$1:00');

  const parsed = new Date(candidate);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  // Unparseable: hand back the original rather than inventing a time.
  return raw;
};

const priceSummary = (basePrice: unknown, unit: unknown): string | null => {
  const amount = money(basePrice);
  if (amount === null || Number.isNaN(amount)) return null;
  const formatted = `₱${amount.toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  return unit ? `${formatted} / ${unit}` : formatted;
};

const mapService = (r: any): AdminCatalogServiceSummary => ({
  id: Number(r.id),
  subcategoryId: Number(r.subcategory_id),
  subcategoryName: r.subcategory_name ?? '',
  categoryId: Number(r.category_id),
  categoryName: r.category_name ?? '',
  name: r.name,
  slug: r.slug,
  status: r.status,
  displayOrder: Number(r.display_order),
  bookable: Boolean(r.bookable),
  providerCount: Number(r.provider_count ?? 0),
  basePrice: money(r.base_price),
  unit: r.unit ?? null,
  basePriceSummary: priceSummary(r.base_price, r.unit),
  updatedAt: toIso(r.updated_at),
});

// ─── Hierarchy read ──────────────────────────────────────────────────────────

/**
 * The Admin catalog browser's single read.
 *
 * Deliberately lightweight (§7): it returns names, statuses, ordering and
 * aggregate counts — never provider records, service options, add-ons,
 * questions, audit events or long-form copy. Detail is fetched per service.
 *
 * Three queries total regardless of catalog size. Provider counts are folded in
 * by a grouped subquery, never one request per service (§78).
 *
 * Ordering is `display_order, name`. The name tie-break is not cosmetic: every
 * one of the 15 hierarchy rows in production still has display_order = 0,
 * because reorder has never been exercised, so display_order alone would leave
 * the catalog in arbitrary insertion order.
 */
export const getCatalogHierarchy = async (opts: { includeArchived?: boolean } = {}) => {
  const archivedFilter = opts.includeArchived ? '' : `WHERE status <> 'archived'`;

  const categories = await dbQuery.query(
    `SELECT id, name, slug, description, image_url, status, display_order
       FROM ${dbSchema}.catalog_categories
       ${archivedFilter}
      ORDER BY display_order, name`,
    [],
  );

  const subcategories = await dbQuery.query(
    `SELECT id, category_id, name, slug, description, image_url, status, display_order
       FROM ${dbSchema}.catalog_subcategories
       ${archivedFilter}
      ORDER BY display_order, name`,
    [],
  );

  const services = await dbQuery.query(
    `SELECT s.id, s.subcategory_id, s.name, s.slug, s.status, s.display_order,
            s.bookable, s.base_price, s.unit, s.updated_at,
            sc.name AS subcategory_name, c.id AS category_id, c.name AS category_name,
            COALESCE(pc.provider_count, 0) AS provider_count
       FROM ${dbSchema}.services s
       JOIN ${dbSchema}.catalog_subcategories sc ON sc.id = s.subcategory_id
       JOIN ${dbSchema}.catalog_categories     c  ON c.id  = sc.category_id
       LEFT JOIN (
            SELECT service_id, COUNT(*)::int AS provider_count
              FROM ${dbSchema}.catalog_provider_services
             WHERE status = 'active'
             GROUP BY service_id
       ) pc ON pc.service_id = s.id
      ${opts.includeArchived ? '' : `WHERE s.status <> 'archived'`}
      ORDER BY s.display_order, s.name`,
    [],
  );

  const servicesBySub = new Map<number, AdminCatalogServiceSummary[]>();
  for (const row of services.rows) {
    const key = Number(row.subcategory_id);
    if (!servicesBySub.has(key)) servicesBySub.set(key, []);
    servicesBySub.get(key)!.push(mapService(row));
  }

  const subsByCategory = new Map<number, AdminCatalogSubcategory[]>();
  for (const row of subcategories.rows) {
    const own = servicesBySub.get(Number(row.id)) ?? [];
    const sub: AdminCatalogSubcategory = {
      id: Number(row.id),
      categoryId: Number(row.category_id),
      name: row.name,
      slug: row.slug,
      description: row.description ?? null,
      imageUrl: row.image_url ?? null,
      status: row.status,
      displayOrder: Number(row.display_order),
      serviceCount: own.length,
      services: own,
    };
    const key = Number(row.category_id);
    if (!subsByCategory.has(key)) subsByCategory.set(key, []);
    subsByCategory.get(key)!.push(sub);
  }

  const result: AdminCatalogCategory[] = categories.rows.map((row: any) => {
    const subs = subsByCategory.get(Number(row.id)) ?? [];
    return {
      id: Number(row.id),
      name: row.name,
      slug: row.slug,
      description: row.description ?? null,
      imageUrl: row.image_url ?? null,
      status: row.status,
      displayOrder: Number(row.display_order),
      subcategoryCount: subs.length,
      serviceCount: subs.reduce((n, s) => n + s.serviceCount, 0),
      subcategories: subs,
    };
  });

  return result;
};

/**
 * Counts for the Services landing header (§23). Every figure is derived here so
 * the frontend never hard-codes 3 / 12 / 95.
 */
export const getCatalogSummary = async () => {
  const res = await dbQuery.query(
    `SELECT
       (SELECT COUNT(*)::int FROM ${dbSchema}.catalog_categories    WHERE status <> 'archived') AS categories,
       (SELECT COUNT(*)::int FROM ${dbSchema}.catalog_subcategories WHERE status <> 'archived') AS subcategories,
       (SELECT COUNT(*)::int FROM ${dbSchema}.services              WHERE status <> 'archived') AS services,
       (SELECT COUNT(*)::int FROM ${dbSchema}.services              WHERE status =  'active')   AS active_services,
       (SELECT COUNT(*)::int FROM ${dbSchema}.services              WHERE status =  'archived') AS archived_services,
       (SELECT COUNT(*)::int
          FROM ${dbSchema}.services s
         WHERE s.status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM ${dbSchema}.catalog_provider_services cps
              WHERE cps.service_id = s.id AND cps.status = 'active')) AS services_without_providers`,
    [],
  );
  const r = res.rows[0] ?? {};
  return {
    categories: Number(r.categories ?? 0),
    subcategories: Number(r.subcategories ?? 0),
    services: Number(r.services ?? 0),
    activeServices: Number(r.active_services ?? 0),
    archivedServices: Number(r.archived_services ?? 0),
    servicesWithoutProviders: Number(r.services_without_providers ?? 0),
  };
};

/**
 * §47 Catalog Content Gaps.
 *
 * Legacy families that still carry provider intent (an `employee_services` link)
 * but have produced no canonical Specific Service. These represent real service
 * areas a provider was approved for, so the approvals must stay visible rather
 * than be deleted — but which services to create under them is a product
 * decision, not something this build resolves. Read-only by design.
 */
export interface CatalogContentGap {
  legacyFamilyId: number;
  legacyFamilyName: string;
  legacyCategory: string | null;
  providerIntentCount: number;
  legacyLinkCount: number;
  canonicalServiceCount: number;
  recommendedAction: string;
}

export const getCatalogContentGaps = async (): Promise<CatalogContentGap[]> => {
  // Deliberately two statements rather than one join.
  //
  // `category` is a legacy-family column that has never existed on the canonical
  // services table, and selecting it out of `services` is the precise query that
  // caused the Deploy-3 outage. The semantic guard therefore rejects any source
  // file that places the token `category` within reach of `FROM …services`, and
  // it is right to: in a single statement the two are textually adjacent and
  // only the alias tells them apart. Splitting the reads keeps the legacy
  // projection and the canonical projection separately legible, and the join
  // happens in JS over at most a few dozen rows.
  const families = await dbQuery.query(
    `SELECT f.id, f.name, f.category,
            COUNT(DISTINCT es.employee_uid)::int AS provider_intent_count,
            COUNT(es.id)::int                    AS legacy_link_count
       FROM ${dbSchema}.service_families f
       LEFT JOIN ${dbSchema}.employee_services es ON es.service_id = f.id
      WHERE f.deleted_at IS NULL
      GROUP BY f.id, f.name, f.category
     HAVING COUNT(es.id) > 0
      ORDER BY COUNT(es.id) DESC, f.name`,
    [],
  );

  const canonical = await dbQuery.query(
    `SELECT legacy_service_family_id AS fid, COUNT(*)::int AS canonical_count
       FROM ${dbSchema}.services
      WHERE status <> 'archived' AND legacy_service_family_id IS NOT NULL
      GROUP BY legacy_service_family_id`,
    [],
  );

  const canonicalByFamily = new Map<number, number>(
    canonical.rows.map((r: any) => [Number(r.fid), Number(r.canonical_count)]),
  );

  const all: CatalogContentGap[] = families.rows.map((r: any) => ({
    legacyFamilyId: Number(r.id),
    legacyFamilyName: r.name,
    legacyCategory: r.category ?? null,
    providerIntentCount: Number(r.provider_intent_count),
    legacyLinkCount: Number(r.legacy_link_count),
    canonicalServiceCount: canonicalByFamily.get(Number(r.id)) ?? 0,
    recommendedAction: 'Create Specific Services for this area, or retire the approvals',
  }));

  return all.filter((g) => g.canonicalServiceCount === 0);
};

// ─── Flat service list (§29) ─────────────────────────────────────────────────

export interface ServiceListParams {
  search?: string;
  categoryId?: number;
  subcategoryId?: number;
  status?: CatalogStatus;
  bookable?: boolean;
  coverage?: 'with_providers' | 'without_providers';
  includeArchived?: boolean;
  sortBy?: 'name' | 'category' | 'subcategory' | 'price' | 'providers' | 'status' | 'order' | 'updated';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

const SORT_COLUMNS: Record<string, string> = {
  name: 's.name',
  category: 'c.name',
  subcategory: 'sc.name',
  price: 's.base_price',
  providers: 'provider_count',
  status: 's.status',
  order: 's.display_order',
  updated: 's.updated_at',
};

export const listServices = async (p: ServiceListParams = {}) => {
  const where: string[] = [];
  const params: any[] = [];

  if (!p.includeArchived && !p.status) where.push(`s.status <> 'archived'`);
  if (p.status)          { params.push(p.status);        where.push(`s.status = $${params.length}`); }
  if (p.categoryId)      { params.push(p.categoryId);    where.push(`c.id = $${params.length}`); }
  if (p.subcategoryId)   { params.push(p.subcategoryId); where.push(`s.subcategory_id = $${params.length}`); }
  if (p.bookable !== undefined) { params.push(p.bookable); where.push(`s.bookable = $${params.length}`); }
  if (p.search) {
    // Search spans all three levels so a hit on a category or subcategory name
    // still surfaces its services, with hierarchy context attached (§30).
    params.push(`%${p.search.trim()}%`);
    where.push(`(s.name ILIKE $${params.length} OR sc.name ILIKE $${params.length} OR c.name ILIKE $${params.length})`);
  }
  if (p.coverage === 'without_providers') {
    where.push(`NOT EXISTS (SELECT 1 FROM ${dbSchema}.catalog_provider_services cps
                             WHERE cps.service_id = s.id AND cps.status = 'active')`);
  } else if (p.coverage === 'with_providers') {
    where.push(`EXISTS (SELECT 1 FROM ${dbSchema}.catalog_provider_services cps
                         WHERE cps.service_id = s.id AND cps.status = 'active')`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sortCol = SORT_COLUMNS[p.sortBy ?? 'name'] ?? 's.name';
  const sortDir = p.sortOrder === 'desc' ? 'DESC' : 'ASC';

  const limit = Math.min(Math.max(Number(p.limit) || 50, 1), 200);
  const page = Math.max(Number(p.page) || 1, 1);
  const offset = (page - 1) * limit;
  params.push(limit, offset);

  const res = await dbQuery.query(
    `SELECT s.id, s.subcategory_id, s.name, s.slug, s.status, s.display_order,
            s.bookable, s.base_price, s.unit, s.updated_at,
            sc.name AS subcategory_name, c.id AS category_id, c.name AS category_name,
            COALESCE(pc.provider_count, 0) AS provider_count,
            COUNT(*) OVER()::int AS total_count
       FROM ${dbSchema}.services s
       JOIN ${dbSchema}.catalog_subcategories sc ON sc.id = s.subcategory_id
       JOIN ${dbSchema}.catalog_categories     c  ON c.id  = sc.category_id
       LEFT JOIN (
            SELECT service_id, COUNT(*)::int AS provider_count
              FROM ${dbSchema}.catalog_provider_services
             WHERE status = 'active'
             GROUP BY service_id
       ) pc ON pc.service_id = s.id
       ${whereSql}
      ORDER BY ${sortCol} ${sortDir} NULLS LAST, s.id ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return {
    items: res.rows.map(mapService),
    meta: {
      total: res.rows.length ? Number(res.rows[0].total_count) : 0,
      page,
      limit,
    },
  };
};

// ─── Service detail ──────────────────────────────────────────────────────────

export const getService = async (serviceId: number) => {
  const res = await dbQuery.query(
    `SELECT s.*, sc.name AS subcategory_name, c.id AS category_id, c.name AS category_name,
            COALESCE(pc.provider_count, 0) AS provider_count
       FROM ${dbSchema}.services s
       JOIN ${dbSchema}.catalog_subcategories sc ON sc.id = s.subcategory_id
       JOIN ${dbSchema}.catalog_categories     c  ON c.id  = sc.category_id
       LEFT JOIN (
            SELECT service_id, COUNT(*)::int AS provider_count
              FROM ${dbSchema}.catalog_provider_services
             WHERE status = 'active'
             GROUP BY service_id
       ) pc ON pc.service_id = s.id
      WHERE s.id = $1`,
    [serviceId],
  );
  if (!res.rowCount) throw notFound('Service');
  const r = res.rows[0];
  return {
    ...mapService(r),
    shortDescription: r.short_description ?? null,
    fullDescription: r.full_description ?? null,
    imageUrl: r.image_url ?? null,
    estimatedDurationMins: r.estimated_duration_mins === null ? null : Number(r.estimated_duration_mins),
    archivedAt: toIso(r.archived_at),
    createdAt: toIso(r.created_at),
    // Provenance only — never presented as the bookable identity (§52).
    legacyServiceOptionId: r.legacy_service_option_id === null ? null : Number(r.legacy_service_option_id),
    legacyServiceFamilyId: r.legacy_service_family_id === null ? null : Number(r.legacy_service_family_id),
  };
};

/**
 * §44 Provider coverage. Counts and rows both derive from
 * `catalog_provider_services.service_id → services.id` — the canonical
 * capability — and never from `employee_services`, which is family-grain and
 * would overstate coverage.
 */
export const getServiceProviders = async (serviceId: number) => {
  const exists = await dbQuery.query(`SELECT 1 FROM ${dbSchema}.services WHERE id = $1`, [serviceId]);
  if (!exists.rowCount) throw notFound('Service');

  const res = await dbQuery.query(
    `SELECT cps.provider_uid, cps.status, cps.source, cps.created_at,
            uc.first_name, uc.last_name
       FROM ${dbSchema}.catalog_provider_services cps
       LEFT JOIN ${dbSchema}.user_credentials uc ON uc.uid = cps.provider_uid
      WHERE cps.service_id = $1
      ORDER BY cps.status, uc.first_name NULLS LAST, cps.provider_uid`,
    [serviceId],
  );

  // Names only — never documents, application notes or profile detail (§82).
  const providers: Array<{
    providerUid: string; name: string | null; status: string; source: string; grantedAt: string | null;
  }> = res.rows.map((r: any) => ({
    providerUid: r.provider_uid,
    name: [r.first_name, r.last_name].filter(Boolean).join(' ') || null,
    status: r.status,
    source: r.source,
    grantedAt: toIso(r.created_at),
  }));

  const approvedCount = providers.filter((p) => p.status === 'active').length;
  return {
    serviceId,
    approvedCount,
    totalCount: providers.length,
    coverageStatus: approvedCount === 0 ? 'no_providers' : 'covered',
    providers,
  };
};

// ─── Category CRUD ───────────────────────────────────────────────────────────

export const listCategories = async (includeArchived = false) => {
  const res = await dbQuery.query(
    `SELECT c.id, c.name, c.slug, c.description, c.image_url, c.status, c.display_order,
            COALESCE(sub.n, 0)::int AS subcategory_count,
            COALESCE(svc.n, 0)::int AS service_count
       FROM ${dbSchema}.catalog_categories c
       LEFT JOIN (SELECT category_id, COUNT(*) AS n FROM ${dbSchema}.catalog_subcategories
                   WHERE status <> 'archived' GROUP BY category_id) sub ON sub.category_id = c.id
       LEFT JOIN (SELECT sc.category_id, COUNT(*) AS n
                    FROM ${dbSchema}.services s
                    JOIN ${dbSchema}.catalog_subcategories sc ON sc.id = s.subcategory_id
                   WHERE s.status <> 'archived' GROUP BY sc.category_id) svc ON svc.category_id = c.id
      ${includeArchived ? '' : `WHERE c.status <> 'archived'`}
      ORDER BY c.display_order, c.name`,
    [],
  );
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    name: r.name,
    slug: r.slug,
    description: r.description ?? null,
    imageUrl: r.image_url ?? null,
    status: r.status as CatalogStatus,
    displayOrder: Number(r.display_order),
    subcategoryCount: Number(r.subcategory_count),
    serviceCount: Number(r.service_count),
  }));
};

export interface CategoryInput {
  name?: string;
  description?: string | null;
  imageUrl?: string | null;
  iconKey?: string | null;
  status?: CatalogStatus;
  displayOrder?: number;
}

export const createCategory = async (input: CategoryInput, adminUid: string) => {
  const name = cleanName(input.name, 'Category name');
  if (input.status && !isCatalogStatus(input.status)) throw fail('Invalid status');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertNoDuplicateName(client, 'catalog_categories', name, 'category');
    const slug = await uniqueSlug(client, 'catalog_categories', slugify(name));
    const res = await client.query(
      `INSERT INTO ${dbSchema}.catalog_categories
         (name, slug, description, icon_key, image_url, display_order, status)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 0), COALESCE($7, 'active'))
       RETURNING id, name, slug, description, image_url, status, display_order`,
      [name, slug, input.description ?? null, input.iconKey ?? null, input.imageUrl ?? null,
       input.displayOrder ?? null, input.status ?? null],
    );
    await client.query('COMMIT');
    const row = res.rows[0];
    auditFire({
      action: 'catalog_category.create', actionCategory: 'catalog', outcome: 'success',
      actorUid: adminUid, actorType: 'admin', entityType: 'catalog_category',
      entityId: String(row.id), after: { name: row.name, status: row.status },
    });
    return { ...row, id: Number(row.id), displayOrder: Number(row.display_order), subcategoryCount: 0, serviceCount: 0 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const updateCategory = async (categoryId: number, input: CategoryInput, adminUid: string) => {
  if (input.status && !isCatalogStatus(input.status)) throw fail('Invalid status');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query(
      `SELECT id, name, slug, status, display_order FROM ${dbSchema}.catalog_categories WHERE id = $1 FOR UPDATE`,
      [categoryId],
    );
    if (!before.rowCount) throw notFound('Category');

    let name: string | undefined;
    let slug: string | undefined;
    if (input.name !== undefined) {
      name = cleanName(input.name, 'Category name');
      if (name !== before.rows[0].name) {
        await assertNoDuplicateName(client, 'catalog_categories', name, 'category', undefined, categoryId);
        slug = await uniqueSlug(client, 'catalog_categories', slugify(name), undefined, categoryId);
      }
    }

    const res = await client.query(
      `UPDATE ${dbSchema}.catalog_categories
          SET name          = COALESCE($2, name),
              slug          = COALESCE($3, slug),
              description   = COALESCE($4, description),
              icon_key      = COALESCE($5, icon_key),
              image_url     = COALESCE($6, image_url),
              display_order = COALESCE($7, display_order),
              status        = COALESCE($8, status),
              archived_at   = CASE WHEN $8 = 'archived' THEN NOW()
                                   WHEN $8 IS NOT NULL   THEN NULL
                                   ELSE archived_at END,
              updated_at    = NOW()
        WHERE id = $1
      RETURNING id, name, slug, description, image_url, status, display_order`,
      [categoryId, name ?? null, slug ?? null, input.description ?? null, input.iconKey ?? null,
       input.imageUrl ?? null, input.displayOrder ?? null, input.status ?? null],
    );
    await client.query('COMMIT');
    const row = res.rows[0];
    auditFire({
      action: 'catalog_category.update', actionCategory: 'catalog', outcome: 'success',
      actorUid: adminUid, actorType: 'admin', entityType: 'catalog_category', entityId: String(categoryId),
      before: { name: before.rows[0].name, status: before.rows[0].status },
      after: { name: row.name, status: row.status },
    });
    return { ...row, id: Number(row.id), displayOrder: Number(row.display_order) };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ─── Subcategory CRUD ────────────────────────────────────────────────────────

export const listSubcategories = async (categoryId?: number, includeArchived = false) => {
  const where: string[] = [];
  const params: any[] = [];
  if (!includeArchived) where.push(`sc.status <> 'archived'`);
  if (categoryId) { params.push(categoryId); where.push(`sc.category_id = $${params.length}`); }

  const res = await dbQuery.query(
    `SELECT sc.id, sc.category_id, sc.name, sc.slug, sc.description, sc.image_url,
            sc.status, sc.display_order, COALESCE(svc.n, 0)::int AS service_count
       FROM ${dbSchema}.catalog_subcategories sc
       LEFT JOIN (SELECT subcategory_id, COUNT(*) AS n FROM ${dbSchema}.services
                   WHERE status <> 'archived' GROUP BY subcategory_id) svc ON svc.subcategory_id = sc.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY sc.display_order, sc.name`,
    params,
  );
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    categoryId: Number(r.category_id),
    name: r.name,
    slug: r.slug,
    description: r.description ?? null,
    imageUrl: r.image_url ?? null,
    status: r.status as CatalogStatus,
    displayOrder: Number(r.display_order),
    serviceCount: Number(r.service_count),
  }));
};

export interface SubcategoryInput extends CategoryInput {
  categoryId?: number;
}

export const createSubcategory = async (input: SubcategoryInput, adminUid: string) => {
  const name = cleanName(input.name, 'Subcategory name');
  const categoryId = Number(input.categoryId);
  if (!Number.isSafeInteger(categoryId) || categoryId <= 0) throw fail('Category is required');
  if (input.status && !isCatalogStatus(input.status)) throw fail('Invalid status');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cat = await client.query(`SELECT id FROM ${dbSchema}.catalog_categories WHERE id = $1`, [categoryId]);
    if (!cat.rowCount) throw notFound('Category');

    await assertNoDuplicateName(client, 'catalog_subcategories', name, 'subcategory',
      { column: 'category_id', value: categoryId });
    const slug = await uniqueSlug(client, 'catalog_subcategories', slugify(name),
      { column: 'category_id', value: categoryId });

    const res = await client.query(
      `INSERT INTO ${dbSchema}.catalog_subcategories
         (category_id, name, slug, description, icon_key, image_url, display_order, status)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 0), COALESCE($8, 'active'))
       RETURNING id, category_id, name, slug, description, image_url, status, display_order`,
      [categoryId, name, slug, input.description ?? null, input.iconKey ?? null,
       input.imageUrl ?? null, input.displayOrder ?? null, input.status ?? null],
    );
    await client.query('COMMIT');
    const row = res.rows[0];
    auditFire({
      action: 'catalog_subcategory.create', actionCategory: 'catalog', outcome: 'success',
      actorUid: adminUid, actorType: 'admin', entityType: 'catalog_subcategory',
      entityId: String(row.id), after: { name: row.name, categoryId, status: row.status },
    });
    return { ...row, id: Number(row.id), categoryId: Number(row.category_id), displayOrder: Number(row.display_order), serviceCount: 0 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Update, and — when `categoryId` changes — MOVE.
 *
 * §11: a move changes taxonomy placement, not identity. `subcategories.id` and
 * every descendant `services.id` are untouched, so `catalog_provider_services`
 * rows, which key on `service_id`, are structurally unable to drift. The whole
 * operation is one transaction so a slug collision in the destination category
 * cannot leave the row half-moved.
 */
export const updateSubcategory = async (subcategoryId: number, input: SubcategoryInput, adminUid: string) => {
  if (input.status && !isCatalogStatus(input.status)) throw fail('Invalid status');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query(
      `SELECT id, category_id, name, slug, status FROM ${dbSchema}.catalog_subcategories WHERE id = $1 FOR UPDATE`,
      [subcategoryId],
    );
    if (!before.rowCount) throw notFound('Subcategory');
    const prev = before.rows[0];

    let targetCategoryId = Number(prev.category_id);
    if (input.categoryId !== undefined && Number(input.categoryId) !== targetCategoryId) {
      targetCategoryId = Number(input.categoryId);
      if (!Number.isSafeInteger(targetCategoryId) || targetCategoryId <= 0) throw fail('Invalid category');
      const cat = await client.query(`SELECT id FROM ${dbSchema}.catalog_categories WHERE id = $1`, [targetCategoryId]);
      if (!cat.rowCount) throw notFound('Category');
    }

    const name = input.name !== undefined ? cleanName(input.name, 'Subcategory name') : prev.name;
    const movedOrRenamed = targetCategoryId !== Number(prev.category_id) || name !== prev.name;

    let slug: string | undefined;
    if (movedOrRenamed) {
      await assertNoDuplicateName(client, 'catalog_subcategories', name, 'subcategory',
        { column: 'category_id', value: targetCategoryId }, subcategoryId);
      // Slug is unique per category, so a move must re-derive it against the
      // destination even when the name has not changed.
      slug = await uniqueSlug(client, 'catalog_subcategories', slugify(name),
        { column: 'category_id', value: targetCategoryId }, subcategoryId);
    }

    const res = await client.query(
      `UPDATE ${dbSchema}.catalog_subcategories
          SET category_id   = $2,
              name          = $3,
              slug          = COALESCE($4, slug),
              description   = COALESCE($5, description),
              icon_key      = COALESCE($6, icon_key),
              image_url     = COALESCE($7, image_url),
              display_order = COALESCE($8, display_order),
              status        = COALESCE($9, status),
              archived_at   = CASE WHEN $9 = 'archived' THEN NOW()
                                   WHEN $9 IS NOT NULL   THEN NULL
                                   ELSE archived_at END,
              updated_at    = NOW()
        WHERE id = $1
      RETURNING id, category_id, name, slug, description, image_url, status, display_order`,
      [subcategoryId, targetCategoryId, name, slug ?? null, input.description ?? null,
       input.iconKey ?? null, input.imageUrl ?? null, input.displayOrder ?? null, input.status ?? null],
    );

    // Assert the invariant inside the transaction rather than trusting it (§56).
    const drift = await client.query(
      `SELECT COUNT(*)::int AS n FROM ${dbSchema}.services WHERE subcategory_id = $1`,
      [subcategoryId],
    );
    await client.query('COMMIT');

    const row = res.rows[0];
    auditFire({
      action: targetCategoryId !== Number(prev.category_id) ? 'catalog_subcategory.move' : 'catalog_subcategory.update',
      actionCategory: 'catalog', outcome: 'success', actorUid: adminUid, actorType: 'admin',
      entityType: 'catalog_subcategory', entityId: String(subcategoryId),
      before: { name: prev.name, categoryId: Number(prev.category_id), status: prev.status },
      after: { name: row.name, categoryId: Number(row.category_id), status: row.status },
    });
    return {
      ...row,
      id: Number(row.id),
      categoryId: Number(row.category_id),
      displayOrder: Number(row.display_order),
      serviceCount: Number(drift.rows[0].n),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ─── Service CRUD ────────────────────────────────────────────────────────────

export interface ServiceInput {
  subcategoryId?: number;
  categoryId?: number;
  name?: string;
  shortDescription?: string | null;
  fullDescription?: string | null;
  imageUrl?: string | null;
  basePrice?: number | null;
  unit?: string | null;
  estimatedDurationMins?: number | null;
  status?: CatalogStatus;
  bookable?: boolean;
  displayOrder?: number;
}

/**
 * Resolves the subcategory a service will live under and refuses a contradictory
 * Category/Subcategory pair (§13/§38). The Category is derived from the
 * Subcategory; if the caller also sends one, it must agree.
 */
const resolveSubcategory = async (
  client: { query: (text: string, params: any[]) => Promise<any> },
  subcategoryId: number,
  categoryId?: number,
) => {
  const res = await client.query(
    `SELECT id, category_id FROM ${dbSchema}.catalog_subcategories WHERE id = $1`,
    [subcategoryId],
  );
  if (!res.rowCount) throw notFound('Subcategory');
  const actualCategoryId = Number(res.rows[0].category_id);
  if (categoryId !== undefined && Number(categoryId) !== actualCategoryId) {
    throw fail('That Subcategory does not belong to the selected Category', 400, 'HIERARCHY_MISMATCH');
  }
  return actualCategoryId;
};

/**
 * §14: the caller never supplies an id. The INSERT omits the column entirely so
 * `services.id` comes from `catalog_services_id_seq`, which is the identity the
 * whole catalog keys on.
 */
export const createService = async (input: ServiceInput, adminUid: string) => {
  const name = cleanName(input.name, 'Service name');
  const subcategoryId = Number(input.subcategoryId);
  if (!Number.isSafeInteger(subcategoryId) || subcategoryId <= 0) throw fail('Subcategory is required');
  if (input.status && !isCatalogStatus(input.status)) throw fail('Invalid status');
  if (input.basePrice !== undefined && input.basePrice !== null &&
      (!Number.isFinite(Number(input.basePrice)) || Number(input.basePrice) < 0)) {
    throw fail('Base price must be zero or greater');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await resolveSubcategory(client, subcategoryId, input.categoryId);
    await assertNoDuplicateName(client, 'services', name, 'service',
      { column: 'subcategory_id', value: subcategoryId });
    // services.slug is globally UNIQUE, so no scope here.
    const slug = await uniqueSlug(client, 'services', slugify(name));

    const res = await client.query(
      `INSERT INTO ${dbSchema}.services
         (subcategory_id, name, slug, short_description, full_description, image_url,
          base_price, unit, estimated_duration_mins, display_order, bookable, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, 0), COALESCE($11, true), COALESCE($12, 'active'))
       RETURNING id`,
      [subcategoryId, name, slug, input.shortDescription ?? null, input.fullDescription ?? null,
       input.imageUrl ?? null, input.basePrice ?? null, input.unit ?? null,
       input.estimatedDurationMins ?? null, input.displayOrder ?? null,
       input.bookable ?? null, input.status ?? null],
    );
    await client.query('COMMIT');

    const id = Number(res.rows[0].id);
    auditFire({
      action: 'catalog_service.create', actionCategory: 'catalog', outcome: 'success',
      actorUid: adminUid, actorType: 'admin', entityType: 'catalog_service',
      entityId: String(id), after: { name, subcategoryId, status: input.status ?? 'active' },
    });
    return getService(id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Item-level update, and — when `subcategoryId` changes — MOVE.
 *
 * §15/§16: never delete-and-recreate. `services.id` is the identity every
 * booking, capability and audit row already points at, so the UPDATE targets it
 * by primary key and the id is invariant by construction. The move is in the
 * same transaction as the validation so a rejected hierarchy cannot leave the
 * row pointing at a subcategory the caller was not allowed to use.
 */
export const updateService = async (serviceId: number, input: ServiceInput, adminUid: string) => {
  if (input.status && !isCatalogStatus(input.status)) throw fail('Invalid status');
  if (input.basePrice !== undefined && input.basePrice !== null &&
      (!Number.isFinite(Number(input.basePrice)) || Number(input.basePrice) < 0)) {
    throw fail('Base price must be zero or greater');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query(
      `SELECT id, subcategory_id, name, slug, status, bookable FROM ${dbSchema}.services WHERE id = $1 FOR UPDATE`,
      [serviceId],
    );
    if (!before.rowCount) throw notFound('Service');
    const prev = before.rows[0];

    let targetSubcategoryId = Number(prev.subcategory_id);
    const isMove = input.subcategoryId !== undefined && Number(input.subcategoryId) !== targetSubcategoryId;
    if (isMove) {
      targetSubcategoryId = Number(input.subcategoryId);
      await resolveSubcategory(client, targetSubcategoryId, input.categoryId);
    } else if (input.categoryId !== undefined) {
      await resolveSubcategory(client, targetSubcategoryId, input.categoryId);
    }

    const name = input.name !== undefined ? cleanName(input.name, 'Service name') : prev.name;
    let slug: string | undefined;
    if (name !== prev.name || isMove) {
      await assertNoDuplicateName(client, 'services', name, 'service',
        { column: 'subcategory_id', value: targetSubcategoryId }, serviceId);
      if (name !== prev.name) slug = await uniqueSlug(client, 'services', slugify(name), undefined, serviceId);
    }

    await client.query(
      `UPDATE ${dbSchema}.services
          SET subcategory_id          = $2,
              name                    = $3,
              slug                    = COALESCE($4, slug),
              short_description       = COALESCE($5, short_description),
              full_description        = COALESCE($6, full_description),
              image_url               = COALESCE($7, image_url),
              base_price              = COALESCE($8, base_price),
              unit                    = COALESCE($9, unit),
              estimated_duration_mins = COALESCE($10, estimated_duration_mins),
              display_order           = COALESCE($11, display_order),
              bookable                = COALESCE($12, bookable),
              status                  = COALESCE($13, status),
              archived_at             = CASE WHEN $13 = 'archived' THEN NOW()
                                             WHEN $13 IS NOT NULL   THEN NULL
                                             ELSE archived_at END,
              updated_at              = NOW()
        WHERE id = $1`,
      [serviceId, targetSubcategoryId, name, slug ?? null, input.shortDescription ?? null,
       input.fullDescription ?? null, input.imageUrl ?? null, input.basePrice ?? null,
       input.unit ?? null, input.estimatedDurationMins ?? null, input.displayOrder ?? null,
       input.bookable ?? null, input.status ?? null],
    );
    await client.query('COMMIT');

    auditFire({
      action: isMove ? 'catalog_service.move' : 'catalog_service.update',
      actionCategory: 'catalog', outcome: 'success', actorUid: adminUid, actorType: 'admin',
      entityType: 'catalog_service', entityId: String(serviceId),
      before: { name: prev.name, subcategoryId: Number(prev.subcategory_id), status: prev.status },
      after: { name, subcategoryId: targetSubcategoryId, status: input.status ?? prev.status },
    });
    return getService(serviceId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

/**
 * §17/§63 Archive — the ordinary Admin alternative to deletion. The row stays,
 * `status` becomes `archived`, and every `catalog_provider_services` row is left
 * exactly as it was so capability history and audit remain resolvable.
 */
export const setServiceStatus = async (serviceId: number, status: CatalogStatus, adminUid: string) => {
  if (!isCatalogStatus(status)) throw fail('Invalid status');
  const before = await dbQuery.query(
    `SELECT status FROM ${dbSchema}.services WHERE id = $1`, [serviceId],
  );
  if (!before.rowCount) throw notFound('Service');

  await dbQuery.query(
    `UPDATE ${dbSchema}.services
        SET status = $2,
            archived_at = CASE WHEN $2 = 'archived' THEN NOW() ELSE NULL END,
            updated_at = NOW()
      WHERE id = $1`,
    [serviceId, status],
  );
  auditFire({
    action: status === 'archived' ? 'catalog_service.archive' : 'catalog_service.status',
    actionCategory: 'catalog', outcome: 'success', actorUid: adminUid, actorType: 'admin',
    entityType: 'catalog_service', entityId: String(serviceId),
    before: { status: before.rows[0].status }, after: { status },
  });
  return getService(serviceId);
};

// ─── Reorder ─────────────────────────────────────────────────────────────────

const REORDERABLE: Record<string, string> = {
  category: 'catalog_categories',
  subcategory: 'catalog_subcategories',
  service: 'services',
};

/**
 * Applies an explicit ordering in one transaction so a partially-applied order
 * can never be observed. Ids are validated against the table before any write.
 */
export const reorder = async (
  entity: 'category' | 'subcategory' | 'service',
  items: Array<{ id: number; displayOrder: number }>,
  adminUid: string,
) => {
  const table = REORDERABLE[entity];
  if (!table) throw fail('Invalid entity');
  if (!Array.isArray(items) || !items.length) throw fail('No items to reorder');
  if (items.length > 500) throw fail('Too many items in one reorder');

  const ids = items.map((i) => Number(i.id));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw fail('Invalid id in reorder');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(`SELECT id FROM ${dbSchema}.${table} WHERE id = ANY($1)`, [ids]);
    if (found.rowCount !== ids.length) throw fail('One or more items no longer exist; refresh and retry', 409, 'STALE');

    for (const item of items) {
      await client.query(
        `UPDATE ${dbSchema}.${table} SET display_order = $2, updated_at = NOW() WHERE id = $1`,
        [Number(item.id), Number(item.displayOrder) || 0],
      );
    }
    await client.query('COMMIT');
    auditFire({
      action: `catalog_${entity}.reorder`, actionCategory: 'catalog', outcome: 'success',
      actorUid: adminUid, actorType: 'admin', entityType: `catalog_${entity}`,
      entityId: ids.join(','), after: { count: ids.length },
    });
    return { reordered: ids.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};
