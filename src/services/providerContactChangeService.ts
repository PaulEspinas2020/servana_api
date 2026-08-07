import bcrypt from 'bcryptjs';
import { createHash, randomInt } from 'crypto';
import { getAuth } from 'firebase-admin/auth';
import dbQuery, { pool } from '../db/dbQuery';
import { db } from '../config';
import { firebaseAdmin } from '../middleware/firebaseApp';
import { noteRevoked } from './tokenRevocation';
import { sendContactChangeCode } from './providerContactChangeDelivery';

const s = db.schema;
const RECENT_AUTH_SECONDS = 5 * 60;
const CHALLENGE_SECONDS = 10 * 60;

export type ContactKind = 'email' | 'mobile';

const normalize = (kind: ContactKind, raw: string): string => {
  const value = raw.trim();
  if (kind === 'email') {
    const normalized = value.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 254) {
      throw Object.assign(new Error('Enter a valid email address'), { statusCode: 422, code: 'INVALID_EMAIL' });
    }
    return normalized;
  }
  const digits = value.replace(/\D/g, '');
  const normalized = digits.startsWith('63') && digits.length === 12 ? `+${digits}`
    : digits.startsWith('0') && digits.length === 11 ? `+63${digits.slice(1)}`
    : digits.length === 10 && digits.startsWith('9') ? `+63${digits}` : '';
  if (!normalized) throw Object.assign(new Error('Enter a valid Philippine mobile number'), { statusCode: 422, code: 'INVALID_MOBILE' });
  return normalized;
};

export const assertRecentAuth = (decoded: any): Date => {
  const authTime = Number(decoded?.auth_time);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authTime) || authTime > nowSeconds + 30 || nowSeconds - authTime > RECENT_AUTH_SECONDS) {
    throw Object.assign(new Error('Sign in again before changing a verified contact'), {
      statusCode: 401,
      code: 'RECENT_AUTH_REQUIRED',
      recovery: 'REAUTHENTICATE',
    });
  }
  return new Date(authTime * 1000);
};

const hashTarget = (target: string) => createHash('sha256').update(target).digest('hex');
const masked = (kind: ContactKind, target: string) => kind === 'email'
  ? `${target.slice(0, 2)}***${target.slice(target.indexOf('@'))}`
  : `*******${target.slice(-4)}`;

export async function requestContactChange(providerUid: string, decoded: any, input: {
  kind: ContactKind;
  target: string;
  clientRequestId: string;
}) {
  const recentAuthAt = assertRecentAuth(decoded);
  if (!['email', 'mobile'].includes(input.kind)) throw Object.assign(new Error('Unsupported contact type'), { statusCode: 422 });
  if (!/^[a-zA-Z0-9:_-]{16,128}$/.test(input.clientRequestId)) throw Object.assign(new Error('Invalid client request id'), { statusCode: 400 });
  const target = normalize(input.kind, input.target);
  const existing = await dbQuery.query(
    `SELECT uid FROM ${s}.user_credentials
     WHERE uid <> $1 AND role::int IN (2,4) AND lower(COALESCE(${input.kind === 'email' ? 'email' : 'phone_normalized'}, '')) = lower($2)
     LIMIT 1`,
    [providerUid, target],
  );
  if (existing.rowCount) throw Object.assign(new Error('That contact is unavailable'), { statusCode: 409, code: 'CONTACT_UNAVAILABLE' });

  const prior = await dbQuery.query(
    `SELECT id, contact_kind, normalized_target, state, expires_at
     FROM ${s}.provider_contact_change_requests WHERE provider_uid = $1 AND client_request_id = $2 LIMIT 1`,
    [providerUid, input.clientRequestId],
  );
  if (prior.rowCount) return present(prior.rows[0]);

  const code = randomInt(100000, 1000000).toString();
  const secretHash = await bcrypt.hash(code, 12);
  const result = await dbQuery.query(
    `INSERT INTO ${s}.provider_contact_change_requests
       (provider_uid, contact_kind, normalized_target, target_hash,
        verification_secret_hash, client_request_id, recent_auth_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW() + INTERVAL '10 minutes')
     RETURNING id, contact_kind, normalized_target, state, expires_at`,
    [providerUid, input.kind, target, hashTarget(target), secretHash, input.clientRequestId, recentAuthAt.toISOString()],
  );
  try {
    await sendContactChangeCode(input.kind, target, code);
  } catch (error) {
    await dbQuery.query(`UPDATE ${s}.provider_contact_change_requests SET state = 'cancelled', updated_at = NOW() WHERE id = $1`, [result.rows[0].id]).catch(() => {});
    throw error;
  }
  return present(result.rows[0]);
}

