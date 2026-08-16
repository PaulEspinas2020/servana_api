/**
 * The home composition service. It aggregates and it owns nothing.
 *
 * ## The one rule
 *
 * Every section DELEGATES to the service that owns its data, or derives from
 * canonical columns through the canonical helper. Nothing here decides what a
 * service costs, what a booking's state is, or how many notifications are
 * unread — those have owners, and a homepage with a second opinion about any of
 * them is a third source of truth that will disagree on a Tuesday.
 *
 * `tests/home-composition.test.ts` asserts that every emitted reference resolves
 * to a canonical id, which is what makes "does not duplicate Service/Booking
 * truth" checkable rather than a claim in a document.
 *
 * ## Partial failure is the normal case, not the exception
 *
 * `Promise.allSettled`, one envelope per section, and a rejected section becomes
 * `status: 'unavailable'` while the rest of the page renders. A homepage that
 * blanks because the popularity ranking timed out is worse than one missing a
 * carousel — and popularity is the section most likely to be slow, because it is
 * the only one that aggregates.
 *
 * ## Personalization is account-scoped by construction
 *
 * The personal sections take the uid as an argument and every query filters on
 * it. There is no parameter anywhere that names another account, which is what
 * makes the isolation test a statement about the code rather than about today's
 * routes.
 */

import dbQuery from '../../db/dbQuery';
import { db } from '../../config';
import * as catalog from '../catalogPublicService';
import { bookingCanonicalServiceSql } from '../booking/eligibilityPipeline';
import { deriveCanonicalState } from '../booking/canonicalState';
import { toCustomerProjection } from '../booking/projections';
import { countUnread } from '../events/notificationInbox';
import {
  PERSONAL_SECTIONS,
  SECTION_TYPES,
  SECTION_TYPE_NAMES,
  isSectionType,
  type SectionEnvelope,
  type SectionType,
} from './homePolicy';

const s = db.schema;

// ─── Card DTOs ────────────────────────────────────────────────────────────────

/**
 * A service card.
 *
 * `serviceId` is `services.id` — the Catalog V2 canonical specific-service
 * identity — and the hierarchy travels with it so a client can render a
 * breadcrumb without a second call. No price is invented here: `basePrice` comes
 * from the catalog projection unchanged, and a card that recomputed it would be
 * the second opinion this service exists not to have.
 */
export interface ServiceCard {
  serviceId: number;
  ref: string;
  name: string;
  slug: string | null;
  imageUrl: string | null;
  categoryId: number | null;
  categoryName: string | null;
  subcategoryId: number | null;
  subcategoryName: string | null;
  basePrice: number | null;
  basePriceSummary: string | null;
  bookable: boolean;
}

export interface CategoryCard {
  categoryId: number;
  ref: string;
  name: string;
  serviceCount: number;
  subcategoryCount: number;
}

/**
 * An active booking card.
 *
 * The state is the CANONICAL state and its customer projection — the same
 * `deriveCanonicalState` + `toCustomerProjection` every other customer surface
 * uses. §113: no homepage-specific status enum, because a four-value homepage
 * enum over an eleven-state machine is a card that says "in progress" for three
 * different situations.
 */
export interface ActiveBookingCard {
  bookingId: number;
  bookingCode: string;
  canonicalState: string;
  label: string;
  terminal: boolean;
  availableActions: string[];
  scheduledAt: string | null;
  serviceId: number | null;
  serviceName: string | null;
}

export interface NotificationSummary {
  unreadCount: number;
}

// ─── Section builders ─────────────────────────────────────────────────────────

const catalogCategoryCard = (row: any): CategoryCard => ({
  categoryId: Number(row.id),
  ref: String(row.ref),
  name: String(row.name),
  serviceCount: Number(row.serviceCount ?? 0),
  subcategoryCount: Number(row.subcategoryCount ?? 0),
});

