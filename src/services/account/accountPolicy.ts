/**
 * THE account declaration — one file, four consumers, no database handle.
 *
 *   1. `accountService.ts` / `addressBookService.ts` / `providerProfileService.ts`
 *      ENFORCE it.
 *   2. `accountDto.ts` PROJECTS from it.
 *   3. `scripts/generate-account-docs.ts` EXECUTES it to write
 *      `PROFILE_V1_CONTRACT.md` and `SETTINGS_V1_CONTRACT.md`.
 *   4. `tests/account-*.test.ts` ASSERT against it.
 *
 * Same arrangement as `financePolicy`, `experiencePolicy`, `messagingPolicy` and
 * `domainEvents`, and for the same reason: a rule written down in a document and
 * again in a service is two rules that agree until one is edited.
 *
 * ## What was wrong
 *
 * "Profile" meant four different things depending on which route you asked:
 *
 *   `/api/v1/me`            identity only — and READ ONLY, no way to change it
 *   `/api/user/profile`     the customer aggregate (credentials + user_profile)
 *   `/api/provider/profile` a provider projection built inline in a controller
 *   `/api/provider/profile-center` the compliance view, with its own field registry
 *
 * Each had its own SQL, its own field list and its own idea of what a caller may
 * see. Nothing said which fields were sensitive, so the answer was whatever each
 * query happened to select — and `getProviderProfile` selects `uc.*`-adjacent
 * columns by name, which is safe only for as long as nobody adds a column.
 *
 * ## What this does about it
 *
 * One classification per field, one seat matrix, one completion rule set. The
 * provider half DELEGATES to `PROFILE_FIELD_REGISTRY`, which already existed and
 * already carried `classification` / `customerVisible` / `masked` — inventing a
 * second provider field taxonomy beside it would have been the exact mistake
 * this file exists to prevent.
 *
 * Nothing here imports anything with a database handle. Every decision function
 * is pure, so the generated contracts are evidence rather than description.
 */

import {
  PROFILE_FIELD_REGISTRY,
  type ProfileFieldDefinition,
} from '../providerProfileComplianceService';

// ─── Client surfaces ──────────────────────────────────────────────────────────

export type ClientSurface =
  | 'customerMobile'
  | 'customerWeb'
  | 'providerMobile'
  | 'providerWeb'
  | 'admin';

export const CLIENT_SURFACES: readonly ClientSurface[] = Object.freeze([
  'customerMobile',
  'customerWeb',
  'providerMobile',
  'providerWeb',
  'admin',
]);

/**
 * WHO is asking, relative to the record.
 *
 * `self` is the account reading its own row. `otherCustomer` is a customer
 * looking at a provider — the public projection. `admin` is staff. The seat is
 * never a role claim from a token: it is a relationship, resolved server-side.
 */
export type AccountSeat = 'self' | 'otherCustomer' | 'admin';

export const ACCOUNT_SEATS: readonly AccountSeat[] = Object.freeze([
  'self',
  'otherCustomer',
  'admin',
]);

// ─── Field sensitivity (§107) ─────────────────────────────────────────────────

/**
 * The four classes, reusing the vocabulary `PROFILE_FIELD_REGISTRY` already
 * established rather than minting a parallel one.
 *
 *   public       anyone who can see the account at all
 *   private      the account itself, and staff
 *   operational  staff decide it; the account may read it
 *   internal     staff only. Never leaves the admin surface.
 */
export type Sensitivity = 'public' | 'private' | 'operational' | 'internal';

export const SENSITIVITY_CLASSES: readonly Sensitivity[] = Object.freeze([
  'public',
  'private',
  'operational',
  'internal',
]);

/**
 * Which seats may READ each class. The one table the projections consult.
 *
 * `otherCustomer` sees `public` and nothing else. That single row is what makes
 * "sensitive documents do not leak" a property of the code rather than of every
 * query author remembering to omit a column.
 */
export const READABLE_BY: Readonly<Record<Sensitivity, readonly AccountSeat[]>> =
  Object.freeze({
    public: Object.freeze(['self', 'otherCustomer', 'admin'] as AccountSeat[]),
    private: Object.freeze(['self', 'admin'] as AccountSeat[]),
    operational: Object.freeze(['self', 'admin'] as AccountSeat[]),
    internal: Object.freeze(['admin'] as AccountSeat[]),
  });

