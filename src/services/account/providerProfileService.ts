/**
 * The canonical provider profile, services and availability projections.
 *
 * ## Sensitive-field isolation (§107)
 *
 * The projection is built by ASKING the policy which fields this seat may see,
 * then emitting only those. It is not built by selecting a row and removing what
 * should not travel — a subtractive projection discloses every column somebody
 * later adds, and `user_credentials` carries the FCM token and auth metadata.
 *
 * `providerFieldsVisibleTo('otherCustomer')` returns the public set, and it
 * requires TWO independent signals to agree: the classification must be readable
 * by that seat AND the registry's own `customerVisible` flag must be set. Either
 * one can veto, which is what makes "sensitive documents do not leak" a property
 * of the declaration rather than of every query author remembering.
 *
 * ## Documents are STATE, never content
 *
 * `listDocuments` publishes review state — which requirement, whether it is
 * present, whether it was accepted, when it expires. It never publishes a
 * document URL or a storage path. The preview endpoint mints a short-lived
 * signed URL after re-authorizing, which is a different operation with a
 * different audit trail, and folding it into a profile read would turn every
 * profile fetch into a document disclosure.
 *
 * ## Availability reads the SAME source matching consumes
 *
 * `providerAvailabilityEngine` is the engine the matching pipeline selects on.
 * A provider editing one source while matching reads another is a provider who
 * is unbookable for reasons nobody can see, which is the release gate here.
 */

import dbQuery from '../../db/dbQuery';
import { db } from '../../config';
import * as availabilityEngine from '../providerAvailabilityEngine';
import {
  DOCUMENT_TYPE_CATALOG,
  PROFILE_FIELD_REGISTRY,
} from '../providerProfileComplianceService';
import {
  PROVIDER_SELF_EDITABLE_FIELDS,
  providerFieldsVisibleTo,
  providerMayEdit,
  type AccountSeat,
} from './accountPolicy';

const s = db.schema;

export class ProviderProfileError extends Error {
  constructor(
    readonly code:
      | 'PROVIDER_NOT_FOUND'
      | 'PROVIDER_FIELD_NOT_EDITABLE'
      | 'PROVIDER_FIELD_INVALID',
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = 'ProviderProfileError';
  }
}

// ─── Profile ──────────────────────────────────────────────────────────────────

export interface ProviderProfileDto {
  uid: string;
  /** Which seat this projection was built for. Present so a client can tell a
   *  public view from its own, rather than inferring it from missing fields. */
  seat: AccountSeat;
  /** Exactly the field ids this seat may read. The contract, on the wire. */
  visibleFields: string[];
  fields: Record<string, unknown>;
  verification: {
    accountStatus: string | null;
    isEmailVerified: boolean;
    documentsAccepted: number;
    documentsRequired: number;
    /** True when every REQUIRED document type has an accepted submission. */
    documentsComplete: boolean;
  };
}

/**
 * One row, named columns, projected through the policy.
 *
 * The public field values come from `user_profile`'s `public_*` columns, which
 * `providerProfileComplianceService` already owns as the reviewed, publishable
 * copy — the private originals are never the source of a customer-visible value.
 */
const loadProviderRow = async (uid: string) => {
  const { rows } = await dbQuery.query(
    `SELECT uc.uid, uc.email, uc.first_name, uc.last_name, uc.phone_number,
            uc.account_status, uc.is_email_verified, uc.role,
            up.photo_url, up.birthdate,
            up.public_display_name, up.public_biography, up.public_skills,
            up.public_languages, up.public_experience_summary
       FROM ${s}.user_credentials uc
       LEFT JOIN ${s}.user_profile up ON up.uid = uc.uid
      WHERE uc.uid = $1
      LIMIT 1`,
    [uid],
  );
  return rows[0] ?? null;
};

const safeList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((v) => String(v)).slice(0, 50);
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((v) => v.trim()).filter(Boolean).slice(0, 50);
  }
  return [];
};

/**
 * The value for one registry field, or `undefined` when this account has none.
 *
 * A field the seat may see but the account has not filled is emitted as null so
 * a client can distinguish "not provided" from "not permitted" — the latter is
 * simply absent, and `visibleFields` says which is which.
 */
const fieldValue = (fieldId: string, row: any): unknown => {
  switch (fieldId) {
    case 'legalName': return [row.first_name, row.last_name].filter(Boolean).join(' ') || null;
    case 'birthDate': return row.birthdate ?? null;
    case 'email': return row.email ?? null;
    case 'mobile': return row.phone_number ?? null;
    case 'displayName': return row.public_display_name
      ?? ([row.first_name, row.last_name].filter(Boolean).join(' ') || null);
    case 'photo': return row.photo_url ?? null;
    case 'biography': return row.public_biography ?? null;
    case 'skills': return safeList(row.public_skills);
    case 'languages': return safeList(row.public_languages);
    case 'experienceSummary': return row.public_experience_summary ?? null;
    case 'providerType': return row.role ?? null;
    // `legalAddress`, `branch`, `serviceArea` and `reviewerNotes` are owned by
    // admin surfaces and the compliance service. Returning null rather than
    // guessing keeps this projection honest about what it actually knows.
    default: return null;
  }
};

