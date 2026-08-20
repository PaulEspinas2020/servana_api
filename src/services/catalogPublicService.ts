/**
 * Canonical PUBLIC Catalog service — Category → Subcategory → Service.
 *
 * This is the customer-facing read model over the same tables the Admin
 * Catalog API writes: `catalog_categories` → `catalog_subcategories` →
 * `services`. `services.id` IS the bookable Specific Service.
 *
 * ## Why this file exists
 *
 * Catalog V2 shipped with exactly one read surface, `/api/admin/catalog/*`,
 * gated `verifyAuth → verifyRoles([1]) → requirePermission(services.*)`. A
 * customer app cannot call that, and must not be given a way to: §6 forbids
 * impersonation and §11/§12 require server-side authorization that a public
 * client cannot satisfy. Without a public projection the Client App had no
 * canonical hierarchy to read, so the only alternative was to rebuild the
 * taxonomy in Dart from the legacy `service_options` shape — which is exactly
 * the "manufacture the catalog on the frontend" outcome §3 and §30 forbid.
 *
 * So this is the missing half of the contract, not a convenience wrapper.
 *
 * ## Relationship to `/api/services*`
 *
 * `/api/services*` remains the LEGACY_PROVIDER_COMPATIBILITY projection over
 * `service_families` + `service_options`. It is load-bearing for every build in
 * the field today and does not move (§4, §18). This router is additive and
 * parallel; nothing here writes, and nothing here touches `service_options`
 * except to read add-ons as configuration.
 *
 * ## What is deliberately NOT exposed (§11, §58, §125)
 *
 * `providerCount`, `catalog_provider_services` rows, `legacy_service_option_id`,
 * `legacy_service_family_id`, `archived_at`, admin audit fields and content-gap
 * analytics are Admin-only. A customer learns what they can book, never how
 * thin supply is behind it or how the catalog was migrated.
 */

import { db } from "../config";
import dbQuery from "../db/dbQuery";
import { checkServiceability } from "./serviceabilityService";

const dbSchema = db.schema;

const fail = (message: string, statusCode = 400, code?: string) =>
  Object.assign(new Error(message), { statusCode, code });

/**
 * Timestamps out of this API are ISO 8601 with an explicit UTC designator.
 *
 * Identical in behaviour to `catalogAdminService.toIso`, and duplicated rather
 * than shared on purpose: importing the admin service into a public router
 * would put an audit-firing, mutation-capable module one typo away from an
 * unauthenticated request path. The helper is nine lines; the coupling is not
 * worth it. Both are covered by their own tests.
 *
 * Postgres emits `2026-08-11 11:03:23.421016+00` — a space where ISO wants `T`,
 * and a two-digit offset where ISO wants ±HH:MM. Repairing only the separator
 * returns NaN from `new Date()` and falls through to the raw value, so both
 * deviations must be fixed together.
 */
const toIso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const raw = String(v);
  let candidate = raw.replace(' ', 'T');
  candidate = candidate.replace(/([+-]\d{2})$/, '$1:00');
  const parsed = new Date(candidate);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return raw;
};

const money = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

