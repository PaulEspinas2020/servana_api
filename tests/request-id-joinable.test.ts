/**
 * The request id, and what it can already be joined to.
 *
 * TAB 09 of the Admin API Master Command reports the front-end half done and
 * asks the backend for three things. Measured from this side, the first is
 * **half already built and undocumented**, the second is **already done**, and
 * the third is **already true**. This suite is what turns those from claims
 * into facts, and it names precisely what is still missing.
 *
 * ## Ask 2 — "the id on EVERY response, not only errors"
 *
 * Already true. `correlationMiddleware` is `app.use`d globally, before every
 * router, and unconditionally does `res.set(CORRELATION.header, …)`. It is not
 * on the error path; it is on the request path.
 *
 * ## Ask 3 — "confirm the id is stamped on the legacy /api/admin/* tree"
 *
 * Already true, and for a structural reason rather than by coincidence: the
 * middleware is mounted at the app level ahead of every router, so it cannot
 * know or care which tree a path belongs to. Asserted below against a legacy
 * admin path specifically, because "it should apply everywhere" is exactly the
 * kind of claim that turns out to have an exception.
 *
 * ## Ask 1 — "a log sink where that id can be looked up"
 *
 * > An operator can now read out `req_01J9ZK…`; nobody can currently turn it
 * > into the server log line that explains the failure. Until then the id is a
 * > token with no lock.
 *
 * **There is a lock, for the class of failure an operator is usually chasing.**
 * `admin_audit_events.request_id` is a real column, `recordAuditEvent` writes
 * it, `findEvents` filters on it, and `GET /api/admin/audit-logs?request_id=…`
 * exposes it. Nothing in either repository said so.
 *
 * What that answers: *"what did this admin action do, and what did it change?"*
 * — before/after state, actor, outcome, reason.
 *
 * What it does NOT answer, and this is the honest remainder: a failure that is
 * not an audited action — a 500 on a read, a validation refusal, a timeout —
 * exists only as a `console.info` line on stdout, which PM2 captures to a file
 * on the host. Greppable with a shell; not queryable by anyone else. Closing
 * that needs a log sink, which is infrastructure rather than code.
 */

import { Request, Response } from 'express';
import { correlationMiddleware } from '../src/observability/requestLog';
import { CORRELATION, CORRELATION_ID_PATTERN } from '../src/observability/observabilityPolicy';

// ─── A minimal express double ────────────────────────────────────────────────

interface FakeRes {
  headers: Record<string, string>;
  set(name: string, value: string): void;
}

const res = (): FakeRes => {
  const headers: Record<string, string> = {};
  return { headers, set(name, value) { headers[name.toLowerCase()] = value; } };
};

const req = (path: string, headers: Record<string, string> = {}, id?: string) =>
  ({
    path,
    id,
    get: (name: string) => headers[name.toLowerCase()],
  }) as unknown as Request;

const run = (r: Request) => {
  const response = res();
  let nexted = false;
  correlationMiddleware(r, response as unknown as Response, () => { nexted = true; });
  return { response, nexted };
};

describe('ask 2 — the id is on every response, not only on errors', () => {
  it('sets the header on a plain v1 request', () => {
    const { response, nexted } = run(req('/api/v1/bookings', {}, 'req_generated_01'));
    expect(response.headers['x-request-id']).toBe('req_generated_01');
    expect(nexted).toBe(true);
  });

  it('sets it with no inbound header and no prior id, rather than omitting it', () => {
    // 'unknown' is a deliberate answer. A missing header would leave a client
    // unable to tell "no id" from "a proxy stripped it".
    const { response } = run(req('/api/v1/catalog'));
    expect(response.headers['x-request-id']).toBe('unknown');
  });

  it('never throws over a malformed inbound header', () => {
    // The middleware wraps its whole body in try/catch on purpose: a header is
    // never a reason to fail a request.
    const nasty = 'x'.repeat(5000);
    expect(() => run(req('/api/v1/catalog', { 'x-request-id': nasty }))).not.toThrow();
  });
});

