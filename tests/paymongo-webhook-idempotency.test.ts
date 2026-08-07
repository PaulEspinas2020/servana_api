/**
 * One PayMongo event must produce exactly one payment record.
 *
 * Command 20 §31 (F-08). Servana uses PayMongo for the actual money and this
 * database purely as the RECORD, which changes what "duplicate" costs: a
 * duplicated payment row is not a cosmetic bug, it is the record disagreeing
 * with the processor — and it flows straight into disbursements, earnings and
 * the provider ledger.
 *
 * `processWebhook` deduplicated by SELECTing on `webhook_event_id` and
 * returning early. That is check-then-act: PayMongo retries webhooks, and a
 * retry overlapping the original means both requests run the SELECT before
 * either INSERTs, so both proceed.
 *
 * The unique index is the actual guarantee. These assertions pin it, and pin
 * the retry semantics around it — answering the wrong status code to a payment
 * processor either loses events or repeats them forever.
 */
import * as fs from "fs";
import * as path from "path";

const read = (rel: string) =>
  fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

/** Comments stripped, so prose describing the fix cannot satisfy a check. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const service = code("src/services/paymentService.ts");
const controller = code("src/controllers/paymentController.ts");

describe("uniqueness is enforced by the database, not by a SELECT", () => {
  it("creates a unique index on webhook_event_id", () => {
    expect(service).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS/);
    expect(service).toMatch(/idx_payments_webhook_event_id/);
    expect(service).toMatch(/\(webhook_event_id\)/);
  });

  it("the index is partial, so historical NULLs do not collide", () => {
    // Several NULLs are not a uniqueness conflict in Postgres, but being
    // explicit documents that rows predating webhook capture are expected.
    expect(service).toMatch(/WHERE webhook_event_id IS NOT NULL/);
  });

  it("the index is ensured BEFORE the dedupe SELECT runs", () => {
    const ensureAt = service.indexOf("ensureWebhookEventUniqueness()");
    const selectAt = service.indexOf("WHERE webhook_event_id = $1");
    expect(ensureAt).toBeGreaterThan(-1);
    expect(selectAt).toBeGreaterThan(-1);
    expect(ensureAt).toBeLessThan(selectAt);
  });

  it("the cheap SELECT path is kept as well", () => {
    // Belt and braces: avoid doing the work before failing on the constraint.
    expect(service).toMatch(/WHERE webhook_event_id = \$1/);
  });

  it("a failed index creation is retryable, not cached as broken", () => {
    expect(service).toMatch(/webhookIndexReady = null/);
  });
});

describe("retry semantics tell PayMongo the right thing", () => {
  it("a duplicate (23505) answers 200, not an error", () => {
    // Answering non-2xx would make PayMongo retry an event that is already
    // recorded, forever.
    expect(controller).toMatch(/23505/);
    expect(controller).toMatch(/duplicate:\s*true/);
  });

  it("a bad signature stays 401 — permanent, stop retrying", () => {
    expect(controller).toMatch(/isSignatureError/);
    expect(controller).toMatch(/status\(401\)/);
  });

  it("a malformed payload is 400 — also permanent", () => {
    expect(controller).toMatch(/isMalformed/);
    expect(controller).toMatch(/400/);
  });

  it("anything else is 500, so a real event IS retried", () => {
    // Losing a genuine payment event is worse than processing it late.
    expect(controller).toMatch(/500/);
  });
});

describe("the signature check is still the gate", () => {
  it("verifies an HMAC over the RAW body", () => {
    expect(service).toMatch(/createHmac\("sha256"/);
    expect(service).toMatch(/rawBody/);
  });

  it("compares in constant time", () => {
    // A non-constant-time compare leaks the expected signature byte by byte.
    expect(service).toMatch(/timingSafeEqual/);
  });

  it("rejects a request with no signature header at all", () => {
    expect(service).toMatch(/Missing signature header/);
  });

  it("the secret comes from the environment, never a literal", () => {
    expect(service).toMatch(/process\.env\.PAYMONGO_WEBHOOK_SECRET/);
    // A hex-looking literal next to the HMAC would be a committed secret.
    const hmacRegion = service.slice(
      Math.max(0, service.indexOf("createHmac") - 400),
      service.indexOf("createHmac") + 200
    );
    expect(hmacRegion).not.toMatch(/["'][0-9a-f]{32,}["']/i);
  });
});
