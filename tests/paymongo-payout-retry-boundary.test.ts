import fs from "fs";
import path from "path";

const read = (file: string) => fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8");

describe("PayMongo payout and retry boundaries", () => {
  test("disbursements share the checkout/refund secret-key contract", () => {
    /**
     * This asserted that the literal expression
     * `process.env.PAYMONGO_SECRET_KEY || process.env.PAYMONGO_SK_DEV` appeared
     * in the payout file, because a separate PAYMONGO_SK variable had once made
     * payouts silently run in a different mode from checkout.
     *
     * The contract is now STRUCTURAL rather than textual: all three money
     * services resolve the key through `finance/paymongoClient`, so they cannot
     * drift apart by editing one file. Asserting the shared resolver — and that
     * nothing reads the environment directly — is what the original text check
     * was standing in for.
     */
    const client = read("services/finance/paymongoClient.ts");
    expect(client).toContain("process.env.PAYMONGO_SECRET_KEY || process.env.PAYMONGO_SK_DEV");
    expect(client).not.toContain("process.env.PAYMONGO_SK ||");

    for (const file of [
      "services/disbursement.service.ts",
      "services/paymentService.ts",
      "services/refund.service.ts",
    ]) {
      const source = read(file);
      expect(source).toContain("paymongoBasicAuth");
      // No second SECRET-KEY contract may reappear in any of the three.
      // Scoped to the key vars deliberately: paymentService legitimately reads
      // PAYMONGO_RETURN_URL, PAYMONGO_WEBHOOK_SECRET and PAYMONGO_EXPECT_LIVE_MODE,
      // which are different settings and not part of this contract.
      expect(source).not.toContain("PAYMONGO_SECRET_KEY");
      expect(source).not.toContain("PAYMONGO_SK_DEV");
    }
  });

  test("each capability keeps its OWN error contract", () => {
    /**
     * The three are deliberately NOT merged. A shared throw would have changed
     * what a customer sees when checkout is down, and what a failed payout or an
     * ambiguous refund records.
     *
     * paymentService   typed 503 reaching a customer mid-checkout
     * disbursement     plain Error, recorded as a payout failure reason
     * refund           plain Error, must NOT mark the refund rejected
     */
    expect(read("services/paymentService.ts")).toContain(
      'throw paymentError("Online payment is temporarily unavailable", "PAYMONGO_NOT_CONFIGURED", 503)',
    );
    expect(read("services/disbursement.service.ts")).toContain(
      'throw new Error("PayMongo is not configured")',
    );
    expect(read("services/refund.service.ts")).toContain(
      'throw new Error("PayMongo is not configured")',
    );

    // The shared transport must not throw on its own — it returns null so each
    // caller can keep the error its callers already handle.
    const client = read("services/finance/paymongoClient.ts");
    expect(client).not.toMatch(/^\s*(throw|  throw) /m);
  });

  test("payment, refund and disbursement remain SEPARATE capabilities", () => {
    /**
     * Centralizing the transport must not become merging the domains. A refund is
     * irreversible, a payout moves money to a third party, and a checkout is
     * customer-initiated — three risk profiles that should not share a blast
     * radius. Each keeps its own service file and its own entry points.
     */
    const fs2 = require("fs");
    const path2 = require("path");
    for (const file of [
      "services/paymentService.ts",
      "services/refund.service.ts",
      "services/disbursement.service.ts",
    ]) {
      expect(fs2.existsSync(path2.join(__dirname, "..", "src", file))).toBe(true);
    }
    // The v1 surface reuses the payment implementation rather than forking it.
    const v1 = read("services/finance/bookingPaymentService.ts");
    expect(v1).toContain("from '../paymentService'");
    expect(v1).not.toContain("api.paymongo.com");
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
    // TAB 07 moved the payout projection into the canonical domain service, so
    // BOTH /api/provider/payouts and /api/v1/provider/earnings/payouts build the
    // reference the same way. The guarantee is now made in one place instead of
    // being repeated per endpoint.
    const source = read("services/finance/providerEarningsService.ts");
    expect(source).toMatch(/SVP-\$\{String\(id\)\.padStart\(6, '0'\)\}/);
    expect(source).not.toContain("paymongo_payout_id");

    // And the controller still emits it, rather than having quietly dropped the
    // field while delegating.
    const controller = read("controllers/providerController.ts");
    const start = controller.indexOf("export const getPayouts");
    const end = controller.indexOf("// ─── Review Status", start);
    expect(controller.slice(start, end)).toContain("reference: p.reference");
  });
});
