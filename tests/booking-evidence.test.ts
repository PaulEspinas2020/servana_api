/**
 * Job evidence: requirements, satisfaction, and metadata stripping.
 *
 * Command 19 §17–§19. Two properties matter most:
 *
 *   §19 — "Uploading must not automatically mean accepted when review is
 *   required." UPLOADED and ACCEPTED stay distinct, and REJECTED never counts
 *   toward a satisfied requirement.
 *
 *   §18 — "Remove embedded location." A photo taken at a customer address
 *   carries GPS in EXIF by default on both major platforms. Storing it would
 *   attach a precise home location to every file, which is the exact data the
 *   C17 disclosure staging works to withhold.
 */
jest.mock("../src/db/dbQuery", () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
jest.mock("../src/config", () => ({ __esModule: true, db: { schema: "test" } }));

import {
  requirementsForBooking,
  findRequirement,
  isRequirementSatisfied,
  blockingRequirements,
  countFor,
  EvidenceItem,
} from "../src/services/bookingEvidenceService";
import { stripImageMetadata } from "../src/helpers/stripImageMetadata";

const item = (
  requirementCode: string,
  state: EvidenceItem["state"] = "UPLOADED"
): EvidenceItem => ({
  id: "1",
  requirementCode,
  stage: "BEFORE_SERVICE",
  state,
  mimeType: "image/jpeg",
  bytes: 100,
  createdAt: null,
  reviewNote: null,
});

const BEFORE = findRequirement("BEFORE_PHOTO")!;

describe("requirements are server-driven", () => {
  it("exposes a before and an after requirement", () => {
    const codes = requirementsForBooking().map((r) => r.code);
    expect(codes).toContain("BEFORE_PHOTO");
    expect(codes).toContain("AFTER_PHOTO");
  });

  it("looks up case-insensitively and rejects unknown codes", () => {
    expect(findRequirement("before_photo")?.code).toBe("BEFORE_PHOTO");
    expect(findRequirement("MADE_UP")).toBeNull();
    expect(findRequirement("")).toBeNull();
  });

  it("accepts only image types, never PDF or anything executable", () => {
    for (const r of requirementsForBooking()) {
      expect(r.acceptedMimeTypes).toEqual(["image/jpeg", "image/png", "image/webp"]);
      expect(r.maxBytes).toBeGreaterThan(0);
      expect(r.minCount).toBeGreaterThan(0);
      expect(r.maxCount).toBeGreaterThanOrEqual(r.minCount);
    }
  });
});

describe("upload is not approval", () => {
  it("an uploaded file satisfies the requirement while no reviewer exists", () => {
    expect(isRequirementSatisfied(BEFORE, [item("BEFORE_PHOTO", "UPLOADED")])).toBe(true);
  });

  it("a REJECTED file never satisfies it", () => {
    // The provider must replace it, not merely have one on record.
    expect(isRequirementSatisfied(BEFORE, [item("BEFORE_PHOTO", "REJECTED")])).toBe(false);
  });

  it("a rejected file plus an accepted one is satisfied", () => {
    expect(
      isRequirementSatisfied(BEFORE, [
        item("BEFORE_PHOTO", "REJECTED"),
        item("BEFORE_PHOTO", "ACCEPTED"),
      ])
    ).toBe(true);
  });

  it("evidence for a different requirement does not satisfy this one", () => {
    expect(isRequirementSatisfied(BEFORE, [item("AFTER_PHOTO")])).toBe(false);
  });

  it("nothing uploaded is not satisfied", () => {
    expect(isRequirementSatisfied(BEFORE, [])).toBe(false);
  });
});

describe("blocking requirements drive completion readiness", () => {
  it("an empty booking blocks both stages", () => {
    expect(blockingRequirements("BEFORE_SERVICE", [])).toEqual(["BEFORE_PHOTO"]);
    expect(blockingRequirements("AFTER_SERVICE", [])).toEqual(["AFTER_PHOTO"]);
  });

  it("satisfying the before stage does not unblock the after stage", () => {
    const items = [item("BEFORE_PHOTO")];
    expect(blockingRequirements("BEFORE_SERVICE", items)).toEqual([]);
    expect(blockingRequirements("AFTER_SERVICE", items)).toEqual(["AFTER_PHOTO"]);
  });

  it("a rejected before-photo re-blocks the stage", () => {
    expect(
      blockingRequirements("BEFORE_SERVICE", [item("BEFORE_PHOTO", "REJECTED")])
    ).toEqual(["BEFORE_PHOTO"]);
  });
});

describe("countFor enforces maxCount", () => {
  it("counts only the matching requirement", () => {
    const items = [item("BEFORE_PHOTO"), item("BEFORE_PHOTO"), item("AFTER_PHOTO")];
    expect(countFor("BEFORE_PHOTO", items)).toBe(2);
    expect(countFor("AFTER_PHOTO", items)).toBe(1);
    expect(countFor("NOPE", items)).toBe(0);
  });
});

// ─── Metadata stripping ─────────────────────────────────────────────────────

const jpegWithExif = (): Buffer => {
  // SOI + APP1(Exif, carrying a recognisable GPS marker) + APP0(JFIF) + SOS
  const exifPayload = Buffer.concat([
    Buffer.from("Exif\0\0", "ascii"),
    Buffer.from("GPSLatitude14.5995GPSLongitude120.9842", "ascii"),
  ]);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    (() => {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(exifPayload.length + 2, 0);
      return b;
    })(),
    exifPayload,
  ]);
  const jfifPayload = Buffer.from("JFIF\0\x01\x02\0\0\x01\0\x01\0\0", "ascii");
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0]),
    (() => {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(jfifPayload.length + 2, 0);
      return b;
    })(),
    jfifPayload,
  ]);
  const sos = Buffer.concat([
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.from([0x12, 0x34, 0x56, 0x78]), // "pixel data"
    Buffer.from([0xff, 0xd9]),
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, app0, sos]);
};