const catalogServiceCard = (row: any): ServiceCard => ({
  serviceId: Number(row.id),
  ref: String(row.ref),
  name: String(row.name),
  slug: row.slug ?? null,
  imageUrl: row.imageUrl ?? null,
  categoryId: row.categoryId == null ? null : Number(row.categoryId),
  categoryName: row.categoryName ?? null,
  subcategoryId: row.subcategoryId == null ? null : Number(row.subcategoryId),
  subcategoryName: row.subcategoryName ?? null,
  basePrice: row.basePrice == null ? null : Number(row.basePrice),
  basePriceSummary: row.basePriceSummary ?? null,
  bookable: row.bookable === true,
});

/** DELEGATED to the catalog. The homepage does not read catalog tables. */
export const categories = async (): Promise<CategoryCard[]> =>
  (await catalog.listCategories())
    .slice(0, SECTION_TYPES.categories.maxItems)
    .map(catalogCategoryCard);

/**
 * Featured, from the catalog's OWN curation signal.
 *
 * `listPublicServices` already orders by `display_order` — the field admins
 * already set to control presentation. Reusing it means featured content is
 * curated where curation already happens, rather than through a second flag
 * somebody has to remember to keep in step with the first.
 */
export const featuredServices = async (): Promise<ServiceCard[]> => {
  const services = await catalog.listPublicServices();
  return services
    .filter((service: any) => service.bookable === true)
    .slice(0, SECTION_TYPES.featuredServices.maxItems)
    .map(catalogServiceCard);
};

/**
 * Popularity, DERIVED from completed bookings.
 *
 * The join resolves each booking to its canonical `services.id` through
 * `bookingCanonicalServiceSql` — the same helper the eligibility pipeline uses —
 * so a booking created against a legacy option id still ranks the right service
 * and nothing here keys on a service family.
 *
 * Restricted to COMPLETED bookings on purpose: a cancelled booking is not
 * evidence that anybody wants the service, and counting one would let a spike of
 * abandoned carts promote something to the front page.
 */
export const popularServices = async (): Promise<ServiceCard[]> => {
  const { rows } = await dbQuery.query(
    `SELECT ${bookingCanonicalServiceSql(s, 'b')} AS service_id, COUNT(*)::int AS bookings
       FROM ${s}.bookings b
      WHERE UPPER(COALESCE(b.status, '')) = 'COMPLETED'
        AND ${bookingCanonicalServiceSql(s, 'b')} IS NOT NULL
      GROUP BY 1
      ORDER BY bookings DESC
      LIMIT $1`,
    [SECTION_TYPES.popularServices.maxItems],
  );

  const ranked: number[] = rows.map((row: any) => Number(row.service_id)).filter(Boolean);
  if (!ranked.length) return [];

  // Hydrated through the CATALOG, so the card is the catalog's own projection
  // and cannot drift from what /catalog/services returns for the same id.
  const all = await catalog.listPublicServices();
  const byId = new Map<number, any>(all.map((service: any) => [Number(service.id), service]));
  return ranked
    .map((id: number) => byId.get(id))
    .filter(Boolean)
    .map(catalogServiceCard);
};

/**
 * Services this account has booked before, most recent first.
 *
 * ACCOUNT-SCOPED: `WHERE b.user_id = $1`. There is no variant of this function
 * that takes another subject.
 */
export const recentServices = async (uid: string): Promise<ServiceCard[]> => {
  const { rows } = await dbQuery.query(
    `SELECT DISTINCT ON (service_id) service_id, created_at
       FROM (
         SELECT ${bookingCanonicalServiceSql(s, 'b')} AS service_id, b.created_at
           FROM ${s}.bookings b
          WHERE b.user_id = $1
            AND ${bookingCanonicalServiceSql(s, 'b')} IS NOT NULL
       ) recent
      ORDER BY service_id, created_at DESC`,
    [uid],
  );

  const ordered: number[] = rows
    .map((row: any) => ({ id: Number(row.service_id), at: String(row.created_at) }))
    .sort((a: { at: string }, b: { at: string }) => b.at.localeCompare(a.at))
    .slice(0, SECTION_TYPES.recentServices.maxItems)
    .map((row: { id: number }) => row.id);
  if (!ordered.length) return [];

  const all = await catalog.listPublicServices();
  const byId = new Map<number, any>(all.map((service: any) => [Number(service.id), service]));
  return ordered
    .map((id: number) => byId.get(id))
    .filter(Boolean)
    .map(catalogServiceCard);
};

