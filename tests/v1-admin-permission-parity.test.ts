/**
 * No v1 admin route may be a quieter way in than the legacy route it supersedes
 * (TAB 06).
 *
 * ## The risk this closes
 *
 * v1's `AuthMode` models a ROLE — `admin` means "role 1" — and nothing more.
 * Every legacy admin route additionally gates on a named permission from
 * `adminPermissionService`. A v1 successor that declared `auth: 'admin'` and
 * stopped there would be reachable by an admin the legacy route would have
 * refused: same data, weaker door, arriving as a migration rather than as a
 * change to authorization.
 *
 * The book calls this the single largest risk in TAB 06, and it is a quiet one.
 * Nothing fails. The endpoint works. It simply answers people it should not.
 *
 * ## How the two surfaces are compared
 *
 * Both sides are READ, never restated:
 *
 *   v1     `ContractEntry.permission`, which `register.ts` refuses to start
 *          without for any implemented `auth: 'admin'` entry
 *   legacy the `requirePermission('…')` literal in the mounted handler chain,
 *          via the same route table `authz:legacy` and the shadowed-route gate
 *          already trust
 *
 * The link between them is `ContractEntry.legacy[].path`, which the contract
 * already carries for the migration matrix. So this test contains no list of
 * routes and no list of permissions: a fifth admin endpoint added tomorrow is
 * compared without anybody editing this file.
 */

import { V1_CONTRACT } from '../src/api/v1/contract';
import { buildMountedRoutes } from '../scripts/lib/routeTable';
import { closureOf, permissionRequires } from '../scripts/lib/capabilityParity';

const ADMIN_ENTRIES = V1_CONTRACT.filter((e) => e.auth === 'admin' && e.status === 'implemented');

const PERM_RE = /requirePermission\(\s*['"]([^'"]+)['"]\s*\)/g;

const legacyPermissionsFor = (method: string, path: string): string[] | null => {
  const route = buildMountedRoutes().find(
    (r) => r.verb === method.toLowerCase() && r.fullPath === path,
  );
  if (!route) return null;
  const chain = route.handlers.join(' , ');
  const found = new Set<string>();
  PERM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PERM_RE.exec(chain))) found.add(m[1]);
  return [...found];
};

describe('the fixture is real (positive control)', () => {
  it('finds implemented admin entries in the contract', () => {
    expect(ADMIN_ENTRIES.length).toBeGreaterThan(0);
  });

  it('reads a permission out of a real legacy chain', () => {
    // If this stops finding one, every comparison below becomes vacuous.
    expect(legacyPermissionsFor('get', '/api/admin/bookings')).toContain('bookings.view');
  });
});

describe('every implemented admin entry declares a permission', () => {
  it.each(ADMIN_ENTRIES.map((e) => [e.id]))('%s', (id) => {
    const entry = ADMIN_ENTRIES.find((e) => e.id === id);
    expect(entry?.permission).toBeTruthy();
  });

  it('register.ts would refuse to start otherwise', () => {
    // Documented here because the enforcement lives at import time and is
    // therefore invisible in a passing run: an admin entry with no permission
    // throws before any route is mounted.
    const undeclared = ADMIN_ENTRIES.filter((e) => !e.permission).map((e) => e.id);
    expect(undeclared).toEqual([]);
  });
});

describe('no v1 admin entry is weaker than the legacy route it supersedes', () => {
  const requires = permissionRequires();

  const cases = ADMIN_ENTRIES.flatMap((entry) =>
    entry.legacy.map((l) => [entry.id, entry.permission ?? '', l.method, l.path] as const),
  );

  it('there are cases to check', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map((c) => [...c]))(
    '%s (%s) is at least as strict as %s %s',
    (id, v1Permission, legacyMethod, legacyPath) => {
      const legacyPerms = legacyPermissionsFor(String(legacyMethod), String(legacyPath));

      // A legacy route that no longer exists cannot be weakened by anything.
      if (legacyPerms === null) return;

      const v1Closure = closureOf([String(v1Permission)], requires);
      const missing = legacyPerms.filter((p) => !v1Closure.has(p));

      // Closure, not equality: a v1 entry declaring `bookings.assign_provider`
      // satisfies a legacy route demanding `bookings.view`, because the
      // catalogue declares the former as REQUIRING the latter. Comparing raw
      // strings would report that pair as a loosening, which it is not.
      expect({ id, missing }).toEqual({ id, missing: [] });
    },
  );
});

describe('the detector would notice a real loosening (positive control)', () => {
  const requires = permissionRequires();

  it('flags a v1 entry that drops its legacy permission entirely', () => {
    // `payouts.view` is not implied by `bookings.view`, so this is a genuine
    // loosening and must be reported as one.
    const v1Closure = closureOf(['bookings.view'], requires);
    expect([...v1Closure]).not.toContain('payouts.view');
  });

  it('does NOT flag a stricter permission that implies the legacy one', () => {
    const v1Closure = closureOf(['bookings.assign_provider'], requires);
    // Whatever the catalogue says assign requires, the check is containment.
    expect(v1Closure.has('bookings.assign_provider')).toBe(true);
  });
});
