import fs from "fs";
import path from "path";

const read = (file: string) => fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8");

describe("PayMongo payout and retry boundaries", () => {
  test("disbursements share the checkout/refund secret-key contract", () => {
    const source = read("services/disbursement.service.ts");
    expect(source).toContain("process.env.PAYMONGO_SECRET_KEY || process.env.PAYMONGO_SK_DEV");
    expect(source).toContain('throw new Error("PayMongo is not configured")');
    expect(source).not.toContain("process.env.PAYMONGO_SK ||");
  });

  test("a processor response needs both an id and a succeeded status before release", () => {
    const source = read("services/disbursement.service.ts");
    const validation = source.indexOf('if (!payoutId || typeof payoutId !== "string")');
    const statusValidation = source.indexOf("PAYOUT_SUCCEEDED_STATUSES.has(processorStatus)");
    const release = source.indexOf("SET status             = 'RELEASED'");
    expect(validation).toBeGreaterThan(-1);
    expect(statusValidation).toBeGreaterThan(validation);
    expect(release).toBeGreaterThan(validation);
    expect(release).toBeGreaterThan(statusValidation);
  });

  test("payout creation is idempotent and ambiguous outcomes are not retryable", () => {
    const source = read("services/disbursement.service.ts");
    expect(source).toContain('"Idempotency-Key": `servana-disbursement-${disbursement.id}-attempt-${attempt}`');
    expect(source).toContain("timeout: PAYMONGO_TIMEOUT_MS");
    expect(source).toContain("PAYOUT_RECONCILIATION_REQUIRED");
    expect(source).toContain("&& ![408, 409, 425, 429].includes(status)");
    expect(source).not.toContain("err?.response?.data?.errors?.[0]?.detail");
  });

  test("automated payout retries only reset confirmed failed completed work", () => {
    const source = read("services/disbursement.service.ts");
    expect(source).toContain("AND bw.status = 'COMPLETED'");
    expect(source).toContain("WHERE id = $1 AND status = 'FAILED' RETURNING id");
    expect(source).toContain("payout_attempt = COALESCE(payout_attempt, 0) + 1");
    expect(source).toContain("WHERE id = $1 AND status = 'PENDING'");
    expect(source).toContain("RETURNING id, payout_attempt");
  });

  test("the controlled migration provisions payout attempt sequencing", () => {
    const migration = fs.readFileSync(
      path.join(__dirname, "..", "scripts", "migrations", "017-paymongo-transaction-integrity.sql"),
      "utf8"
    );
    expect(migration).toContain("ALTER TABLE servana.disbursements");
    expect(migration).toContain("payout_attempt INTEGER NOT NULL DEFAULT 0");
  });

  test("checkout retry never turns a failed URL into a recent pending URL", () => {
    const source = read("scheduler.ts");
    const retry = source.slice(source.indexOf('const runPaymentRetries'), source.indexOf('const runConversationGraceSweep'));
    expect(retry).toContain('createCheckoutSession(row.booking_id)');
    expect(retry).not.toContain("SET status = 'PENDING'");
    expect(retry).not.toContain("WHERE id = $1 AND status = 'PENDING'");
  });

  test("additional-work checkout is state guarded and reuses a recent link", () => {
    const source = read("services/additional.service.ts");
    expect(source).toContain('request.status !== "WAITING_FOR_PAYMENT"');
    expect(source).toContain("additional_request_id = $1 AND provider = 'PAYMONGO' AND status = 'PENDING'");
    expect(source).toContain("updated_at > NOW() - INTERVAL '2 hours'");
  });

  test("bank-account endpoints never return the full account row", () => {
    const source = read("controllers/technicianController.ts");
    expect(source).toContain("maskedAccountNumber");
    expect(source).not.toContain('data: toCamel(account)');
  });

  test("provider payout responses replace PayMongo ids with safe Servana references", () => {
    const source = read("controllers/providerController.ts");
    const start = source.indexOf("export const getPayouts");
    const end = source.indexOf("// ─── Review Status", start);
    const payoutResponse = source.slice(start, end);
    expect(payoutResponse).toContain('`SVP-${String(r.id).padStart(6, "0")}`');
    expect(payoutResponse).not.toContain("r.paymongo_payout_id");
  });
});