describe('ask 3 — the id is stamped on the LEGACY admin tree too', () => {
  it('stamps a legacy /api/admin path', () => {
    // The book asks for confirmation "since that is where 51 of the portal's
    // calls go". Measured from this side the legacy admin surface is 251
    // operations, which makes the answer matter more, not less.
    const { response } = run(req('/api/admin/communications/templates', {}, 'req_legacy_01'));
    expect(response.headers['x-request-id']).toBe('req_legacy_01');
  });

  it('stamps a legacy non-admin path as well', () => {
    const { response } = run(req('/api/bookings/7', {}, 'req_legacy_02'));
    expect(response.headers['x-request-id']).toBe('req_legacy_02');
  });

  it('is mounted before any router, which is WHY it covers both trees', () => {
    /**
     * The structural reason, asserted rather than trusted. If
     * `correlationMiddleware` ever moved below a router mount, that router's
     * responses would lose the header and every test above would still pass —
     * they exercise the middleware directly, not the app.
     */
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const app: string = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'app.ts'),
      'utf8',
    );
    const mountedAt = app.indexOf('app.use(correlationMiddleware)');
    expect(mountedAt).toBeGreaterThan(-1);

    /**
     * Every ROUTER mount must come after it.
     *
     * The first version of this matched `app.use(cors(` and failed — on
     * `app.use(cors(corsOptionsDelegate))` at the top of the file, which is the
     * GLOBAL cors policy and mounts no router at all. The detector was wrong,
     * not the app. A path-prefixed mount is what carries a router, so that is
     * what is matched: `app.use("/api/v1", cors(…), v1Router)`.
     */
    const routerMounts = [...app.matchAll(/app\.use\(\s*["'][^"']+["']\s*,\s*cors\(/g)]
      .map((m) => m.index!);
    expect(routerMounts.length).toBeGreaterThan(10);
    expect(Math.min(...routerMounts)).toBeGreaterThan(mountedAt);
  });
});

describe('an inbound correlation id is adopted, not discarded', () => {
  it('adopts a well-formed x-request-id from the caller', () => {
    // What makes a client-side trace joinable to a server-side one at all.
    const r = req('/api/v1/bookings', { 'x-request-id': 'req_from_client_123' }, 'req_generated');
    const { response } = run(r);
    expect(response.headers['x-request-id']).toBe('req_from_client_123');
    expect((r as any).correlationAdopted).toBe(true);
  });

  it('also accepts x-correlation-id', () => {
    const r = req('/api/v1/bookings', { 'x-correlation-id': 'corr_abc_123' }, 'req_generated');
    expect(run(r).response.headers['x-request-id']).toBe('corr_abc_123');
  });

  it('REFUSES a malformed id and keeps its own', () => {
    // Adopting anything a caller sends makes the id a log-injection vector and
    // an unbounded cardinality label on every metric.
    const r = req('/api/v1/bookings', { 'x-request-id': 'bad id with spaces' }, 'req_generated');
    expect(run(r).response.headers['x-request-id']).toBe('req_generated');
    expect((r as any).correlationAdopted).toBeUndefined();
  });

  it('refuses one that is too short to be a real trace id', () => {
    const r = req('/api/v1/bookings', { 'x-request-id': 'abc' }, 'req_generated');
    expect(run(r).response.headers['x-request-id']).toBe('req_generated');
  });

  it('bounds what it will accept, so the pattern is not decorative', () => {
    expect(CORRELATION_ID_PATTERN.test('req_01J9ZK4T7QY8')).toBe(true);
    expect(CORRELATION_ID_PATTERN.test('x'.repeat(129))).toBe(false);
    expect(CORRELATION_ID_PATTERN.test('has space')).toBe(false);
    expect(CORRELATION.header).toBe('X-Request-Id');
  });
});

