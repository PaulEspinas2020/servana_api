/**
 * ONE settings store, for every account and every client (§106).
 *
 * ## What this replaces
 *
 * Nothing, and that is the finding. There was no settings store: locale, time
 * zone and privacy choices were held per-client, so Customer Web and Customer
 * Mobile each remembered a different language for the same person and neither
 * could tell the backend. Notification preferences were the only server-side
 * setting, and they were gated on a provider role for a uid-keyed table.
 *
 * So this ADDS `account_settings` — additive, lazily ensured, one row per
 * account — and makes notification preferences a POINTER to the TAB 09 model
 * rather than a second copy. Restating the nine categories here would be exactly
 * the second preference model TAB 09 exists to have prevented.
 *
 * ## Security is READ-ONLY here
 *
 * `/me/security` reports posture: verified identifiers, whether 2FA is on, how
 * many devices are enrolled. Every security ACTION already has a dedicated
 * endpoint with its own proof of possession. Folding them into a settings PATCH
 * would put credential changes behind a JSON body — including turning 2FA OFF
 * from a session that should not be able to.
 */

import dbQuery from '../../db/dbQuery';
import { db } from '../../config';
import { getIdentity } from '../identityService';
import { getPreferences } from '../events/notificationPreferences';
import { countDevices } from '../events/deviceTokenService';
import {
  SECURITY_ACTIONS,
  SETTINGS_CATALOG,
  SETTINGS_WRITABLE,
  SETTING_IDS,
} from './accountPolicy';

const s = db.schema;

export class SettingsError extends Error {
  constructor(
    readonly code: 'SETTING_UNKNOWN' | 'SETTING_NOT_WRITABLE' | 'SETTING_INVALID',
    message: string,
    readonly status: number = 422,
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}

// ─── Schema ───────────────────────────────────────────────────────────────────

let schemaReady: Promise<void> | null = null;

/**
 * Additive, IF NOT EXISTS, lazily applied — the convention every tab since 029
 * has used. `scripts/migrations/034-account-settings.sql` performs the same DDL
 * so a DBA can apply it deliberately; whichever runs first wins.
 *
 * Values are stored as TEXT and coerced on read against the catalog's declared
 * default. A typed column per setting would mean a migration per setting, and a
 * JSONB blob would mean no way to see what an account has actually chosen.
 */
export const ensureSettingsSchema = async (): Promise<void> => {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await dbQuery.query(
      `CREATE TABLE IF NOT EXISTS ${s}.account_settings (
         uid         VARCHAR(128) NOT NULL,
         setting_id  VARCHAR(64)  NOT NULL,
         value       TEXT,
         updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
         PRIMARY KEY (uid, setting_id)
       )`,
      [],
    );
    await dbQuery.query(
      `CREATE INDEX IF NOT EXISTS idx_account_settings_uid
         ON ${s}.account_settings (uid)`,
      [],
    );
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
};

// ─── Reads ────────────────────────────────────────────────────────────────────

export interface SettingsDto {
  locale: Record<string, unknown>;
  privacy: Record<string, unknown>;
  security: Record<string, unknown>;
  /** A POINTER to the TAB 09 model, plus the current values for convenience. */
  notifications: {
    endpoint: string;
    categories: Record<string, boolean>;
  };
}

/** Coerce a stored TEXT value back to the type its declared default implies. */
const coerce = (raw: string | null | undefined, fallback: string | boolean | null) => {
  if (raw === null || raw === undefined) return fallback;
  if (typeof fallback === 'boolean') return raw === 'true';
  return raw;
};

export const getSettings = async (uid: string): Promise<SettingsDto> => {
  await ensureSettingsSchema();

  const { rows } = await dbQuery.query(
    `SELECT setting_id, value FROM ${s}.account_settings WHERE uid = $1`,
    [uid],
  );
  const stored = new Map<string, string>(
    rows.map((row: any) => [String(row.setting_id), row.value as string]),
  );

  const grouped: Record<string, Record<string, unknown>> = {
    locale: {},
    privacy: {},
    security: {},
  };
  for (const spec of SETTINGS_CATALOG) {
    // Every declared setting is ALWAYS present, filled from the account's row or
    // the catalog default. A client never has to decide what a missing key
    // means, which is the decision that produces two different answers in two
    // clients.
    grouped[spec.group][spec.id] = coerce(stored.get(spec.id), spec.defaultValue);
  }

  const preferences = await getPreferences(uid);

  return {
    locale: grouped.locale,
    privacy: grouped.privacy,
    security: grouped.security,
    notifications: {
      endpoint: '/api/v1/me/notification-preferences',
      categories: preferences as unknown as Record<string, boolean>,
    },
  };
};

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * A PARTIAL update. Unnamed settings keep their value.
 *
 * PATCH rather than PUT for the same reason the notification preferences use it:
 * a client that knows about four settings must not silently reset the one it has
 * never heard of every time the backend adds another.
 *
 * An unknown key is REFUSED rather than ignored. Silently dropping a setting a
 * client believes it saved is how two clients come to disagree about what a
 * person chose.
 */
export const patchSettings = async (
  uid: string,
  patch: Record<string, unknown>,
): Promise<SettingsDto> => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new SettingsError('SETTING_INVALID', 'Body must be a JSON object of settings.', 400);
  }
  await ensureSettingsSchema();

  // Accept both the flat shape and the grouped shape the GET returns, so a
  // client can round-trip what it read without reshaping it.
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
        flat[inner] = innerValue;
      }
      continue;
    }
    flat[key] = value;
  }

  for (const [key, value] of Object.entries(flat)) {
    if (!SETTING_IDS.includes(key)) {
      throw new SettingsError(
        'SETTING_UNKNOWN',
        `Unknown setting "${key}". Known: ${SETTING_IDS.join(', ')}.`,
      );
    }
    if (!SETTINGS_WRITABLE.includes(key)) {
      const spec = SETTINGS_CATALOG.find((setting) => setting.id === key)!;
      throw new SettingsError(
        'SETTING_NOT_WRITABLE',
        `"${key}" cannot be changed here. ${spec.note}`,
      );
    }
    const spec = SETTINGS_CATALOG.find((setting) => setting.id === key)!;
    if (typeof spec.defaultValue === 'boolean' && typeof value !== 'boolean') {
      throw new SettingsError('SETTING_INVALID', `${key} must be true or false.`);
    }
    if (typeof spec.defaultValue === 'string') {
      if (typeof value !== 'string' || !/^[A-Za-z0-9_\-/+.]{1,64}$/.test(value)) {
        throw new SettingsError(
          'SETTING_INVALID',
          `${key} must be a short identifier such as "${spec.defaultValue}".`,
        );
      }
    }
  }

  for (const [key, value] of Object.entries(flat)) {
    await dbQuery.query(
      `INSERT INTO ${s}.account_settings (uid, setting_id, value, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (uid, setting_id) DO UPDATE
          SET value = EXCLUDED.value, updated_at = NOW()`,
      [uid, key, String(value)],
    );
  }

  return getSettings(uid);
};

