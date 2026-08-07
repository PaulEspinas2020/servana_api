import fs from "fs";
import path from "path";

const service = fs.readFileSync(
  path.join(__dirname, "../src/services/technicianService.ts"),
  "utf8",
);

describe("cash completion guard", () => {
  it("makes payment eligibility part of the completion update", () => {
    const complete = service.slice(service.indexOf("export const completeJob"));
    expect(complete).toMatch(/UPDATE \$\{dbSchema\}\.booking_workers bw/);
    expect(complete).toMatch(/EXISTS \([\s\S]*payments p[\s\S]*p\.method[\s\S]*p\.status/);
    expect(complete).toContain("<> 'CASH'");
    expect(complete).toContain("= 'PAID'");
  });

  it("uses a stable error code for unpaid cash", () => {
    expect(service).toContain('readonly code = "CASH_PAYMENT_REQUIRED"');
    expect(service).toContain("throw new UnpaidCashBookingError()");
  });
});