describe('ask 1 — the lock that already exists', () => {
  /**
   * Asserted against the PRODUCTION statement builder, not a re-implementation
   * of it. `tests/admin-audit.test.js` re-implements pure logic inline "to
   * avoid needing a TS transform", and a test that reassembles a predicate can
   * be wider or narrower than the one that runs.
   */
  const audit = () => {
    let captured: { sql: string; params: unknown[] } | null = null;
    jest.resetModules();
    jest.doMock('../src/db/dbQuery', () => ({
      __esModule: true,
      default: {
        query: async (sql: string, params?: unknown[]) => {
          captured = { sql, params: params ?? [] };
          // findEvents runs a COUNT and a page query; both tolerate this.
          return { rows: [{ total: 0 }], rowCount: 0 };
        },
      },
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const svc = require('../src/services/adminAuditService');
    return { svc, captured: () => captured };
  };

  afterEach(() => {
    jest.dontMock('../src/db/dbQuery');
    jest.resetModules();
  });

  it('filters the audit trail by request id, in real SQL', async () => {
    const { svc, captured } = audit();
    await svc.findEvents({ requestId: 'req_01J9ZK4T7QY8', page: 1, limit: 10 });
    const c = captured();
    expect(c).not.toBeNull();
    // The predicate itself — this is the lock.
    expect(c!.sql).toMatch(/request_id\s*=\s*\$\d+/);
    expect(c!.params).toContain('req_01J9ZK4T7QY8');
  });

  it('does NOT add the predicate when no request id is given', () => {
    // A filter that always applies is not a filter. Proving the negative is
    // what shows the clause is driven by the argument.
    return (async () => {
      const { svc, captured } = audit();
      await svc.findEvents({ page: 1, limit: 10 });
      expect(captured()!.sql).not.toMatch(/request_id\s*=/);
    })();
  });

  it('persists the request id when an event is recorded', () => {
    // Both halves are needed. A filter over a column nothing writes finds
    // nothing, forever, with the gate green.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const src: string = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'adminAuditService.ts'),
      'utf8',
    );
    expect(src).toMatch(/INSERT INTO[\s\S]{0,600}?request_id/);
  });

  it('exposes the filter on the admin route, so an operator can reach it', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const ctrl: string = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'controllers', 'adminAuditController.ts'),
      'utf8',
    );
    // The query parameter, and the mapping onto the service filter.
    expect(ctrl).toMatch(/request_id/);
    expect(ctrl).toMatch(/requestId:\s*request_id/);
  });

  it('has a column for it in the schema baseline', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const sql: string = fs.readFileSync(
      path.join(__dirname, '..', 'scripts', 'baseline', '000-baseline.sql'),
      'utf8',
    );
    const table = /CREATE TABLE servana\.admin_audit_events \(([\s\S]*?)\n\);/.exec(sql);
    expect(table).not.toBeNull();
    expect(table![1]).toMatch(/^\s*request_id\s+text/m);
  });
});

/**
 * The admin error envelope reports the id the LOG will actually contain.
 *
 * This is the defect TAB 09 surfaced from this side, and it is worse than the
 * gap the book describes.
 *
 * `helpers/adminError` had no `req` — its signature takes only `res` — so it
 * did `randomUUID()` and stamped that. But `correlationMiddleware` had already
 * put the real correlation id on the response, the structured request log emits
 * THAT id, and `auditFire` records THAT id in `admin_audit_events.request_id`.
 * The helper overwrote it a moment before the body was sent.
 *
 * So an operator reading an id off a failed admin screen and searching for it
 * found nothing — not because the log was missing, but because they had been
 * handed a number that appears nowhere else in the system. The book calls the
 * id "a token with no lock"; on the admin tree it was a token with a lock that
 * could never open, across all 251 admin operations.
 *
 * The id is now read back off the response, where the middleware already put
 * it, so no call site had to change.
 */
