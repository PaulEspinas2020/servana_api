/**
 * Uploads are validated by content, not by what the client claims.
 *
 * Command 19 §18/§54 (LJ-08). `uploadWorkerRequirement` read the MIME type out
 * of the data URI the CLIENT sent and checked THAT against its allowlist:
 *
 *   const mimeType = file.slice(file.indexOf(":") + 1, file.indexOf(";"));
 *   if (!ALLOWED_REQUIREMENT_MIMES.includes(mimeType)) reject
 *
 * So the check asked the uploader what the file was and believed the answer.
 * `data:image/png;base64,<any bytes at all>` passed an allowlist that looked
 * strict. §54: "Evidence file-type spoofing is rejected."
 */
import { validateDataUri, sniffMime } from "../src/helpers/fileSignature";

const ALLOWED = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

const MAX = 10 * 1024 * 1024;

const bytes = (...b: number[]) => Buffer.from(b);
const pad = (b: Buffer, n = 64) => Buffer.concat([b, Buffer.alloc(n)]);

const JPEG = pad(bytes(0xff, 0xd8, 0xff, 0xe0));
const PNG = pad(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));
const WEBP = pad(
  Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    bytes(0x24, 0x00, 0x00, 0x00),
    Buffer.from("WEBP", "ascii"),
  ])
);
const PDF = pad(Buffer.from("%PDF-1.7\n", "ascii"));
const HTML = pad(Buffer.from("<html><script>alert(1)</script>", "ascii"));
const ELF = pad(bytes(0x7f, 0x45, 0x4c, 0x46));
const ZIP = pad(bytes(0x50, 0x4b, 0x03, 0x04));

const uri = (mime: string, buf: Buffer) =>
  `data:${mime};base64,${buf.toString("base64")}`;

const check = (input: unknown, maxBytes = MAX) =>
  validateDataUri(input, { allowed: ALLOWED, maxBytes });

describe("genuine files of each allowed type pass", () => {
  it.each([
    ["image/jpeg", JPEG],
    ["image/png", PNG],
    ["image/webp", WEBP],
    ["application/pdf", PDF],
  ])("%s", (mime, buf) => {
    const r = check(uri(mime, buf));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mime).toBe(mime);
  });
});

describe("spoofing is rejected — the defect this closes", () => {
  it("an executable labelled as a PNG is rejected", () => {
    const r = check(uri("image/png", ELF));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("CONTENT_TYPE_NOT_ALLOWED");
  });

  it("HTML labelled as a JPEG is rejected", () => {
    const r = check(uri("image/jpeg", HTML));
    expect(r.ok).toBe(false);
  });

  it("a zip labelled as a PDF is rejected", () => {
    expect(check(uri("application/pdf", ZIP)).ok).toBe(false);
  });

  it("a REAL PNG labelled as a PDF is still rejected", () => {
    // Both types are allowed, but the declared type and the content disagree,
    // which means something downstream will mis-handle it.
    const r = check(uri("application/pdf", PNG));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("CONTENT_DOES_NOT_MATCH_DECLARED_TYPE");
  });

  it("a disallowed declared type is rejected before any decoding", () => {
    const r = check(uri("application/x-msdownload", PNG));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DECLARED_TYPE_NOT_ALLOWED");
  });
});

describe("size limits", () => {
  it("rejects a payload over the ceiling", () => {
    const big = pad(bytes(0xff, 0xd8, 0xff, 0xe0), 5000);
    const r = check(uri("image/jpeg", big), 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TOO_LARGE");
  });

  it("accepts one just under it", () => {
    expect(check(uri("image/png", PNG), 10_000).ok).toBe(true);
  });

  it("rejects an empty payload", () => {
    const r = check("data:image/png;base64,");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("EMPTY_FILE");
  });
});

describe("malformed input fails closed", () => {
  it.each([
    [null, "NOT_A_DATA_URI"],
    [undefined, "NOT_A_DATA_URI"],
    [12345, "NOT_A_DATA_URI"],
    ["https://example.com/x.png", "NOT_A_DATA_URI"],
    ["data:image/png", "MALFORMED_DATA_URI"],
    ["data:,abc", "MALFORMED_DATA_URI"],
  ])("%s is rejected", (input, code) => {
    const r = check(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });

  it("a truncated file too short to carry a signature is rejected", () => {
    const r = check(uri("image/png", bytes(0x89, 0x50)));
    expect(r.ok).toBe(false);
  });
});

describe("sniffMime reads content only", () => {
  it("identifies each allowed type", () => {
    expect(sniffMime(JPEG)).toBe("image/jpeg");
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(WEBP)).toBe("image/webp");
    expect(sniffMime(PDF)).toBe("application/pdf");
  });

  it("returns null for anything else", () => {
    expect(sniffMime(HTML)).toBeNull();
    expect(sniffMime(ELF)).toBeNull();
    expect(sniffMime(ZIP)).toBeNull();
    expect(sniffMime(Buffer.alloc(0))).toBeNull();
  });

  it("does not mistake a bare RIFF container for WebP", () => {
    // RIFF also fronts WAV and AVI; only the WEBP form type may pass.
    const wav = pad(
      Buffer.concat([
        Buffer.from("RIFF", "ascii"),
        bytes(0x24, 0x00, 0x00, 0x00),
        Buffer.from("WAVE", "ascii"),
      ])
    );
    expect(sniffMime(wav)).toBeNull();
  });

  it("requires the full PNG signature, not just the first four bytes", () => {
    // The trailing CRLF/EOF bytes catch text-mode transfer corruption.
    const truncated = pad(bytes(0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00));
    expect(sniffMime(truncated)).toBeNull();
  });
});

describe("the upload path uses this, not the client's word", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs
    .readFileSync(
      path.join(__dirname, "..", "src/controllers/providerController.ts"),
      "utf8"
    )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it("the canonical private document upload calls validateDataUri", () => {
    const complianceService = fs
      .readFileSync(
        path.join(__dirname, "..", "src/services/providerProfileComplianceService.ts"),
        "utf8"
      )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const fn = complianceService.slice(
      complianceService.indexOf("export const uploadDocument"),
      complianceService.indexOf("export const listCertifications")
    );
    expect(fn).toContain("validateDataUri");
  });

  it("no longer derives the MIME from the client's data URI string", () => {
    const fn = src.slice(
      src.indexOf("export const uploadWorkerRequirement"),
      src.indexOf("export const getWorkerRequirementsOwn")
    );
    expect(fn).not.toMatch(/file\.slice\(file\.indexOf\(":"\)/);
  });
});
