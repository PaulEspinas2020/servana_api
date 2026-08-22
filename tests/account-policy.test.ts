/**
 * The account policy is ONE declaration with real consumers.
 *
 * `accountPolicy` is only worth having if the services enforce it, the documents
 * are generated from it, and nothing restates it. A policy module everybody
 * imports and nobody obeys is a comment with a type signature.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));

import fs from 'fs';
import path from 'path';
import {
  ACCOUNT_CAPABILITIES,
  ACCOUNT_SEATS,
  ADDRESS_LIMITS,
  CUSTOMER_WRITABLE_FIELDS,
  ME_EXCLUSIONS,
  ME_FIELDS,
  ME_FIELD_IDS,
  ME_WRITABLE_FIELDS,
  NEVER_PROJECTED,
  PROVIDER_PROFILE_FIELDS,
  PROVIDER_SELF_EDITABLE_FIELDS,
  READABLE_BY,
  SENSITIVITY_CLASSES,
  SETTINGS_CATALOG,
  SETTINGS_WRITABLE,
  mayRead,
  providerFieldsVisibleTo,
  providerMayEdit,
} from '../src/services/account/accountPolicy';
import { PROFILE_FIELD_REGISTRY } from '../src/services/providerProfileComplianceService';

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/**
 * Source assertions run against COMMENT-STRIPPED text.
 *
 * The docblocks in these modules explain the rules by NAMING the things the
 * rules forbid — `service_families`, `provider_documents`, the notification
 * category ids. Asserting on raw source would pass on the explanation alone
 * while the code was wrong, which is the exact failure mode
 * `booking-conversation-lifecycle` documents.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// ─── Sensitivity ──────────────────────────────────────────────────────────────

describe('the sensitivity matrix', () => {
  it('gives every class a readable-by row', () => {
    for (const cls of SENSITIVITY_CLASSES) {
      expect(READABLE_BY[cls]).toBeDefined();
      expect(READABLE_BY[cls].length).toBeGreaterThan(0);
    }
  });

  it('lets otherCustomer read PUBLIC and nothing else', () => {
    // The single row that makes "sensitive documents do not leak" a property of
    // the declaration rather than of every query author remembering.
    expect(mayRead('public', 'otherCustomer')).toBe(true);
    expect(mayRead('private', 'otherCustomer')).toBe(false);
    expect(mayRead('operational', 'otherCustomer')).toBe(false);
    expect(mayRead('internal', 'otherCustomer')).toBe(false);
  });

  it('reserves INTERNAL for admin alone — not even the subject', () => {
    expect(mayRead('internal', 'admin')).toBe(true);
    expect(mayRead('internal', 'self')).toBe(false);
  });

  it('never lets self read less than otherCustomer', () => {
    // A projection where a stranger sees more than the subject would be an
    // obvious bug and an easy one to introduce by editing one row.
    for (const cls of SENSITIVITY_CLASSES) {
      if (mayRead(cls, 'otherCustomer')) expect(mayRead(cls, 'self')).toBe(true);
    }
  });
});

describe('NEVER_PROJECTED and the classes do not overlap', () => {
  /**
   * The contradiction the leakage suite caught on first run.
   *
   * `reviewerNotes` was on the refusal list AND classified `internal`, so one
   * mechanism said admins may read it and the other said nobody may. Two
   * mechanisms for one concern is how a policy comes to disagree with itself.
   */
  it('no CLASSIFIED provider field appears on the refusal list', () => {
    for (const field of PROVIDER_PROFILE_FIELDS) {
      expect(NEVER_PROJECTED).not.toContain(field.id);
    }
  });

  it('the refusal list is credentials and artefacts only', () => {
    // Every entry names a credential, a token or document content. If a future
    // addition does not, it belongs in a class instead.
    for (const entry of NEVER_PROJECTED) {
      expect(entry).toMatch(/password|token|otp|document|storage|number/i);
    }
  });
});

// ─── /me ──────────────────────────────────────────────────────────────────────

describe('/me stays a common account record', () => {
  it('every writable field is declared and every declared field is known', () => {
    for (const field of ME_WRITABLE_FIELDS) expect(ME_FIELD_IDS).toContain(field);
    expect(ME_WRITABLE_FIELDS).toEqual(
      ME_FIELDS.filter((f) => f.writableBySelf).map((f) => f.id),
    );
  });

  it('verified identifiers and role are NOT writable, and say why', () => {
    for (const id of ['email', 'phoneNumber', 'role', 'accountStatus', 'uid']) {
      const field = ME_FIELDS.find((f) => f.id === id)!;
      expect(field.writableBySelf).toBe(false);
      // A refusal with no reason is one the next person removes.
      expect(String(field.writeNote ?? '').length).toBeGreaterThan(20);
    }
  });

  it('names an owning endpoint for everything it excludes', () => {
    expect(Object.keys(ME_EXCLUSIONS).length).toBeGreaterThan(4);
    for (const owner of Object.values(ME_EXCLUSIONS)) {
      expect(String(owner).length).toBeGreaterThan(5);
    }
  });

  it('excludes nothing it also declares — the two lists cannot overlap', () => {
    for (const excluded of Object.keys(ME_EXCLUSIONS)) {
      expect(ME_FIELD_IDS).not.toContain(excluded);
    }
  });
});

