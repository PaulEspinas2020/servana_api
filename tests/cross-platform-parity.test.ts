/**
 * Cross-platform parity (§134, §135): ids, enums, timestamps, errors, states.
 *
 * ## What this suite is actually testing
 *
 * Not "does the backend work" — every domain suite does that. This asks a
 * narrower question that no domain suite can: when the SAME thing is handed to
 * five different clients, do they all receive the same thing?
 *
 * The failures it exists to catch are the ones that survive every other test.
 * A booking is EN_ROUTE; the Admin projection reports `accepted` because its
 * legacy field cannot express en-route; if that were the ONLY field, Admin and
 * Customer would be looking at one booking and disagreeing about where the
 * provider is. That is not a bug in either projection. It is a bug in the pair,
 * and only a test that holds both at once can see it.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));

import {
  ALL_BOOKING_STATES,
  CANONICAL_BOOKING,
  CANONICAL_CATEGORY,
  CANONICAL_ERROR,
  CANONICAL_REF_PATTERN,
  CANONICAL_SERVICE,
  CANONICAL_SUBCATEGORY,
  CANONICAL_SUCCESS,
  CANONICAL_TIMESTAMP_PATTERN,
  FORBIDDEN_SERVICE_IDENTITIES,
  overTheWire,
} from './fixtures/canonicalContracts';
import {
  BOOKING_STATES,
  allowedActions,
  groupOf,
  isTerminal,
  type BookingState,
} from '../src/services/booking/canonicalState';
import {
  toAdminProjection,
  toCustomerProjection,
  toProviderProjection,
} from '../src/services/booking/projections';
import { V1_ERROR_STATUS, type V1ErrorCode } from '../src/api/v1/errors';
import { V1_CONTRACT } from '../src/api/v1/contract';
import { buildOpenApiDocument } from '../src/api/v1/openapi';

// ─── The fixtures are the real contract ───────────────────────────────────────

describe('the shared fixtures match the published schemas', () => {
  const doc: any = buildOpenApiDocument();
  const schema = (name: string) => doc.components.schemas[name];

  const requiredOf = (name: string): string[] => schema(name)?.required ?? [];
  const propsOf = (name: string): string[] => Object.keys(schema(name)?.properties ?? {});

  it('CatalogService carries every required field and invents none', () => {
    // A fixture that has drifted from the contract is a fixture testing a shape
    // nothing serves, which is worse than no fixture.
    for (const field of requiredOf('CatalogService')) {
      expect(Object.keys(CANONICAL_SERVICE)).toContain(field);
    }
    for (const field of Object.keys(CANONICAL_SERVICE)) {
      expect(propsOf('CatalogService')).toContain(field);
    }
  });

  it('CatalogSubcategory and CatalogCategory likewise', () => {
    for (const field of Object.keys(CANONICAL_SUBCATEGORY)) {
      expect(propsOf('CatalogSubcategory')).toContain(field);
    }
    for (const field of Object.keys(CANONICAL_CATEGORY)) {
      expect(propsOf('CatalogCategory')).toContain(field);
    }
  });
});

// ─── Identity parity ──────────────────────────────────────────────────────────

describe('one service identity, whichever client is asking', () => {
  it('the canonical id is services.id and the ref names it', () => {
    expect(CANONICAL_SERVICE.ref).toBe(`service:${CANONICAL_SERVICE.id}`);
    expect(CANONICAL_SERVICE.ref).toMatch(CANONICAL_REF_PATTERN);
  });

  it('never presents a family id or an option id as the service id', () => {
    /**
     * Four different things in this platform are called a "service id" and
     * three are integers in overlapping ranges. This is the assertion that
     * catches a projection reaching for the wrong one.
     */
    expect(CANONICAL_SERVICE.id).not.toBe(FORBIDDEN_SERVICE_IDENTITIES.familyId);
    expect(CANONICAL_SERVICE.id).not.toBe(FORBIDDEN_SERVICE_IDENTITIES.optionId);
    expect(CANONICAL_SERVICE.id).not.toBe(FORBIDDEN_SERVICE_IDENTITIES.subcategoryId);
  });

  it('the subcategory id is a SUBCATEGORY, not the service repeated', () => {
    // The legacy `level2` field means the subcategory, and response-parity
    // middleware used to map `name` onto it — so a Service claimed its own name
    // as its subcategory.
    expect(CANONICAL_SERVICE.subcategoryId).toBe(CANONICAL_SUBCATEGORY.id);
    expect(CANONICAL_SERVICE.subcategoryId).not.toBe(CANONICAL_SERVICE.id);
  });

  it('the tree is category → subcategory → service, keyed all the way down', () => {
    expect(CANONICAL_CATEGORY.subcategories[0].categoryId).toBe(CANONICAL_CATEGORY.id);
    expect(CANONICAL_CATEGORY.subcategories[0].services[0].subcategoryId)
      .toBe(CANONICAL_SUBCATEGORY.id);
  });

  it('carries no level2 field in any form', () => {
    const wire = JSON.stringify([CANONICAL_CATEGORY, CANONICAL_SUBCATEGORY, CANONICAL_SERVICE]);
    expect(wire).not.toMatch(/level2|level_2/i);
  });

  it('survives a JSON round trip byte-identically', () => {
    // Ids that arrive as strings on one platform and numbers on another are the
    // classic cross-platform break; so is a price that gains a decimal.
    const wire = overTheWire(CANONICAL_SERVICE);
    expect(wire).toEqual(CANONICAL_SERVICE);
    expect(typeof wire.id).toBe('number');
    expect(wire.basePrice).toBe(1234.56);
  });

  it('keeps a non-ASCII name intact', () => {
    const wire = overTheWire({ name: 'Aircon Cleaning — Split Type' });
    expect(wire.name).toContain('—');
  });
});