export const mayRead = (classification: Sensitivity, seat: AccountSeat): boolean =>
  (READABLE_BY[classification] ?? []).includes(seat);

/**
 * Data that may NEVER appear in ANY profile projection, at any seat.
 *
 * Not a sensitivity class — a REFUSAL, and the distinction is the point.
 *
 * A class says "which seats may read this". A refusal says "no seat reads this
 * here, ever". These are credentials and verification artefacts: a password
 * hash, a push token, an OTP, a document image, an ID number. An admin who needs
 * a document uses the document endpoint, which authorizes per document and
 * records the access; a profile read is not that, and an admin seat is not a
 * reason to hand one over as a side effect of loading a page.
 *
 * ## Why `reviewerNotes` is deliberately NOT on this list
 *
 * It was, on the first draft, and the leakage suite caught the contradiction:
 * the field registry classifies it `internal`, and `READABLE_BY.internal` is
 * `['admin']` — so one mechanism said admins may read it and another said nobody
 * may. Two mechanisms for one concern is how a policy comes to disagree with
 * itself, and the classification is the right one here because an internal note
 * genuinely IS something staff read. A refusal list that also contains
 * classified fields would make every future addition ambiguous.
 *
 * So: classified data uses a class. Credentials and artefacts use this list.
 *
 * `tests/account-leakage.test.ts` serialises every projection at every seat and
 * asserts none of these appear, which is what makes the list load-bearing rather
 * than aspirational.
 */
export const NEVER_PROJECTED: readonly string[] = Object.freeze([
  'password',
  'password_hash',
  'passwordHash',
  'fcm_token',
  'fcmToken',
  'otp',
  'otp_code',
  'otpCode',
  'reset_token',
  'resetToken',
  'document_url',
  'documentUrl',
  'storage_path',
  'storagePath',
  'id_number',
  'idNumber',
  'nbi_number',
]);

// ─── /me — the common account record (§101) ───────────────────────────────────

export interface AccountFieldSpec {
  id: string;
  label: string;
  classification: Sensitivity;
  /** May the account itself change it directly? */
  writableBySelf: boolean;
  /** Why not, when it cannot be written here. */
  writeNote?: string;
}

/**
 * `/me` is identity, contact and verification SUMMARY. Nothing else.
 *
 * The gate says "/me is not overloaded with private role data", and the
 * temptation is real: every client needs the account and one round trip is
 * cheaper than two. But a `/me` that carries the provider's compliance state
 * and the customer's addresses is a payload every screen fetches and almost no
 * screen uses, and it is the payload most likely to be cached, logged and
 * shipped to an analytics tool.
 *
 * So role data lives behind `/customer/profile` and `/provider/profile`, which
 * this file also declares, and `/me` carries a `profiles` POINTER — which role
 * extensions exist for this account — rather than their contents.
 */
export const ME_FIELDS: readonly AccountFieldSpec[] = Object.freeze([
  { id: 'uid', label: 'Account id', classification: 'public', writableBySelf: false,
    writeNote: 'The canonical identity. It never changes.' },
  { id: 'email', label: 'Email', classification: 'private', writableBySelf: false,
    writeNote: 'A verified identifier. Changing it needs the re-verification workflow, not a profile PATCH.' },
  { id: 'phoneNumber', label: 'Mobile number', classification: 'private', writableBySelf: false,
    writeNote: 'A verified identifier. Same reason as email.' },
  { id: 'firstName', label: 'First name', classification: 'private', writableBySelf: true },
  { id: 'lastName', label: 'Last name', classification: 'private', writableBySelf: true },
  { id: 'displayName', label: 'Display name', classification: 'public', writableBySelf: true },
  { id: 'photoUrl', label: 'Profile photo', classification: 'public', writableBySelf: true },
  { id: 'role', label: 'Role', classification: 'operational', writableBySelf: false,
    writeNote: 'Set by Servana. A self-writable role is a privilege-escalation endpoint.' },
  { id: 'accountStatus', label: 'Account status', classification: 'operational', writableBySelf: false,
    writeNote:
      'Set by Servana. A self-writable status is a suspended account un-suspending itself, ' +
      'which is the whole point of having one.' },
  { id: 'isEmailVerified', label: 'Email verified', classification: 'private', writableBySelf: false,
    writeNote: 'Derived from the verification workflow.' },
  { id: 'isPhoneVerified', label: 'Mobile verified', classification: 'private', writableBySelf: false,
    writeNote: 'Derived from the verification workflow.' },
]);

