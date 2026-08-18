/**
 * The successor signpost is a published, machine-readable contract.
 *
 * `Link rel="successor-version"` (RFC 8288) is what a client generator or an
 * HTTP proxy follows automatically, and five Servana platforms are migrating
 * off legacy right now. A wrong signpost here is a wrong migration there.
 *
 * Production published, measured 2026-08-18:
 *
 *   GET /api/catalog   ->  </api/v1/bookings/:bookingId>; rel="successor-version"
 *   GET /api/services  ->  </api/v1/bookings/:bookingId>; rel="successor-version"
 *   GET /api/bookings  ->  </api/v1/bookings/:bookingId>; rel="successor-version"
 *   POST /api/quote    ->  </api/v1/bookings/:bookingId>; rel="successor-version"
 *
 * The catalog is not superseded by a booking read, and neither is pricing. The
 * cause was `GET /api/:id` compiling to a pattern matching any single segment
 * under `/api`, so the booking-detail alias answered for its literal siblings.
 *
 * Every path below is pinned — including the two that were already correct —
 * so a later refactor cannot silently invert the fix.
 */
import { findNotice, __notices, deprecationHeaders } from '../src/api/v1/deprecation';
import type { NextFunction, Request, Response } from 'express';

describe('successor-version signpost', () => {
  describe('a parameter must not swallow a literal sibling', () => {
    it.each([
      ['get', '/api/catalog', '/api/v1/catalog'],
      ['get', '/api/catalog/summary', '/api/v1/catalog/summary'],
      ['get', '/api/user/profile', '/api/v1/customer/profile'],
    ])('%s %s points at %s', (method, path, successor) => {
      expect(findNotice(method, path)?.successor).toBe(successor);
    });

    it.each([
      ['get', '/api/services'],
      ['get', '/api/bookings'],
      // GET is the verb measured broken on production; POST is pinned beside
      // it so the case cannot pass vacuously if the greedy matcher is ever
      // re-registered under a different method.
      ['get', '/api/quote'],
      ['post', '/api/quote'],
    ])(
      '%s %s publishes no successor, because the contract declares none',
      (method, path) => {
        // Silence is the honest answer. The contract holds no
        // ALIAS_TEMPORARILY mapping for these, so a header claiming one would
        // be inventing a migration target — which is exactly what production
        // was doing.
        expect(findNotice(method, path)).toBeNull();
      },
    );
  });

  describe('the parameterised aliases still resolve', () => {
    // The fix must not buy correctness for the literals by breaking the route
    // it was actually written for.
    it.each([
      ['get', '/api/123', '/api/v1/bookings/:bookingId'],
      ['get', '/api/456/timeline', '/api/v1/bookings/:bookingId/timeline'],
      ['get', '/api/789/tracking', '/api/v1/bookings/:bookingId/tracking'],
    ])('%s %s points at %s', (method, path, successor) => {
      expect(findNotice(method, path)?.successor).toBe(successor);
    });
  });

  describe('the guards, each independently', () => {
    it('an integer parameter rejects a non-numeric segment', () => {
      // Constraint 1. Booking and service ids are integers everywhere on this
      // platform, so a word can never be one.
      expect(findNotice('get', '/api/not-a-number')).toBeNull();
    });

    it('no notice matches a literal that another legacy route claims', () => {
      // Constraint 2, independent of the first: it holds even for a parameter
      // the contract types as a string, and it fails on a NEW route rather
      // than on a type change.
      const literals = new Set<string>();
      for (const n of __notices) {
        const seg = n.path.split('/').filter(Boolean)[1];
        if (seg && !seg.startsWith(':')) literals.add(seg);
      }
      expect(literals.size).toBeGreaterThan(0);

      for (const literal of literals) {
        const notice = findNotice('get', `/api/${literal}`);
        if (notice) {
          // If something answers, it must be the route that named this
          // literal — never a parameterised alias that merely fits.
          expect(notice.path).toBe(`/api/${literal}`);
        }
      }
    });

    it('literal routes are ordered before parameterised ones', () => {
      // Constraint 3. `findNotice` takes the first match, so order is part of
      // the correctness argument and not a cosmetic detail.
      const paramCount = (p: string) =>
        p.split('/').filter((s) => s.startsWith(':')).length;
      const counts = __notices.map((n) => paramCount(n.path));
      expect(counts).toEqual([...counts].sort((a, b) => a - b));
    });
  });

  it('EVERY notice still matches its own path', () => {
    /**
     * The check this TAB should have had from the start.
     *
     * The fix added three constraints across all 90 compiled notices, and only
     * nine paths were pinned individually. A matcher that stops matching its
     * own path does not fail loudly — the route keeps working and its
     * Deprecation header silently vanishes, so a client mid-migration simply
     * stops being told to move. Nothing else in the suite would notice.
     *
     * Both an integer and an opaque identifier are tried, because the digits
     * constraint is derived positionally from the successor's declared param
     * types: `/api/:id` is an integer booking id, while
     * `/api/user/notifications/:key` is an opaque string. A notice matching
     * neither form is broken.
     */
    const unmatched: string[] = [];
    for (const n of __notices) {
      const numeric = n.path.replace(/:[A-Za-z0-9_]+/g, '12345');
      const opaque = n.path.replace(/:[A-Za-z0-9_]+/g, 'abc-XYZ_9');
      if (!findNotice(n.method, numeric) && !findNotice(n.method, opaque)) {
        unmatched.push(`${n.method.toUpperCase()} ${n.path}`);
      }
    }
    expect({ count: unmatched.length, unmatched }).toMatchObject({ count: 0 });
  });

  it('there is a meaningful number of notices to check', () => {
    // Guards the vacuous pass: an empty notice list makes the property above
    // trivially true, and a build that compiles zero notices is a deprecation
    // clock that stopped.
    expect(__notices.length).toBeGreaterThan(50);
  });

  it('every notice points at an implemented canonical successor', () => {
    // A signpost to something unmounted is worse than no signpost.
    for (const n of __notices) {
      expect(n.successor.startsWith('/api/v1/')).toBe(true);
      expect(n.canonical).toBeTruthy();
    }
  });

  describe('additive only — one backend, five clients', () => {
    /**
     * The guardrail is that a deprecation notice changes no status, no body and
     * no behaviour. Asserted by measurement rather than by reading the code:
     * the middleware is run against a response that records every method
     * touched, and anything outside header-setting is a failure.
     */
    const runMiddleware = (method: string, path: string) => {
      const touched: string[] = [];
      const headers: Record<string, string> = {};
      const record = (name: string) => () => {
        touched.push(name);
        return res;
      };
      const res = {
        set: (name: string, value: string) => {
          headers[name] = value;
          return res;
        },
        status: record('status'),
        send: record('send'),
        json: record('json'),
        end: record('end'),
        write: record('write'),
        redirect: record('redirect'),
      } as unknown as Response;

      let nexted = false;
      const next: NextFunction = () => {
        nexted = true;
      };
      deprecationHeaders({ method, path } as Request, res, next);
      return { headers, touched, nexted };
    };

    it.each([
      ['GET', '/api/catalog'],
      ['GET', '/api/services'],
      ['GET', '/api/bookings'],
      ['GET', '/api/quote'],
      ['GET', '/api/catalog/summary'],
      ['GET', '/api/user/profile'],
    ])('%s %s: headers only, and always calls next()', (method, path) => {
      const { touched, nexted } = runMiddleware(method, path);
      // Nothing that could alter what the client receives.
      for (const forbidden of ['status', 'send', 'json', 'end', 'write', 'redirect']) {
        expect(touched).not.toContain(forbidden);
      }
      expect(nexted).toBe(true);
    });

    it('sets Deprecation and Link together, or neither', () => {
      for (const path of ['/api/catalog', '/api/services', '/api/catalog/summary']) {
        const { headers } = runMiddleware('GET', path);
        expect(Boolean(headers['Deprecation'])).toBe(Boolean(headers['Link']));
      }
    });

    it('emits no Sunset date, because none can honestly be kept', () => {
      // A date the platform cannot keep teaches client teams to ignore the
      // header, and then the one route really going away is ignored too.
      for (const n of __notices) {
        expect(n.sunsetEligible).toBe(false);
      }
    });
  });
});
