/**
 * The provider ledger must not call unpaid money settled.
 *
 * Command 20 §1 (F-01). `/provider/ledger` queried `bookings`, never joined
 * `disbursements`, and hardcoded `status: "settled"` on every completed
 * booking while recomputing the amount from `final_price`.
 *
 * `/provider/earnings/summary` reads the same money correctly — RELEASED
 * disbursements as paid, PENDING/FAILED/absent as pending — so the two
 * endpoints disagreed about one booking, and a payout that had FAILED was
 * reported to the provider as settled.
 *
 * §1: "Pending, available, held, processing, paid, reversed, and disputed
 * values must remain distinct."
 *
 * These assertions cover the mapping directly. The SQL join is verified by
 * source inspection, because a query cannot run without a database here.
 */
import * as fs from "fs";
import * as path from "path";

const src = fs.readFileSync(
  path.join(__dirname, "..", "src/controllers/providerController.ts"),
  "utf8"
);

/** The getLedger body only, so assertions cannot match a neighbouring handler. */
const ledger = src.slice(
  src.indexOf("export const getLedger = async"),
  src.indexOf("export const getPayouts = async")
);

/** Comments stripped, so prose describing the fix cannot satisfy a check. */
const code = ledger
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");

describe("the ledger reads the actual disbursement", () => {
  it("joins disbursements, scoped to the calling provider", () => {
    expect(code).toMatch(/LEFT JOIN \$\{dbSchema\}\.disbursements/);
    // Scoped by worker_uid as well as booking, or one provider's row could
    // attach to another's booking.
    expect(code).toMatch(/d\.worker_uid = \$1/);
  });

  it("selects the payout status and the disbursed amount", () => {
    expect(code).toMatch(/d\.status\s+AS payout_status/);
    expect(code).toMatch(/d\.worker_share/);
  });

  it("no longer hardcodes settled", () => {
    expect(code).not.toMatch(/status:\s*"settled"/);
  });
});

describe("status distinguishes the states §1 requires", () => {
  it("only a RELEASED disbursement is settled", () => {
    expect(code).toMatch(/RELEASED.*settled/s);
  });

  it("a FAILED payout is reported as failed, not settled", () => {
    // The sharpest case: money that failed to pay out was shown as settled.
    expect(code).toMatch(/FAILED.*failed/s);
  });

  it("anything else falls back to pending, not settled", () => {
    expect(code).toMatch(/:\s*"pending"/);
  });
});

describe("estimates are labelled", () => {
  it("marks a row with no disbursement as an estimate", () => {
    // final_price x rate is a projection, not a settled figure (§9).
    expect(code).toMatch(/isEstimate/);
  });

  it("prefers the authoritative worker_share when it exists", () => {
    expect(code).toMatch(/hasDisbursement/);
    expect(code).toMatch(/Number\(r\.worker_share\)/);
  });
});

describe("settledAt reflects settlement, not scheduling", () => {
  it("uses released_at rather than the booking schedule", () => {
    // settledAt: r.schedule claimed the money settled when the job was booked.
    expect(code).toMatch(/released_at/);
    expect(code).not.toMatch(/settledAt:\s*r\.schedule/);
  });

  it("is null unless the payout actually released", () => {
    expect(code).toMatch(/RELEASED.*released_at.*:\s*null/s);
  });
});

describe("the response still carries an explicit currency", () => {
  it("PHP, and never a dollar symbol", () => {
    expect(code).toMatch(/currency:\s*"PHP"/);
    expect(ledger).not.toContain("$" + "{'$'}");
    expect(code).not.toMatch(/["'`]\$\d/);
  });
});