export const ME_FIELD_IDS: readonly string[] = Object.freeze(ME_FIELDS.map((f) => f.id));

/** The fields a caller may PATCH on `/me`. Everything else is refused, by name. */
export const ME_WRITABLE_FIELDS: readonly string[] = Object.freeze(
  ME_FIELDS.filter((f) => f.writableBySelf).map((f) => f.id),
);

/**
 * Data `/me` must NOT carry, with the endpoint that owns it.
 *
 * Asserted by `tests/account-contract.test.ts` against the real projection, so
 * the gate is checked rather than promised.
 */
export const ME_EXCLUSIONS: Readonly<Record<string, string>> = Object.freeze({
  addresses: 'GET /api/v1/customer/addresses',
  documents: 'GET /api/v1/provider/documents',
  availability: 'GET /api/v1/provider/availability',
  services: 'GET /api/v1/provider/services',
  earnings: 'GET /api/v1/provider/earnings/summary',
  notificationPreferences: 'GET /api/v1/me/settings',
  complianceDetail: 'GET /api/v1/provider/profile',
});

// ─── Customer profile (§101) ──────────────────────────────────────────────────

export const CUSTOMER_PROFILE_FIELDS: readonly AccountFieldSpec[] = Object.freeze([
  { id: 'birthDate', label: 'Birth date', classification: 'private', writableBySelf: true },
  { id: 'gender', label: 'Gender', classification: 'private', writableBySelf: true },
  { id: 'photoUrl', label: 'Profile photo', classification: 'public', writableBySelf: true },
  { id: 'defaultAddressId', label: 'Default address', classification: 'private', writableBySelf: false,
    writeNote: 'Set through the address book, so the default and the address that carries the flag cannot disagree.' },
]);

export const CUSTOMER_WRITABLE_FIELDS: readonly string[] = Object.freeze(
  CUSTOMER_PROFILE_FIELDS.filter((f) => f.writableBySelf).map((f) => f.id),
);

// ─── Provider profile (§103, §107) ────────────────────────────────────────────

/**
 * DELEGATED, not restated.
 *
 * `PROFILE_FIELD_REGISTRY` already declares every provider profile field with a
 * classification, whether a customer may see it, and whether it is masked. It is
 * the registry `/api/provider/profile-fields` already serves to Provider Web.
 * Re-declaring those fields here would create exactly the second taxonomy this
 * file exists to prevent.
 */
export const PROVIDER_PROFILE_FIELDS: readonly ProfileFieldDefinition[] =
  PROFILE_FIELD_REGISTRY;

export const PROVIDER_FIELD_IDS: readonly string[] = Object.freeze(
  PROFILE_FIELD_REGISTRY.map((f) => f.id),
);

/**
 * Which provider fields a customer may see, computed from the registry.
 *
 * Two independent signals must agree: the classification must be readable by
 * `otherCustomer` AND the registry's own `customerVisible` flag must be set.
 * Requiring both means a field can only reach a customer if two people, editing
 * two different things, both decided it should — and either one can veto.
 */
export const providerFieldsVisibleTo = (seat: AccountSeat): readonly string[] =>
  PROFILE_FIELD_REGISTRY.filter((field) => {
    const classification = field.classification as Sensitivity;
    if (!mayRead(classification, seat)) return false;
    if (seat === 'otherCustomer' && !field.customerVisible) return false;
    return true;
  }).map((f) => f.id);

/**
 * A provider may edit only what the registry says is theirs to edit.
 *
 * `editable: 'review'` means they submit a revision and it is reviewed —
 * `providerProfileComplianceService` owns that workflow, and the canonical
 * PATCH delegates to it rather than writing the column. `'reverification'` and
 * `'admin'` are refused outright here: an identifier change needs the
 * verification flow, and an operational field is Servana's decision.
 */
