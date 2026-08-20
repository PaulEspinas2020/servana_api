/**
 * TAB 01 mandate 4 — the PATCH story, as a gate rather than a paragraph.
 *
 * ## The defect this closes
 *
 * One rule — "which fields may a provider propose a change to" — was stated in
 * three places and two of them disagreed:
 *
 *   1. `PROFILE_FIELD_REGISTRY`, where six fields carry `editable: 'review'`.
 *   2. `PROVIDER_SELF_EDITABLE_FIELDS`, derived from (1), so also six.
 *   3. `submitPublicProfileRevision`'s hand-written allow-list — FIVE.
 *
 * `photo` was in the first two and not the third. `patchProviderProfile` gated
 * on (2), let it through, printed (2) back to the provider as the list of
 * reviewable fields, and then the compliance service refused it with
 * `FIELD_NOT_EDITABLE` — a code `provider.profile.patch` does not declare, so a
 * client gating on the published contract could not branch on it.
 *
 * ## Why this is a coverage assertion and not a field list
 *
 * A test that hard-codes "the five are these five" is a vocabulary that cannot
 * grow: add a seventh review field and the list keeps asserting the old five,
 * green, forever. This asserts a RELATIONSHIP instead — the revision channel and
 * the named exceptions must together cover the registry exactly. A new review
 * field then fails this test until somebody states which channel carries it,
 * which is the question that was never asked about `photo`.
 */

import {
  PROFILE_FIELD_REGISTRY,
  PUBLIC_PROFILE_REVISION_FIELDS,
  REVIEW_FIELD_CHANNELS,
} from '../src/services/providerProfileComplianceService';
import { PROVIDER_SELF_EDITABLE_FIELDS } from '../src/services/account/accountPolicy';

const reviewEditable = PROFILE_FIELD_REGISTRY
  .filter((f) => f.editable === 'review')
  .map((f) => f.id);

describe('every review-editable field has exactly one submission channel', () => {
  it('the registry and the derived policy list still agree', () => {
    expect([...PROVIDER_SELF_EDITABLE_FIELDS].sort()).toEqual([...reviewEditable].sort());
  });

  it('the revision channel and the named exceptions COVER the registry', () => {
    const covered = [
      ...PUBLIC_PROFILE_REVISION_FIELDS,
      ...Object.keys(REVIEW_FIELD_CHANNELS),
    ].sort();
    // A review field in neither is a field a provider is told they may change
    // and that nothing accepts.
    expect(covered).toEqual([...reviewEditable].sort());
  });

  it('no field is claimed by BOTH the revision channel and an exception', () => {
    const both = PUBLIC_PROFILE_REVISION_FIELDS.filter((f) => f in REVIEW_FIELD_CHANNELS);
    expect(both).toEqual([]);
  });

  it('every exception names where the field is actually changed', () => {
    for (const [field, channel] of Object.entries(REVIEW_FIELD_CHANNELS)) {
      // A refusal that does not name the alternative is a dead end, not an
      // instruction — §19 forbids those.
      expect(typeof channel).toBe('string');
      expect(channel.length).toBeGreaterThan(0);
      expect(channel).toMatch(/\/api\//);
      expect(field).not.toBe('');
    }
  });

  it('records that `photo` is the field this gate was built for', () => {
    // Not a vocabulary assertion — a regression pin on the specific defect.
    // If photo ever becomes submittable through the revision channel, this
    // fails and the change gets read rather than absorbed.
    expect(REVIEW_FIELD_CHANNELS.photo).toContain('profile-photo-submissions');
    expect(PUBLIC_PROFILE_REVISION_FIELDS).not.toContain('photo');
  });
});

describe('a photo patch is refused with the code the contract declares', () => {
  it('names the route the photo is actually submitted through', async () => {
    jest.resetModules();
    jest.doMock('../src/db/dbQuery', () => ({ __esModule: true, default: { query: jest.fn() } }));
    jest.doMock('../src/config', () => ({ db: { schema: 'servana' } }));

    const { patchProviderProfile } = await import(
      '../src/services/account/providerProfileService');

    await expect(
      patchProviderProfile('prov-1', { photo: 'x.jpg' }, 'client-request-id-0001'),
    ).rejects.toMatchObject({
      // Maps to ACCOUNT_FIELD_NOT_WRITABLE, which provider.profile.patch declares.
      // Before this fix the caller received FIELD_NOT_EDITABLE, which it does not.
      code: 'PROVIDER_FIELD_NOT_EDITABLE',
      status: 422,
      message: expect.stringContaining('profile-photo-submissions'),
    });
  });
});