// ─── State parity ─────────────────────────────────────────────────────────────

describe('three projections of ONE booking state', () => {
  it('every canonical state projects for every actor', () => {
    for (const state of ALL_BOOKING_STATES) {
      expect(() => toAdminProjection(state)).not.toThrow();
      expect(() => toCustomerProjection(state)).not.toThrow();
      expect(() => toProviderProjection(state)).not.toThrow();
    }
  });

  it('every projection carries the canonical state VERBATIM', () => {
    /**
     * The load-bearing assertion of this whole suite. A projection may reword
     * and may group; it may not lose the distinction. As long as every one
     * carries `canonicalState` unchanged, no two surfaces can report a booking
     * as being in different states.
     */
    for (const state of ALL_BOOKING_STATES) {
      expect(toAdminProjection(state).canonicalState).toBe(state);
      expect(toCustomerProjection(state).canonicalState).toBe(state);
      expect(toProviderProjection(state).canonicalState).toBe(state);
    }
  });

  it('agrees on terminality across all three', () => {
    // A booking that is finished for the customer and live for the provider is
    // a support call nobody can resolve.
    for (const state of ALL_BOOKING_STATES) {
      const admin = toAdminProjection(state).terminal;
      expect(toCustomerProjection(state).terminal).toBe(admin);
      expect(toProviderProjection(state).terminal).toBe(admin);
      expect(admin).toBe(isTerminal(state));
    }
  });

  it("Admin's lossy legacy field is FLAGGED wherever it cannot express the state", () => {
    // EN_ROUTE and ARRIVED both collapse to `accepted`. The collapse stays
    // because the portal types the field as a closed union — but a client
    // reading only that field must be able to know it is being lied to.
    const enroute = toAdminProjection('EN_ROUTE');
    expect(enroute.operationsStatus).toBe('accepted');
    expect(enroute.stateIsCollapsedInLegacyField).toBe(true);
    expect(enroute.canonicalState).toBe('EN_ROUTE');

    // ...and where it is faithful, it says so.
    expect(toAdminProjection('IN_PROGRESS').stateIsCollapsedInLegacyField).toBe(false);
  });

  it('offers a provider no action the state machine would refuse', () => {
    // A button whose request the backend rejects is worse than no button.
    for (const state of ALL_BOOKING_STATES) {
      const projection = toProviderProjection(state);
      if (projection.nextAction) {
        expect(projection.availableActions).toContain(projection.nextAction);
      }
    }
  });

  it('gives each actor only the actions their own role permits', () => {
    for (const state of ALL_BOOKING_STATES) {
      expect(toCustomerProjection(state).availableActions).toEqual(allowedActions(state, 'customer'));
      expect(toProviderProjection(state).availableActions)
        .toEqual(allowedActions(state, 'assigned_provider'));
      expect(toAdminProjection(state).availableActions).toEqual(allowedActions(state, 'admin'));
    }
  });

  it('never lets a customer projection claim a provider-only action', () => {
    for (const state of ALL_BOOKING_STATES) {
      const customer = toCustomerProjection(state).availableActions;
      for (const action of ['accept', 'decline', 'markEnRoute', 'markArrived', 'startJob']) {
        expect(customer).not.toContain(action);
      }
    }
  });

  it('groups states without ever replacing them', () => {
    for (const state of ALL_BOOKING_STATES) {
      const admin = toAdminProjection(state);
      expect(admin.stateGroup).toBe(groupOf(state));
      // The group is ALONGSIDE the state, never instead of it.
      expect(admin.canonicalState).toBe(state);
    }
  });

  it('the state vocabulary is the one the fixture was written against', () => {
    // If a state is added, this fails and the fixture is updated deliberately
    // rather than the suite silently covering ten of eleven states.
    expect(BOOKING_STATES).toHaveLength(11);
    expect(ALL_BOOKING_STATES).toEqual(BOOKING_STATES);
    expect(CANONICAL_BOOKING.canonicalState).toBe('EN_ROUTE');
  });

  it('every state a contract entry can produce is in the canonical vocabulary', () => {
    const states = new Set<string>(BOOKING_STATES as readonly string[]);
    for (const state of ALL_BOOKING_STATES) expect(states.has(state)).toBe(true);
  });
});