export const providerMayEdit = (fieldId: string): boolean =>
  PROFILE_FIELD_REGISTRY.some((f) => f.id === fieldId && f.editable === 'review');

export const PROVIDER_SELF_EDITABLE_FIELDS: readonly string[] = Object.freeze(
  PROFILE_FIELD_REGISTRY.filter((f) => f.editable === 'review').map((f) => f.id),
);

// ─── Addresses (§102) ─────────────────────────────────────────────────────────

/**
 * The address book contract.
 *
 * Stable ids: `user_address.address_id`, a `CAD`-prefixed generated string that
 * every shipped client already stores. It is NOT the primary key of the table
 * and it is what every route already takes, so it is the canonical handle.
 */
export const ADDRESS_IDENTITY = {
  resource: 'address',
  idColumn: 'user_address.address_id',
  idFormat: 'CAD + 6 characters',
  owner: 'user_address.uid',
  note:
    'Owner-scoped in SQL on every statement. An address id is not a capability: ' +
    'presenting somebody else\'s resolves to nothing rather than to their home.',
} as const;

export interface AddressFieldRule {
  id: string;
  required: boolean;
  maxLength?: number;
  note: string;
}

export const ADDRESS_FIELDS: readonly AddressFieldRule[] = Object.freeze([
  { id: 'addressOne', required: true, maxLength: 255, note: 'Street line. The only genuinely required line.' },
  { id: 'addressTwo', required: false, maxLength: 255, note: 'Unit, floor, landmark.' },
  { id: 'postTown', required: false, maxLength: 120, note: 'City or municipality.' },
  { id: 'zipCode', required: false, maxLength: 20, note: 'Postal code.' },
  { id: 'country', required: false, maxLength: 80, note: 'Defaults to the operating country.' },
  { id: 'label', required: false, maxLength: 60, note: 'Home, Office. Free text the customer chose.' },
  { id: 'locationId', required: false, maxLength: 128, note: 'Geocode handle. Drives coverage and distance pricing.' },
]);

export const ADDRESS_LIMITS = {
  /** Per account. A ceiling, not a product feature — an unbounded address book
   *  is a storage and a coverage-check cost with no upper edge. */
  maxPerAccount: 25,
  /** Exactly one default, always, once at least one address exists. */
  exactlyOneDefault: true,
} as const;

export type AddressRefusal =
  | 'ADDRESS_FIELD_REQUIRED'
  | 'ADDRESS_FIELD_TOO_LONG'
  | 'ADDRESS_LIMIT_REACHED'
  | 'ADDRESS_NOT_FOUND';

export interface AddressValidation {
  ok: boolean;
  refusal: AddressRefusal | null;
  message: string | null;
  field: string | null;
}

/**
 * Validate an address payload. Pure, so the generated contract renders the real
 * rules and the tests assert the real function.
 */
export const validateAddress = (
  input: Record<string, unknown>,
  opts: { existingCount?: number; isCreate?: boolean } = {},
): AddressValidation => {
  const ok: AddressValidation = { ok: true, refusal: null, message: null, field: null };

  if (opts.isCreate && (opts.existingCount ?? 0) >= ADDRESS_LIMITS.maxPerAccount) {
    return {
      ok: false,
      refusal: 'ADDRESS_LIMIT_REACHED',
      message: `An account may hold at most ${ADDRESS_LIMITS.maxPerAccount} addresses.`,
      field: null,
    };
  }

  for (const rule of ADDRESS_FIELDS) {
    const raw = input[rule.id];
    const provided = raw !== undefined && raw !== null && String(raw).trim() !== '';

    // A required field is required on CREATE. On PATCH an absent field means
    // "leave it alone" — treating absence as a clear would let a client that
    // sends one field wipe the rest of somebody's address.
    if (rule.required && opts.isCreate && !provided) {
      return {
        ok: false,
        refusal: 'ADDRESS_FIELD_REQUIRED',
        message: `${rule.id} is required.`,
        field: rule.id,
      };
    }
    if (provided && rule.maxLength && String(raw).length > rule.maxLength) {
      return {
        ok: false,
        refusal: 'ADDRESS_FIELD_TOO_LONG',
        message: `${rule.id} must be at most ${rule.maxLength} characters.`,
        field: rule.id,
      };
    }
  }

  return ok;
};

