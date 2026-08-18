/**
 * One-time codes, with an explicit PURPOSE.
 *
 * ## The gap this closes
 *
 * `email_otps` has no purpose column. Today that is harmless because exactly
 * one thing writes to it — registration verification — so there is nothing to
 * confuse it with. It stops being harmless the moment a second purpose exists:
 * a code mailed to confirm a password reset would satisfy
 * `getLatestValidEmailOtp`, which asks only "is there an unused, unexpired code
 * for this address", and a registration screen would accept it. The same six
 * digits would unlock two different decisions.
 *
 * That is not a hypothetical for this platform. The target auth contract calls
 * for registration verification, password reset and sensitive-change
 * verification, and all three would land in this one table.
 *
 * So the purpose is written now, while there is only one, and every read is
 * scoped to it. Adding the second purpose then costs nothing and cannot go
 * wrong quietly.
 *
 * ## Why the column is ensured lazily rather than at boot
 *
 * `app.ts` runs fourteen schema bootstraps as unawaited IIFEs and calls
 * `listen()` without waiting for any of them, so a column created that way is
 * not guaranteed to exist when the first request arrives. A migration file
 * alone has the opposite problem: the code would ship before the migration ran
 * and every OTP read would fail on a missing column — a rename that is not
 * atomic with its deploy, which has taken this platform's production down once
 * already.
 *
 * The ensure here is memoised and AWAITED by every read and write, so the
 * column's existence is a precondition this module guarantees rather than a
 * deploy-ordering assumption. `scripts/migrations/026-otp-purpose.sql` carries
 * the same DDL for the controlled path; both are `IF NOT EXISTS`, so whichever
 * runs first wins and the other is a no-op.
 */

import bcrypt from 'bcryptjs';
import dbQuery from '../db/dbQuery';
import { db } from '../config';
import { normalizeEmail } from '../helpers/phoneIdentifier';
import { generateOTP } from '../helpers/otp';

const s = db.schema;

/**
 * What a code entitles the holder to do.
 *
 * A code minted for one purpose must never satisfy another. The values are
 * stored, so they are a contract: append, never rename.
 */
export const OTP_PURPOSES = {
  /** Prove control of an email address at sign-up. The only purpose in use today. */
  REGISTRATION_VERIFICATION: 'REGISTRATION_VERIFICATION',
  /** Prove control of an identifier before allowing a password reset. */
  PASSWORD_RESET: 'PASSWORD_RESET',
  /** Re-prove control before a sensitive change (identifier swap, payout details). */
  SENSITIVE_CHANGE: 'SENSITIVE_CHANGE',
} as const;

export type OtpPurpose = keyof typeof OTP_PURPOSES;

export const isOtpPurpose = (value: unknown): value is OtpPurpose =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(OTP_PURPOSES, value);

/** The only purpose any code in production carries today. */
export const DEFAULT_PURPOSE: OtpPurpose = 'REGISTRATION_VERIFICATION';

export const OTP_EXPIRY_MINUTES = 10;

/**
 * State a code can be in. Derived, not stored — `used` and `expires_at` are the
 * columns, and collapsing them into one enum here keeps every caller from
 * re-deriving the same three-way check slightly differently.
 */
export type OtpState = 'valid' | 'used' | 'expired' | 'absent';

let ensured: Promise<boolean> | null = null;

/**
 * Ensures the column, and reports whether it is there.
 *
 * ## Why this returns a boolean instead of throwing
 *
 * The DDL runs as the application's database role. If that role cannot ALTER
 * this table — a permission difference between environments, a migration
 * applied by the wrong user, the failure mode that has already taken this
 * platform's production down once — then throwing here would break email
 * verification for every new account. A schema nicety would have taken out
 * registration.
 *
 * So a failure degrades to the behaviour that exists today: an unscoped read.
 * That is not a silent weakening, and the reasoning is specific rather than
 * convenient — **registration is the only purpose any code has ever carried**,
 * so with one purpose in existence a scoped read and an unscoped read return
 * the same row. The scoping matters when a SECOND purpose is issued, and a
 * second purpose cannot be issued while this column is missing, because
 * `issueEmailOtp` refuses (below). The degradation is self-limiting.
 *
 * It is also loud: one error line naming the cause, every process start.
 */
export async function ensureOtpPurposeColumn(): Promise<boolean> {
  if (!ensured) {
    ensured = (async () => {
      try {
        await dbQuery.query(
          `ALTER TABLE ${s}.email_otps
             ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT '${DEFAULT_PURPOSE}'`,
          [],
        );
        await dbQuery.query(
          `CREATE INDEX IF NOT EXISTS idx_email_otps_email_purpose
             ON ${s}.email_otps (email, purpose, used, expires_at)`,
          [],
        );
        return true;
      } catch (error: any) {
        // eslint-disable-next-line no-console
        console.error(
          '[otp] could not ensure email_otps.purpose — falling back to UNSCOPED reads. ' +
            'Safe only while REGISTRATION_VERIFICATION is the sole purpose. ' +
            'Apply scripts/migrations/026-otp-purpose.sql as the `admin` role.',
          { error: error?.message ?? 'unknown' },
        );
        return false;
      }
    })();
  }
  return ensured;
}

/** Test seam — the memo is module-global and would leak between cases. */
export function __resetOtpEnsure(): void {
  ensured = null;
}

export interface IssuedOtp {
  code: string;
  purpose: OtpPurpose;
  expiresInMinutes: number;
}

/**
 * Mints and stores a code for one purpose.
 *
 * Returns the plaintext code because the caller has to deliver it. It is hashed
 * before storage and is never logged, never returned over the wire, and never
 * placed in an error message.
 */
