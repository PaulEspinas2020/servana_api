/**
 * Validates uploads by their CONTENT, not by what the client says they are.
 *
 * Command 19 §18/§54 (LJ-08). `uploadWorkerRequirement` did this:
 *
 *   const mimeType = file.slice(file.indexOf(":") + 1, file.indexOf(";"));
 *   if (!ALLOWED_REQUIREMENT_MIMES.includes(mimeType)) reject
 *
 * That reads the MIME type out of the data URI the CLIENT SENT. The check
 * therefore asks the uploader what the file is and believes the answer, so
 * `data:image/png;base64,<any bytes at all>` passes an allowlist that looks
 * strict. §54 names this exactly: "Evidence file-type spoofing is rejected."
 *
 * The fix is to read the magic bytes. A PNG starts with a fixed eight-byte
 * signature whatever the sender claims, and a file whose declared type and
 * actual bytes disagree is rejected rather than trusted.
 *
 * Deliberately signature-based and dependency-free: this runs on the upload
 * path for every provider document, and a decoder would be a larger attack
 * surface than the check it replaces.
 */

export type AllowedUploadMime =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "application/pdf";

interface Signature {
  mime: AllowedUploadMime;
  /** Byte prefix. `null` entries are wildcards. */
  magic: (number | null)[];
  offset?: number;
  /** Extra bytes that must also match, for containers like RIFF/WebP. */
  also?: { offset: number; bytes: number[] };
}

const SIGNATURES: Signature[] = [
  // FF D8 FF — every JPEG variant (JFIF, Exif, SPIFF) shares this prefix.
  { mime: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  // \x89PNG\r\n\x1a\n — includes the CRLF trap that catches text-mode transfer
  // corruption, which is why the full eight bytes are checked rather than four.
  { mime: "image/png", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // RIFF....WEBP — a RIFF container whose form type is WEBP. The four size
  // bytes between are file-specific, hence the wildcards.
  {
    mime: "image/webp",
    magic: [0x52, 0x49, 0x46, 0x46, null, null, null, null],
    also: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  },
  // %PDF-
  { mime: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];

export interface FileValidationOk {
  ok: true;
  mime: AllowedUploadMime;
  buffer: Buffer;
  bytes: number;
}

export interface FileValidationError {
  ok: false;
  code:
    | "NOT_A_DATA_URI"
    | "MALFORMED_DATA_URI"
    | "EMPTY_FILE"
    | "TOO_LARGE"
    | "DECLARED_TYPE_NOT_ALLOWED"
    | "CONTENT_TYPE_NOT_ALLOWED"
    | "CONTENT_DOES_NOT_MATCH_DECLARED_TYPE";
  message: string;
}

export type FileValidation = FileValidationOk | FileValidationError;

const err = (
  code: FileValidationError["code"],
  message: string
): FileValidationError => ({ ok: false, code, message });

/** Reads the actual type from the leading bytes. Null when unrecognised. */
export function sniffMime(buffer: Buffer): AllowedUploadMime | null {
  for (const sig of SIGNATURES) {
    const offset = sig.offset ?? 0;
    if (buffer.length < offset + sig.magic.length) continue;

    let matched = true;
    for (let i = 0; i < sig.magic.length; i++) {
      const expected = sig.magic[i];
      if (expected === null) continue; // wildcard
      if (buffer[offset + i] !== expected) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;

    if (sig.also) {
      const { offset: o, bytes } = sig.also;
      if (buffer.length < o + bytes.length) continue;
      if (!bytes.every((b, i) => buffer[o + i] === b)) continue;
    }
    return sig.mime;
  }
  return null;
}

/**
 * Validates a data-URI upload end to end.
 *
 * Rejects when the declared type is not allowed, when the CONTENT is not an
 * allowed type, or when the two disagree — the last being the spoofing case.
 */
export function validateDataUri(
  input: unknown,
  opts: { allowed: readonly AllowedUploadMime[]; maxBytes: number }
): FileValidation {
  if (typeof input !== "string" || !input.startsWith("data:")) {
    return err("NOT_A_DATA_URI", "file must be a data URI");
  }

  const comma = input.indexOf(",");
  const semi = input.indexOf(";");
  const colon = input.indexOf(":");
  if (comma < 0 || semi < 0 || semi > comma || colon !== 4) {
    return err("MALFORMED_DATA_URI", "file must be a data URI");
  }

  const declared = input.slice(colon + 1, semi).toLowerCase().trim();
  if (!opts.allowed.includes(declared as AllowedUploadMime)) {
    return err(
      "DECLARED_TYPE_NOT_ALLOWED",
      "File type not allowed. Use JPG, PNG, WebP, or PDF."
    );
  }

  // Cheap size gate BEFORE decoding: base64 is 4 characters per 3 bytes, so an
  // oversized payload is rejected without allocating a buffer for it.
  const b64 = input.slice(comma + 1);
  if (b64.length === 0) return err("EMPTY_FILE", "file is empty");
  if (Math.floor((b64.length * 3) / 4) > opts.maxBytes) {
    return err("TOO_LARGE", "File is too large.");
  }

  const buffer = Buffer.from(b64, "base64");
  if (buffer.length === 0) return err("EMPTY_FILE", "file is empty");
  if (buffer.length > opts.maxBytes) return err("TOO_LARGE", "File is too large.");

  const actual = sniffMime(buffer);
  if (!actual) {
    return err(
      "CONTENT_TYPE_NOT_ALLOWED",
      "File type not allowed. Use JPG, PNG, WebP, or PDF."
    );
  }
  if (!opts.allowed.includes(actual)) {
    return err(
      "CONTENT_TYPE_NOT_ALLOWED",
      "File type not allowed. Use JPG, PNG, WebP, or PDF."
    );
  }
  if (actual !== declared) {
    // The spoofing case: a payload labelled one thing and built as another.
    return err(
      "CONTENT_DOES_NOT_MATCH_DECLARED_TYPE",
      "File contents do not match the file type."
    );
  }

  return { ok: true, mime: actual, buffer, bytes: buffer.length };
}
