/**
 * The homepage composes and owns nothing.
 *
 * ## The gates this suite encodes
 *
 *   - "Homepage does not duplicate Service/Booking truth" — every card is a
 *     REFERENCE, and the values come from the owning service unchanged.
 *   - "All entity references use canonical IDs" — `services.id` from Catalog V2
 *     and `bookings.id`, never a family or a legacy option id.
 *   - "Personalized data is account-isolated" — driven as two customers.
 *
 * None of those can be read off a route table. Each is a claim about what a
 * specific caller receives, so every case here composes a real page against a
 * fake database that routes the real SQL, then asserts on the result.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => {
  const fake = require('./support/homeDbFake');
  return { __esModule: true, default: fake.dbQueryFake, pool: { connect: jest.fn() } };
});

/**
 * The CATALOG is mocked, and that is the point of the test rather than a
 * shortcut: the assertion is that the homepage republishes the catalog's own
 * projection unchanged. Giving it a distinctive price and asserting the card
 * carries exactly that proves the homepage did not recompute one.
 */
jest.mock('../src/services/catalogPublicService', () => ({
  listCategories: jest.fn().mockResolvedValue([
    { ref: 'category:3', id: 3, name: 'Personal Care', subcategoryCount: 4, serviceCount: 30 },
    { ref: 'category:5', id: 5, name: 'Home Repair', subcategoryCount: 2, serviceCount: 12 },
  ]),
  listPublicServices: jest.fn().mockResolvedValue([
    {
      ref: 'service:15', id: 15, name: 'Pimple Facial', slug: 'pimple-facial',
      imageUrl: null, categoryId: 3, categoryName: 'Personal Care',
      subcategoryId: 7, subcategoryName: 'Facial',
      basePrice: 1234.56, basePriceSummary: 'from PHP 1,234.56', bookable: true,
    },
    {
      ref: 'service:16', id: 16, name: 'Aircon Cleaning', slug: 'aircon-cleaning',
      imageUrl: null, categoryId: 5, categoryName: 'Home Repair',
      subcategoryId: 9, subcategoryName: 'Aircon',
      basePrice: 800, basePriceSummary: 'from PHP 800.00', bookable: true,
    },
    {
      ref: 'service:17', id: 17, name: 'Retired Service', slug: 'retired',
      imageUrl: null, categoryId: 5, categoryName: 'Home Repair',
      subcategoryId: 9, subcategoryName: 'Aircon',
      basePrice: null, basePriceSummary: null, bookable: false,
    },
  ]),
}));

import * as fake from './support/homeDbFake';
import { composeHome, describeSections } from '../src/services/home/homeService';
import {
  PERSONAL_SECTIONS,
  SECTION_TYPES,
  SECTION_TYPE_NAMES,
  cacheControlFor,
} from '../src/services/home/homePolicy';

const CUSTOMER_A = 'customer-a';
const CUSTOMER_B = 'customer-b';

const seed = () => {
  fake.reset();
  fake.seedUser(CUSTOMER_A, 3);
  fake.seedUser(CUSTOMER_B, 3);

  // Catalog V2 services, one of which carries a pre-V2 option id.
  fake.seedService(15, 'Pimple Facial');
  fake.seedService(16, 'Aircon Cleaning', { legacyOptionId: 900 });

  // A's history: two completed bookings for 15, one for 16 via the LEGACY id.
  fake.seedBooking(1, CUSTOMER_A, { catalog_service_id: 15, status: 'COMPLETED' });
  fake.seedBooking(2, CUSTOMER_A, { catalog_service_id: 15, status: 'COMPLETED' });
  fake.seedBooking(3, CUSTOMER_A, { service_option_id: 900, status: 'COMPLETED' });
  // A has one in flight.
  fake.seedBooking(4, CUSTOMER_A, { catalog_service_id: 15, status: 'CONFIRMED' });
  fake.seedNotification(CUSTOMER_A, true);
  fake.seedNotification(CUSTOMER_A, true);

  // B's history is separate and must stay that way.
  fake.seedBooking(5, CUSTOMER_B, { catalog_service_id: 16, status: 'COMPLETED' });
  fake.seedBooking(6, CUSTOMER_B, { catalog_service_id: 16, status: 'IN_PROGRESS' });
};

