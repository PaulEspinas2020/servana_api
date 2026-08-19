/**
 * Move legacy provider documents into private storage.
 *
 * DRY RUN BY DEFAULT:
 *   npx ts-node -r dotenv/config scripts/backfill-document-private-storage.ts
 *   npx ts-node -r dotenv/config scripts/backfill-document-private-storage.ts --apply
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Measured on production 2026-08-09: 120 provider documents across 32
 * providers, and NOT ONE of them on the private storage path. Two consequences,
 * both live:
 *
 *   • 85 rows hold a `firebasestorage.googleapis.com` URL with a permanent
 *     `token=`. An unauthenticated HEAD returns 200. Anyone holding the URL
 *     reads that provider's ID or NBI clearance, indefinitely. Firebase
 *     download tokens live on the object, so key rotation does NOT revoke them.
 *
 *   • 35 rows hold a V4 signed `storage.googleapis.com` URL that returns 403
 *     even though it does not expire until 2027 — the signing key was rotated,
 *     which invalidates signatures issued under it. Admin preview falls back to
 *     the raw file_url when storage_path is absent, so those documents cannot
 *     be reviewed by anyone.
 *
 * The upload code has been correct since the private-storage work landed; every
 * one of these rows simply predates it.
 *
 * ── Why this is safe to run against live data ───────────────────────────────
 *
 * `file_url` is never written. All three consumers (admin, provider web,
 * provider mobile) already read `storage_path` when present and fall back to
 * `file_url` when absent, so setting `storage_path` flips a row onto the
 * private path with no client change and no release (§2, §4). Rollback is
 * therefore `storage_path = NULL`, which restores exactly today's behaviour.
 *
 * Objects are read through the Admin SDK service account, NOT through the URL,
 * so the 35 rows with dead signatures copy across just as readily as the 85.
 *
 * Idempotent: only rows with `storage_path IS NULL` are considered, and the
 * UPDATE re-asserts that predicate, so a second run reports zero and a run
 * interrupted halfway resumes cleanly.
 *
 * EXIF is stripped on the way through. These files were uploaded before the
 * stripping fix (007927a), so this is the one moment the historical GPS
 * metadata can be removed without asking 32 providers to re-upload.
 */

import { createHash } from "crypto";
import { writeFileSync } from "fs";
import { join } from "path";
import { db, firebaseConfig } from "../src/config";
import dbQuery from "../src/db/dbQuery";
import { sniffMime } from "../src/helpers/fileSignature";
import { stripImageMetadata } from "../src/helpers/stripImageMetadata";

const s = db.schema;
const APPLY = process.argv.includes("--apply");

interface LegacyRow {
  id: number;
  worker_uid: string;
  file_url: string;
  file_name: string | null;
  requirement_type: string | null;
}

/** Never echo a whole document URL or a uid into a log this may be pasted into. */
const maskUid = (u: string) => (u.length < 8 ? "•••" : `${u.slice(0, 4)}•••${u.slice(-3)}`);

/**
 * Extracts the bucket and object path from either legacy URL shape.
 *
 *   firebasestorage.googleapis.com/v0/b/<bucket>/o/<urlencoded path>?alt=media&token=…
 *   storage.googleapis.com/<bucket>/<path>?X-Goog-Signature=…
 *
 * Returns null rather than guessing. A row whose URL does not parse is reported
 * and skipped — inventing an object path would mean copying an arbitrary file
 * into a provider's compliance folder.
 */