const documentCounts = async (uid: string) => {
  const required = DOCUMENT_TYPE_CATALOG.filter((d) => d.required).length;
  try {
    const { rows } = await dbQuery.query(
      `SELECT COUNT(*)::int AS accepted
         FROM ${s}.worker_requirements
        WHERE worker_uid = $1
          AND COALESCE(LOWER(status), '') IN ('approved', 'accepted', 'verified')`,
      [uid],
    );
    return { required, accepted: Number(rows[0]?.accepted ?? 0) };
  } catch {
    // The status column shape varies across environments. An unreadable count
    // must not fail a profile read, and reporting zero is the safe direction —
    // it under-claims completion rather than over-claiming it.
    return { required, accepted: 0 };
  }
};

export const getProviderProfile = async (
  uid: string,
  seat: AccountSeat,
): Promise<ProviderProfileDto> => {
  const row = await loadProviderRow(uid);
  if (!row) throw new ProviderProfileError('PROVIDER_NOT_FOUND', 'No such provider.', 404);

  const visibleFields = [...providerFieldsVisibleTo(seat)];
  const fields: Record<string, unknown> = {};
  for (const fieldId of visibleFields) fields[fieldId] = fieldValue(fieldId, row);

  const counts = await documentCounts(uid);

  return {
    uid,
    seat,
    visibleFields,
    fields,
    verification: {
      // A customer looking at a provider sees WHETHER they are verified, never
      // the operational status string that says how Servana classifies them.
      accountStatus: seat === 'otherCustomer' ? null : (row.account_status ?? null),
      isEmailVerified: row.is_email_verified === true,
      documentsAccepted: seat === 'otherCustomer' ? 0 : counts.accepted,
      documentsRequired: seat === 'otherCustomer' ? 0 : counts.required,
      documentsComplete: counts.accepted >= counts.required && counts.required > 0,
    },
  };
};

/**
 * Change a provider profile field.
 *
 * Only registry fields marked `editable: 'review'` are accepted, and the write
 * DELEGATES to the compliance service's revision workflow rather than touching a
 * column. A provider does not edit their public profile; they propose a change
 * and it is reviewed, and that is the behaviour Provider Web already has.
 */
export const patchProviderProfile = async (
  uid: string,
  patch: Record<string, unknown>,
  clientRequestId: string,
): Promise<{ submitted: string[]; status: 'PENDING_REVIEW' }> => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ProviderProfileError('PROVIDER_FIELD_INVALID', 'Body must be a JSON object.', 400);
  }

  /**
   * The revision workflow is idempotent on `clientRequestId`, and it is
   * REQUIRED rather than generated here.
   *
   * Generating one server-side would make every retry a new revision, and a
   * provider on a flaky connection would queue three copies of the same
   * biography change for a human to review.
   */
  if (!/^[a-zA-Z0-9:_-]{16,128}$/.test(String(clientRequestId ?? ''))) {
    throw new ProviderProfileError(
      'PROVIDER_FIELD_INVALID',
      'A clientRequestId of 16-128 characters is required so a retried submission does not queue a second revision.',
      422,
    );
  }

  const keys = Object.keys(patch);
  const rejected = keys.filter((key) => !providerMayEdit(key));
  if (rejected.length) {
    throw new ProviderProfileError(
      'PROVIDER_FIELD_NOT_EDITABLE',
      `Not editable here: ${rejected.join(', ')}. ` +
        `Reviewable fields: ${PROVIDER_SELF_EDITABLE_FIELDS.join(', ')}. ` +
        'Identifiers change through re-verification; operational fields are set by Servana.',
      422,
    );
  }
  if (!keys.length) {
    return { submitted: [], status: 'PENDING_REVIEW' };
  }

  // DELEGATED. The compliance service owns the revision workflow, its allow-list
  // and its audit trail; writing the columns here would be a second, weaker copy
  // of a review process.
  const compliance = await import('../providerProfileComplianceService');
  await compliance.submitPublicProfileRevision(uid, {
    fields: patch,
    clientRequestId: String(clientRequestId),
  });

  return { submitted: keys, status: 'PENDING_REVIEW' };
};

// ─── Documents (§104) ─────────────────────────────────────────────────────────

export interface ProviderDocumentDto {
  requirementId: string;
  documentType: string;
  name: string;
  category: string;
  required: boolean;
  status: string;
  submittedAt: string | null;
  expiresAt: string | null;
  reviewNote: string | null;
}

