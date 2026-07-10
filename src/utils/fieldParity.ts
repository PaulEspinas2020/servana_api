/**
 * Cross-Platform Field Parity Registry — Servana SWEEP System
 *
 * Every concept in the Servana data model appears under different field names
 * across the four platforms:
 *   - servana_api        (this backend — PostgreSQL column names → camelCase responses)
 *   - Servana.com.ph     (provider web portal — Angular, reads camelCase)
 *   - ServanaWorker      (provider mobile — Flutter, reads camelCase + nested shapes)
 *   - ServanaClient      (customer mobile — Flutter, reads camelCase)
 *   - servana_adminportal (admin portal — Angular, reads camelCase)
 *
 * RULE: applyParity() enriches any response object so every platform finds
 *       the field name it expects — without removing or overwriting any existing field.
 * RULE: Mobile field contracts are immutable. Aliases extend; never replace.
 * RULE: Before adding any new field name, check if a parity alias already covers it.
 */

interface ParityGroup {
  /** The field name this backend outputs as the primary key */
  canonical: string;
  /** All other names any platform may use for the same concept */
  aliases: string[];
  /** Human-readable note on which platform uses which name */
  note: string;
}

export const PARITY_REGISTRY: ParityGroup[] = [
  {
    canonical: 'id',
    aliases: ['uid', 'workerUid', 'providerUid', 'userId', 'provider_id'],
    note: 'Firebase UID — DB stores as uid, backend response uses id, mobile may read uid/workerUid',
  },
  {
    canonical: 'firstName',
    aliases: ['first_name'],
    note: 'DB: first_name  |  all response layers: firstName',
  },
  {
    canonical: 'lastName',
    aliases: ['last_name'],
    note: 'DB: last_name  |  all response layers: lastName',
  },
  {
    canonical: 'phoneNumber',
    aliases: ['phone', 'phone_number'],
    note: 'DB: phone_number  |  backend response: phoneNumber  |  mobile/web portal: phone',
  },
  {
    canonical: 'isArchived',
    aliases: ['is_archive', 'is_archived', 'archived'],
    note: 'DB: is_archive  |  backend response: isArchived  |  admin portal may check is_archived',
  },
  {
    canonical: 'isEmailVerified',
    aliases: ['is_email_verified', 'emailVerified'],
    note: 'DB: is_email_verified  |  backend: isEmailVerified  |  getUserByEmail uses SQL alias',
  },
  {
    canonical: 'isPhoneVerified',
    aliases: ['is_phone_verified'],
    note: 'DB: is_phone_verified  |  backend: isPhoneVerified',
  },
  {
    canonical: 'createdDate',
    aliases: ['created_date', 'createdAt', 'created_at'],
    note: 'DB: created_date  |  backend: createdDate  |  some contexts use createdAt',
  },
  {
    canonical: 'photoUrl',
    aliases: ['photo_url', 'photoURL', 'avatarUrl', 'avatar_url'],
    note: 'DB: photo_url  |  backend/web: photoUrl  |  mobile may read photoURL (Firebase convention)',
  },
  {
    canonical: 'bookingId',
    aliases: ['booking_id'],
    note: 'Booking PK — controller maps b.id → bookingId; admin portal calls it orderId (URL param only)',
  },
  {
    canonical: 'scheduleAt',
    aliases: ['schedule', 'scheduledAt', 'scheduled_at', 'schedule_at'],
    note: 'DB: schedule  |  controller output: scheduleAt  |  web portal DTO: scheduledAt',
  },
  {
    canonical: 'workerStatus',
    aliases: ['worker_status'],
    note: 'bw.status from booking_workers — controller maps to workerStatus (camelCase)',
  },
  {
    canonical: 'fcmToken',
    aliases: ['fcm_token'],
    note: 'DB: fcm_token  |  backend: fcmToken',
  },
];

// ── Internal lookup maps ──────────────────────────────────────────────────────

/** any field name (canonical or alias) → canonical field name */
const aliasToCanonical: Record<string, string> = {};
/** canonical field name → [canonical, ...aliases] (all known names) */
const canonicalToAll: Record<string, string[]> = {};

for (const group of PARITY_REGISTRY) {
  const all = [group.canonical, ...group.aliases];
  canonicalToAll[group.canonical] = all;
  for (const name of all) {
    aliasToCanonical[name] = group.canonical;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Enriches a response object by adding all known parity aliases for every field
 * it already contains. Non-destructive: never overwrites an existing key.
 *
 * Example:
 *   applyParity({ id: 'uid-123', phoneNumber: '+63...' })
 *   // → { id, uid, workerUid, providerUid, userId, provider_id, phoneNumber, phone, phone_number, ... }
 */
export function applyParity<T extends Record<string, unknown>>(
  obj: T,
): T & Record<string, unknown> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj as T & Record<string, unknown>;
  }

  const result: Record<string, unknown> = { ...obj };

  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val === undefined) continue;
    const canonical = aliasToCanonical[key];
    if (!canonical) continue;
    for (const alias of canonicalToAll[canonical] ?? []) {
      if (!(alias in result)) {
        result[alias] = val;
      }
    }
  }

  return result as T & Record<string, unknown>;
}

/**
 * Resolves a value from an object using any of the known parity aliases.
 * Tries the given field name first, then falls back through all aliases.
 *
 * Example:
 *   resolveByParity({ uid: 'abc' }, 'id')  // → 'abc'
 *   resolveByParity({ id: 'abc' },  'uid') // → 'abc'
 */
export function resolveByParity(
  obj: Record<string, unknown>,
  field: string,
): unknown {
  if (!obj) return undefined;
  if (field in obj) return obj[field];
  const canonical = aliasToCanonical[field];
  if (!canonical) return undefined;
  for (const alias of canonicalToAll[canonical] ?? []) {
    if (alias in obj) return obj[alias];
  }
  return undefined;
}

/**
 * Returns every known name for a given field (canonical or alias).
 * Useful for building queries that accept multiple parameter names.
 */
export function getAllAliases(field: string): string[] {
  const canonical = aliasToCanonical[field];
  return canonical ? (canonicalToAll[canonical] ?? []) : [field];
}
