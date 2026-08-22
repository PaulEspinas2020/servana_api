/**
 * TAB 04 — `public-profile-preview` is NOT the customer-facing provider profile.
 *
 * ## The trap this closes
 *
 * TAB 01 listed `/api/provider/public-profile-preview` as "successor likely
 * already exists", reasoning that `GET /api/v1/providers/{uid}/profile` returns
 * a provider's public profile and so probably covers it. It refused to assert
 * that without a field-by-field comparison, and the comparison is why:
 *
 * `getPublicProfile` returns **`pendingRevision`** — the provider's UNREVIEWED
 * proposed text, together with `providerReasonCode` and `providerReasonDetail`,
 * which are the moderator's reasons for refusing a previous attempt.
 *
 * Migrating the two routes together on the strength of the shared words "public
 * profile" had two possible outcomes, and both are bad. Drop the field, and a
 * provider loses the screen that tells them a change is pending and why the last
 * one was rejected. Add it to the shared schema instead, and unreviewed text and
 * internal moderation notes travel on the endpoint customers read.
 *
 * So they are separate resources at separate seats, and this suite pins the
 * boundary so a later tidy-up cannot merge them without going red.
 *
 * This is the second time a shared noun nearly drove a false migration in this
 * programme — the first two were `support/cases/{id}/messages` onto
 * `/v1/conversations/{id}/messages`, and `reputation/summary` onto
 * `/v1/provider/earnings/summary`.
 */

import { SCHEMAS } from '../src/api/v1/openapi';
import { V1_CONTRACT } from '../src/api/v1/contract';

const schema = (name: string) => SCHEMAS[name] as any;

describe('the two public-profile routes are different resources', () => {
  it('they are separate contract entries with separate response schemas', () => {
    const preview = V1_CONTRACT.find((e) => e.id === 'provider.publicProfile.preview')!;
    const customerFacing = V1_CONTRACT.find((e) => e.id === 'provider.publicProfile.get')!;

    expect(preview.responseSchema).toBe('ProviderPublicProfilePreview');
    expect(customerFacing.responseSchema).toBe('ProviderProfile');
    expect(preview.responseSchema).not.toBe(customerFacing.responseSchema);
  });

  it('the preview is provider-only and names no other account', () => {
    const preview = V1_CONTRACT.find((e) => e.id === 'provider.publicProfile.preview')!;
    expect(preview.auth).toBe('provider');
    // No path parameter at all — the uid comes from the token, so there is no
    // way to ask for somebody else's pending revision.
    expect(preview.params ?? []).toEqual([]);
    expect(preview.path).not.toContain(':');
  });

  it('the customer-facing profile takes a uid, and so must never carry a revision', () => {
    const customerFacing = V1_CONTRACT.find((e) => e.id === 'provider.publicProfile.get')!;
    expect(customerFacing.path).toContain(':providerUid');
  });
});

describe('unreviewed text and moderation notes stay off the customer-facing schema', () => {
  it('ProviderProfile declares no pendingRevision', () => {
    const properties = Object.keys(schema('ProviderProfile').properties);
    expect(properties).not.toContain('pendingRevision');
  });

  it('ProviderProfile declares no moderator reason anywhere in its own properties', () => {
    const serialized = JSON.stringify(schema('ProviderProfile'));
    expect(serialized).not.toContain('providerReasonCode');
    expect(serialized).not.toContain('providerReasonDetail');
  });

  it('the preview schema DOES declare it — that is what makes it a different resource', () => {
    const preview = schema('ProviderPublicProfilePreview');
    expect(Object.keys(preview.properties)).toContain('pendingRevision');
    const revision = preview.properties.pendingRevision;
    expect(Object.keys(revision.properties)).toEqual(
      expect.arrayContaining(['providerReasonCode', 'providerReasonDetail', 'state']),
    );
  });

  it('the preview schema says WHY it is separate, so the next reader does not merge them', () => {
    // A boundary that exists only in a test is a boundary somebody deletes to
    // make the test pass. The reason travels with the declaration.
    expect(schema('ProviderPublicProfilePreview').description).toMatch(/pendingRevision/);
    expect(schema('ProviderPublicProfilePreview').description).toMatch(/not public|NOT the same/i);
  });
});

describe('the certification surface discloses state, never a credential', () => {
  it('the submit schema accepts only the last four digits', () => {
    const submit = schema('ProviderCertificationSubmit');
    expect(Object.keys(submit.properties)).toContain('credentialLast4');
    expect(Object.keys(submit.properties)).not.toContain('credentialNumber');
    expect(submit.properties.credentialLast4.maxLength).toBe(4);
  });

  it('the read projection carries a mask, not a number', () => {
    const cert = schema('ProviderCertification');
    expect(Object.keys(cert.properties)).toContain('credentialMask');
    expect(Object.keys(cert.properties)).not.toContain('credentialNumber');
  });

  it('the submit schema is strict, so an invented field is refused rather than ignored', () => {
    expect(schema('ProviderCertificationSubmit').additionalProperties).toBe(false);
  });
});

describe('the timeline publishes provider-facing reasons only', () => {
  it('declares the provider reason fields and no internal reviewer note', () => {
    const timeline = JSON.stringify(schema('ProviderVerificationTimeline'));
    expect(timeline).toContain('providerReasonCode');
    // §34 — internal notes must not be returned to providers. The query does not
    // select them; the schema must not declare them either, or somebody will add
    // one to match.
    expect(timeline).not.toContain('reviewerNotes');
    expect(timeline).not.toContain('internalNote');
  });
});