const priceSummary = (basePrice: unknown, unit: unknown): string | null => {
  const amount = money(basePrice);
  if (amount === null || Number.isNaN(amount)) return null;
  const formatted = `₱${amount.toLocaleString('en-PH', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
  return unit ? `${formatted} / ${unit}` : formatted;
};

/**
 * Customer visibility.
 *
 * `draft` and `archived` are never browsable. `inactive` is withheld from
 * browse too — an admin deactivating a service intends it to stop being
 * offered. Only `active` is listed.
 *
 * Detail-by-id deliberately does NOT apply this filter; see `getServiceDetail`.
 */
const VISIBLE_STATUS = 'active';

/**
 * ─── Qualified canonical references ──────────────────────────────────────────
 *
 * Every catalog entity carries a `ref` of the form `<type>:<id>` alongside its
 * numeric `id`.
 *
 * ## Why a bare integer is not enough
 *
 * Four different things in this platform are called a "service id" and three of
 * them are integers in overlapping ranges:
 *
 *   `services.id`            the canonical Specific Service  — 95 rows
 *   `service_families.id`    the legacy coarse family        — 10 rows
 *   `service_options.id`     a legacy option or add-on       — ≤ 231 rows
 *   `catalog_subcategories.id` / `catalog_categories.id`     — 12 / 3 rows
 *
 * `GET /api/services/:serviceId/level2` resolves its parameter against
 * `service_options.service_id`, which is a foreign key to **service_families**.
 * `GET /api/v1/catalog/services/:serviceId` resolves the same-named parameter
 * against **services.id**. The integer `3` is meaningful to both and means
 * different things to each — a coarse family on one, a Specific Service on the
 * other. Neither errors; both answer.
 *
 * Today the numeric ranges happen not to collide in the one place it would be
 * dangerous: a promoted `services.id` IS the id of a MAIN `service_options`
 * row, and add-on ids are different rows of the same unique key, so a Service
 * id and an add-on id are never the same integer. That is a property of how the
 * migration happened, not a rule anything enforces — and new Services come from
 * a sequence starting at 100000 precisely because somebody noticed.
 *
 * A `ref` removes the reliance on that accident. `service:180` cannot be read
 * as a family, an add-on or a subcategory, and a search result mixing all three
 * entity types can be keyed unambiguously without the client inferring type
 * from which array it arrived in.
 *
 * Additive: `id` is unchanged and still authoritative. Nothing that reads the
 * deployed contract has to change.
 */
export const REF_TYPES = ['category', 'subcategory', 'service', 'addon'] as const;
export type RefType = (typeof REF_TYPES)[number];

export const makeRef = (type: RefType, id: number | string): string => `${type}:${id}`;

/** Parses a qualified reference. Returns null for anything malformed. */
export const parseRef = (raw: unknown): { type: RefType; id: number } | null => {
  if (typeof raw !== 'string') return null;
  const [type, rest, ...extra] = raw.split(':');
  if (extra.length || !rest) return null;
  if (!(REF_TYPES as readonly string[]).includes(type)) return null;
  const id = Number(rest);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { type: type as RefType, id };
};

export interface PublicService {
  /** Qualified canonical reference, e.g. `service:180`. */
  ref: string;
  id: number;
  subcategoryId: number;
  subcategoryName: string;
  categoryId: number;
  categoryName: string;
  name: string;
  slug: string;
  shortDescription: string | null;
  imageUrl: string | null;
  status: string;
  displayOrder: number;
  bookable: boolean;
  basePrice: number | null;
  unit: string | null;
  basePriceSummary: string | null;
  estimatedDurationMins: number | null;
  updatedAt: string | null;
}

export interface PublicSubcategory {
  /** Qualified canonical reference, e.g. `subcategory:7`. */
  ref: string;
  id: number;
  categoryId: number;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  displayOrder: number;
  serviceCount: number;
  services: PublicService[];
}

export interface PublicCategory {
  /** Qualified canonical reference, e.g. `category:3`. */
  ref: string;
  id: number;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  displayOrder: number;
  subcategoryCount: number;
  serviceCount: number;
  subcategories: PublicSubcategory[];
}

/**
 * `status` is projected on the Service even though browse only ever returns
 * `active`. The client renders a Service reached by deep link or restored from
 * cache through the same model, and that instance CAN be non-active — so the
 * field has to exist on the type or the client would have to infer
 * availability from the absence of a key.
 */
const mapService = (r: any): PublicService => ({
  ref: makeRef('service', Number(r.id)),
  id: Number(r.id),
  subcategoryId: Number(r.subcategory_id),
  subcategoryName: r.subcategory_name ?? '',
  categoryId: Number(r.category_id),
  categoryName: r.category_name ?? '',
  name: r.name,
  slug: r.slug,
  shortDescription: r.short_description ?? null,
  imageUrl: r.image_url ?? null,
  status: r.status,
  displayOrder: Number(r.display_order),
  bookable: Boolean(r.bookable),
  basePrice: money(r.base_price),
  unit: r.unit ?? null,
  basePriceSummary: priceSummary(r.base_price, r.unit),
  estimatedDurationMins:
    r.estimated_duration_mins === null || r.estimated_duration_mins === undefined
      ? null
      : Number(r.estimated_duration_mins),
  updatedAt: toIso(r.updated_at),
});

const SERVICE_COLUMNS = `
  s.id, s.subcategory_id, s.name, s.slug, s.short_description, s.image_url,
  s.status, s.display_order, s.bookable, s.base_price, s.unit,
  s.estimated_duration_mins, s.updated_at,
  sc.name AS subcategory_name,
  c.id AS category_id, c.name AS category_name
`;

const SERVICE_JOINS = `
  FROM ${dbSchema}.services s
  JOIN ${dbSchema}.catalog_subcategories sc ON sc.id = s.subcategory_id
  JOIN ${dbSchema}.catalog_categories     c  ON c.id  = sc.category_id
`;

/**
 * The whole customer-visible hierarchy in one request.
 *
 * Three statements regardless of catalog size. The client's alternative — fetch
 * categories, then a request per category, then a request per subcategory —
 * is 16 round trips on today's 3/12 shape and is what §92 exists to prevent.
 *
 * Ordering is `display_order, name`. The name tie-break is load-bearing, not
 * cosmetic: every hierarchy row in production still has `display_order = 0`
 * because reorder has never been exercised, so ordering by `display_order`
 * alone would hand the customer an arbitrary insertion order that changes
 * between deploys.
 *
 * A Subcategory with no visible Services, or a Category with no visible
 * Subcategories, is still returned. The client needs the row in order to render
 * the empty state §61/§62 require; dropping it here would make an empty
 * Category indistinguishable from a deleted one.
 */
export const getPublicCatalog = async (): Promise<PublicCategory[]> => {
  const categories = await dbQuery.query(
    `SELECT id, name, slug, description, image_url, display_order
       FROM ${dbSchema}.catalog_categories
      WHERE status = $1
      ORDER BY display_order, name`,
    [VISIBLE_STATUS],
  );

  const subcategories = await dbQuery.query(
    `SELECT id, category_id, name, slug, description, image_url, display_order
       FROM ${dbSchema}.catalog_subcategories
      WHERE status = $1
      ORDER BY display_order, name`,
    [VISIBLE_STATUS],
  );

  const services = await dbQuery.query(
    `SELECT ${SERVICE_COLUMNS}
     ${SERVICE_JOINS}
      WHERE s.status = $1 AND sc.status = $1 AND c.status = $1
      ORDER BY s.display_order, s.name`,
    [VISIBLE_STATUS],
  );

  const servicesBySub = new Map<number, PublicService[]>();
  for (const row of services.rows) {
    const key = Number(row.subcategory_id);
    if (!servicesBySub.has(key)) servicesBySub.set(key, []);
    servicesBySub.get(key)!.push(mapService(row));
  }

  const subsByCategory = new Map<number, PublicSubcategory[]>();
  for (const row of subcategories.rows) {
    const own = servicesBySub.get(Number(row.id)) ?? [];
    const key = Number(row.category_id);
    if (!subsByCategory.has(key)) subsByCategory.set(key, []);
    subsByCategory.get(key)!.push({
      ref: makeRef('subcategory', Number(row.id)),
      id: Number(row.id),
      categoryId: key,
      name: row.name,
      slug: row.slug,
      description: row.description ?? null,
      imageUrl: row.image_url ?? null,
      displayOrder: Number(row.display_order),
      serviceCount: own.length,
      services: own,
    });
  }

  return categories.rows.map((row: any) => {
    const subs = subsByCategory.get(Number(row.id)) ?? [];
    return {
      ref: makeRef('category', Number(row.id)),
      id: Number(row.id),
      name: row.name,
      slug: row.slug,
      description: row.description ?? null,
      imageUrl: row.image_url ?? null,
      displayOrder: Number(row.display_order),
      subcategoryCount: subs.length,
      serviceCount: subs.reduce((n, s) => n + s.serviceCount, 0),
      subcategories: subs,
    };
  });
};

/** Flat visible Service list, for search indexes and cache warming. */
export const listPublicServices = async (): Promise<PublicService[]> => {
  const res = await dbQuery.query(
    `SELECT ${SERVICE_COLUMNS}
     ${SERVICE_JOINS}
      WHERE s.status = $1 AND sc.status = $1 AND c.status = $1
      ORDER BY s.display_order, s.name`,
    [VISIBLE_STATUS],
  );
  return res.rows.map(mapService);
};

export interface PublicAddon {
  /**
   * Qualified canonical reference, e.g. `addon:130`.
   *
   * An add-on id is a `service_options` id and is NOT a Service id. Without the
   * ref, a client caching `addons[].id` and later calling
   * `/catalog/services/<that id>` would be asking a question about a different
   * kind of thing — and on today's data it would 404 rather than error, which
   * is the quietest possible way to be wrong.
   */
  ref: string;
  id: number;
  name: string;
  unit: string | null;
  basePrice: number | null;
  basePriceSummary: string | null;
  durationMins: number | null;
}

export interface PublicServiceDetail extends PublicService {
  fullDescription: string | null;
  inclusions: string[];
  exclusions: string[];
  addons: PublicAddon[];
  available: boolean;
}

/**
 * One Service by canonical id, for Service Detail and deep links.
 *
 * **This read is deliberately not status-filtered.** §54 requires an old link
 * to an archived Service to land on "This service is currently unavailable"
 * rather than a dead end, and §55 requires a moved Service to keep resolving on
 * the same id. Both need the row to come back. `available` states the verdict
 * so the client is not left deriving it from a status string it would have to
 * keep in sync with the backend's enum — and `status` is still projected so an
 * unknown future value degrades to unavailable rather than crashing (§59).
 *
 * A Service whose Subcategory or Category has since been deactivated is also
 * unavailable, which is why `available` folds in all three rows rather than
 * reading `s.status` alone.
 *
 * Add-ons are read from `service_options` by `parent_option_id`, keyed on the
 * Service's legacy option id. That column is the join key ONLY; it is never
 * projected (§125). Measured in production: 5 add-ons exist in the whole
 * catalog, all under service 1.
 */
export const getServiceDetail = async (
  serviceId: number,
): Promise<PublicServiceDetail> => {
  const res = await dbQuery.query(
    `SELECT ${SERVICE_COLUMNS},
            s.full_description, s.legacy_service_option_id,
            sc.status AS subcategory_status, c.status AS category_status,
            COALESCE(m.inclusions, '[]'::jsonb) AS inclusions,
            COALESCE(m.exclusions, '[]'::jsonb) AS exclusions
     ${SERVICE_JOINS}
     LEFT JOIN ${dbSchema}.service_option_meta m
            ON m.service_option_id = s.legacy_service_option_id
      WHERE s.id = $1`,
    [serviceId],
  );

  const row = res.rows[0];
  if (!row) throw fail('Service not found', 404, 'NOT_FOUND');

  const addonRes = await dbQuery.query(
    `SELECT id, level_3, unit, base_price, duration_mins
       FROM ${dbSchema}.service_options
      WHERE parent_option_id = $1
        AND option_type = 'ADD_ON'
        AND is_active = TRUE
      ORDER BY level_3`,
    [row.legacy_service_option_id],
  );

  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x)).filter((x) => x.length > 0) : [];

  const available =
    row.status === VISIBLE_STATUS &&
    row.subcategory_status === VISIBLE_STATUS &&
    row.category_status === VISIBLE_STATUS &&
    Boolean(row.bookable);

  return {
    ...mapService(row),
    fullDescription: row.full_description ?? null,
    inclusions: asStringArray(row.inclusions),
    exclusions: asStringArray(row.exclusions),
    addons: addonRes.rows.map((a: any) => ({
      ref: makeRef('addon', Number(a.id)),
      id: Number(a.id),
      name: a.level_3,
      unit: a.unit ?? null,
      basePrice: money(a.base_price),
      basePriceSummary: priceSummary(a.base_price, a.unit),
      durationMins:
        a.duration_mins === null || a.duration_mins === undefined
          ? null
          : Number(a.duration_mins),
    })),
    available,
  };
};

/* ─── Lightweight summaries and hierarchy navigation ─────────────────────────
 *
 * `getPublicCatalog` returns the whole tree in three statements, which is right
 * for a cold start and wrong for everything else: a category chooser that only
 * needs three names should not receive 95 services with prices and images.
 *
 * These reads are the other half of that trade. A summary carries counts and no
 * children; a detail carries one level of children and no grandchildren. §92 is
 * about round trips, and the answer to it is not "always send everything" — it
 * is "send the level being rendered".
 */

export interface CategorySummary {
  ref: string;
  id: number;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  displayOrder: number;
  subcategoryCount: number;
  serviceCount: number;
}

export interface SubcategorySummary {
  ref: string;
  id: number;
  categoryId: number;
  categoryName: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  displayOrder: number;
  serviceCount: number;
}

/**
 * Counts come from a LEFT JOIN aggregate rather than a per-row subquery.
 *
 * Three categories today, so either is instant — but the per-row form is the
 * shape that turns into 95 statements the first time somebody adds a category
 * per city, and it reads identically until it does.
 */
export const listCategories = async (): Promise<CategorySummary[]> => {
  const res = await dbQuery.query(
    `SELECT c.id, c.name, c.slug, c.description, c.image_url, c.display_order,
            COUNT(DISTINCT sc.id) FILTER (WHERE sc.status = $1) AS subcategory_count,
            COUNT(DISTINCT s.id)  FILTER (WHERE s.status = $1 AND sc.status = $1) AS service_count
       FROM ${dbSchema}.catalog_categories c
       LEFT JOIN ${dbSchema}.catalog_subcategories sc ON sc.category_id = c.id
       LEFT JOIN ${dbSchema}.services s ON s.subcategory_id = sc.id
      WHERE c.status = $1
      GROUP BY c.id, c.name, c.slug, c.description, c.image_url, c.display_order
      ORDER BY c.display_order, c.name`,
    [VISIBLE_STATUS],
  );
  return res.rows.map((r: any) => ({
    ref: makeRef('category', Number(r.id)),
    id: Number(r.id),
    name: r.name,
    slug: r.slug,
    description: r.description ?? null,
    imageUrl: r.image_url ?? null,
    displayOrder: Number(r.display_order),
    subcategoryCount: Number(r.subcategory_count ?? 0),
    serviceCount: Number(r.service_count ?? 0),
  }));
};

/**
 * One Category by canonical id.
 *
 * Not status-filtered, for the same reason `getServiceDetail` is not: a deep
 * link to a deactivated Category must land on an honest "unavailable" rather
 * than a 404 that a client cannot tell apart from a typo.
 */
export const getCategory = async (categoryId: number): Promise<CategorySummary & { available: boolean }> => {
  const res = await dbQuery.query(
    `SELECT c.id, c.name, c.slug, c.description, c.image_url, c.display_order, c.status,
            COUNT(DISTINCT sc.id) FILTER (WHERE sc.status = $2) AS subcategory_count,
            COUNT(DISTINCT s.id)  FILTER (WHERE s.status = $2 AND sc.status = $2) AS service_count
       FROM ${dbSchema}.catalog_categories c
       LEFT JOIN ${dbSchema}.catalog_subcategories sc ON sc.category_id = c.id
       LEFT JOIN ${dbSchema}.services s ON s.subcategory_id = sc.id
      WHERE c.id = $1
      GROUP BY c.id, c.name, c.slug, c.description, c.image_url, c.display_order, c.status`,
    [categoryId, VISIBLE_STATUS],
  );
  const r = res.rows[0];
  if (!r) throw fail('Category not found', 404, 'NOT_FOUND');
  return {
    ref: makeRef('category', Number(r.id)),
    id: Number(r.id),
    name: r.name,
    slug: r.slug,
    description: r.description ?? null,
    imageUrl: r.image_url ?? null,
    displayOrder: Number(r.display_order),
    subcategoryCount: Number(r.subcategory_count ?? 0),
    serviceCount: Number(r.service_count ?? 0),
    available: r.status === VISIBLE_STATUS,
  };
};

const mapSubcategorySummary = (r: any): SubcategorySummary => ({
  ref: makeRef('subcategory', Number(r.id)),
  id: Number(r.id),
  categoryId: Number(r.category_id),
  categoryName: r.category_name ?? '',
  name: r.name,
  slug: r.slug,
  description: r.description ?? null,
  imageUrl: r.image_url ?? null,
  displayOrder: Number(r.display_order),
  serviceCount: Number(r.service_count ?? 0),
});

const SUBCATEGORY_SUMMARY_SQL = `
  SELECT sc.id, sc.category_id, sc.name, sc.slug, sc.description, sc.image_url,
         sc.display_order, sc.status,
         c.name AS category_name, c.status AS category_status,
         COUNT(s.id) FILTER (WHERE s.status = $1) AS service_count
    FROM ${dbSchema}.catalog_subcategories sc
    JOIN ${dbSchema}.catalog_categories c ON c.id = sc.category_id
    LEFT JOIN ${dbSchema}.services s ON s.subcategory_id = sc.id
`;

/**
 * The Subcategories of one Category.
 *
 * Throws 404 when the Category does not exist, rather than returning an empty
 * list. An empty Category and a missing one are different facts, and a client
 * rendering "no subcategories yet" for a deleted id is showing a page that
 * should not exist.
 */
export const listSubcategoriesOfCategory = async (
  categoryId: number,
): Promise<SubcategorySummary[]> => {
  const parent = await dbQuery.query(
    `SELECT 1 FROM ${dbSchema}.catalog_categories WHERE id = $1`,
    [categoryId],
  );
  if (!parent.rows.length) throw fail('Category not found', 404, 'NOT_FOUND');

  const res = await dbQuery.query(
    `${SUBCATEGORY_SUMMARY_SQL}
      WHERE sc.category_id = $2 AND sc.status = $1
      GROUP BY sc.id, sc.category_id, sc.name, sc.slug, sc.description, sc.image_url,
               sc.display_order, sc.status, c.name, c.status
      ORDER BY sc.display_order, sc.name`,
    [VISIBLE_STATUS, categoryId],
  );
  return res.rows.map(mapSubcategorySummary);
};

export const getSubcategory = async (
  subcategoryId: number,
): Promise<SubcategorySummary & { available: boolean }> => {
  const res = await dbQuery.query(
    `${SUBCATEGORY_SUMMARY_SQL}
      WHERE sc.id = $2
      GROUP BY sc.id, sc.category_id, sc.name, sc.slug, sc.description, sc.image_url,
               sc.display_order, sc.status, c.name, c.status`,
    [VISIBLE_STATUS, subcategoryId],
  );
  const r = res.rows[0];
  if (!r) throw fail('Subcategory not found', 404, 'NOT_FOUND');
  return {
    ...mapSubcategorySummary(r),
    // Folds in the parent, exactly as `getServiceDetail.available` does: a
    // Subcategory under a deactivated Category is not reachable, whatever its
    // own status says.
    available: r.status === VISIBLE_STATUS && r.category_status === VISIBLE_STATUS,
  };
};

/** The Services of one Subcategory. 404s on a missing parent, for the reason above. */
export const listServicesOfSubcategory = async (
  subcategoryId: number,
): Promise<PublicService[]> => {
  const parent = await dbQuery.query(
    `SELECT 1 FROM ${dbSchema}.catalog_subcategories WHERE id = $1`,
    [subcategoryId],
  );
  if (!parent.rows.length) throw fail('Subcategory not found', 404, 'NOT_FOUND');

  const res = await dbQuery.query(
    `SELECT ${SERVICE_COLUMNS}
     ${SERVICE_JOINS}
      WHERE s.subcategory_id = $2 AND s.status = $1 AND sc.status = $1 AND c.status = $1
      ORDER BY s.display_order, s.name`,
    [VISIBLE_STATUS, subcategoryId],
  );
  return res.rows.map(mapService);
};

/** Shape counters for cache validation and the client's empty-state copy. */
export const getPublicCatalogSummary = async () => {
  const res = await dbQuery.query(
    `SELECT
       (SELECT COUNT(*)::int FROM ${dbSchema}.catalog_categories    WHERE status = $1) AS categories,
       (SELECT COUNT(*)::int FROM ${dbSchema}.catalog_subcategories WHERE status = $1) AS subcategories,
       (SELECT COUNT(*)::int FROM ${dbSchema}.services              WHERE status = $1) AS services,
       (SELECT MAX(updated_at) FROM ${dbSchema}.services)                              AS last_updated_at`,
    [VISIBLE_STATUS],
  );
  const r = res.rows[0] ?? {};
  return {
    categories: Number(r.categories ?? 0),
    subcategories: Number(r.subcategories ?? 0),
    services: Number(r.services ?? 0),
    lastUpdatedAt: toIso(r.last_updated_at),
  };
};

export const __test__ = { toIso, priceSummary, mapService };

/**
 * Whether a service can be booked at a point.
 *
 * Delegates: the mechanics live in `serviceabilityService`, which has to know
 * how `createBooking` resolves a service family and how coverage is tested.
 * Neither belongs in the public catalog projection.
 *
 * It is re-exported HERE because `serviceId` on this route means what it means
 * on every other public catalog route — the canonical `services.id` — and
 * `v1-catalog-contract.test.ts` proves that by checking each parameter name
 * resolves through ONE domain service. Naming a second service for the same
 * parameter is how "four different things are called a service id" starts
 * again, which is the ambiguity that gate exists to prevent.
 */
export const getServiceability = (
  serviceId: number,
  lat: number,
  lon: number,
) => checkServiceability(serviceId, lat, lon);