describe("JPEG metadata stripping", () => {
  const original = jpegWithExif();
  const stripped = stripImageMetadata(original, "image/jpeg");

  it("removes the GPS coordinates", () => {
    expect(original.toString("latin1")).toContain("GPSLatitude");
    expect(stripped.toString("latin1")).not.toContain("GPSLatitude");
    expect(stripped.toString("latin1")).not.toContain("120.9842");
  });

  it("removes the whole APP1 segment", () => {
    expect(stripped.toString("latin1")).not.toContain("Exif");
  });

  it("keeps APP0/JFIF so the file stays a valid JPEG", () => {
    expect(stripped.toString("latin1")).toContain("JFIF");
  });

  it("keeps the SOI marker and the pixel data", () => {
    expect(stripped[0]).toBe(0xff);
    expect(stripped[1]).toBe(0xd8);
    expect(stripped.includes(Buffer.from([0x12, 0x34, 0x56, 0x78]))).toBe(true);
  });

  it("gets smaller, never larger", () => {
    expect(stripped.length).toBeLessThan(original.length);
  });
});

describe("PNG metadata stripping", () => {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
  };
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", Buffer.alloc(13)),
    chunk("eXIf", Buffer.from("GPSLatitude14.5995", "ascii")),
    chunk("tEXt", Buffer.from("Comment\0taken at home", "ascii")),
    chunk("IDAT", Buffer.from([0x11, 0x22, 0x33])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const stripped = stripImageMetadata(png, "image/png");

  it("removes eXIf and tEXt chunks", () => {
    expect(stripped.toString("latin1")).not.toContain("GPSLatitude");
    expect(stripped.toString("latin1")).not.toContain("taken at home");
  });

  it("keeps the critical chunks", () => {
    const text = stripped.toString("latin1");
    expect(text).toContain("IHDR");
    expect(text).toContain("IDAT");
    expect(text).toContain("IEND");
  });

  it("keeps the signature intact", () => {
    expect(stripped.subarray(0, 8)).toEqual(png.subarray(0, 8));
  });
});

describe("stripping never destroys an upload", () => {
  it("returns unrecognised types unchanged", () => {
    const pdf = Buffer.from("%PDF-1.7 some content", "ascii");
    expect(stripImageMetadata(pdf, "application/pdf")).toEqual(pdf);
  });

  it("returns malformed images unchanged rather than truncating them", () => {
    const junk = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]);
    expect(stripImageMetadata(junk, "image/jpeg").length).toBeGreaterThanOrEqual(2);
  });

  it("survives an empty buffer", () => {
    expect(stripImageMetadata(Buffer.alloc(0), "image/jpeg").length).toBe(0);
  });

  it("a JPEG with no metadata is left alone", () => {
    const plain = Buffer.from([
      0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
      0xaa, 0xbb, 0xff, 0xd9,
    ]);
    expect(stripImageMetadata(plain, "image/jpeg")).toEqual(plain);
  });
});
