/**
 * Parity between Customer Web and Customer Mobile, and the payload budget (§119).
 *
 * ## Parity is a property of there being one endpoint
 *
 * The release gate says "Customer Web/Mobile receive equivalent shared content".
 * The honest way to check that is to drive the SAME endpoint the way each client
 * would and assert the shared sections are byte-identical — because there is one
 * composition, and the only thing a client varies is which sections it asks for.
 *
 * If this suite ever had to reconcile two code paths, the gate would already be
 * lost. That it can compare two REQUESTS rather than two implementations is the
 * result the tab is claiming.
 *
 * ## The budget is measured, not estimated
 *
 * Every number is taken from a composed response: item counts against the
 * declared `maxItems`, serialized bytes against the ceiling, and query count
 * against the fan-out limit. A homepage that grows without a ceiling gets slower
 * every release and nobody notices which change did it.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => {
  const fake = require('./support/homeDbFake');
  return { __esModule: true, default: fake.dbQueryFake, pool: { connect: jest.fn() } };
});

/**
 * A DELIBERATELY oversized catalog.
 *
 * Forty services and thirty categories, so the per-section ceilings are the
 * thing being tested rather than the fixture happening to be small. A budget
 * test against three rows proves nothing.
 */
jest.mock('../src/services/catalogPublicService', () => ({
  listCategories: jest.fn().mockResolvedValue(
    Array.from({ length: 30 }, (_, i) => ({
      ref: `category:${i + 1}`, id: i + 1, name: `Category ${i + 1}`,
      subcategoryCount: 3, serviceCount: 10,
    })),
  ),
  listPublicServices: jest.fn().mockResolvedValue(
    Array.from({ length: 40 }, (_, i) => ({
      ref: `service:${i + 1}`, id: i + 1, name: `Service ${i + 1}`,
      slug: `service-${i + 1}`, imageUrl: `https://cdn.example/img/${i + 1}.jpg`,
      categoryId: 3, categoryName: 'Personal Care',
      subcategoryId: 7, subcategoryName: 'Facial',
      basePrice: 1000 + i, basePriceSummary: `from PHP ${1000 + i}.00`, bookable: true,
    })),
  ),
}));

import * as fake from './support/homeDbFake';
import { composeHome } from '../src/services/home/homeService';
import {
  PAYLOAD_BUDGET,
  PUBLIC_SECTIONS,
  SECTION_TYPES,
  SECTION_TYPE_NAMES,
  type SectionType,
} from '../src/services/home/homePolicy';

const CUSTOMER = 'customer-1';

const seed = () => {
  fake.reset();
  fake.seedUser(CUSTOMER, 3);
  for (let i = 1; i <= 40; i += 1) fake.seedService(i, `Service ${i}`);
  // Enough history that recents and popularity would both overflow their
  // ceilings if the ceilings were not applied.
  for (let i = 1; i <= 30; i += 1) {
    fake.seedBooking(i, CUSTOMER, { catalog_service_id: i, status: 'COMPLETED' });
  }
  for (let i = 31; i <= 40; i += 1) {
    fake.seedBooking(i, CUSTOMER, { catalog_service_id: i, status: 'CONFIRMED' });
  }
  for (let i = 0; i < 5; i += 1) fake.seedNotification(CUSTOMER, true);
};

beforeEach(seed);

const viewer = { uid: CUSTOMER, role: 3 };

/** What Customer Web asks for: the whole page. */
const WEB_SECTIONS = [...SECTION_TYPE_NAMES];

/**
 * What Customer Mobile asks for on launch.
 *
 * A narrower set, because a phone renders less above the fold. The parity claim
 * is about the sections BOTH ask for, not about them asking for the same list —
 * two clients tailoring their payload is the feature, and it is only safe if the
 * shared sections are identical.
 */
const MOBILE_SECTIONS: SectionType[] = [
  'categories', 'featuredServices', 'activeBooking', 'notificationSummary',
];

// ─── Parity ───────────────────────────────────────────────────────────────────

