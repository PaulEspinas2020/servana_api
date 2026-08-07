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

  test("a processor response without a payout id is never marked released", () => {
    const source = read("services/disbursement.service.ts");
    const validation = source.indexOf('if (!payoutId || typeof payoutId !== "string")');
    const release = source.indexOf("SET status             = 'RELEASED'");
    expect(validation).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(validation);
  });

  test("automated payout retries only claim failed completed work", () => {
    const source = read("services/disbursement.service.ts");
    expect(source).toContain("AND bw.status = 'COMPLETED'");
    expect(source).toContain("WHERE id = $1 AND status = 'FAILED' RETURNING id");
  });

  test("checkout retry restores FAILED after a processor error", () => {
    const source = read("scheduler.ts");
    expect(source).toContain("WHERE id = $1 AND status = 'FAILED' RETURNING id");
    expect(source).toContain("WHERE id = $1 AND status = 'PENDING'");
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
});
