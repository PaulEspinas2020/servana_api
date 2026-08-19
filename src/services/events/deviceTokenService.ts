/**
 * ONE account-scoped device-token store (§95).
 *
 * ## What was wrong
 *
 * Providers had a token TABLE (`provider_notification_device_tokens`) and
 * therefore multi-device push. Customers had a single COLUMN
 * (`user_credentials.fcm_token`), so a customer signed in on a phone and a
 * tablet only ever received push on whichever signed in last — silently, with
 * no error anywhere. Same platform, same feature, two implementations, one of
 * them broken.
 *
 * ## What this does about it
 *
 * `account_device_tokens` is the canonical store for every account regardless of
 * role. Both legacy locations are DUAL-WRITTEN and are still READ, because
 * ServanaWorker and ServanaClient register through the legacy routes today and
 * a device that registered before this shipped must keep receiving push. The
 * union is what `tokensFor` returns.
 *
 * ## Stale tokens
 *
 * FCM tells you when a token is dead — `messaging/registration-token-not-registered`
 * — and until now nothing listened. Dead tokens accumulate forever and every
 * send retries all of them, so a provider who has reinstalled three times costs
 * four sends and gets one. `pruneToken` removes a token from every store it can
 * be in, and it is called from the send path's per-token failure handler.
 *
 * Pruning is deliberately narrow: ONLY the two error codes that mean "this token
 * will never work again". A transient network failure must not delete a working
 * device, which would silently un-enroll people from push during an outage.
 */

import dbQuery from '../../db/dbQuery';
import { db } from '../../config';
import { recordEventSignal } from './eventTelemetry';

const s = db.schema;

let schemaReady: Promise<void> | null = null;

/**
 * Additive DDL, lazily applied. `scripts/migrations/033-domain-event-outbox.sql`
 * performs the same statements so a DBA can apply them deliberately.
 */