beforeEach(seed);

const viewerA = { uid: CUSTOMER_A, role: 3 };
const viewerB = { uid: CUSTOMER_B, role: 3 };

const sectionOf = (feed: Awaited<ReturnType<typeof composeHome>>, type: string) =>
  feed.sections.find((s) => s.type === type)!;

// ─── Canonical references ─────────────────────────────────────────────────────

describe('every reference is a canonical id', () => {
  it('service cards carry services.id and the Catalog V2 hierarchy', async () => {
    const feed = await composeHome(viewerA, ['featuredServices']);
    const items = sectionOf(feed, 'featuredServices').items as any[];

    expect(items.length).toBeGreaterThan(0);
    for (const card of items) {
      expect(typeof card.serviceId).toBe('number');
      expect(card.ref).toBe(`service:${card.serviceId}`);
      // §112: hierarchy context travels with the id.
      expect(card).toHaveProperty('categoryId');
      expect(card).toHaveProperty('subcategoryId');
    }
  });

  it('NO card carries a service family or a legacy option id', async () => {
    const feed = await composeHome(viewerA);
    const serialized = JSON.stringify(feed);
    for (const forbidden of [
      'serviceFamilyId', 'service_family_id', 'serviceOptionId', 'service_option_id',
      'legacyServiceOptionId', 'legacy_service_option_id',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('booking cards carry bookings.id and the CANONICAL state', async () => {
    const feed = await composeHome(viewerA, ['activeBooking']);
    const items = sectionOf(feed, 'activeBooking').items as any[];

    expect(items.length).toBeGreaterThan(0);
    for (const card of items) {
      expect(typeof card.bookingId).toBe('number');
      expect(card.bookingCode).toBe(`SVN-${String(card.bookingId).padStart(6, '0')}`);
      // §113: the canonical state, not a homepage enum. It must be one of the
      // machine's own states.
      const { BOOKING_STATES } = require('../src/services/booking/canonicalState');
      expect(BOOKING_STATES).toContain(card.canonicalState);
      expect(Array.isArray(card.availableActions)).toBe(true);
    }
  });

  it('resolves a booking created against a LEGACY option id to the right services.id', async () => {
    // Booking 3 has no catalog_service_id and option id 900, which maps to
    // service 16. Without the COALESCE fallback it would rank nothing, silently.
    const feed = await composeHome(viewerA, ['popularServices']);
    const ids = (sectionOf(feed, 'popularServices').items as any[]).map((c) => c.serviceId);
    expect(ids).toContain(16);
  });
});

// ─── It owns nothing ──────────────────────────────────────────────────────────

describe('the homepage does not duplicate Service or Booking truth', () => {
  it('republishes the catalog price UNCHANGED', async () => {
    const feed = await composeHome(viewerA, ['featuredServices']);
    const card = (sectionOf(feed, 'featuredServices').items as any[])
      .find((c) => c.serviceId === 15);

    // The distinctive value the mocked catalog returns. A homepage that
    // recomputed, rounded or reformatted would not produce exactly this.
    expect(card.basePrice).toBe(1234.56);
    expect(card.basePriceSummary).toBe('from PHP 1,234.56');
  });

  it('every section declares WHICH service owns its data', () => {
    for (const spec of describeSections()) {
      expect(spec.ownedBy.length).toBeGreaterThan(10);
      // The homepage naming itself as the owner of catalog or booking data would
      // be the violation this whole tab exists to prevent.
      if (['categories', 'featuredServices', 'activeBooking', 'notificationSummary'].includes(spec.type)) {
        expect(spec.ownedBy).not.toMatch(/^services\/home\//);
      }
    }
  });

  it('excludes non-bookable services from featured', async () => {
    // Service 17 is bookable: false. Surfacing it would be the homepage
    // deciding what may be booked, which the catalog already decided.
    const feed = await composeHome(viewerA, ['featuredServices']);
    const ids = (sectionOf(feed, 'featuredServices').items as any[]).map((c) => c.serviceId);
    expect(ids).not.toContain(17);
  });

  it('counts only COMPLETED bookings as popularity', async () => {
    // An in-flight or cancelled booking is not evidence that anybody wants the
    // service; counting one would let abandoned carts promote something.
    fake.seedBooking(7, CUSTOMER_B, { catalog_service_id: 17, status: 'CANCELLED' });
    fake.seedBooking(8, CUSTOMER_B, { catalog_service_id: 17, status: 'CANCELLED' });
    fake.seedBooking(9, CUSTOMER_B, { catalog_service_id: 17, status: 'CANCELLED' });

    const feed = await composeHome(viewerA, ['popularServices']);
    const ids = (sectionOf(feed, 'popularServices').items as any[]).map((c) => c.serviceId);
    expect(ids).not.toContain(17);
  });
});

// ─── Account isolation (§115) ─────────────────────────────────────────────────

describe('personal sections are account-isolated', () => {
  it('two customers get their OWN recent services', async () => {
    const a = await composeHome(viewerA, ['recentServices']);
    const b = await composeHome(viewerB, ['recentServices']);

    const idsA = (sectionOf(a, 'recentServices').items as any[]).map((c) => c.serviceId).sort();
    const idsB = (sectionOf(b, 'recentServices').items as any[]).map((c) => c.serviceId).sort();

    expect(idsA).toEqual([15, 16]);
    expect(idsB).toEqual([16]);
  });

  it('two customers get their OWN active bookings', async () => {
    const a = await composeHome(viewerA, ['activeBooking']);
    const b = await composeHome(viewerB, ['activeBooking']);

    expect((sectionOf(a, 'activeBooking').items as any[]).map((c) => c.bookingId)).toEqual([4]);
    expect((sectionOf(b, 'activeBooking').items as any[]).map((c) => c.bookingId)).toEqual([6]);
  });

  it('one customer\'s booking id never appears in another\'s page', async () => {
    const b = await composeHome(viewerB);
    const serialized = JSON.stringify(b);
    // Booking 4 is A's. Its code is the thing a leak would surface.
    expect(serialized).not.toContain('SVN-000004');
  });

  it('the unread count is the caller\'s own', async () => {
    const a = await composeHome(viewerA, ['notificationSummary']);
    const b = await composeHome(viewerB, ['notificationSummary']);

    expect((sectionOf(a, 'notificationSummary').items as any[])[0].unreadCount).toBe(2);
    expect((sectionOf(b, 'notificationSummary').items as any[])[0].unreadCount).toBe(0);
  });

  it('no composition function accepts a subject other than the viewer', () => {
    // The property, not an instance of it: `composeHome` takes a viewer and a
    // section list. There is no request field that could redirect it.
    expect(composeHome.length).toBeLessThanOrEqual(2);
  });

  it('an anonymous caller gets the page WITHOUT personal sections', async () => {
    const feed = await composeHome({ uid: null, role: 3 });
    for (const type of PERSONAL_SECTIONS) {
      const section = sectionOf(feed, type);
      expect(section.items).toEqual([]);
      // Not an error — a homepage without personalization is exactly what a
      // signed-out customer should see.
      expect(section.reason).toBe('REQUIRES_AUTH');
      expect(section.status).toBe('ok');
    }
    expect(feed.meta.personalized).toBe(false);
  });
});

// ─── Partial failure (§117) ───────────────────────────────────────────────────

describe('one failed section does not blank the homepage', () => {
  it('a failing section becomes unavailable and the rest still render', async () => {
    fake.store.failing.add('popularServices');
    const feed = await composeHome(viewerA);

    expect(sectionOf(feed, 'popularServices').status).toBe('unavailable');
    expect(sectionOf(feed, 'popularServices').reason).toBe('UNAVAILABLE');
    expect(sectionOf(feed, 'popularServices').items).toEqual([]);

    // Everything else is fine.
    expect(sectionOf(feed, 'categories').status).toBe('ok');
    expect((sectionOf(feed, 'categories').items as any[]).length).toBeGreaterThan(0);
    expect(sectionOf(feed, 'activeBooking').status).toBe('ok');
  });

  it('names the failures in meta, so a client can tell a partial page', async () => {
    fake.store.failing.add('popularServices');
    fake.store.failing.add('recentServices');
    const feed = await composeHome(viewerA);

    expect(feed.meta.unavailable.sort()).toEqual(['popularServices', 'recentServices']);
  });

  it('distinguishes EMPTY from UNAVAILABLE', async () => {
    // A new customer with no history.
    fake.seedUser('customer-new', 3);
    const feed = await composeHome({ uid: 'customer-new', role: 3 }, ['recentServices']);
    const section = sectionOf(feed, 'recentServices');

    // Empty is a fact about the account; unavailable is a fact about the
    // backend. Collapsing them shows "no recent services" to somebody with ten.
    expect(section.status).toBe('ok');
    expect(section.reason).toBe('EMPTY');
  });

  it('serves banners as NOT_CONFIGURED rather than inventing a promotions table', async () => {
    const feed = await composeHome(viewerA, ['banners']);
    const section = sectionOf(feed, 'banners');

    expect(section.items).toEqual([]);
    expect(section.reason).toBe('NOT_CONFIGURED');
    // Declared and empty, so a client builds the surface once and it fills in
    // the day a promotion source exists.
    expect(section.status).toBe('ok');
  });
});

// ─── Section selection ────────────────────────────────────────────────────────

describe('section selection', () => {
  it('returns the full declared set by default', async () => {
    const feed = await composeHome(viewerA);
    expect(feed.sections.map((s) => s.type).sort()).toEqual([...SECTION_TYPE_NAMES].sort());
  });

  it('honours an explicit selection', async () => {
    const feed = await composeHome(viewerA, ['categories']);
    expect(feed.sections.map((s) => s.type)).toEqual(['categories']);
  });

  it('deduplicates a repeated request rather than doubling the work', async () => {
    const feed = await composeHome(viewerA, ['categories', 'categories', 'categories']);
    expect(feed.sections).toHaveLength(1);
  });

  it('ignores an unknown section rather than refusing the page', async () => {
    // The registry is append-only. Refusing would make adding a section a
    // breaking change for every client shipped before it.
    const feed = await composeHome(viewerA, ['categories', 'somethingFromTheFuture']);
    expect(feed.sections.map((s) => s.type)).toEqual(['categories']);
  });

  it('falls back to the full set when EVERY requested name is unknown', async () => {
    // Composing an empty page would look like an outage to a client that simply
    // asked for something this build has not heard of.
    const feed = await composeHome(viewerA, ['nope', 'alsoNope']);
    expect(feed.sections.length).toBe(SECTION_TYPE_NAMES.length);
  });
});

// ─── Caching (§115, §116) ─────────────────────────────────────────────────────

describe('cache control is derived from the sections present', () => {
  it('a public-only selection is cacheable', () => {
    expect(cacheControlFor(['categories', 'featuredServices'])).toBe('public, max-age=300');
  });

  it('the shortest TTL wins — a response is only as fresh as its stalest part', () => {
    // categories is 300, popularServices is 900. Taking the maximum would serve
    // a 15-minute ranking under a 5-minute promise.
    expect(cacheControlFor(['categories', 'popularServices'])).toBe('public, max-age=300');
  });

  it('ANY personal section makes the whole response no-store', () => {
    for (const personal of PERSONAL_SECTIONS) {
      expect(cacheControlFor(['categories', personal])).toBe('private, no-store');
    }
  });

  it('every personal section declares a zero TTL', () => {
    for (const type of PERSONAL_SECTIONS) {
      expect(SECTION_TYPES[type].ttlSeconds).toBe(0);
    }
  });
});
