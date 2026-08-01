/**
 * Routes that returned other people's data with no token at all.
 *
 * These survived the first six-pass audit because of how they were counted. A
 * route was treated as "legacy worker family, cannot authenticate without a
 * coordinated ServanaWorker release (§2)" — a real constraint, applied without
 * checking what each route actually returned or whether anything still called
 * it. Two of them returned customer PII and had no caller at all.
 *
 * The blanket comment heading the block ("Public mobile routes — do NOT add
 * auth") was itself the problem: it was read as a constraint rather than as a
 * claim to verify. It was wrong. Both released apps attach a bearer token to
 * every request — ServanaClient at servana_api_client.dart:37-47, ServanaWorker
 * via a global Dio interceptor at servana_api_config.dart:74-79.
 *
 * Asserted at the source level: these are route-table facts, and a route table
 * is exactly the thing that regresses silently when someone adds a handler by
 * copy-paste.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const technicianRoutes = read('routes', 'technician.routes.ts');
const additionalRoutes = read('routes', 'additional.routes.ts');
const technicianService = read('services', 'technicianService.ts');

/**
 * The middleware list between the path and the handler for a given route, with
 * array spreads resolved.
 *
 * Resolving `...adminOnly` matters more than it looks. Counting `verifyAuth`
 * line by line is what produced the "261 of 412 routes unauthenticated" figure
 * during this audit — a scan that could not see
 * `const adminOnly = [verifyAuth, verifyRoles([1])]` and reported the entire
 * admin API as public. The real number was 71. A matcher that repeats that
 * mistake would pass this file while the routes were wide open, which is the
 * only failure mode that actually matters here.
 */
function guardsFor(source: string, method: string, routePath: string): string {
  const re = new RegExp(
    `router\\.${method}\\(\\s*["'\`]${routePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\`]([\\s\\S]*?)\\);`,
    'm',
  );
  const m = source.match(re);
  if (!m) throw new Error(`route not found: ${method.toUpperCase()} ${routePath}`);

  return m[1].replace(/\.\.\.(\w+)/g, (whole, name) => {
    // Terminate on `];` rather than the first `]`. The array being resolved is
    // `[verifyAuth, verifyRoles([0, 1])]` — a lazy `[\s\S]*?\]` stops at the
    // bracket inside verifyRoles and silently returns a truncated guard list.
    const decl = source.match(
      new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;`, 'm'),
    );
    return decl ? decl[1] : whole;
  });
}

describe('GET /api/workers/role/:role — the customer table dump', () => {
  it('the query really does return contact details for a caller-chosen role', () => {
    // Establishes that this is a PII route rather than a directory of names, so
    // a future reader can see why it is admin-gated.
    const sql = technicianService.slice(
      technicianService.indexOf('export const listWorkersByRole'),
      technicianService.indexOf('export const listWorkersByRole') + 500,
    );
    expect(sql).toContain('email');
    expect(sql).toContain('phone_number');
    expect(sql).toMatch(/WHERE role = \$1/);
  });

  it('requires authentication', () => {
    expect(guardsFor(technicianRoutes, 'get', '/workers/role/:role')).toContain('verifyAuth');
  });

  it('is restricted to admin roles, because the role comes from the URL', () => {
    // Authentication alone would not be enough: any logged-in customer could
    // still ask for role 3 and walk every other customer.
    const guards = guardsFor(technicianRoutes, 'get', '/workers/role/:role');
    expect(guards).toMatch(/adminOnly|verifyRoles\(\s*\[\s*0\s*,\s*1\s*\]\s*\)/);
  });
});

describe('GET /api/workers/all', () => {
  it('requires authentication and an admin role', () => {
    const guards = guardsFor(technicianRoutes, 'get', '/workers/all');
    expect(guards).toMatch(/adminOnly|verifyAuth/);
    expect(guards).toMatch(/adminOnly|verifyRoles/);
  });
});

describe('GET /api/workers/:workerId/job-cards — a customer address book', () => {
  it('is authenticated and scoped to the worker in the path', () => {
    const guards = guardsFor(technicianRoutes, 'get', '/workers/:workerId/job-cards');
    expect(guards).toContain('verifyAuth');
    expect(guards).toContain('verifyOwnership');
  });

  it('verifyOwnership actually reads workerId, not just uid', () => {
    // The middleware is shared; if someone narrows it to req.params.uid this
    // route silently stops being scoped while still looking guarded.
    const ownership = read('middleware', 'verifyOwnership.ts');
    expect(ownership).toContain('req.params.workerId');
  });
});

describe('the /api/additional/* family', () => {
  const ROUTES: Array<[string, string]> = [
    ['get', '/additional/booking/:bookingId'],
    ['post', '/additional/request/:userId'],
    ['post', '/additional/:id/payment'],
    ['post', '/additional/:id/worker-decision'],
    ['post', '/additional/:id/withdraw'],
    ['post', '/additional/:id/confirm-proceed'],
  ];

  it.each(ROUTES)('%s %s requires authentication', (method, routePath) => {
    expect(guardsFor(additionalRoutes, method, routePath)).toContain('verifyAuth');
  });

  it('the admin approval route keeps its role check', () => {
    const guards = guardsFor(additionalRoutes, 'post', '/additional/:id/approve');
    expect(guards).toContain('verifyAuth');
    expect(guards).toContain('verifyRoles');
  });

  it('no route in the family is left unguarded', () => {
    // Catches a newly added sibling, which is how this family grew to six open
    // routes in the first place.
    const declarations = [...additionalRoutes.matchAll(/router\.(get|post|put|patch|delete)\(([\s\S]*?)\);/g)];
    expect(declarations.length).toBeGreaterThanOrEqual(7);
    for (const d of declarations) {
      expect(d[2]).toContain('verifyAuth');
    }
  });
});

describe('the misleading comment is gone', () => {
  it('no blanket "do NOT add auth" instruction heads the worker block', () => {
    // It was load-bearing in the worst way: accurate-sounding, unverified, and
    // it kept three PII routes open through a security audit that read them.
    expect(technicianRoutes).not.toMatch(/do NOT add auth/i);
  });
});