// ─── Provider fields ──────────────────────────────────────────────────────────

describe('the provider field policy DELEGATES to the existing registry', () => {
  it('is the registry, not a copy of it', () => {
    // Declaring a second provider taxonomy is exactly the mistake this policy
    // exists to prevent, and `/api/provider/profile-fields` already serves this
    // one to Provider Web.
    expect(PROVIDER_PROFILE_FIELDS).toBe(PROFILE_FIELD_REGISTRY);
  });

  it('requires BOTH signals before a field reaches a customer', () => {
    const visible = new Set(providerFieldsVisibleTo('otherCustomer'));
    for (const field of PROFILE_FIELD_REGISTRY) {
      const byClass = mayRead(field.classification as never, 'otherCustomer');
      const expected = byClass && field.customerVisible;
      expect(visible.has(field.id)).toBe(expected);
    }
  });

  it('a customerVisible flag alone is not enough', () => {
    // Either signal can veto. The test is meaningful because the registry does
    // contain a field with customerVisible: true and a non-public class.
    const vetoed = PROFILE_FIELD_REGISTRY.filter(
      (f) => f.customerVisible && !mayRead(f.classification as never, 'otherCustomer'),
    );
    const visible = new Set(providerFieldsVisibleTo('otherCustomer'));
    for (const field of vetoed) expect(visible.has(field.id)).toBe(false);
    expect(vetoed.length).toBeGreaterThan(0);
  });

  it('only `review` fields are self-editable', () => {
    for (const field of PROFILE_FIELD_REGISTRY) {
      expect(providerMayEdit(field.id)).toBe(field.editable === 'review');
    }
    expect(PROVIDER_SELF_EDITABLE_FIELDS.length).toBeGreaterThan(0);
  });

  it('refuses an unknown field id', () => {
    expect(providerMayEdit('somethingInvented')).toBe(false);
  });
});

// ─── Settings ─────────────────────────────────────────────────────────────────

describe('the settings catalog', () => {
  it('gives every setting a group, a default and a note', () => {
    for (const spec of SETTINGS_CATALOG) {
      expect(['locale', 'privacy', 'security', 'notifications']).toContain(spec.group);
      expect(spec.defaultValue).not.toBeUndefined();
      expect(spec.note.length).toBeGreaterThan(20);
    }
  });

  it('keeps two-factor out of the writable set', () => {
    expect(SETTINGS_WRITABLE).not.toContain('twoFactorEnabled');
  });

  it('defaults analytics sharing to OFF', () => {
    const spec = SETTINGS_CATALOG.find((s) => s.id === 'shareUsageAnalytics')!;
    expect(spec.defaultValue).toBe(false);
  });

  it('does NOT restate the notification categories', () => {
    // TAB 09 owns them. A second preference model is what that tab existed to
    // prevent, and it very nearly had one.
    const source = read('src/services/account/accountPolicy.ts');
    const code = stripComments(source);
    for (const category of ['jobAssigned', 'jobReminder', 'requirementReview']) {
      expect(code).not.toContain(`${category}:`);
    }
  });
});

// ─── Wiring ───────────────────────────────────────────────────────────────────

