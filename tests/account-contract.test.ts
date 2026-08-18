/**
 * The account domain behaves the way the policy declares.
 *
 * Three things this proves that a route table cannot:
 *
 *   1. **The default address is exactly one, always** — including across a
 *      failed transaction, which is the defect the legacy two-statement path
 *      left behind.
 *   2. **Completion is derived from the same facts matching selects on**, so a
 *      provider cannot be told they are ready while being unmatchable.
 *   3. **Settings round-trip** in both the flat and the grouped shape, and an
 *      unknown key is refused rather than silently dropped.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => {
  const fake = require('./support/accountDbFake');
  return { __esModule: true, default: fake.dbQueryFake, pool: fake.poolFake };
});
jest.mock('../src/db/mongodbQuery', () => ({
  __esModule: true,
  default: Promise.resolve({
    collection: () => ({
      findOne: async () => null,
      insertOne: async () => undefined,
      updateOne: async () => undefined,
    }),
  }),
}));

import * as fake from './support/accountDbFake';
import * as addresses from '../src/services/account/addressBookService';
import * as settings from '../src/services/account/accountSettingsService';
import { getCompletion } from '../src/services/account/profileCompletionService';
import {
  ADDRESS_LIMITS,
  SETTINGS_CATALOG,
  computeCompletion,
  validateAddress,
} from '../src/services/account/accountPolicy';

const CUSTOMER = 'customer-1';
const PROVIDER = 'provider-1';

const seed = () => {
  fake.reset();
  settings.__resetSettingsSchema();
  fake.seedUser(CUSTOMER, 3);
  fake.seedUser(PROVIDER, 2);
};

beforeEach(seed);

const rejects = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (error: any) {
    return { code: String(error?.code ?? 'NONE'), message: String(error?.message ?? '') };
  }
  throw new Error('expected a refusal, and the call succeeded');
};

// ─── The default address ──────────────────────────────────────────────────────

describe('exactly one default address, always', () => {
  it('the FIRST address becomes the default automatically', async () => {
    const created = await addresses.createAddress(CUSTOMER, { addressOne: '1 Street' });
    expect(created.isDefault).toBe(true);
    expect(await addresses.countDefaults(CUSTOMER)).toBe(1);
  });

  it('a second address does NOT displace the default unless asked', async () => {
    await addresses.createAddress(CUSTOMER, { addressOne: '1 Street' });
    const second = await addresses.createAddress(CUSTOMER, { addressOne: '2 Avenue' });

    expect(second.isDefault).toBe(false);
    expect(await addresses.countDefaults(CUSTOMER)).toBe(1);
  });

  it('promoting demotes the previous one in the SAME transaction', async () => {
    const first = await addresses.createAddress(CUSTOMER, { addressOne: '1 Street' });
    const second = await addresses.createAddress(CUSTOMER, { addressOne: '2 Avenue' });

    await addresses.setDefaultAddress(CUSTOMER, second.addressId);

    expect(await addresses.countDefaults(CUSTOMER)).toBe(1);
    const list = await addresses.listAddresses(CUSTOMER);
    expect(list.find((a) => a.addressId === second.addressId)!.isDefault).toBe(true);
    expect(list.find((a) => a.addressId === first.addressId)!.isDefault).toBe(false);
  });

  /**
   * The defect the legacy path had.
   *
   * It set the new default and cleared the others in two statements with no
   * transaction. A failure between them left TWO primaries, and every reader
   * picks whichever the planner returned first.
   */
  it('a FAILED promotion leaves the previous default intact, never two', async () => {
    const first = await addresses.createAddress(CUSTOMER, { addressOne: '1 Street' });
    const second = await addresses.createAddress(CUSTOMER, { addressOne: '2 Avenue' });

    fake.store.failNextCommit = true;
    await expect(addresses.setDefaultAddress(CUSTOMER, second.addressId)).rejects.toThrow();

    expect(await addresses.countDefaults(CUSTOMER)).toBe(1);
    const list = await addresses.listAddresses(CUSTOMER);
    expect(list.find((a) => a.addressId === first.addressId)!.isDefault).toBe(true);
  });

  it('promoting the CURRENT default is a no-op, not a duplicate', async () => {
    const only = await addresses.createAddress(CUSTOMER, { addressOne: '1 Street' });
    await addresses.setDefaultAddress(CUSTOMER, only.addressId);
    await addresses.setDefaultAddress(CUSTOMER, only.addressId);

    expect(await addresses.countDefaults(CUSTOMER)).toBe(1);
  });

  it('deleting the default PROMOTES the oldest survivor', async () => {
    const first = await addresses.createAddress(CUSTOMER, { addressOne: '1 Street' });
    const second = await addresses.createAddress(CUSTOMER, { addressOne: '2 Avenue' });

    const result = await addresses.deleteAddress(CUSTOMER, first.addressId);

    // An account with addresses is never left without a default — the legacy
    // delete left exactly that: a checkout screen with nothing selected.
    expect(result.promotedAddressId).toBe(second.addressId);
    expect(await addresses.countDefaults(CUSTOMER)).toBe(1);
  });

  it('deleting the LAST address leaves no default and no error', async () => {
    const only = await addresses.createAddress(CUSTOMER, { addressOne: '1 Street' });
    const result = await addresses.deleteAddress(CUSTOMER, only.addressId);

    expect(result.deleted).toBe(true);
    expect(result.promotedAddressId).toBeNull();
    expect(await addresses.countDefaults(CUSTOMER)).toBe(0);
  });

  it('deleting a NON-default promotes nobody', async () => {
    const first = await addresses.createAddress(CUSTOMER, { addressOne: '1 Street' });
    const second = await addresses.createAddress(CUSTOMER, { addressOne: '2 Avenue' });

    const result = await addresses.deleteAddress(CUSTOMER, second.addressId);
    expect(result.promotedAddressId).toBeNull();
    expect((await addresses.listAddresses(CUSTOMER))[0].addressId).toBe(first.addressId);
  });
});

