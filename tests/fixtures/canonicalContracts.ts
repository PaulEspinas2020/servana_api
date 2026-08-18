/**
 * Shared contract fixtures (§134).
 *
 * ONE instance of each cross-platform DTO, defined once here and consumed by
 * every parity test. The command asks that "the same Category/Subcategory/
 * Service/Booking response must deserialize consistently" across platforms, and
 * a fixture per test file cannot demonstrate that — five copies of a fixture
 * drift in exactly the way five copies of a DTO do.
 *
 * ## Why these values in particular
 *
 * Each field is chosen to FAIL if a platform gets it wrong, rather than to look
 * plausible:
 *
 *   - ids are in the ranges that actually collide. `services.id` 180,
 *     `service_families.id` 12 and a subcategory id 45 are all "service ids" in
 *     this platform's history, so a fixture using 1/2/3 would pass under any
 *     mix-up. 180 is the id from the ref-format docblock for the same reason.
 *   - `basePrice` is 1234.56 — two decimal places, not round. A client that
 *     reformats currency, or a backend that re-derives a price rather than
 *     republishing it, produces a different string.
 *   - timestamps are UTC ISO-8601 with milliseconds and a `Z`. A client parsing
 *     into local time and re-serializing produces an offset form, which is the
 *     bug this catches.
 *   - the name carries a non-ASCII character, because Philippine addresses and
 *     names do and a latin-1 round trip mangles it silently.
 *
 * ## What this file is NOT
 *
 * Not a mock of the backend. These are the SHAPES the OpenAPI document
 * declares; `tests/cross-platform-parity.test.ts` validates each fixture
 * against the real schema, so a fixture that stops matching the contract fails
 * rather than quietly testing a shape nothing serves.
 */

import { BOOKING_STATES, type BookingState } from '../../src/services/booking/canonicalState';

// ─── Catalog ──────────────────────────────────────────────────────────────────

export const CANONICAL_SERVICE = Object.freeze({
  ref: 'service:180',
  id: 180,
  subcategoryId: 45,
  name: 'Aircon Cleaning — Split Type',
  slug: 'aircon-cleaning-split-type',
  shortDescription: 'Deep clean for a wall-mounted split-type unit.',
  imageUrl: null,
  status: 'active',
  bookable: true,
  basePrice: 1234.56,
  unit: 'per unit',
  estimatedDurationMins: 90,
});

export const CANONICAL_SUBCATEGORY = Object.freeze({
  ref: 'subcategory:45',
  id: 45,
  categoryId: 7,
  name: 'Aircon Services',
  slug: 'aircon-services',
  services: Object.freeze([CANONICAL_SERVICE]),
});

export const CANONICAL_CATEGORY = Object.freeze({
  ref: 'category:7',
  id: 7,
  name: 'Home Cooling & Ventilation',
  slug: 'home-cooling-ventilation',
  subcategories: Object.freeze([CANONICAL_SUBCATEGORY]),
});

/**
 * The identities that must NOT appear as a service id anywhere in a v1
 * response. Kept beside the fixture so a parity test can assert their absence
 * against the same object every platform reads.
 */
export const FORBIDDEN_SERVICE_IDENTITIES = Object.freeze({
  /** `service_families.id` — legacy coarse provenance. */
  familyId: 12,
  /** `service_options.id` — the pre-Catalog-V2 bookable row. */
  optionId: 903,
  /** The subcategory, which the legacy `level2` field also means. */
  subcategoryId: 45,
});

// ─── Booking ──────────────────────────────────────────────────────────────────

export const CANONICAL_TIMESTAMP = '2026-03-09T01:30:00.000Z';

export const CANONICAL_BOOKING = Object.freeze({
  bookingId: 84213,
  reference: 'SRV-84213',
  serviceRef: CANONICAL_SERVICE.ref,
  serviceId: CANONICAL_SERVICE.id,
  canonicalState: 'EN_ROUTE' as BookingState,
  scheduledAt: CANONICAL_TIMESTAMP,
  createdAt: '2026-03-08T09:15:22.481Z',
  totalAmount: 1234.56,
  currency: 'PHP',
});

/** Every canonical state, so a parity test covers the machine rather than a sample. */
export const ALL_BOOKING_STATES: readonly BookingState[] = BOOKING_STATES;

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * The failure envelope every client parses. One shape, four keys.
 *
 * `details` is optional and `requestId` is not: a client that cannot quote a
 * request id turns every support conversation into a search.
 */
export const CANONICAL_ERROR = Object.freeze({
  error: Object.freeze({
    code: 'BOOKING_NOT_FOUND',
    message: 'No booking with that id.',
    requestId: '7f3c1a92-0d4e-4f6b-9c2a-1b8e5d0a3f77',
  }),
});

export const CANONICAL_SUCCESS = Object.freeze({
  data: CANONICAL_BOOKING,
  meta: Object.freeze({
    page: Object.freeze({ limit: 20, offset: 0, total: 1, hasMore: false }),
  }),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A deep JSON round trip — what actually happens between a server and a client. */
export const overTheWire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** ISO-8601, UTC, milliseconds, `Z`. The only timestamp form v1 emits. */
export const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const CANONICAL_REF_PATTERN = /^(category|subcategory|service|addon):[0-9]+$/;
