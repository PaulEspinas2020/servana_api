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

describe('schema', () => {
  test('adds the columns additively', () => {
    expect(cols).toContain('ADD COLUMN IF NOT EXISTS email_normalized');
    expect(cols).toContain('ADD COLUMN IF NOT EXISTS phone_normalized');
    expect(cols).toContain('ADD COLUMN IF NOT EXISTS is_mobile_verified');
  });

  test('mobile verification defaults to FALSE', () => {
    // §31: missing verification data must never imply verification.
    expect(cols).toMatch(/is_mobile_verified BOOLEAN NOT NULL DEFAULT false/);
  });

  test('uniqueness is enforced on the NORMALIZED columns', () => {
    // Enforcing on the raw column would be worthless: 0917… and +63917… are
    // different strings for the same number.
    // The index name comes from a loop variable, so the CREATE and the name are
    // not contiguous in the source. Assert both halves.
    expect(cols).toContain('CREATE UNIQUE INDEX IF NOT EXISTS ${name}');
    expect(cols).toContain('idx_uc_email_normalized_unique');
    expect(cols).toContain('idx_uc_phone_normalized_unique');
    // ...and that it indexes the normalized column, not the raw one.
    expect(cols).toMatch(/ON \$\{s\}\.user_credentials \(\$\{column\}\)/);
  });

  test('a duplicate is reported, not resolved automatically', () => {
    // §16: ambiguous ownership is quarantined for manual review. A script that
    // merged them would be picking a winner with no evidence.
    expect(cols).toContain('duplicate value(s) exist');
    expect(cols).not.toMatch(/DELETE FROM|MERGE|UPDATE .* SET uid/);
  });
});