/**
 * The default-address rule, stated once.
 *
 * The legacy path set the new default and then cleared the others in two
 * separate statements with no transaction, so a failure between them left the
 * account with TWO primary addresses — and every reader picks the first, which
 * is whichever the planner happened to return.
 */
export const DEFAULT_ADDRESS_RULE = {
  statement: 'Exactly one address per account carries is_primary.',
  onFirstAddress: 'The first address an account creates becomes the default automatically.',
  onDelete:
    'Deleting the default promotes the oldest remaining address, so an account with ' +
    'addresses is never left without a default.',
  atomicity:
    'Promotion and demotion happen in ONE transaction. Two statements without one is how ' +
    'an account ends up with two primaries and every reader picks whichever the planner ' +
    'returned first.',
} as const;

// ─── Settings (§106) ──────────────────────────────────────────────────────────

export interface SettingSpec {
  id: string;
  group: 'locale' | 'privacy' | 'security' | 'notifications';
  label: string;
  classification: Sensitivity;
  writableBySelf: boolean;
  defaultValue: string | boolean | null;
  note: string;
}

/**
 * One settings catalog. No separate web and mobile stores.
 *
 * `notifications` is a POINTER, not a copy: the nine notification categories are
 * declared in `services/events/domainEvents` and served by
 * `/me/notification-preferences`. Restating them here would be a second
 * preference model, and TAB 09 exists precisely because there was nearly one.
 */
export const SETTINGS_CATALOG: readonly SettingSpec[] = Object.freeze([
  {
    id: 'locale',
    group: 'locale',
    label: 'Language',
    classification: 'private',
    writableBySelf: true,
    defaultValue: 'en-PH',
    note: 'BCP-47. Drives server-rendered copy; clients may still override locally.',
  },
  {
    id: 'timeZone',
    group: 'locale',
    label: 'Time zone',
    classification: 'private',
    writableBySelf: true,
    defaultValue: 'Asia/Manila',
    note:
      'IANA. Servana operates in Asia/Manila and a booking at 08:00 local is 00:00 UTC, ' +
      'so getting this wrong moves a job across a day boundary.',
  },
  {
    id: 'profileDiscoverable',
    group: 'privacy',
    label: 'Discoverable profile',
    classification: 'private',
    writableBySelf: true,
    defaultValue: true,
    note: 'Whether the public provider projection may be surfaced in search.',
  },
  {
    id: 'shareUsageAnalytics',
    group: 'privacy',
    label: 'Share usage analytics',
    classification: 'private',
    writableBySelf: true,
    defaultValue: false,
    note: 'OFF by default. Privacy by default means the permissive value is the chosen one.',
  },
  {
    id: 'twoFactorEnabled',
    group: 'security',
    label: 'Two-factor authentication',
    classification: 'private',
    writableBySelf: false,
    defaultValue: false,
    note:
      'READ-ONLY here. Enabling it is a credential ceremony with proof of possession; a ' +
      'settings PATCH that could flip it would be a way to turn it OFF from a stolen session.',
  },
]);

export const SETTING_IDS: readonly string[] = Object.freeze(SETTINGS_CATALOG.map((s) => s.id));

export const SETTINGS_WRITABLE: readonly string[] = Object.freeze(
  SETTINGS_CATALOG.filter((s) => s.writableBySelf).map((s) => s.id),
);

export const SETTINGS_GROUPS: readonly SettingSpec['group'][] = Object.freeze([
  'locale',
  'privacy',
  'security',
  'notifications',
]);

/**
 * The security surface is deliberately thin and READ-mostly.
 *
 * It reports what the account can see about its own security posture — verified
 * identifiers, session count, whether 2FA is on, when the password last changed.
 * Every ACTION (change password, revoke sessions, enable 2FA) already has a
 * dedicated endpoint with its own proof-of-possession, and folding those into a
 * settings PATCH would put credential changes behind a JSON body.
 */