export async function confirmContactChange(providerUid: string, decoded: any, input: { requestId: string; code: string }) {
  assertRecentAuth(decoded);
  if (!/^\d{6}$/.test(input.code)) throw invalidCode();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT * FROM ${s}.provider_contact_change_requests
       WHERE id = $1 AND provider_uid = $2 FOR UPDATE`,
      [input.requestId, providerUid],
    );
    if (!found.rowCount) throw Object.assign(new Error('Contact change request not found'), { statusCode: 404 });
    const row = found.rows[0];
    if (row.state === 'committed') {
      await client.query('COMMIT');
      return { ...present(row), committed: true, signInRequired: true };
    }
    if (row.state !== 'pending_verification' || new Date(row.expires_at).getTime() <= Date.now()) {
      throw Object.assign(new Error('Verification code expired'), { statusCode: 410, code: 'CONTACT_CHALLENGE_EXPIRED' });
    }
    if (!await bcrypt.compare(input.code, row.verification_secret_hash)) throw invalidCode();

    const conflictColumn = row.contact_kind === 'email' ? 'email' : 'phone_normalized';
    const conflict = await client.query(
      `SELECT uid FROM ${s}.user_credentials
       WHERE uid <> $1 AND role::int IN (2,4) AND lower(COALESCE(${conflictColumn}, '')) = lower($2)
       LIMIT 1 FOR UPDATE`,
      [providerUid, row.normalized_target],
    );
    if (conflict.rowCount) throw Object.assign(new Error('That contact is unavailable'), { statusCode: 409, code: 'CONTACT_UNAVAILABLE' });

    const auth = getAuth(firebaseAdmin);
    const before = await auth.getUser(providerUid);
    try {
      if (row.contact_kind === 'email') {
        await auth.updateUser(providerUid, { email: row.normalized_target, emailVerified: true });
        await client.query(`UPDATE ${s}.user_credentials SET email = $1, email_normalized = $1, is_email_verified = true WHERE uid = $2 AND role::int IN (2,4)`, [row.normalized_target, providerUid]);
      } else {
        await auth.updateUser(providerUid, { phoneNumber: row.normalized_target });
        await client.query(`UPDATE ${s}.user_credentials SET phone_number = $1, phone_normalized = $1, is_mobile_verified = true WHERE uid = $2 AND role::int IN (2,4)`, [row.normalized_target, providerUid]);
      }
      await client.query(
        `UPDATE ${s}.provider_contact_change_requests
         SET state = 'committed', verified_at = NOW(), committed_at = NOW(),
             verification_secret_hash = NULL, version = version + 1, updated_at = NOW()
         WHERE id = $1`,
        [row.id],
      );
      await client.query(
        `INSERT INTO ${s}.provider_verification_events
           (provider_uid, domain, source_type, source_id, event_type, event_key)
         VALUES ($1, 'contact', 'contact_change', $2, $3, $4)
         ON CONFLICT (provider_uid, event_key) DO NOTHING`,
        [providerUid, String(row.id), `${row.contact_kind}_changed`, `contact-change:${row.id}`],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      const rollback = row.contact_kind === 'email'
        ? { email: before.email, emailVerified: before.emailVerified }
        : { phoneNumber: before.phoneNumber ?? null };
      await auth.updateUser(providerUid, rollback).catch(() => {});
      throw error;
    }
    await auth.revokeRefreshTokens(providerUid);
    noteRevoked(providerUid);
    return { requestId: String(row.id), kind: row.contact_kind, maskedTarget: masked(row.contact_kind, row.normalized_target), state: 'committed', committed: true, signInRequired: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const present = (row: any) => ({
  requestId: String(row.id),
  kind: row.contact_kind,
  maskedTarget: masked(row.contact_kind, row.normalized_target),
  state: row.state,
  expiresAt: row.expires_at,
});

const invalidCode = () => Object.assign(new Error('Verification code is invalid'), { statusCode: 422, code: 'INVALID_CONTACT_VERIFICATION_CODE' });
