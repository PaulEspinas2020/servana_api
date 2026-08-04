/**
 * createAdminUser must create a COMPLETE user_credentials row.
 *
 * The insert used to be `(uid, role)` only. first_name and last_name are NOT
 * NULL, so that statement could only ever succeed on its ON CONFLICT branch —
 * for a uid that already had a row. Handed a genuinely new admin it raised:
 *
 *   23502  null value in column "first_name" violates not-null constraint
 *
 * which made the whole invite flow non-functional for new people, the only kind
 * of person anyone invites. It survived review because every check used a uid
 * that already existed as a customer or provider, so the insert always took the
 * conflict path and the missing columns never mattered.
 *
 * Static assertions over the source, consistent with the other admin tests here.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/**
 * Strip /* *\/ block comments BEFORE asserting.
 *
 * This is load-bearing, not tidiness. The function under test now carries a
 * long doc comment that names first_name and last_name several times to explain
 * the bug — so an assertion run against the raw file would be satisfied by the
 * PROSE and would keep passing after someone deleted the columns from the SQL.
 */
const stripBlockComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const stripLineComments = (s: string) =>
  s
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/.*/, ''))
    .join('\n');
const flat = (s: string) => s.replace(/\s+/g, ' ');

const svc = flat(stripLineComments(stripBlockComments(read('services/adminPermissionService.ts'))));

describe('the stripper this file depends on', () => {
  test('block comments really are removed', () => {
    // If this regresses, every assertion below becomes decorative — it would
    // match the explanation of the bug rather than the fix for it.
    expect(stripBlockComments('/** first_name last_name */ const x = 1;')).not.toContain('first_name');
    expect(stripBlockComments('/** a */ KEEP /* b */')).toContain('KEEP');
  });

  test('and real code survives it', () => {
    expect(svc).toContain('splitNameForCredentials');
  });
});

describe('createAdminUser writes a row that satisfies NOT NULL', () => {
  test('the insert supplies first_name and last_name', () => {
    expect(svc).toMatch(
      /INSERT INTO \$\{s\}\.user_credentials \(uid, email, first_name, last_name, role\)/
    );
  });

  test('the old (uid, role)-only insert is gone', () => {
    // The precise shape that raised 23502 in production.
    expect(svc).not.toMatch(/INSERT INTO \$\{s\}\.user_credentials \(uid, role\)/);
  });

  test('granting admin does not overwrite an existing real name', () => {
    // An existing account has a name its owner entered. Replacing it with an
    // email local part because they were made an admin is a regression, so
    // ON CONFLICT touches role and a null email only.
    const conflict = svc.match(/ON CONFLICT \(uid\) DO UPDATE SET[^`]*/)?.[0] ?? '';
    expect(conflict).toContain('role = 1');
    expect(conflict).not.toContain('first_name');
    expect(conflict).not.toContain('last_name');
  });

  test('an existing email is not clobbered either', () => {
    expect(svc).toMatch(/email\s*=\s*COALESCE\(\$\{s\}\.user_credentials\.email, EXCLUDED\.email\)/);
  });
});

describe('splitNameForCredentials', () => {
  test('falls back to the email local part, not a fabricated name', () => {
    // Inventing "John Smith" would put a wrong name on an account that shows up
    // in audit trails as the actor for real decisions.
    expect(svc).toMatch(/email\.split\(["']@["']\)\[0\]/);
    expect(svc).toMatch(/last:\s*["']["']/);
  });

  test('splits a supplied display name on whitespace', () => {
    expect(svc).toMatch(/dn\.split\(\/\\s\+\/\)/);
  });
});
