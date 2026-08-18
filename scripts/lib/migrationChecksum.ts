/**
 * The migration checksum, computed the same way on every platform.
 *
 * ## The defect this fixes
 *
 * A deploy failed with `Applied migration checksum changed: 001-massage-services.sql`
 * when nothing about that migration had changed in eight months. The ledger held
 * `63809a45…` and the file on the deploy host hashed to `272d57a5…`.
 *
 * Both were correct. The ledger rows were written from a Windows working copy,
 * where git checks out CRLF; the Linux deploy host checks out LF. Same bytes of
 * SQL, different line-ending encoding, different sha256 — and no `.gitattributes`
 * in the repository to normalise either way.
 *
 * The consequence is worse than one failed deploy: EVERY migration mismatches,
 * so the drift check fires on the first file it reads and no deploy can ever
 * apply a migration again. A guard that always fires is the same as no guard,
 * because the fix people reach for is to delete it.
 *
 * ## Why normalise rather than add .gitattributes
 *
 * A `.gitattributes` with `*.sql text eol=lf` would fix future checkouts, but it
 * would not fix the 38 rows already recorded, and it would silently rewrite
 * working copies on the next checkout. More importantly it treats the symptom:
 * the checksum is meant to answer "has this migration's CONTENT changed", and
 * the answer should not depend on which operating system asked.
 *
 * So the hash is taken over content with line endings normalised. A migration
 * edited on Windows and one edited on Linux produce the same checksum, which is
 * what the guard was always trying to express.
 *
 * A lone CR (classic Mac) is normalised too — not because anyone uses it, but
 * because leaving one case out is how this recurs.
 */

import { createHash } from 'crypto';

/**
 * Line endings normalised to LF.
 *
 * Exported so a test can assert the normalisation directly rather than inferring
 * it from a hash, and so a ledger-repair script uses the identical rule.
 */
export const normaliseLineEndings = (sql: string): string =>
  sql.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

/**
 * The checksum recorded in `servana.schema_migrations`.
 *
 * Every producer must use THIS function. Two call sites computing the hash
 * slightly differently is the same class of bug as two line-ending conventions,
 * and harder to see.
 */
export const migrationChecksum = (sql: string): string =>
  createHash('sha256').update(normaliseLineEndings(sql)).digest('hex');