// ─── Timestamp parity ─────────────────────────────────────────────────────────

describe('one timestamp format', () => {
  it('is ISO-8601, UTC, with milliseconds', () => {
    expect(CANONICAL_BOOKING.scheduledAt).toMatch(CANONICAL_TIMESTAMP_PATTERN);
    expect(CANONICAL_BOOKING.createdAt).toMatch(CANONICAL_TIMESTAMP_PATTERN);
  });

  it('round-trips through Date without moving', () => {
    // A client that parses to local time and re-serializes produces an offset
    // form. Same instant, different string — and a cache key that no longer
    // matches, and a "today" filter that is wrong for eight hours a day in
    // Manila.
    const parsed = new Date(CANONICAL_BOOKING.scheduledAt);
    expect(parsed.toISOString()).toBe(CANONICAL_BOOKING.scheduledAt);
  });

  it('carries no local-offset form anywhere in the fixtures', () => {
    const wire = JSON.stringify([CANONICAL_BOOKING, CANONICAL_SUCCESS]);
    expect(wire).not.toMatch(/\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/);
  });
});

// ─── Error parity ─────────────────────────────────────────────────────────────

describe('one error envelope', () => {
  it('is { error: { code, message, requestId } }', () => {
    expect(Object.keys(CANONICAL_ERROR)).toEqual(['error']);
    expect(CANONICAL_ERROR.error.code).toBeDefined();
    expect(CANONICAL_ERROR.error.message).toBeDefined();
    // Without a request id every support conversation becomes a log search.
    expect(CANONICAL_ERROR.error.requestId).toBeDefined();
  });

  it('carries no success flag a client could read instead of the status', () => {
    // A second, independently-settable signal is how `{ success: true }` bodies
    // end up on 500s.
    expect(CANONICAL_ERROR).not.toHaveProperty('success');
    expect(CANONICAL_ERROR).not.toHaveProperty('status');
    expect(CANONICAL_SUCCESS).not.toHaveProperty('success');
    expect(CANONICAL_SUCCESS).not.toHaveProperty('status');
  });

  it('every code a contract entry declares has exactly one status', () => {
    // The same code answering 404 on one route and 422 on another is a client
    // branching on the status and getting it right by accident.
    const declared = new Set<V1ErrorCode>();
    for (const entry of V1_CONTRACT) for (const code of entry.errors) declared.add(code);
    expect(declared.size).toBeGreaterThan(10);
    for (const code of declared) {
      expect(typeof V1_ERROR_STATUS[code]).toBe('number');
    }
  });

  it('no contract entry declares a code the error module does not know', () => {
    for (const entry of V1_CONTRACT) {
      for (const code of entry.errors) {
        expect(V1_ERROR_STATUS).toHaveProperty(code);
      }
    }
  });

  it('the fixture error code is a real one', () => {
    expect(V1_ERROR_STATUS).toHaveProperty(CANONICAL_ERROR.error.code);
    expect(V1_ERROR_STATUS[CANONICAL_ERROR.error.code as V1ErrorCode]).toBe(404);
  });
});

// ─── Envelope parity ──────────────────────────────────────────────────────────

describe('one success envelope', () => {
  it('is { data, meta? } with no envelope-level flags', () => {
    expect(Object.keys(CANONICAL_SUCCESS).sort()).toEqual(['data', 'meta']);
  });

  it('pages the same way for every client', () => {
    const page = CANONICAL_SUCCESS.meta.page;
    expect(Object.keys(page).sort()).toEqual(['hasMore', 'limit', 'offset', 'total']);
    // `hasMore` is computed, never guessed from a short page — a client cannot
    // tell a short page from the end of the list.
    expect(page.hasMore).toBe(page.offset + page.limit < (page.total ?? 0));
  });
});