// ─── Address validation ───────────────────────────────────────────────────────

describe('address validation', () => {
  it('requires the street line on CREATE', async () => {
    const refusal = await rejects(() => addresses.createAddress(CUSTOMER, { label: 'Home' }));
    expect(refusal.code).toBe('ADDRESS_FIELD_REQUIRED');
  });

  it('does NOT require it on PATCH — absence means "leave it alone"', () => {
    // Treating absence as a clear would let a client that sends one field wipe
    // the rest of somebody's address.
    expect(validateAddress({ label: 'Home' }, { isCreate: false }).ok).toBe(true);
  });

  it('refuses an over-long field, naming which one', () => {
    const verdict = validateAddress(
      { addressOne: 'x'.repeat(300) },
      { isCreate: true },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.refusal).toBe('ADDRESS_FIELD_TOO_LONG');
    expect(verdict.field).toBe('addressOne');
  });

  it('refuses at the ceiling', () => {
    const verdict = validateAddress(
      { addressOne: '1 Street' },
      { isCreate: true, existingCount: ADDRESS_LIMITS.maxPerAccount },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.refusal).toBe('ADDRESS_LIMIT_REACHED');
  });
});

// ─── Settings ─────────────────────────────────────────────────────────────────

describe('one settings store, every account', () => {
  it('returns EVERY declared setting, from the row or the catalog default', async () => {
    const result = await settings.getSettings(CUSTOMER);
    for (const spec of SETTINGS_CATALOG) {
      expect(result[spec.group as 'locale' | 'privacy' | 'security']).toHaveProperty(spec.id);
    }
  });

  it('privacy defaults to the NON-permissive value', async () => {
    const result = await settings.getSettings(CUSTOMER);
    // Privacy by default means the permissive value is the chosen one, never
    // the assumed one.
    expect(result.privacy.shareUsageAnalytics).toBe(false);
  });

  it('a PATCH changes only what it names', async () => {
    await settings.patchSettings(CUSTOMER, { locale: 'fil-PH' });
    const result = await settings.getSettings(CUSTOMER);

    expect(result.locale.locale).toBe('fil-PH');
    // Untouched, which a full replace could not promise.
    expect(result.locale.timeZone).toBe('Asia/Manila');
    expect(result.privacy.profileDiscoverable).toBe(true);
  });

  it('accepts the GROUPED shape the GET returns, so a client can round-trip', async () => {
    await settings.patchSettings(CUSTOMER, { privacy: { shareUsageAnalytics: true } });
    expect((await settings.getSettings(CUSTOMER)).privacy.shareUsageAnalytics).toBe(true);
  });

  it('REFUSES an unknown setting rather than ignoring it', async () => {
    const refusal = await rejects(() => settings.patchSettings(CUSTOMER, { notASetting: true }));
    expect(refusal.code).toBe('SETTING_UNKNOWN');
  });

  it('REFUSES to change two-factor from a settings PATCH', async () => {
    // A settings PATCH that could flip it would be a way to turn it OFF from a
    // stolen session.
    const refusal = await rejects(() => settings.patchSettings(CUSTOMER, { twoFactorEnabled: true }));
    expect(refusal.code).toBe('SETTING_NOT_WRITABLE');
  });

  it('refuses a wrongly-typed value', async () => {
    const refusal = await rejects(() => settings.patchSettings(CUSTOMER, { profileDiscoverable: 'yes' }));
    expect(refusal.code).toBe('SETTING_INVALID');
  });

  it('two accounts do not share settings', async () => {
    await settings.patchSettings(CUSTOMER, { locale: 'fil-PH' });
    expect((await settings.getSettings(PROVIDER)).locale.locale).toBe('en-PH');
  });

  it('points at the notification model rather than copying it', async () => {
    const result = await settings.getSettings(CUSTOMER);
    expect(result.notifications.endpoint).toBe('/api/v1/me/notification-preferences');
  });
});