/**
 * Documents as REVIEW STATE, from `worker_requirements`.
 *
 * The command says not to invent `provider_documents` if it does not exist, and
 * it does not: `worker_requirements` is the real model and is what admin
 * onboarding, the dashboard and the provider compliance service all already
 * read. This projects it.
 *
 * No URL, no storage path, no file name that encodes one. `NEVER_PROJECTED`
 * lists those and the leak test serialises this DTO against it.
 */
export const listDocuments = async (uid: string): Promise<ProviderDocumentDto[]> => {
  let rows: any[] = [];
  try {
    const result = await dbQuery.query(
      `SELECT id, requirement_type, status, created_at, expiry_date, review_note
         FROM ${s}.worker_requirements
        WHERE worker_uid = $1
        ORDER BY created_at DESC`,
      [uid],
    );
    rows = result.rows;
  } catch {
    // Column shapes vary across environments; a document LIST that cannot be
    // read must not fail the whole provider surface. The catalog below still
    // tells the provider what is required of them.
    rows = [];
  }

  const byType = new Map<string, any>();
  for (const row of rows) {
    const type = String(row.requirement_type ?? '').toLowerCase();
    if (!byType.has(type)) byType.set(type, row);
  }

  // Driven by the CATALOG, not by the rows: a required document that has never
  // been submitted must appear as missing. A list built from rows alone shows an
  // empty screen to a provider who has everything left to do.
  return DOCUMENT_TYPE_CATALOG.map((spec) => {
    const row = byType.get(spec.id)
      ?? (spec.aliases ?? []).map((a) => byType.get(a)).find(Boolean);
    return {
      requirementId: row ? String(row.id) : `missing:${spec.id}`,
      documentType: spec.id,
      name: spec.name,
      category: spec.category,
      required: spec.required,
      status: row ? String(row.status ?? 'pending') : 'missing',
      submittedAt: row?.created_at ? new Date(String(row.created_at)).toISOString() : null,
      expiresAt: row?.expiry_date ? new Date(String(row.expiry_date)).toISOString() : null,
      reviewNote: row?.review_note ?? null,
    };
  });
};

// ─── Availability (§105) ──────────────────────────────────────────────────────

export interface ProviderAvailabilityDto {
  timezone: string;
  weeklySchedule: unknown;
  version: number | null;
  updatedAt: string | null;
  /** True when at least one day has a usable window. What matching needs. */
  hasUsableSchedule: boolean;
}

export const getAvailability = async (uid: string): Promise<ProviderAvailabilityDto> => {
  const profile = await availabilityEngine.getAvailabilityProfile(uid);
  const slots = Array.isArray(profile.weeklySchedule) ? profile.weeklySchedule : [];
  return {
    timezone: profile.timezone,
    weeklySchedule: profile.weeklySchedule,
    version: (profile as any).version ?? null,
    updatedAt: (profile as any).updatedAt ?? null,
    hasUsableSchedule: slots.length > 0,
  };
};

// ─── Services (§105) ──────────────────────────────────────────────────────────

export interface ProviderServiceDto {
  /** `services.id` — the Catalog V2 canonical specific-service identity. */
  serviceId: number;
  name: string | null;
  status: string;
  isActive: boolean;
}

/**
 * The services this provider is approved for.
 *
 * Keyed on `services.id`, never on a service family. `service_families` is
 * legacy coarse provenance and Catalog V2 is certified with `services.id` as the
 * canonical specific-service identity — a provider service list keyed on a
 * family is how the family becomes the bookable identity again.
 *
 * This is the same qualification `adminBookingService` selects on when matching,
 * which is the point: the provider sees what makes them matchable.
 */
export const listServices = async (uid: string): Promise<ProviderServiceDto[]> => {
  try {
    const { rows } = await dbQuery.query(
      `SELECT es.service_id, es.status, sv.name
         FROM ${s}.employee_services es
         LEFT JOIN ${s}.services sv ON sv.id = es.service_id
        WHERE es.worker_uid = $1
        ORDER BY sv.name ASC NULLS LAST`,
      [uid],
    );
    return rows.map((row: any) => ({
      serviceId: Number(row.service_id),
      name: row.name ?? null,
      status: String(row.status ?? 'active'),
      isActive: String(row.status ?? 'active').toLowerCase() === 'active',
    }));
  } catch {
    // Same reasoning as documents: a service list that cannot be read must not
    // fail the provider surface, and an empty list under-claims rather than
    // over-claims what the provider is qualified for.
    return [];
  }
};

/** Exported so the completion service and the docs generator share one source. */
export const PROVIDER_FIELD_COUNT = PROFILE_FIELD_REGISTRY.length;