export const SECURITY_READ_FIELDS: readonly string[] = Object.freeze([
  'emailVerified',
  'phoneVerified',
  'twoFactorEnabled',
  'passwordUpdatedAt',
  'activeDeviceCount',
]);

export const SECURITY_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  changePassword: 'POST /api/v1/auth/reset-password (or the provider password flow)',
  revokeSessions: 'POST /api/v1/auth/logout',
  releaseDevice: 'DELETE /api/v1/me/devices',
  changeEmail: 'the identifier re-verification workflow',
  changeMobile: 'the identifier re-verification workflow',
});

// ─── Profile completion (§109) ────────────────────────────────────────────────

export interface CompletionRequirement {
  id: string;
  label: string;
  /** Which role this applies to. */
  role: 'customer' | 'provider';
  /** Whether onboarding is blocked without it. */
  blocking: boolean;
  note: string;
}

/**
 * Completion is BACKEND-DERIVED (§109).
 *
 * The gate exists because welcome cards and onboarding checklists were deciding
 * for themselves what "complete" meant — one client counted a photo, another did
 * not, and neither could see the document review state at all. A client guessing
 * at completion shows a green tick over an account that cannot take work.
 *
 * Each requirement names what satisfies it. `computeCompletion` runs them.
 */
export const COMPLETION_REQUIREMENTS: readonly CompletionRequirement[] = Object.freeze([
  { id: 'name', label: 'Name', role: 'customer', blocking: true,
    note: 'A booking has to be addressed to somebody.' },
  { id: 'contact', label: 'Verified contact', role: 'customer', blocking: true,
    note: 'A verified email or mobile. Without one a booking cannot be confirmed.' },
  { id: 'address', label: 'A saved address', role: 'customer', blocking: true,
    note: 'Serviceability is decided from an address; there is nothing to check without one.' },
  { id: 'photo', label: 'Profile photo', role: 'customer', blocking: false,
    note: 'Presentation only. Never blocks.' },

  { id: 'name', label: 'Name', role: 'provider', blocking: true,
    note: 'Appears on the job card the customer sees.' },
  { id: 'contact', label: 'Verified contact', role: 'provider', blocking: true,
    note: 'Assignment notifications have to reach somebody.' },
  { id: 'documents', label: 'Required documents', role: 'provider', blocking: true,
    note: 'Every document the catalog marks required, present and not rejected.' },
  { id: 'services', label: 'At least one service', role: 'provider', blocking: true,
    note: 'Matching selects on services; a provider with none is invisible to it.' },
  { id: 'availability', label: 'Weekly availability', role: 'provider', blocking: true,
    note: 'Matching selects on availability. The same source the provider edits.' },
  { id: 'photo', label: 'Profile photo', role: 'provider', blocking: false,
    note: 'Presentation only. Never blocks.' },
]);

export interface CompletionInput {
  role: 'customer' | 'provider';
  hasName: boolean;
  hasVerifiedContact: boolean;
  hasPhoto: boolean;
  /** Customer only. */
  hasAddress?: boolean;
  /** Provider only. */
  hasRequiredDocuments?: boolean;
  hasServices?: boolean;
  hasAvailability?: boolean;
}

export interface CompletionState {
  role: 'customer' | 'provider';
  /** 0-100, computed from the requirements that apply to this role. */
  percent: number;
  isComplete: boolean;
  /** True when every BLOCKING requirement is met — what onboarding gates on. */
  canProceed: boolean;
  satisfied: string[];
  missing: string[];
  /** Missing AND blocking. The list a welcome card should actually show. */
  blockedBy: string[];
}

/**
 * The one completion computation.
 *
 * `percent` counts every requirement including the non-blocking ones, because
 * that is what a progress bar means to a person. `canProceed` counts only the
 * blocking ones, because that is what the product gates on. Conflating the two
 * is why a client can show "80% complete" next to a button that does not work.
 */