// ─── Completion ───────────────────────────────────────────────────────────────

describe('completion is derived, and percent is not canProceed', () => {
  it('a provider missing only a photo CAN proceed', () => {
    const state = computeCompletion({
      role: 'provider',
      hasName: true,
      hasVerifiedContact: true,
      hasPhoto: false,
      hasRequiredDocuments: true,
      hasServices: true,
      hasAvailability: true,
    });
    expect(state.canProceed).toBe(true);
    expect(state.isComplete).toBe(false);
    expect(state.percent).toBeLessThan(100);
  });

  it('a provider with no accepted documents CANNOT, however high the percentage', () => {
    // The case the gate exists for: looks nearly done, cannot take work, because
    // matching cannot select them.
    const state = computeCompletion({
      role: 'provider',
      hasName: true,
      hasVerifiedContact: true,
      hasPhoto: true,
      hasRequiredDocuments: false,
      hasServices: true,
      hasAvailability: true,
    });
    expect(state.percent).toBeGreaterThan(50);
    expect(state.canProceed).toBe(false);
    expect(state.blockedBy).toEqual(['documents']);
  });

  it('availability and services block, because matching selects on them', () => {
    const noAvailability = computeCompletion({
      role: 'provider', hasName: true, hasVerifiedContact: true, hasPhoto: true,
      hasRequiredDocuments: true, hasServices: true, hasAvailability: false,
    });
    const noServices = computeCompletion({
      role: 'provider', hasName: true, hasVerifiedContact: true, hasPhoto: true,
      hasRequiredDocuments: true, hasServices: false, hasAvailability: true,
    });
    expect(noAvailability.blockedBy).toEqual(['availability']);
    expect(noServices.blockedBy).toEqual(['services']);
  });

  it('a customer with no address cannot proceed', () => {
    const state = computeCompletion({
      role: 'customer', hasName: true, hasVerifiedContact: true, hasPhoto: true, hasAddress: false,
    });
    expect(state.blockedBy).toEqual(['address']);
  });

  it('a fully-set customer is complete and can proceed', () => {
    const state = computeCompletion({
      role: 'customer', hasName: true, hasVerifiedContact: true, hasPhoto: true, hasAddress: true,
    });
    expect(state).toMatchObject({ percent: 100, isComplete: true, canProceed: true, blockedBy: [] });
  });

  it('the live service reads the real facts, not a guess', async () => {
    fake.seedAddress(CUSTOMER, { is_primary: true });
    const state = await getCompletion(CUSTOMER);

    expect(state.role).toBe('customer');
    // Name and verified contact come from the seeded credential row; the address
    // from the address table. None of it is assumed.
    expect(state.satisfied).toEqual(expect.arrayContaining(['name', 'contact', 'address']));
    expect(state.missing).toContain('photo');
    expect(state.canProceed).toBe(true);
  });

  it('names a canonical ENDPOINT for each missing requirement, never a screen', async () => {
    const state = await getCompletion(CUSTOMER);
    for (const target of Object.values(state.next)) {
      // A screen name is a client implementation detail and breaks when a route
      // is renamed — the same reason the deep-link contract keys on ids.
      expect(String(target)).toMatch(/^(GET|POST|PATCH|DELETE|the )/);
    }
  });
});