describe('the admin error envelope joins to the log', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { adminError } = require('../src/helpers/adminError');

  const errorRes = () => {
    const headers: Record<string, unknown> = {};
    const captured: { status?: number; body?: any } = {};
    const r: any = {
      setHeader: (n: string, v: unknown) => { headers[n.toLowerCase()] = v; },
      getHeader: (n: string) => headers[n.toLowerCase()],
      status(code: number) { captured.status = code; return this; },
      json(body: any) { captured.body = body; return this; },
    };
    return { res: r, headers, captured };
  };

  it('reports the correlation id the middleware stamped, not a new one', () => {
    const { res, headers, captured } = errorRes();
    // Exactly what correlationMiddleware does, first.
    res.setHeader('X-Request-Id', 'req_01J9ZK4T7QY8');

    adminError(res, 404, 'NOT_FOUND', 'Template not found');

    expect(captured.body.error.requestId).toBe('req_01J9ZK4T7QY8');
    expect(headers['x-request-id']).toBe('req_01J9ZK4T7QY8');
  });

  it('does not mint a fresh id over an existing one', () => {
    // The regression, stated as the defect being GONE. Asserting "it equals the
    // stamped id" above would also pass if the helper coincidentally produced
    // it; this asserts it is not a UUID, which is what randomUUID emits.
    const { captured } = (() => {
      const e = errorRes();
      e.res.setHeader('X-Request-Id', 'req_01J9ZK4T7QY8');
      adminError(e.res, 500, 'SERVER_ERROR', 'boom');
      return e;
    })();
    expect(captured.body.error.requestId).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('falls back to a generated id rather than emitting "undefined"', () => {
    // Not reachable through the mounted app — the middleware always runs first
    // — but reachable from a unit test constructing a bare res, and a literal
    // "undefined" in an error envelope is worse than a useless uuid.
    const { captured } = (() => {
      const e = errorRes();
      adminError(e.res, 400, 'VALIDATION_ERROR', 'bad input');
      return e;
    })();
    expect(typeof captured.body.error.requestId).toBe('string');
    expect(captured.body.error.requestId.length).toBeGreaterThan(8);
    expect(captured.body.error.requestId).not.toBe('undefined');
  });

  it('does not adopt the placeholder the middleware uses when it has no id', () => {
    // correlationMiddleware writes 'unknown' when there is nothing to adopt and
    // nothing was generated. Echoing that into an error envelope would give an
    // operator a token that matches every other unknown request.
    const { captured } = (() => {
      const e = errorRes();
      e.res.setHeader('X-Request-Id', 'unknown');
      adminError(e.res, 500, 'SERVER_ERROR', 'boom');
      return e;
    })();
    expect(captured.body.error.requestId).not.toBe('unknown');
  });
});

describe('the error formatter cannot fail while formatting a failure', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { adminError } = require('../src/helpers/adminError');

  it('survives a response with no getHeader at all', () => {
    /**
     * Found by breaking it. The first version of the correlation lookup called
     * `res.getHeader(...)` directly and threw against a response double that
     * only implemented `setHeader` — and because this function runs while
     * BUILDING an error response, the throw did not degrade the message, it
     * replaced a clean 403 with an unhandled exception. 148 assertions in
     * tests/authz-negative went from 403 to 0.
     *
     * A formatter on the failure path must not be able to fail. Reading a
     * header is never worth a crash.
     */
    const captured: any = {};
    const bare: any = {
      setHeader: () => {},
      status(code: number) { captured.status = code; return this; },
      json(body: any) { captured.body = body; return this; },
    };
    expect(() => adminError(bare, 403, 'FORBIDDEN', 'nope')).not.toThrow();
    expect(captured.status).toBe(403);
    expect(typeof captured.body.error.requestId).toBe('string');
  });

  it('survives a getHeader that throws', () => {
    const captured: any = {};
    const hostile: any = {
      setHeader: () => {},
      getHeader: () => { throw new Error('header store exploded'); },
      status(code: number) { captured.status = code; return this; },
      json(body: any) { captured.body = body; return this; },
    };
    expect(() => adminError(hostile, 500, 'SERVER_ERROR', 'boom')).not.toThrow();
    expect(captured.status).toBe(500);
  });

  it('survives a getHeader returning a non-string, as node may for arrays', () => {
    const captured: any = {};
    const arrayish: any = {
      setHeader: () => {},
      getHeader: () => ['a', 'b'],
      status(code: number) { captured.status = code; return this; },
      json(body: any) { captured.body = body; return this; },
    };
    expect(() => adminError(arrayish, 400, 'VALIDATION_ERROR', 'bad')).not.toThrow();
    expect(typeof captured.body.error.requestId).toBe('string');
  });
});