export const ensureDeviceTokenSchema = async (): Promise<void> => {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await dbQuery.query(
      `CREATE TABLE IF NOT EXISTS ${s}.account_device_tokens (
         token       TEXT PRIMARY KEY,
         uid         VARCHAR(128) NOT NULL,
         platform    VARCHAR(16),
         app         VARCHAR(32),
         created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
      [],
    );
    await dbQuery.query(
      `CREATE INDEX IF NOT EXISTS idx_account_device_tokens_uid
         ON ${s}.account_device_tokens (uid)`,
      [],
    );
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
};

/**
 * The same validation the provider path already applied, in one place.
 *
 * A token is opaque and long; anything with whitespace or a control character in
 * it is a client bug or an injection attempt, and either way is not a token.
 */
export const validDeviceToken = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  return token.length >= 10 && token.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(token)
    ? token
    : null;
};

const PLATFORMS = new Set(['ios', 'android', 'web', 'unknown']);

const normalisePlatform = (value: unknown): string | null => {
  const raw = String(value ?? '').trim().toLowerCase();
  return PLATFORMS.has(raw) ? raw : null;
};

export interface RegisterResult {
  registered: boolean;
  /** How many devices this account now has, after the write. */
  deviceCount: number;
}

/**
 * Register this device for this account.
 *
 * ## The account-scoping rule
 *
 * A token identifies a DEVICE, and a device can only be signed into one account
 * at a time. So registering a token that another account holds MOVES it, rather
 * than adding a second owner — otherwise a shared or resold handset would
 * receive both accounts' notifications, which is a cross-account leak with a
 * lock screen attached. `ON CONFLICT (token) DO UPDATE SET uid` is that rule.
 */
export const registerDevice = async (
  uid: string,
  rawToken: unknown,
  options: { platform?: unknown; app?: unknown } = {},
): Promise<RegisterResult> => {
  const token = validDeviceToken(rawToken);
  if (!token) return { registered: false, deviceCount: await countDevices(uid) };

  await ensureDeviceTokenSchema();

  await dbQuery.query(
    `INSERT INTO ${s}.account_device_tokens (token, uid, platform, app, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (token) DO UPDATE
        SET uid = EXCLUDED.uid,
            platform = COALESCE(EXCLUDED.platform, ${s}.account_device_tokens.platform),
            app = COALESCE(EXCLUDED.app, ${s}.account_device_tokens.app),
            updated_at = NOW()`,
    [token, uid, normalisePlatform(options.platform), String(options.app ?? '').slice(0, 32) || null],
  );

  /**
   * Dual-write, so nothing shipped breaks.
   *
   * The legacy provider table and the legacy single column are both still read
   * by the send path. Writing all three keeps a device reachable no matter which
   * route registered it, and lets the legacy stores be retired later by
   * measurement rather than by hope.
   */
  await dbQuery.query(
    `INSERT INTO ${s}.provider_notification_device_tokens (token, worker_uid, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (token) DO UPDATE SET worker_uid = EXCLUDED.worker_uid, updated_at = NOW()`,
    [token, uid],
  ).catch(() => undefined);

  // Detach the token from any other account's legacy column BEFORE claiming it,
  // in that order: the reverse leaves a window where two accounts both point at
  // one device.
  await dbQuery.query(
    `UPDATE ${s}.user_credentials SET fcm_token = NULL WHERE fcm_token = $1 AND uid <> $2`,
    [token, uid],
  );
  await dbQuery.query(
    `UPDATE ${s}.user_credentials SET fcm_token = $1 WHERE uid = $2`,
    [token, uid],
  );

  return { registered: true, deviceCount: await countDevices(uid) };
};

/**
 * Release ONE device, or every device for the account.
 *
 * Sign-out on one phone must not un-enroll the other, which is why the token is
 * optional rather than assumed: omitting it is "sign me out everywhere" and is
 * what `endAllSessions` wants; passing it is "this handset only".
 */
export const releaseDevice = async (uid: string, rawToken?: unknown): Promise<void> => {
  await ensureDeviceTokenSchema();
  const token = validDeviceToken(rawToken);

  if (token) {
    await dbQuery.query(
      `DELETE FROM ${s}.account_device_tokens WHERE uid = $1 AND token = $2`,
      [uid, token],
    );
    await dbQuery.query(
      `DELETE FROM ${s}.provider_notification_device_tokens WHERE worker_uid = $1 AND token = $2`,
      [uid, token],
    ).catch(() => undefined);
    await dbQuery.query(
      `UPDATE ${s}.user_credentials SET fcm_token = NULL WHERE uid = $1 AND fcm_token = $2`,
      [uid, token],
    );
    return;
  }

  await dbQuery.query(`DELETE FROM ${s}.account_device_tokens WHERE uid = $1`, [uid]);
  await dbQuery.query(
    `DELETE FROM ${s}.provider_notification_device_tokens WHERE worker_uid = $1`,
    [uid],
  ).catch(() => undefined);
  await dbQuery.query(
    `UPDATE ${s}.user_credentials SET fcm_token = NULL WHERE uid = $1`,
    [uid],
  );
};

/**
 * Every token that could reach this account, from all three stores.
 *
 * The UNION is the migration: a device registered through a legacy route before
 * this shipped is still in exactly one of the old places, and dropping it from
 * the send path would silently stop that person's push.
 *
 * Capped, because an unbounded fan-out is a way to turn one notification into a
 * thousand FCM calls if a token store is ever corrupted.
 */
export const MAX_DEVICES_PER_SEND = 500;

export const tokensFor = async (uid: string): Promise<string[]> => {
  await ensureDeviceTokenSchema();
  const { rows } = await dbQuery.query(
    `SELECT token FROM ${s}.account_device_tokens WHERE uid = $1
     UNION
     SELECT token FROM ${s}.provider_notification_device_tokens WHERE worker_uid = $1
     UNION
     SELECT fcm_token AS token FROM ${s}.user_credentials
      WHERE uid = $1 AND fcm_token IS NOT NULL`,
    [uid],
  );
  return rows
    .map((row: any) => String(row.token ?? ''))
    .filter(Boolean)
    .slice(0, MAX_DEVICES_PER_SEND);
};

export const countDevices = async (uid: string): Promise<number> => {
  try {
    return (await tokensFor(uid)).length;
  } catch {
    return 0;
  }
};

/**
 * The push provider's error codes that mean a token is permanently dead.
 *
 * Deliberately only two. Everything else — quota, unavailable, timeout,
 * internal — is transient, and deleting a token on a transient failure would
 * un-enroll working devices during exactly the outage that caused it.
 */
export const PERMANENT_TOKEN_ERRORS: readonly string[] = Object.freeze([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

export const isPermanentTokenError = (error: unknown): boolean => {
  const code = String((error as { code?: unknown })?.code ?? '').trim();
  return PERMANENT_TOKEN_ERRORS.includes(code);
};

/**
 * Remove a dead token from every store it can be in.
 *
 * Not scoped to a uid on purpose: the send that discovered the token is dead
 * knows the token, and the token is the primary key everywhere it lives. Making
 * the caller also prove ownership would mean a token owned by an account that
 * has since been reassigned never gets cleaned up.
 */
export const pruneToken = async (token: string, reason = 'unregistered'): Promise<void> => {
  const clean = validDeviceToken(token);
  if (!clean) return;
  await ensureDeviceTokenSchema();
  await Promise.allSettled([
    dbQuery.query(`DELETE FROM ${s}.account_device_tokens WHERE token = $1`, [clean]),
    dbQuery.query(
      `DELETE FROM ${s}.provider_notification_device_tokens WHERE token = $1`,
      [clean],
    ),
    dbQuery.query(
      `UPDATE ${s}.user_credentials SET fcm_token = NULL WHERE fcm_token = $1`,
      [clean],
    ),
  ]);
  recordEventSignal('DEVICE_TOKEN_PRUNED', reason === 'unregistered' ? 'UNREGISTERED' : 'INVALID');
};

/** Test seam. */
export const __resetDeviceTokenSchema = (): void => {
  schemaReady = null;
};
