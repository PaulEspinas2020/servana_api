import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Guard against a column name that does not exist reaching production SQL.
 *
 * `accountLinking.ts` queried `COALESCE(is_archived, FALSE)`. The column is
 * `is_archive`. Postgres answered 42703 and the entire merge path died before
 * condition (4) — the guard detected the collision, the merge threw, and the
 * caller received a 500 instead of either a merge or the ACCOUNT_LINK_REQUIRED
 * 409. Nobody noticed because the only account exercising mobile sign-in
 * already had a row, so the collision block was skipped entirely.
 *
 * ── Why the existing test suite could not catch it ──────────────────────────
 * `tests/account-linking.test.ts` does `jest.mock('../src/db/dbQuery')` and
 * hands back fixtures keyed `is_archived`. The test therefore checks the code
 * against its OWN assumption about the schema, and a wrong assumption is
 * exactly what the bug was. A mocked database cannot catch a column that does
 * not exist; the fixture agrees with the defect.
 *
 * This test reads the SQL as text instead. It cannot prove a column exists —
 * only a live database can do that — but it can pin the spellings we have
 * already been bitten by, which is the failure that actually recurs.
 *
 * COLUMNS below were read from production on 2026-08-03:
 *   \d servana.user_credentials
 */
const REAL_USER_CREDENTIALS_COLUMNS = new Set([
  'uid',
  'email',
  'first_name',
  'last_name',
  'role',
  'created_date',
  'password',
  'phone_number',
  'is_archive', // NOT is_archived
  'is_email_verified',
  'is_phone_verified',
  'fcm_token',
  'worker_code',
  'account_status',
  'is_internal_fixer',
  'last_activity_at',
  'email_normalized',
  'phone_normalized',
  'is_mobile_verified',
]);

/** Files whose SQL touches user_credentials on the authentication path. */
const AUTH_SQL_FILES = [
  'src/services/accountLinking.ts',
  'src/services/accountLinkGuard.ts',
  'src/services/identifierResolver.ts',
  'src/services/identityColumns.ts',
  'src/services/accountDeletionService.ts',
];

/**
 * Spellings that are NOT columns but read like they are. Each earned its place
 * by shipping. `is_archived` is the response-shape name and a documented alias
 * in `fieldParity.ts`, which is precisely why it looks plausible in SQL.
 */
const NOT_COLUMNS = ['is_archived', 'isArchived', 'phoneNormalized', 'emailNormalized'];

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

/** Strip line and block comments so prose does not trip the check. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/**
 * Only SQL is in scope. TypeScript may legitimately use camelCase names like
 * `emailNormalized` as object fields — `deriveNormalized` returns exactly that —
 * and scanning whole files would flag them. Column names are a property of the
 * query text, so the query text is what gets inspected.
 */
const sqlLiterals = (src: string): string =>
  (stripComments(src).match(/`[^`]*`/g) ?? [])
    .filter((lit) => /\b(SELECT|INSERT|UPDATE|DELETE|ALTER TABLE|CREATE (UNIQUE )?INDEX)\b/i.test(lit))
    .join('\n');

describe('auth SQL uses real user_credentials column names', () => {
  for (const rel of AUTH_SQL_FILES) {
    for (const bad of NOT_COLUMNS) {
      it(`${rel} SQL does not read a column called "${bad}"`, () => {
        // An alias is legitimate: `... AS is_archived` renames the OUTPUT and
        // callers read that name off the row. What must never appear is the
        // token being selected or filtered on as though it were a column.
        const sql = sqlLiterals(read(rel)).replace(
          new RegExp(`\\bAS\\s+${bad}\\b`, 'gi'),
          ''
        );

        expect(sql).not.toMatch(new RegExp(`\\b${bad}\\b`));
      });
    }
  }

  it('the scanner actually sees the SQL it is meant to guard', () => {
    // A scanner that silently matches nothing passes every assertion above and
    // proves nothing. Pin that it is reading real queries.
    const sql = sqlLiterals(read('src/services/accountLinking.ts'));
    expect(sql).toMatch(/FROM\s+\$\{s\}\.user_credentials/);
    expect(sql.length).toBeGreaterThan(100);
  });

  it('rejects the exact defect that shipped', () => {
    // Positive control: the pre-fix text must fail the check.
    const shipped = 'const q = `SELECT uid, COALESCE(is_archived, FALSE) FROM x`;';
    const scanned = sqlLiterals(shipped).replace(/\bAS\s+is_archived\b/gi, '');
    expect(scanned).toMatch(/\bis_archived\b/);
  });

  it('the archive column is spelled is_archive in accountLinking', () => {
    const code = read('src/services/accountLinking.ts');
    expect(code).toMatch(/COALESCE\(is_archive,\s*FALSE\)/);
    expect(REAL_USER_CREDENTIALS_COLUMNS.has('is_archive')).toBe(true);
    expect(REAL_USER_CREDENTIALS_COLUMNS.has('is_archived')).toBe(false);
  });
});
