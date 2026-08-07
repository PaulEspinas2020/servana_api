/**
 * Removes embedded metadata from uploaded images.
 *
 * Command 19 §18: "Strip unnecessary EXIF metadata. Remove embedded location
 * unless explicitly required."
 *
 * This matters more for job evidence than the phrase suggests. A photo taken at
 * a customer's home carries GPS coordinates in EXIF by default on both iOS and
 * Android. Storing that attaches a precise home location to every piece of
 * evidence — the exact data C17's disclosure staging works to withhold, handed
 * over through the image instead.
 *
 * It also carries device serial numbers, lens data and timestamps, none of
 * which any Servana workflow reads.
 *
 * ── Byte-level, no dependency ─────────────────────────────────────────────
 * The repo has no image library, and adding a decoder to the upload path would
 * be a larger attack surface than the metadata it removes: image parsers are a
 * classic source of memory-safety bugs, and this runs on attacker-supplied
 * bytes. Container surgery needs no decoding — the pixel data is never parsed,
 * only copied.
 *
 * Anything unrecognised is returned unchanged rather than mangled. A stripper
 * that corrupts evidence is worse than one that misses a field.
 */

/** JPEG markers that carry no pixel data and may be dropped wholesale. */
const JPEG_STRIPPABLE = new Set([
  0xe1, // APP1  — EXIF and XMP. This is where GPS lives.
  0xe2, // APP2  — FlashPix / ICC extensions
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec,
  0xed, // APP13 — Photoshop IRB / IPTC, often holds author and location
  0xee, 0xef,
  0xfe, // COM   — free-text comment
]);

/**
 * PNG ancillary chunks carrying text or metadata.
 *
 * Critical chunks (IHDR, PLTE, IDAT, IEND) are never touched — dropping one
 * destroys the image. Ancillary chunks are safe to remove by specification.
 */
const PNG_STRIPPABLE = new Set([
  "tEXt", "zTXt", "iTXt", // text, including comments and descriptions
  "eXIf",                  // EXIF, including GPS
  "tIME",                  // last-modified timestamp
]);

/** WebP chunks carrying metadata rather than image data. */
const WEBP_STRIPPABLE = new Set(["EXIF", "XMP "]);

function stripJpeg(buf: Buffer): Buffer {
  // SOI
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;

  const out: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;

  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) break; // not a marker boundary — bail out unchanged
    const marker = buf[i + 1];

    // SOS: entropy-coded pixel data begins and runs to the end. Copy verbatim.
    if (marker === 0xda) {
      out.push(buf.subarray(i));
      i = buf.length;
      break;
    }
    // Standalone markers carry no length field.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      out.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }

    if (i + 4 > buf.length) break;
    const length = buf.readUInt16BE(i + 2);
    if (length < 2 || i + 2 + length > buf.length) break; // malformed — stop here

    if (!JPEG_STRIPPABLE.has(marker)) {
      out.push(buf.subarray(i, i + 2 + length));
    }
    i += 2 + length;
  }

  // Anything left after an abandoned parse is preserved, so a file this
  // function does not fully understand still survives intact.
  if (i < buf.length) out.push(buf.subarray(i));
  return Buffer.concat(out);
}

function stripPng(buf: Buffer): Buffer {
  const SIG = 8;
  if (buf.length < SIG + 12) return buf;

  const out: Buffer[] = [buf.subarray(0, SIG)];
  let i = SIG;

  while (i + 8 <= buf.length) {
    const length = buf.readUInt32BE(i);
    const type = buf.toString("ascii", i + 4, i + 8);
    const total = 12 + length; // length + type + data + crc
    if (length > buf.length || i + total > buf.length) break; // malformed

    if (!PNG_STRIPPABLE.has(type)) out.push(buf.subarray(i, i + total));
    i += total;

    if (type === "IEND") break;
  }

  if (i < buf.length) out.push(buf.subarray(i));
  return Buffer.concat(out);
}

function stripWebp(buf: Buffer): Buffer {
  // RIFF....WEBP
  if (buf.length < 12) return buf;

  const out: Buffer[] = [buf.subarray(0, 12)];
  let i = 12;
  let removed = false;

  while (i + 8 <= buf.length) {
    const fourcc = buf.toString("ascii", i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    // Chunks are padded to even length.
    const total = 8 + size + (size % 2);
    if (i + total > buf.length) break;

    if (WEBP_STRIPPABLE.has(fourcc)) removed = true;
    else out.push(buf.subarray(i, i + total));
    i += total;
  }

  if (!removed) return buf; // nothing to do — avoid rewriting the RIFF size
  if (i < buf.length) out.push(buf.subarray(i));

  const result = Buffer.concat(out);
  // RIFF size counts everything after the first 8 bytes and must be corrected
  // or the file is invalid.
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

/**
 * Strips metadata according to the image type.
 *
 * `mime` comes from the magic-byte sniff, never from the client, so this
 * cannot be pointed at the wrong parser by a mislabelled upload.
 */
export function stripImageMetadata(buffer: Buffer, mime: string): Buffer {
  try {
    switch (mime) {
      case "image/jpeg":
        return stripJpeg(buffer);
      case "image/png":
        return stripPng(buffer);
      case "image/webp":
        return stripWebp(buffer);
      // PDFs carry metadata in object dictionaries and an XMP stream; removing
      // it safely needs a real parser. Left intact deliberately, and recorded
      // rather than half-done.
      default:
        return buffer;
    }
  } catch {
    // Never let stripping lose an upload. Worst case the metadata survives,
    // which is the status quo, not a regression.
    return buffer;
  }
}
