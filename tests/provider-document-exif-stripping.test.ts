/**
 * Provider identity documents must not carry EXIF GPS into storage (§58).
 *
 * The booking-evidence upload path has stripped image metadata since Command 19,
 * on the reasoning that "a photo taken at a customer address carries GPS in EXIF
 * by default". The provider DOCUMENT paths — self-upload and admin-on-behalf —
 * never did, and they are strictly more sensitive: a provider photographs their
 * ID or NBI clearance at home, so the file carries their home coordinates into
 * storage and into every admin preview.
 *
 * A production audit found 120 documents across 32 providers, none of which had
 * been through a stripping path. These cases pin the fix.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { stripImageMetadata } from '../src/helpers/stripImageMetadata';

/**
 * Builds a minimal but structurally valid JPEG carrying an APP1/Exif segment
 * with a recognisable GPS payload.
 *
 * Constructed rather than fixture-loaded so the GPS bytes under test are
 * unambiguous — a binary fixture would make a failure hard to read.
 */
function jpegWithExifGps(): { buffer: Buffer; needle: Buffer } {
  const needle = Buffer.from('GPSHOMECOORDS', 'ascii');
  const exifBody = Buffer.concat([
    Buffer.from('Exif\0\0', 'ascii'),
    Buffer.from('MM\0\x2a\0\0\0\x08', 'ascii'), // TIFF header, big-endian
    needle,
  ]);

  const app1Length = exifBody.length + 2; // length field includes itself
  return {
    needle,
    buffer: Buffer.concat([
      Buffer.from([0xff, 0xd8]), // SOI
      Buffer.from([0xff, 0xe1]), // APP1
      Buffer.from([(app1Length >> 8) & 0xff, app1Length & 0xff]),
      exifBody,
      // A baseline frame + scan so what remains is still a plausible image.
      Buffer.from([0xff, 0xdb, 0x00, 0x03, 0x00]), // DQT (stub)
      Buffer.from([0xff, 0xda, 0x00, 0x02]), // SOS
      Buffer.from([0x11, 0x22, 0x33, 0x44]), // entropy-coded data
      Buffer.from([0xff, 0xd9]), // EOI
    ]),
  };
}

describe('provider document uploads — EXIF stripping (§58)', () => {
  it('removes the EXIF GPS payload from a JPEG', () => {
    const { buffer, needle } = jpegWithExifGps();
    expect(buffer.includes(needle)).toBe(true); // the input really carries it

    const cleaned = stripImageMetadata(buffer, 'image/jpeg');

    expect(cleaned.includes(needle)).toBe(false);
    expect(cleaned.length).toBeLessThan(buffer.length);
  });

  it('keeps the result a structurally valid JPEG', () => {
    const { buffer } = jpegWithExifGps();
    const cleaned = stripImageMetadata(buffer, 'image/jpeg');

    // SOI preserved, EOI preserved, image data survives.
    expect(cleaned[0]).toBe(0xff);
    expect(cleaned[1]).toBe(0xd8);
    expect(cleaned.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
    expect(cleaned.includes(Buffer.from([0xff, 0xda]))).toBe(true); // scan intact
  });

  it('leaves a PDF untouched rather than corrupting it', () => {
    // PDFs need a real parser; the helper deliberately passes them through.
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<</Type/Catalog>>\nendobj\n', 'ascii');
    expect(stripImageMetadata(pdf, 'application/pdf').equals(pdf)).toBe(true);
  });

  it('never loses an upload on malformed input', () => {
    // A truncated APP1 length must not throw — worst case metadata survives,
    // which is the status quo rather than a regression.
    const truncated = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x45]);
    expect(() => stripImageMetadata(truncated, 'image/jpeg')).not.toThrow();
  });
});

describe('both document upload paths are wired to the stripper', () => {
  // A behavioural test cannot reach these without a database and a storage
  // bucket, and the defect being guarded is an OMISSION — the call simply was
  // not there. Reading the source is what actually detects that.
  //
  // Line endings are normalised because this repo is edited on Windows and a
  // CRLF checkout has previously broken source-introspection tests.
  const read = (p: string) =>
    readFileSync(join(__dirname, '..', 'src', 'services', p), 'utf8').replace(/\r\n/g, '\n');

  it.each([
    ['providerProfileComplianceService.ts', 'provider self-upload'],
    ['adminProviderService.ts', 'admin upload on behalf'],
  ])('%s (%s) strips metadata before persisting', (file) => {
    const src = read(file);

    expect(src).toContain("from '../helpers/stripImageMetadata'");
    expect(src).toMatch(/persistenceBuffer\s*=\s*stripImageMetadata\(/);

    // Order matters: the scanner must see the original bytes, so stripping
    // happens after the scan, not instead of it.
    expect(src.indexOf('assertCleanScan')).toBeLessThan(src.indexOf('stripImageMetadata('));
  });

  it('hashes the stored bytes, not the pre-strip bytes', () => {
    // If the digest were taken before stripping it would describe a file that
    // was never stored, silently breaking any future integrity check.
    const src = read('providerProfileComplianceService.ts');
    expect(src.indexOf('persistenceBuffer = stripImageMetadata('))
      .toBeLessThan(src.indexOf("createHash('sha256').update(persistenceBuffer)"));
  });
});