/**
 * In-flight bookings, with the canonical state.
 *
 * The state is DERIVED by `deriveCanonicalState` from the same three columns
 * every other surface derives it from, then projected for the customer seat.
 * That is §113: the homepage borrows the read model rather than summarising it.
 */
export const activeBookings = async (uid: string): Promise<ActiveBookingCard[]> => {
  const { rows } = await dbQuery.query(
    `SELECT b.id, b.status, b.schedule, b.worker_uid,
            bw.status AS assignment_status,
            ${bookingCanonicalServiceSql(s, 'b')} AS service_id
       FROM ${s}.bookings b
       LEFT JOIN LATERAL (
         SELECT status FROM ${s}.booking_workers w
          WHERE w.booking_id = b.id
          ORDER BY w.id DESC
          LIMIT 1
       ) bw ON TRUE
      WHERE b.user_id = $1
        AND UPPER(COALESCE(b.status, '')) NOT IN ('COMPLETED', 'CANCELLED', 'EXPIRED')
      ORDER BY b.created_at DESC
      LIMIT $2`,
    [uid, SECTION_TYPES.activeBooking.maxItems],
  );
  if (!rows.length) return [];

  const all = await catalog.listPublicServices().catch(() => [] as any[]);
  const byId = new Map<number, any>(all.map((service: any) => [Number(service.id), service]));

  return rows
    .map((row: any) => {
      const state = deriveCanonicalState({
        bookingStatus: row.status,
        workerStatus: row.assignment_status,
        workerUid: row.worker_uid,
        hasEscalation: false,
      });
      const projection = toCustomerProjection(state);
      const serviceId = row.service_id == null ? null : Number(row.service_id);
      return {
        bookingId: Number(row.id),
        bookingCode: `SVN-${String(Number(row.id)).padStart(6, '0')}`,
        canonicalState: projection.canonicalState,
        label: (projection as any).label ?? projection.canonicalState,
        terminal: projection.terminal,
        availableActions: projection.availableActions,
        scheduledAt: row.schedule ? new Date(String(row.schedule)).toISOString() : null,
        serviceId,
        serviceName: serviceId != null ? (byId.get(serviceId)?.name ?? null) : null,
      };
    })
    // Terminal states are excluded in SQL, but the canonical derivation is the
    // authority and can disagree with the raw column — that disagreement is the
    // whole reason the derivation exists. Filtering on the DERIVED answer means
    // a booking the machine considers finished never shows as active.
    .filter((card: ActiveBookingCard) => !card.terminal);
};

/** DELEGATED to the ONE inbox. Not a second count computed here. */
export const notificationSummary = async (
  uid: string,
  role: number,
): Promise<NotificationSummary> => ({
  unreadCount: await countUnread({ uid, role }),
});

// ─── Composition ──────────────────────────────────────────────────────────────

export interface HomeViewer {
  uid: string | null;
  role: number;
}

export interface HomeFeed {
  sections: Array<SectionEnvelope<unknown>>;
  /** Which sections were asked for and built. Lets a client detect a partial page. */
  meta: {
    requested: SectionType[];
    unavailable: SectionType[];
    personalized: boolean;
    generatedAt: string;
  };
}

const envelope = <T>(
  type: SectionType,
  items: T[],
  reason: string | null = null,
): SectionEnvelope<T> => ({
  type,
  status: reason === 'UNAVAILABLE' ? 'unavailable' : 'ok',
  items,
  // EMPTY and UNAVAILABLE are different facts a client should render
  // differently: an empty recents list is a new customer, an unavailable one is
  // a backend that failed. Collapsing them shows "no recent services" to
  // somebody who has ten.
  reason: reason ?? (items.length ? null : 'EMPTY'),
  ttlSeconds: SECTION_TYPES[type].ttlSeconds,
});

