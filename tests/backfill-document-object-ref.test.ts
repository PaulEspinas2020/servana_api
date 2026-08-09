/**
 * Parsing guards for the private-storage backfill.
 *
 * These two functions decide WHICH object gets copied into WHICH provider's
 * private folder. A wrong answer copies one provider's identity document into
 * another provider's compliance record — the cross-user leak §11 exists to
 * prevent — so both are pure, exported, and pinned here rather than trusted.
 *
 * The URL shapes are the two actually present in production (measured
 * 2026-08-09: 85 firebasestorage, 35 storage.googleapis).
 */

import {
  parseLegacyObjectRef,
  objectUidMatches,
} from '../scripts/backfill-document-private-storage';

const BUCKET = 'servana-59bee.firebasestorage.app';

describe('parseLegacyObjectRef', () => {
  it('parses the Firebase download-token shape and decodes the path', () => {
    const ref = parseLegacyObjectRef(
      `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/provider-requirements%2FabcUID123_deadbeef.jpeg?alt=media&token=xyz`
    );
    expect(ref).toEqual({
      bucket: BUCKET,
      objectPath: 'provider-requirements/abcUID123_deadbeef.jpeg',
    });
  });

  it('parses the V4 signed GCS shape', () => {
    const ref = parseLegacyObjectRef(
      `https://storage.googleapis.com/${BUCKET}/employee-requirements/abcUID123_0.png?X-Goog-Signature=aa&Expires=1800000000`
    );
    expect(ref).toEqual({
      bucket: BUCKET,
      objectPath: 'employee-requirements/abcUID123_0.png',
    });
  });

  it('keeps the bucket separate so a foreign bucket can be refused', () => {
    const ref = parseLegacyObjectRef(
      'https://storage.googleapis.com/someone-elses-bucket/x/abcUID123_1.png'
    );
    expect(ref?.bucket).toBe('someone-elses-bucket');
  });

  it.each([
    ['not a url at all', 'provider-requirements/x.png'],
    ['an unknown host', 'https://cdn.example.com/a/b.png'],
    ['firebase shape with no object segment', `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/`],
    ['gcs shape with only a bucket', `https://storage.googleapis.com/${BUCKET}`],
  ])('returns null rather than guessing: %s', (_label, input) => {
    expect(parseLegacyObjectRef(input)).toBeNull();
  });

  it('does not mistake a nested path for a bucket', () => {
    const ref = parseLegacyObjectRef(
      `https://storage.googleapis.com/${BUCKET}/a/b/c/abcUID123_9.pdf`
    );
    expect(ref?.objectPath).toBe('a/b/c/abcUID123_9.pdf');
  });
});

describe('objectUidMatches', () => {
  it('accepts an object whose filename carries the owning uid', () => {
    expect(objectUidMatches('provider-requirements/abcUID123_deadbeef.jpeg', 'abcUID123')).toBe(true);
  });

  it('rejects a mismatched uid — the leak case', () => {
    expect(objectUidMatches('provider-requirements/OTHERUID_deadbeef.jpeg', 'abcUID123')).toBe(false);
  });

  it('rejects a uid that is merely a prefix of the object owner', () => {
    // 'abcUID' must not be accepted as the owner of 'abcUID123_...'.
    expect(objectUidMatches('provider-requirements/abcUID123_x.png', 'abcUID')).toBe(false);
  });

  it('rejects a filename with no uid separator', () => {
    expect(objectUidMatches('provider-requirements/scan.png', 'abcUID123')).toBe(false);
  });

  it('rejects a leading-underscore filename rather than matching an empty uid', () => {
    expect(objectUidMatches('provider-requirements/_x.png', '')).toBe(false);
  });
});
