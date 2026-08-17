/**
 * Normalized identifiers are maintained on every account write (Command 5 §15).
 *
 * The uniqueness indexes and the unified sign-in lookup both key on
 * email_normalized / phone_normalized. A write path that does not maintain them
 * produces a row that cannot be found by sign-in and cannot be caught as a
 * duplicate — so the constraint silently stops protecting anything.
 *
 * Static assertions over the SQL: the defect would live in a column list or a
 * COALESCE, and a test stubbing the query result would pass against the broken
 * version.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const flat = (s: string) => s.replace(/\s+/g, ' ');
const code = (s: string) =>
  s.split('\n').map((l) => l.replace(/--.*/, '').replace(/^\s*\/\/.*/, '')).join('\n');

const user = flat(code(read('services/user.service.ts')));
const cols = flat(code(read('services/identityColumns.ts')));

describe('upsertFirebaseUser', () => {
  test('derives the normalized forms rather than trusting a caller', () => {
    // At the write path, so every caller maintains them without having to know.
    expect(user).toContain('deriveNormalized(email, phoneNumber)');
  });

  test('persists both normalized columns', () => {
    expect(user).toContain('email_normalized');
    expect(user).toContain('phone_normalized');
  });

  test('linking is preserved — a phone sign-in does not erase the email', () => {
    // §13. This already held for the raw columns; the normalized ones must
    // follow the same rule or the lookup key disagrees with its source value.
    expect(user).toMatch(
      /email_normalized = COALESCE\(EXCLUDED\.email_normalized, user_credentials\.email_normalized\)/
    );
    expect(user).toMatch(
      /phone_normalized = COALESCE\(EXCLUDED\.phone_normalized, user_credentials\.phone_normalized\)/
    );
  });

  test('still conflicts on uid, so linking cannot create a second account', () => {
    expect(user).toContain('ON CONFLICT (uid)');
  });
});

/**
 * ── Where these guarantees moved (TAB 02) ────────────────────────────────────
 *
 * This block used to assert the DDL text inside
 * `services/identityColumns.ts` — `ADD COLUMN IF NOT EXISTS email_normalized`,
 * `CREATE UNIQUE INDEX IF NOT EXISTS ${name}`, and so on. That function is gone:
 * the application no longer creates its own schema (TAB 02), so asserting on the
 * source of a deleted bootstrap would only pin a design that has been removed.
 *
 * Every guarantee it protected is still real, and every one is now asserted
 * against `scripts/baseline/000-baseline.sql` — production's own dump, and the
 * artifact a fresh database is built from. That is a STRONGER assertion than
 * before: it checks the schema that will actually exist, rather than checking
 * that some code intended to create it.
 *
 * The one that changed character is the duplicate rule. It used to be a
 * try/catch around `CREATE UNIQUE INDEX` that logged a count. The baseline
 * CARRIES both unique indexes, which means that attempt already succeeded in
 * production — no duplicate identifiers exist there. So the assertion is that
 * the constraint is present, plus that the audit script still exists and still
 * refuses to resolve a conflict by itself.
 */

const BASELINE = fs
  .readFileSync(path.join(__dirname, '..', 'scripts', 'baseline', '000-baseline.sql'), 'utf8')
  .replace(/\r\n/g, '\n');

/** The columns `servana.user_credentials` is created with. */
const userCredentialsColumns = (): string => {
  const match = /CREATE TABLE servana\.user_credentials \(([\s\S]*?)\n\);/.exec(BASELINE);
  if (!match) throw new Error('baseline does not create servana.user_credentials');
  return match[1];
};

describe('schema — the baseline supplies the normalized identifier columns', () => {
  const columns = userCredentialsColumns();

  test('the baseline really does define user_credentials (positive fixture)', () => {
    // A regex that silently matched nothing would make every test below vacuous.
    expect(columns).toContain('uid');
    expect(columns.split('\n').length).toBeGreaterThan(10);
  });

  test('carries all three identity columns', () => {
    expect(columns).toMatch(/email_normalized character varying\(254\)/);
    expect(columns).toMatch(/phone_normalized character varying\(20\)/);
    expect(columns).toContain('is_mobile_verified');
  });

  test('mobile verification defaults to FALSE', () => {
    // §31: missing verification data must never imply verification.
    expect(columns).toMatch(/is_mobile_verified boolean DEFAULT false NOT NULL/);
  });

  test('uniqueness is enforced on the NORMALIZED columns, not the raw ones', () => {
    /**
     * Enforcing on the raw column would be worthless: 0917… and +63917… are
     * different strings for the same number. So the index must name the
     * normalized column, and it must be UNIQUE and PARTIAL — Postgres treats
     * NULLs as distinct, but the predicate keeps the index small.
     */
    expect(BASELINE).toMatch(
      /CREATE UNIQUE INDEX idx_uc_email_normalized_unique ON servana\.user_credentials USING btree \(email_normalized\) WHERE \(email_normalized IS NOT NULL\)/,
    );
    expect(BASELINE).toMatch(
      /CREATE UNIQUE INDEX idx_uc_phone_normalized_unique ON servana\.user_credentials USING btree \(phone_normalized\) WHERE \(phone_normalized IS NOT NULL\)/,
    );
    // Neither uniqueness constraint may key on the RAW columns.
    expect(BASELINE).not.toMatch(/CREATE UNIQUE INDEX \S+ ON servana\.user_credentials USING btree \(email\)/);
    expect(BASELINE).not.toMatch(/CREATE UNIQUE INDEX \S+ ON servana\.user_credentials USING btree \(phone_number\)/);
  });

  test('the lookup indexes exist too, so sign-in does not table-scan', () => {
    expect(BASELINE).toContain('CREATE INDEX idx_uc_email_normalized ON servana.user_credentials');
    expect(BASELINE).toContain('CREATE INDEX idx_uc_phone_normalized ON servana.user_credentials');
  });

  test('a duplicate is still reported, not resolved automatically', () => {
    /**
     * §16: ambiguous ownership is quarantined for manual review. A script that
     * merged them would be picking a winner with no evidence.
     */
    const audit = fs.readFileSync(
      path.join(__dirname, '..', 'scripts', 'audit-identifier-conflicts.ts'),
      'utf8',
    );
    const auditSrc = flat(audit);
    // It groups in JavaScript rather than with SQL HAVING — it normalizes each
    // value through the same helpers sign-in uses, which SQL cannot do.
    expect(auditSrc).toMatch(/group\.length > 1/);
    expect(auditSrc).toMatch(/normalizeEmail|toE164PhMobile/);
    // READ ONLY is the §16 guarantee: it must never pick a winner.
    expect(flat(code(audit))).not.toMatch(/DELETE FROM|MERGE INTO|UPDATE \S+ SET /i);
  });

  test('identityColumns no longer issues DDL at all', () => {
    // The point of the change, asserted directly so a revert is visible.
    expect(cols).not.toMatch(/ADD COLUMN|CREATE INDEX|CREATE TABLE|ALTER TABLE/);
    expect(cols).toContain('deriveNormalized');
  });
});