export function parseLegacyObjectRef(
  fileUrl: string
): { bucket: string; objectPath: string } | null {
  let url: URL;
  try {
    url = new URL(fileUrl);
  } catch {
    return null;
  }

  if (url.hostname === "firebasestorage.googleapis.com") {
    // /v0/b/<bucket>/o/<encoded path>
    const m = url.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
    if (!m) return null;
    try {
      return { bucket: m[1], objectPath: decodeURIComponent(m[2]) };
    } catch {
      return null;
    }
  }

  if (url.hostname === "storage.googleapis.com") {
    // /<bucket>/<path>
    const m = url.pathname.match(/^\/([^/]+)\/(.+)$/);
    if (!m) return null;
    try {
      return { bucket: m[1], objectPath: decodeURIComponent(m[2]) };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * The legacy object name embeds the owning uid: `<uid>_<something>.<ext>`.
 *
 * Checked rather than trusted. If the uid in the path disagrees with the row's
 * worker_uid, the pairing is wrong somewhere, and copying that object into this
 * provider's private folder would hand one provider another's identity
 * document — the exact cross-user leak §11 exists to prevent. Report, skip.
 */
export function objectUidMatches(objectPath: string, workerUid: string): boolean {
  const base = objectPath.split("/").pop() ?? "";
  const underscore = base.indexOf("_");
  if (underscore <= 0) return false;
  return base.slice(0, underscore) === workerUid;
}

async function main() {
  const configuredBucket = String(firebaseConfig.storageBucket ?? "").trim();
  if (!configuredBucket) {
    throw new Error("STORAGE_BUCKET is not set; refusing to guess which bucket holds these documents");
  }

  const { rows } = await dbQuery.query(
    `SELECT id, worker_uid, file_url, file_name, requirement_type
       FROM ${s}.worker_requirements
      WHERE storage_path IS NULL AND file_url IS NOT NULL
      ORDER BY id`
  );
  const legacy = rows as LegacyRow[];

  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${legacy.length} document(s) without private storage\n`);
  if (legacy.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const { getFirebaseAdmin } = await import("../src/middleware/firebaseApp");
  const bucket = getFirebaseAdmin().storage().bucket(configuredBucket);
  const { uploadPrivateFileToStorage } = await import("../src/helpers/firebaseStorageUploader");

  const migrated: Array<{ id: number; storagePath: string }> = [];
  const skipped: Array<{ id: number; reason: string }> = [];
  let strippedBytes = 0;

  for (const row of legacy) {
    const label = `#${row.id} (${maskUid(row.worker_uid)}, ${row.requirement_type ?? "untyped"})`;

    const ref = parseLegacyObjectRef(row.file_url);
    if (!ref) {
      skipped.push({ id: row.id, reason: "URL_UNPARSEABLE" });
      console.log(`  skip ${label}: URL shape not recognised`);
      continue;
    }
    if (ref.bucket !== configuredBucket) {
      skipped.push({ id: row.id, reason: "FOREIGN_BUCKET" });
      console.log(`  skip ${label}: object lives in a different bucket`);
      continue;
    }
    if (!objectUidMatches(ref.objectPath, row.worker_uid)) {
      // Loud on purpose — this is a data-integrity finding, not a skip.
      skipped.push({ id: row.id, reason: "UID_MISMATCH" });
      console.log(`  SKIP ${label}: object filename uid does not match worker_uid — REVIEW MANUALLY`);
      continue;
    }

    const file = bucket.file(ref.objectPath);
    const [exists] = await file.exists();
    if (!exists) {
      skipped.push({ id: row.id, reason: "OBJECT_MISSING" });
      console.log(`  skip ${label}: object no longer in the bucket`);
      continue;
    }

    const [original] = await file.download();
    const mime = sniffMime(original);
    if (!mime) {
      // Not fatal to the row — it stays on file_url — but worth knowing about.
      skipped.push({ id: row.id, reason: "UNRECOGNISED_CONTENT" });
      console.log(`  skip ${label}: content is not JPEG/PNG/WebP/PDF`);
      continue;
    }

    const cleaned = stripImageMetadata(original, mime);
    if (cleaned.length !== original.length) strippedBytes += original.length - cleaned.length;
    const sha256 = createHash("sha256").update(cleaned).digest("hex");

    if (!APPLY) {
      console.log(
        `  would migrate ${label}: ${mime}, ${original.length}B` +
          (cleaned.length !== original.length ? ` → ${cleaned.length}B after metadata strip` : "")
      );
      migrated.push({ id: row.id, storagePath: "(dry-run)" });
      continue;
    }

    const dataUri = `data:${mime};base64,${cleaned.toString("base64")}`;
    const stored = await uploadPrivateFileToStorage(
      `provider-compliance/${row.worker_uid}`,
      `backfill-${row.id}`,
      dataUri
    );

    // Re-assert storage_path IS NULL so a concurrent upload for the same row
    // wins rather than being silently overwritten by this backfill.
    const updated = await dbQuery.query(
      `UPDATE ${s}.worker_requirements
          SET storage_path = $1, mime_type = COALESCE(mime_type, $2),
              byte_size = COALESCE(byte_size, $3), content_sha256 = COALESCE(content_sha256, $4),
              updated_at = NOW()
        WHERE id = $5 AND storage_path IS NULL
        RETURNING id`,
      [stored.storagePath, mime, cleaned.length, sha256, row.id]
    );

    if (!updated.rowCount) {
      skipped.push({ id: row.id, reason: "RACED_CONCURRENT_UPLOAD" });
      console.log(`  skip ${label}: row gained a storage_path mid-run; leaving it alone`);
      continue;
    }

    migrated.push({ id: row.id, storagePath: stored.storagePath });
    console.log(`  migrated ${label}: ${mime}, ${cleaned.length}B`);
  }

  console.log(`\n── summary ──────────────────────────────────────────`);
  console.log(`  migrated : ${migrated.length}`);
  console.log(`  skipped  : ${skipped.length}`);
  for (const reason of new Set(skipped.map((x) => x.reason))) {
    console.log(`      ${reason}: ${skipped.filter((x) => x.reason === reason).length}`);
  }
  if (strippedBytes > 0) console.log(`  EXIF/metadata removed: ${strippedBytes} bytes total`);

  if (APPLY && migrated.length) {
    // Rollback manifest. `file_url` was never touched, so nulling storage_path
    // returns every row to exactly today's behaviour; the listed objects can
    // then be deleted.
    const manifest = join(__dirname, `backfill-document-private-storage.rollback.json`);
    writeFileSync(
      manifest,
      JSON.stringify(
        {
          note: "Rollback: UPDATE servana.worker_requirements SET storage_path=NULL WHERE id = ANY(ids); then delete privateObjects from the bucket. file_url was never modified.",
          ids: migrated.map((m) => m.id),
          privateObjects: migrated.map((m) => m.storagePath),
        },
        null,
        2
      )
    );
    console.log(`\n  rollback manifest: ${manifest}`);
  }

  if (!APPLY) console.log(`\nRe-run with --apply to perform the migration.`);
}

// Only when run as a script. The parsing helpers above are imported by tests,
// and without this guard that import would connect to the database and start
// migrating production documents as a side effect of running the suite.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("backfill failed:", error?.message ?? error);
      process.exit(1);
    });
}
