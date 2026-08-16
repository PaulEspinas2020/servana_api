/**
 * Cross-account leakage and sensitive-field isolation (§107, §108).
 *
 * ## What this suite is for
 *
 * Two release gates: "sensitive documents do not leak" and "/me is not
 * overloaded with private role data". Neither can be read off a route table —
 * both are claims about what a specific caller receives, and the only way to
 * know is to ask as that caller and look at the bytes.
 *
 * So every case here drives the real services against a fake database that
 * routes the real SQL, then SERIALISES the result and asserts on it. A
 * projection that grew a field would fail here rather than in production.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => {
  const fake = require('./support/accountDbFake');
  return { __esModule: true, default: fake.dbQueryFake, pool: fake.poolFake };
});
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: Promise.resolve({ collection: () => ({ findOne: async () => null, insertOne: async () => undefined, updateOne: async () => undefined }) }) }));

import * as fake from './support/accountDbFake';
import * as account from '../src/services/account/accountService';
import * as addresses from '../src/services/account/addressBookService';
import * as providerProfile from '../src/services/account/providerProfileService';
import {
  ME_EXCLUSIONS,
  NEVER_PROJECTED,
  providerFieldsVisibleTo,
} from '../src/services/account/accountPolicy';

const CUSTOMER_A = 'customer-a';
const CUSTOMER_B = 'customer-b';
const PROVIDER = 'provider-1';
const ADMIN = 'admin-1';

const seed = () => {
  fake.reset();
  fake.seedUser(CUSTOMER_A, 3);
  fake.seedUser(CUSTOMER_B, 3);
  fake.seedUser(PROVIDER, 2, {
    first_name: 'Pat',
    last_name: 'Provider',
    phone_number: '+639170000001',
  });
  fake.seedUser(ADMIN, 1);
  fake.seedAddress(CUSTOMER_A, { label: 'A Home', is_primary: true });
  fake.seedAddress(CUSTOMER_B, { label: 'B Home', is_primary: true, address_one: '99 Secret Lane' });
  fake.seedRequirement(PROVIDER, 'valid_id', 'approved');
};

beforeEach(seed);

const rejects = async (fn: () => Promise<unknown>): Promise<{ code: string; status: number }> => {
  try {
    await fn();
  } catch (error: any) {
    return { code: String(error?.code ?? 'NONE'), status: Number(error?.status ?? 0) };
  }
  throw new Error('expected a refusal, and the call succeeded');
};

// ─── Addresses ────────────────────────────────────────────────────────────────

describe('a customer reaches their own addresses and nobody else\'s', () => {
  it('the list contains only the caller\'s addresses', async () => {
    const a = await addresses.listAddresses(CUSTOMER_A);
    const b = await addresses.listAddresses(CUSTOMER_B);

    expect(a.map((x) => x.label)).toEqual(['A Home']);
    expect(b.map((x) => x.label)).toEqual(['B Home']);
  });

  it('presenting another account\'s address id resolves to NOTHING', async () => {
    const [theirs] = await addresses.listAddresses(CUSTOMER_B);
    const refusal = await rejects(() => addresses.getAddress(CUSTOMER_A, theirs.addressId));

    expect(refusal.code).toBe('ADDRESS_NOT_FOUND');
    expect(refusal.status).toBe(404);
  });

  it('the refusal does NOT distinguish "no such address" from "not yours"', async () => {
    const [theirs] = await addresses.listAddresses(CUSTOMER_B);
    const foreign = await rejects(() => addresses.getAddress(CUSTOMER_A, theirs.addressId));
    const absent = await rejects(() => addresses.getAddress(CUSTOMER_A, 'CADZZZZ'));

    // Address ids are short generated strings. An endpoint that told the two
    // apart would let a caller confirm which ids exist, and these are homes.
    expect(foreign).toEqual(absent);
  });

  it('cannot UPDATE another account\'s address', async () => {
    const [theirs] = await addresses.listAddresses(CUSTOMER_B);
    const refusal = await rejects(() =>
      addresses.updateAddress(CUSTOMER_A, theirs.addressId, { label: 'Mine now' }),
    );
    expect(refusal.code).toBe('ADDRESS_NOT_FOUND');
    expect(fake.addressesFor(CUSTOMER_B)[0].label).toBe('B Home');
  });

  it('cannot DELETE another account\'s address', async () => {
    const [theirs] = await addresses.listAddresses(CUSTOMER_B);
    const refusal = await rejects(() => addresses.deleteAddress(CUSTOMER_A, theirs.addressId));

    expect(refusal.code).toBe('ADDRESS_NOT_FOUND');
    expect(fake.addressesFor(CUSTOMER_B)).toHaveLength(1);
  });

  it('cannot promote another account\'s address to default', async () => {
    const [theirs] = await addresses.listAddresses(CUSTOMER_B);
    const refusal = await rejects(() => addresses.setDefaultAddress(CUSTOMER_A, theirs.addressId));
    expect(refusal.code).toBe('ADDRESS_NOT_FOUND');
  });

  it('no address function accepts a subject other than the caller', () => {
    // The property, not an instance of it. Every signature takes the owner uid
    // as its FIRST argument; there is no variant that names a different one.
    expect(addresses.listAddresses.length).toBe(1);
    expect(addresses.getAddress.length).toBe(2);
    expect(addresses.setDefaultAddress.length).toBe(2);
  });

  it('publishes no audit or owner columns', async () => {
    const [row] = await addresses.listAddresses(CUSTOMER_A);
    const serialized = JSON.stringify(row);
    for (const forbidden of ['created_by', 'updated_by', 'uid']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

// ─── /me ──────────────────────────────────────────────────────────────────────

describe('/me is not overloaded with private role data', () => {
  it('carries a POINTER to the role extension, never its contents', async () => {
    const me = await account.getAccount(PROVIDER);
    expect(me.profiles).toEqual([
      { kind: 'provider', endpoint: '/api/v1/provider/profile' },
    ]);
  });

  it('carries none of the things the policy excludes', async () => {
    const me = await account.getAccount(CUSTOMER_A);
    const keys = Object.keys(me);
    // The gate, asserted against the declared exclusion list rather than a
    // hand-written one that could drift from it.
    for (const excluded of Object.keys(ME_EXCLUSIONS)) {
      expect(keys).not.toContain(excluded);
    }
  });

  it('never projects a credential or a push token', async () => {
    const serialized = JSON.stringify(await account.getAccount(CUSTOMER_A));
    for (const forbidden of NEVER_PROJECTED) {
      expect(serialized).not.toContain(forbidden);
    }
    // The fixture really does hold one, so this is a live assertion rather than
    // a check against an absence that was never there.
    expect(serialized).not.toContain('do-not-project-me');
  });

  it('refuses to write a verified identifier', async () => {
    const refusal = await rejects(() =>
      account.patchAccount(CUSTOMER_A, { email: 'new@example.test' }),
    );
    expect(refusal.code).toBe('ACCOUNT_FIELD_NOT_WRITABLE');
    // REFUSED, not silently dropped: ignoring it leaves the caller believing
    // they changed a verified identifier.
    expect(refusal.status).toBe(422);
  });

  it('refuses to write a role', async () => {
    const refusal = await rejects(() => account.patchAccount(CUSTOMER_A, { role: 1 }));
    expect(refusal.code).toBe('ACCOUNT_FIELD_NOT_WRITABLE');
  });
});

// ─── Provider profile ─────────────────────────────────────────────────────────

describe('the public provider projection discloses only public fields', () => {
  it('a customer sees the public set and nothing more', async () => {
    const publicView = await providerProfile.getProviderProfile(PROVIDER, 'otherCustomer');
    expect(publicView.visibleFields.sort()).toEqual([...providerFieldsVisibleTo('otherCustomer')].sort());
    // Spot-check the ones that matter most.
    expect(publicView.visibleFields).toContain('displayName');
    expect(publicView.visibleFields).not.toContain('email');
    expect(publicView.visibleFields).not.toContain('mobile');
    expect(publicView.visibleFields).not.toContain('birthDate');
    expect(publicView.visibleFields).not.toContain('legalAddress');
    expect(publicView.visibleFields).not.toContain('reviewerNotes');
  });

  it('the private VALUES are absent from the payload, not merely unlisted', async () => {
    const serialized = JSON.stringify(
      await providerProfile.getProviderProfile(PROVIDER, 'otherCustomer'),
    );
    // The fixture's real phone number and email. A projection that listed the
    // field as hidden and emitted the value anyway would pass a `visibleFields`
    // check and fail this one.
    expect(serialized).not.toContain('+639170000001');
    expect(serialized).not.toContain('provider-1@example.test');
  });

  it('withholds account status and document counts from a customer seat', async () => {
    const publicView = await providerProfile.getProviderProfile(PROVIDER, 'otherCustomer');
    expect(publicView.verification.accountStatus).toBeNull();
    expect(publicView.verification.documentsAccepted).toBe(0);
    expect(publicView.verification.documentsRequired).toBe(0);
  });

  it('the provider themselves sees the private set', async () => {
    const own = await providerProfile.getProviderProfile(PROVIDER, 'self');
    expect(own.visibleFields).toContain('email');
    expect(own.visibleFields).toContain('mobile');
    expect(own.verification.accountStatus).toBe('active');
    // ...and still never the internal one.
    expect(own.visibleFields).not.toContain('reviewerNotes');
  });

  it('only an admin sees the internal class', async () => {
    const asAdmin = await providerProfile.getProviderProfile(PROVIDER, 'admin');
    expect(asAdmin.visibleFields).toContain('reviewerNotes');
  });

  it('no seat receives a document URL or storage path', async () => {
    for (const seat of ['self', 'otherCustomer', 'admin'] as const) {
      const serialized = JSON.stringify(await providerProfile.getProviderProfile(PROVIDER, seat));
      for (const forbidden of NEVER_PROJECTED) {
        expect(serialized).not.toContain(forbidden);
      }
    }
  });
});

describe('the document list is state, never content', () => {
  it('publishes review state and no URL or path', async () => {
    const documents = await providerProfile.listDocuments(PROVIDER);
    const serialized = JSON.stringify(documents);
    for (const forbidden of ['documentUrl', 'document_url', 'storagePath', 'storage_path', 'previewUrl']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(documents.length).toBeGreaterThan(0);
    expect(documents[0]).toHaveProperty('status');
  });

  it('shows a required document that was never submitted as MISSING', async () => {
    // Driven by the CATALOG, not by the rows. A list built from rows alone shows
    // an empty screen to a provider who has everything left to do.
    const documents = await providerProfile.listDocuments(CUSTOMER_A);
    const required = documents.filter((d) => d.required);
    expect(required.length).toBeGreaterThan(0);
    expect(required.every((d) => d.status === 'missing')).toBe(true);
  });
});

// ─── Account switch ───────────────────────────────────────────────────────────

describe('nothing in this domain accepts a subject other than the token', () => {
  it('every read is derived from the uid it was given', async () => {
    // The server half of account-switch invalidation: there is no cached
    // response that could belong to another account, because every call takes
    // the subject and nothing else.
    const a = await account.getAccount(CUSTOMER_A);
    const b = await account.getAccount(CUSTOMER_B);
    expect(a.uid).toBe(CUSTOMER_A);
    expect(b.uid).toBe(CUSTOMER_B);
    expect(a.uid).not.toBe(b.uid);
  });

  it('a customer profile read for one account never returns another\'s address id', async () => {
    const a = await account.getCustomerProfile(CUSTOMER_A);
    const b = await account.getCustomerProfile(CUSTOMER_B);
    expect(a.defaultAddressId).not.toBe(b.defaultAddressId);
    expect(a.addressCount).toBe(1);
  });
});