describe('the declaration has real consumers', () => {
  it('the address service scopes every statement to the owner in SQL', () => {
    const source = read('src/services/account/addressBookService.ts');
    // Not in a controller afterwards: the row is already in memory by the time
    // anybody asks whose it is.
    const statements = source.match(/(SELECT|UPDATE|DELETE)[\s\S]{0,400}?user_address[\s\S]{0,300}?`/g) ?? [];
    expect(statements.length).toBeGreaterThan(4);
    for (const statement of statements) {
      expect(statement).toMatch(/uid = \$\d/);
    }
  });

  it('the default promotion is ONE transaction, demote-then-promote', () => {
    const source = read('src/services/account/addressBookService.ts');
    const fn = source.slice(source.indexOf('export const setDefaultAddress'));
    expect(fn).toMatch(/BEGIN/);
    expect(fn).toMatch(/COMMIT/);
    expect(fn).toMatch(/ROLLBACK/);
    // Demote BEFORE promote: that order never transiently satisfies
    // "exactly one" by having zero rather than two.
    expect(fn.indexOf('is_primary = FALSE')).toBeLessThan(fn.indexOf('is_primary = TRUE'));
  });

  it('the account service delegates to ONE profile writer', () => {
    const source = read('src/services/account/accountService.ts');
    expect(source).toMatch(/userService\.updateUserProfile/);
    // A second writer for one row would disagree the first time either grew a
    // rule, which is how first_name came to be settable three ways.
    expect(source).not.toMatch(/INSERT INTO \$\{s\}\.user_profile/);
  });

  it('the provider patch delegates to the compliance revision workflow', () => {
    const source = read('src/services/account/providerProfileService.ts');
    expect(source).toMatch(/submitPublicProfileRevision/);
    expect(source).toMatch(/clientRequestId/);
  });

  it('availability reads the SAME engine matching consumes', () => {
    const source = read('src/services/account/providerProfileService.ts');
    expect(source).toMatch(/availabilityEngine\.getAvailabilityProfile/);
    expect(source).not.toMatch(/FROM \$\{s\}\.provider_availability/);
  });

  /**
   * CORRECTED (TAB 05). This assertion was exactly backwards, and the database
   * says so in a constraint.
   *
   * It read: "provider services are keyed on services.id, never a family", and
   * refused any mention of `service_famil` in the query. But the baseline
   * schema carries
   *
   *     ADD CONSTRAINT employee_services_service_id_fkey
   *       FOREIGN KEY (service_id) REFERENCES servana.service_families(id)
   *
   * so the column is FK-constrained to the FAMILY table. It cannot hold a
   * `services.id` at all unless that number also exists in `service_families`.
   *
   * The belief was true once. Migration 024 renamed the two tables past each
   * other — the old coarse families became `service_families`, and
   * `catalog_services` (the 95 canonical bookable services) became `services` —
   * and `employee_services.service_id` was never remapped. The detector was
   * written after that rename and encoded the pre-rename meaning of the word
   * "services", which is how it outlived the thing it described.
   *
   * Worth noting that the SAME commit (8282e46) added migration 029, which
   * joins `services s ON s.legacy_service_family_id = es.service_id` — treating
   * the column as a family id. One rule, two statements, contradicting each
   * other inside one commit. The executable one was right.
   *
   * The cost: `listServices` backs `GET /api/v1/provider/services`, which the
   * provider mobile app has migrated to. Joining `services sv ON sv.id =
   * es.service_id` compared a family id against a different id space. As a LEFT
   * JOIN it raised nothing — where the number happened to exist the provider was
   * shown a DIFFERENT service's name, and where it did not, null.
   */
  it('provider services are keyed on a FAMILY id, because the FK says so', () => {
    const source = read('src/services/account/providerProfileService.ts');
    expect(source).toMatch(/es\.service_id/);
    const code = stripComments(source);
    // The name must be resolved through the table the foreign key points at.
    expect(code).toMatch(/service_families/);
    // And NOT through the canonical bookable catalog, which is a different id
    // space with its own sequence since migration 025.
    expect(code).not.toMatch(/\bservices\s+sv\s+ON\s+sv\.id\s*=\s*es\.service_id/i);
  });

  it('the schema still constrains that column to the family table', () => {
    // The citation, asserted rather than quoted, so this pair cannot drift from
    // the database the way the assertion above did.
    const baseline = read('scripts/baseline/000-baseline.sql');
    expect(baseline).toMatch(
      /employee_services_service_id_fkey[\s\S]{0,200}REFERENCES servana\.service_families\(id\)/,
    );
  });

  it('documents come from worker_requirements, and provider_documents is not invented', () => {
    const source = read('src/services/account/providerProfileService.ts');
    expect(source).toMatch(/worker_requirements/);
    expect(stripComments(source)).not.toMatch(/provider_documents/);
  });
});

// ─── Capabilities ─────────────────────────────────────────────────────────────

describe('every capability explains its role split rather than asserting one', () => {
  it('has a rationale, a module and at least one surface', () => {
    for (const capability of ACCOUNT_CAPABILITIES) {
      expect(capability.roleSplitRationale.length).toBeGreaterThan(80);
      expect(capability.domainModule).toMatch(/^services\//);
      expect(capability.surfaces.length).toBeGreaterThan(0);
      expect(capability.contractIds.length).toBeGreaterThan(0);
    }
  });

  it('every contract id it names exists', () => {
    const { V1_CONTRACT } = require('../src/api/v1/contract');
    const ids = new Set(V1_CONTRACT.map((e: any) => e.id));
    for (const capability of ACCOUNT_CAPABILITIES) {
      for (const id of capability.contractIds) expect(ids.has(id)).toBe(true);
    }
  });
});

describe('the declared limits', () => {
  it('are the ones the contract publishes', () => {
    expect(ADDRESS_LIMITS.maxPerAccount).toBe(25);
    expect(ADDRESS_LIMITS.exactlyOneDefault).toBe(true);
    expect(CUSTOMER_WRITABLE_FIELDS).not.toContain('defaultAddressId');
    expect(ACCOUNT_SEATS).toEqual(['self', 'otherCustomer', 'admin']);
  });
});