describe('Customer Web and Customer Mobile receive equivalent shared content', () => {
  it('every section both ask for is byte-identical', async () => {
    const web = await composeHome(viewer, WEB_SECTIONS);
    const mobile = await composeHome(viewer, MOBILE_SECTIONS);

    const shared = MOBILE_SECTIONS.filter((type) => WEB_SECTIONS.includes(type));
    expect(shared.length).toBeGreaterThan(2);

    for (const type of shared) {
      const fromWeb = web.sections.find((s) => s.type === type)!;
      const fromMobile = mobile.sections.find((s) => s.type === type)!;
      // One composition, so this is an equality rather than a reconciliation.
      expect(JSON.stringify(fromMobile.items)).toBe(JSON.stringify(fromWeb.items));
      expect(fromMobile.ttlSeconds).toBe(fromWeb.ttlSeconds);
      expect(fromMobile.status).toBe(fromWeb.status);
    }
  });

  it('asking for fewer sections changes nothing about the ones returned', async () => {
    const full = await composeHome(viewer, WEB_SECTIONS);
    const one = await composeHome(viewer, ['categories']);

    expect(JSON.stringify(one.sections[0].items))
      .toBe(JSON.stringify(full.sections.find((s) => s.type === 'categories')!.items));
  });

  it('there is ONE composition function, not one per client', () => {
    // The property behind the parity: nothing in the module exports a
    // web-specific or mobile-specific builder that could drift.
    const homeService = require('../src/services/home/homeService');
    const exported = Object.keys(homeService);
    for (const name of exported) {
      expect(name.toLowerCase()).not.toMatch(/web|mobile|ios|android/);
    }
  });
});

// ─── Payload budget ───────────────────────────────────────────────────────────

describe('the payload is bounded', () => {
  it('every section respects its declared maxItems', async () => {
    const feed = await composeHome(viewer);
    for (const section of feed.sections) {
      const max = SECTION_TYPES[section.type].maxItems;
      expect(section.items.length).toBeLessThanOrEqual(max);
    }
  });

  it('the ceilings actually bite on an oversized catalog', async () => {
    // The fixture holds 40 services and 30 categories. Without the slices these
    // sections would carry all of them.
    const feed = await composeHome(viewer);
    const categories = feed.sections.find((s) => s.type === 'categories')!;
    const featured = feed.sections.find((s) => s.type === 'featuredServices')!;

    expect(categories.items.length).toBe(SECTION_TYPES.categories.maxItems);
    expect(featured.items.length).toBe(SECTION_TYPES.featuredServices.maxItems);
  });

  it('the total item count stays inside the budget', async () => {
    const feed = await composeHome(viewer);
    const total = feed.sections.reduce((sum, s) => sum + s.items.length, 0);
    expect(total).toBeLessThanOrEqual(PAYLOAD_BUDGET.maxTotalItems);
  });

  it('the serialized response stays inside the byte ceiling', async () => {
    // The backstop for a section whose ITEMS grew rather than whose count did —
    // a card that gained a long description would pass the item check.
    const feed = await composeHome(viewer);
    const bytes = Buffer.byteLength(JSON.stringify(feed), 'utf8');
    expect(bytes).toBeLessThanOrEqual(PAYLOAD_BUDGET.maxBytes);
  });

  it('composition does not fan out unboundedly', async () => {
    fake.store.sql = [];
    await composeHome(viewer);
    // Seven sections, and several share the catalog read. A composition that
    // issued a query per ITEM would show up here immediately.
    expect(fake.store.sql.length).toBeLessThanOrEqual(PAYLOAD_BUDGET.maxQueriesPerRequest);
  });

  it('one request replaces the serial launch calls', async () => {
    // The whole reason the endpoint exists: the app assembles home from three
    // or four serial calls, each a round trip on a mobile network.
    const feed = await composeHome(viewer);
    expect(feed.sections.length).toBeGreaterThanOrEqual(6);
    expect(feed.meta.generatedAt).toBeTruthy();
  });
});

// ─── The declared budget itself ───────────────────────────────────────────────

describe('the budget is a real ceiling', () => {
  it('sums maxItems from the declarations rather than restating a number', () => {
    const declared = SECTION_TYPE_NAMES.reduce(
      (sum, name) => sum + SECTION_TYPES[name].maxItems,
      0,
    );
    expect(PAYLOAD_BUDGET.maxTotalItems).toBe(declared);
  });

  it('every public section has a non-zero TTL and every section a maxItems', () => {
    for (const type of PUBLIC_SECTIONS) {
      expect(SECTION_TYPES[type].ttlSeconds).toBeGreaterThan(0);
    }
    for (const type of SECTION_TYPE_NAMES) {
      expect(SECTION_TYPES[type].maxItems).toBeGreaterThan(0);
    }
  });
});