/**
 * Build one section. Never throws.
 *
 * A section that fails becomes `unavailable` with a CODE, and the exception goes
 * to the log. §117 and §21 in one place: one failed optional section must not
 * blank the homepage, and a driver message must not reach a client.
 */
const buildSection = async (
  type: SectionType,
  viewer: HomeViewer,
): Promise<SectionEnvelope<unknown>> => {
  const spec = SECTION_TYPES[type];

  // A personal section for an anonymous caller is not an error — it is a
  // homepage without personalization, which is exactly what a signed-out
  // customer should see.
  if (spec.audience === 'personal' && !viewer.uid) {
    return envelope(type, [], 'REQUIRES_AUTH');
  }

  try {
    switch (type) {
      case 'categories':
        return envelope(type, await categories());
      case 'featuredServices':
        return envelope(type, await featuredServices());
      case 'popularServices':
        return envelope(type, await popularServices());
      case 'recentServices':
        return envelope(type, await recentServices(viewer.uid!));
      case 'activeBooking':
        return envelope(type, await activeBookings(viewer.uid!));
      case 'notificationSummary':
        return envelope(type, [await notificationSummary(viewer.uid!, viewer.role)]);
      case 'banners':
        // Declared and empty. There is no promotions source, and the command
        // forbids the homepage owning promotion truth — so inventing one here
        // would be the violation rather than the fix.
        return envelope(type, [], 'NOT_CONFIGURED');
      default:
        return envelope(type, [], 'NOT_CONFIGURED');
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[home] section ${type} failed:`, (error as Error)?.message);
    return envelope(type, [], 'UNAVAILABLE');
  }
};

/**
 * Compose the home surface.
 *
 * Sections run in PARALLEL. The whole reason this endpoint exists is that the
 * customer app assembles home from three or four serial calls on launch, each
 * with its own round trip; here the page costs one round trip and the slowest
 * section rather than the sum of all of them.
 */
export const composeHome = async (
  viewer: HomeViewer,
  requested?: readonly string[],
): Promise<HomeFeed> => {
  const sections: SectionType[] = (requested ?? SECTION_TYPE_NAMES)
    .filter(isSectionType)
    // Deduplicated: a caller asking for the same section twice must not double
    // the work or the payload.
    .filter((type, index, all) => all.indexOf(type) === index);

  const resolved = sections.length ? sections : [...SECTION_TYPE_NAMES];

  const settled = await Promise.allSettled(
    resolved.map((type) => buildSection(type, viewer)),
  );

  const built = settled.map((result, index) =>
    result.status === 'fulfilled'
      ? result.value
      // `buildSection` catches its own failures, so this is the belt-and-braces
      // case: something threw outside the try, and the page still renders.
      : envelope(resolved[index], [], 'UNAVAILABLE'),
  );

  return {
    sections: built,
    meta: {
      requested: resolved,
      unavailable: built.filter((s) => s.status === 'unavailable').map((s) => s.type),
      personalized: resolved.some((type) => PERSONAL_SECTIONS.includes(type)) && !!viewer.uid,
      generatedAt: new Date().toISOString(),
    },
  };
};

/**
 * The section registry as data.
 *
 * Serves `GET /home/sections`: what the page is made of, what owns each part and
 * how long each may be cached. A client uses it to render an unknown section
 * safely rather than crashing on it; an operator uses it to see what home is
 * composed of without reading the source.
 */
export const describeSections = () =>
  SECTION_TYPE_NAMES.map((type) => ({
    type,
    audience: SECTION_TYPES[type].audience,
    failureMode: SECTION_TYPES[type].failureMode,
    ownedBy: SECTION_TYPES[type].ownedBy,
    referenceId: SECTION_TYPES[type].referenceId,
    ttlSeconds: SECTION_TYPES[type].ttlSeconds,
    maxItems: SECTION_TYPES[type].maxItems,
    description: SECTION_TYPES[type].description,
  }));