// ─── Security posture ─────────────────────────────────────────────────────────

export interface SecurityDto {
  emailVerified: boolean;
  phoneVerified: boolean;
  twoFactorEnabled: boolean;
  passwordUpdatedAt: string | null;
  activeDeviceCount: number;
  /** Where each ACTION lives. This surface reports; it does not perform. */
  actions: Record<string, string>;
}

export const getSecurity = async (uid: string): Promise<SecurityDto> => {
  const identity = await getIdentity(uid);
  const settings = await getSettings(uid);

  let passwordUpdatedAt: string | null = null;
  let phoneVerified = false;
  try {
    const { rows } = await dbQuery.query(
      `SELECT password_updated_at, is_mobile_verified
         FROM ${s}.user_credentials WHERE uid = $1 LIMIT 1`,
      [uid],
    );
    passwordUpdatedAt = rows[0]?.password_updated_at
      ? new Date(String(rows[0].password_updated_at)).toISOString()
      : null;
    phoneVerified = rows[0]?.is_mobile_verified === true;
  } catch {
    // Older databases lack these columns. Absent means "we do not know", and
    // reporting unverified is the safe direction — never treat unknown as
    // verified on a security surface.
    passwordUpdatedAt = null;
  }

  return {
    emailVerified: identity?.isEmailVerified === true,
    phoneVerified,
    twoFactorEnabled: settings.security.twoFactorEnabled === true,
    passwordUpdatedAt,
    activeDeviceCount: await countDevices(uid),
    actions: { ...SECURITY_ACTIONS },
  };
};

/** Test seam. */
export const __resetSettingsSchema = (): void => {
  schemaReady = null;
};