export async function issueEmailOtp(
  email: string,
  purpose: OtpPurpose = DEFAULT_PURPOSE,
): Promise<IssuedOtp> {
  const canonicalEmail = normalizeEmail(email);
  if (!canonicalEmail) throw new Error('Invalid email address');

  const hasPurpose = await ensureOtpPurposeColumn();

  // A non-default purpose CANNOT be issued without the column. Writing one into
  // a table that cannot record it would produce a code indistinguishable from a
  // registration code — exactly the ambiguity this module exists to prevent,
  // arrived at by a different route. Refuse instead.
  if (!hasPurpose && purpose !== DEFAULT_PURPOSE) {
    throw new Error(
      `Cannot issue a ${purpose} code: email_otps.purpose is missing, so it could not be told ` +
        `apart from a ${DEFAULT_PURPOSE} code.`,
    );
  }

  const code = generateOTP();
  const codeHash = await bcrypt.hash(code, 10);

  if (hasPurpose) {
    await dbQuery.query(
      `INSERT INTO ${s}.email_otps (email, code_hash, expires_at, purpose)
       VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval, $4)`,
      [canonicalEmail, codeHash, OTP_EXPIRY_MINUTES, purpose],
    );
  } else {
    await dbQuery.query(
      `INSERT INTO ${s}.email_otps (email, code_hash, expires_at)
       VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval)`,
      [canonicalEmail, codeHash, OTP_EXPIRY_MINUTES],
    );
  }

  return { code, purpose, expiresInMinutes: OTP_EXPIRY_MINUTES };
}

/** The newest unused, unexpired code for this address AND this purpose. */
export async function findValidOtp(
  email: string,
  purpose: OtpPurpose = DEFAULT_PURPOSE,
): Promise<{ id: number; code_hash: string } | null> {
  const canonicalEmail = normalizeEmail(email);
  if (!canonicalEmail) return null;

  const hasPurpose = await ensureOtpPurposeColumn();

  const { rows } = hasPurpose
    ? await dbQuery.query(
        `SELECT * FROM ${s}.email_otps
          WHERE email = $1
            AND purpose = $2
            AND used = FALSE
            AND expires_at > NOW()
          ORDER BY created_at DESC
          LIMIT 1`,
        [canonicalEmail, purpose],
      )
    : await dbQuery.query(
        `SELECT * FROM ${s}.email_otps
          WHERE email = $1
            AND used = FALSE
            AND expires_at > NOW()
          ORDER BY created_at DESC
          LIMIT 1`,
        [canonicalEmail],
      );
  return rows[0] ?? null;
}

/**
 * Claims a code. Returns false if somebody else claimed it first.
 *
 * The UPDATE re-checks `used` and `expires_at`, so this is a compare-and-swap
 * rather than a read-then-write: two concurrent verifications of the same code
 * cannot both succeed.
 */
export async function consumeOtp(id: number): Promise<boolean> {
  const { rows } = await dbQuery.query(
    `UPDATE ${s}.email_otps
        SET used = TRUE
      WHERE id = $1 AND used = FALSE AND expires_at > NOW()
      RETURNING id`,
    [id],
  );
  return rows.length === 1;
}

export type VerifyOutcome =
  | { ok: true }
  /** No code, wrong code, expired code, or already used — deliberately one outcome. */
  | { ok: false; reason: 'OTP_INVALID' }
  /** A code exists for this address and purpose but its window has passed. */
  | { ok: false; reason: 'OTP_EXPIRED' };

/**
 * Checks a submitted code against the stored hash and claims it on success.
 *
 * ## Why "wrong code" and "no code" are the same outcome
 *
 * Distinguishing them tells an attacker whether an address is mid-registration,
 * which is a free membership check. `OTP_EXPIRED` is reported separately only
 * when a code for this address and purpose demonstrably existed and its window
 * has passed — that is information the legitimate holder needs (request a new
 * one) and that an attacker cannot obtain without already holding a valid code
 * for the address.
 */
export async function verifyEmailOtp(
  email: string,
  code: string,
  purpose: OtpPurpose = DEFAULT_PURPOSE,
): Promise<VerifyOutcome> {
  const canonicalEmail = normalizeEmail(email);
  if (!canonicalEmail || !/^\d{6}$/.test(String(code))) {
    return { ok: false, reason: 'OTP_INVALID' };
  }

  const hasPurpose = await ensureOtpPurposeColumn();

  const row = await findValidOtp(canonicalEmail, purpose);
  if (!row) {
    // Separate "expired" from "never existed" ONLY for a code that was really
    // issued for this address and purpose.
    const { rows } = hasPurpose
      ? await dbQuery.query(
          `SELECT 1 FROM ${s}.email_otps
            WHERE email = $1 AND purpose = $2 AND used = FALSE AND expires_at <= NOW()
            LIMIT 1`,
          [canonicalEmail, purpose],
        )
      : await dbQuery.query(
          `SELECT 1 FROM ${s}.email_otps
            WHERE email = $1 AND used = FALSE AND expires_at <= NOW()
            LIMIT 1`,
          [canonicalEmail],
        );
    return rows.length
      ? { ok: false, reason: 'OTP_EXPIRED' }
      : { ok: false, reason: 'OTP_INVALID' };
  }

  const matches = await bcrypt.compare(String(code), row.code_hash);
  if (!matches) return { ok: false, reason: 'OTP_INVALID' };

  const claimed = await consumeOtp(row.id);
  return claimed ? { ok: true } : { ok: false, reason: 'OTP_INVALID' };
}