export const computeCompletion = (input: CompletionInput): CompletionState => {
  const requirements = COMPLETION_REQUIREMENTS.filter((r) => r.role === input.role);

  const satisfiedBy: Record<string, boolean> = {
    name: input.hasName,
    contact: input.hasVerifiedContact,
    photo: input.hasPhoto,
    address: input.hasAddress === true,
    documents: input.hasRequiredDocuments === true,
    services: input.hasServices === true,
    availability: input.hasAvailability === true,
  };

  const satisfied: string[] = [];
  const missing: string[] = [];
  const blockedBy: string[] = [];

  for (const requirement of requirements) {
    if (satisfiedBy[requirement.id]) {
      satisfied.push(requirement.id);
      continue;
    }
    missing.push(requirement.id);
    if (requirement.blocking) blockedBy.push(requirement.id);
  }

  const percent = requirements.length
    ? Math.round((satisfied.length / requirements.length) * 100)
    : 100;

  return {
    role: input.role,
    percent,
    isComplete: missing.length === 0,
    canProceed: blockedBy.length === 0,
    satisfied,
    missing,
    blockedBy,
  };
};

// ─── Account-switch invalidation (§108) ───────────────────────────────────────

/**
 * What a client must drop when the account changes.
 *
 * The backend half is that every response is account-scoped and carries no
 * cross-account cache key. The CLIENT half is stated here so it is a contract
 * rather than an assumption about what the apps happen to do — the same shape
 * TAB 08 used for chat session hygiene, and for the same reason: a cached
 * profile rendered under the next person's identity is a leak the server cannot
 * see.
 */
export const ACCOUNT_SWITCH_INVALIDATION = {
  serverGuarantee:
    'Every account response is derived from the token subject. No endpoint in this domain ' +
    'accepts a uid parameter, so there is no cached response that could belong to another ' +
    'account.',
  clientObligation: Object.freeze([
    'profile (/me, /customer/profile, /provider/profile)',
    'addresses',
    'settings and notification preferences',
    'provider services and availability',
    'completion state',
  ]),
  signal:
    'Sign-out already evicts chat sockets and clears the push token via endAllSessions. ' +
    'Account state is fetched fresh after a switch because none of it is cached across ' +
    'identities.',
} as const;

// ─── Capabilities and the caller matrix ───────────────────────────────────────

export interface AccountCapability {
  key: string;
  title: string;
  contractIds: readonly string[];
  domainModule: string;
  surfaces: readonly ClientSurface[];
  roleSplitRationale: string;
}

export const ACCOUNT_CAPABILITIES: readonly AccountCapability[] = Object.freeze([
  {
    key: 'identity',
    title: 'Read and change my account record',
    contractIds: ['identity.me', 'me.patch'],
    domainModule: 'services/account/accountService',
    surfaces: Object.freeze([
      'customerMobile', 'customerWeb', 'providerMobile', 'providerWeb', 'admin',
    ] as ClientSurface[]),
    roleSplitRationale:
      'No role split. One identity record for every account, and the ROLE-specific data is ' +
      'deliberately not here — `/me` carries a pointer to which extensions exist, not their ' +
      'contents. A `/me` that carried the provider compliance state would be fetched by every ' +
      'screen, used by almost none, and cached everywhere.',
  },
  {
    key: 'settings',
    title: 'Read and change my settings',
    contractIds: ['me.settings.get', 'me.settings.patch'],
    domainModule: 'services/account/accountSettingsService',
    surfaces: Object.freeze([
      'customerMobile', 'customerWeb', 'providerMobile', 'providerWeb', 'admin',
    ] as ClientSurface[]),
    roleSplitRationale:
      'No role split, and no web/mobile split either — which is the point. The settings live ' +
      'in one account-keyed store, and notification preferences are a POINTER to the TAB 09 ' +
      'model rather than a second copy of it.',
  },
  {
    key: 'security',
    title: 'Read my security posture',
    contractIds: ['me.security.get'],
    domainModule: 'services/account/accountSettingsService',
    surfaces: Object.freeze([
      'customerMobile', 'customerWeb', 'providerMobile', 'providerWeb', 'admin',
    ] as ClientSurface[]),
    roleSplitRationale:
      'No role split. READ-ONLY on purpose: every security ACTION already has a dedicated ' +
      'endpoint with its own proof of possession, and folding them into a settings PATCH ' +
      'would put credential changes behind a JSON body — including the ability to turn 2FA ' +
      'OFF from a session that should not be able to.',
  },
  {
    key: 'customerProfile',
    title: 'Read and change my customer profile',
    contractIds: ['customer.profile.get', 'customer.profile.patch'],
    domainModule: 'services/account/accountService',
    surfaces: Object.freeze(['customerMobile', 'customerWeb', 'admin'] as ClientSurface[]),
    roleSplitRationale:
      'Role-specific by DATA, not by authorization: birth date and gender exist for a customer ' +
      'and mean nothing for a provider. Customer Web and Customer Mobile call the identical ' +
      'route with the identical DTO, which is what the release gate asks for.',
  },
  {
    key: 'addresses',
    title: 'Manage my saved addresses',
    contractIds: [
      'customer.addresses.list', 'customer.addresses.create',
      'customer.addresses.update', 'customer.addresses.delete',
      'customer.addresses.setDefault',
    ],
    domainModule: 'services/account/addressBookService',
    surfaces: Object.freeze(['customerMobile', 'customerWeb', 'admin'] as ClientSurface[]),
    roleSplitRationale:
      'No role split. Five legacy routes with five shapes — query-param ids, a POST that ' +
      'doubles as an update, a separate make-primary verb — become one REST resource with ' +
      'stable ids. Every statement is owner-scoped in SQL rather than checked in a controller.',
  },
  {
    key: 'providerProfile',
    title: 'Read and change my provider profile',
    contractIds: ['provider.profile.get', 'provider.profile.patch'],
    domainModule: 'services/account/providerProfileService',
    surfaces: Object.freeze(['providerMobile', 'providerWeb', 'admin'] as ClientSurface[]),
    roleSplitRationale:
      'Role-specific by DATA and by WORKFLOW. A provider profile field is classified, and ' +
      'editing a reviewable one submits a revision rather than writing a column — the ' +
      'compliance service owns that, and the canonical PATCH delegates to it instead of ' +
      'reimplementing it.',
  },
  {
    key: 'providerDocuments',
    title: 'Read my documents and requirements',
    contractIds: ['provider.documents.list'],
    domainModule: 'services/account/providerProfileService',
    surfaces: Object.freeze(['providerMobile', 'providerWeb'] as ClientSurface[]),
    roleSplitRationale:
      'Provider-only, and it must stay that way. The projection carries review STATE and never ' +
      'a document URL or storage path; the preview endpoint mints a short-lived signed URL ' +
      'after re-authorizing, which is a different operation with a different audit trail.',
  },
  {
    key: 'providerAvailability',
    title: 'Read and change my availability',
    contractIds: ['provider.availability.get', 'provider.availability.patch'],
    domainModule: 'services/providerAvailabilityEngine',
    surfaces: Object.freeze(['providerMobile', 'providerWeb'] as ClientSurface[]),
    roleSplitRationale:
      'No role split. The canonical route reads and writes the SAME engine matching consumes, ' +
      'which is the release gate: a provider editing one source while matching reads another ' +
      'is a provider who is unbookable for reasons nobody can see.',
  },
  {
    key: 'providerServices',
    title: 'Read the services I am approved for',
    contractIds: ['provider.services.list'],
    domainModule: 'services/account/providerProfileService',
    surfaces: Object.freeze(['providerMobile', 'providerWeb'] as ClientSurface[]),
    roleSplitRationale:
      'Provider-only. Keyed on `services.id` — the Catalog V2 canonical specific-service ' +
      'identity — never on a service family, and it projects the same qualification the ' +
      'matching pipeline selects on.',
  },
  {
    key: 'completion',
    title: 'What is left before my account is usable',
    contractIds: ['me.completion.get'],
    domainModule: 'services/account/profileCompletionService',
    surfaces: Object.freeze([
      'customerMobile', 'customerWeb', 'providerMobile', 'providerWeb',
    ] as ClientSurface[]),
    roleSplitRationale:
      'No role split; the RULES differ by role and are declared, not branched. One endpoint ' +
      'answers both, which is what stops a welcome card from inventing its own definition of ' +
      'complete and showing a green tick over an account that cannot take work.',
  },
]);

export const ACCOUNT_CAPABILITY_KEYS: readonly string[] = Object.freeze(
  ACCOUNT_CAPABILITIES.map((c) => c.key),
);
