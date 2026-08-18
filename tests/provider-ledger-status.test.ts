/**
 * The provider ledger must not call unpaid money settled.
 *
 * Command 20 §1 (F-01). `/provider/ledger` queried `bookings`, never joined
 * `disbursements`, and hardcoded `status: "settled"` on every completed
 * booking while recomputing the amount from `final_price`.
 *
 * `/provider/earnings/summary` read the same money differently, so the two
 * endpoints disagreed about one booking and a payout that had FAILED was
 * reported to the provider as settled.
 *
 * CORRECTION (C20 F-04): this header originally said the summary "reads the
 * same money correctly". It did not. It also folded FAILED into pending, lost
 * PROCESSING entirely, and recomputed from `final_price` — see
 * provider-earnings-summary.test.ts. The ledger was the worse of the two, not
 * the only wrong one.
 *
 * §1: "Pending, available, held, processing, paid, reversed, and disputed
 * values must remain distinct."
 *
 * These assertions cover the mapping directly. The SQL join is verified by
 * source inspection, because a query cannot run without a database here.
 */
import * as fs from "fs";
import * as path from "path";
import { ledgerPayoutDialect, canonicalPayoutStatus } from "../src/services/payoutStatus";

/**
 * TAB 07 moved the QUERY out of the controller.
 *
 * `getLedger` no longer holds SQL: it projects from
 * `services/finance/providerEarningsService`, which reads the one shared SELECT
 * in `financeLedger.bookingFinanceSelect`. The guarantees below are unchanged —
 * the disbursement must still be joined and scoped to the calling provider, and
 * the status must still not be hardcoded — so the assertions follow the code to
 * its new home rather than being deleted with it.
 */
const src = fs.readFileSync(
  path.join(__dirname, "..", "src/services/finance/financeLedger.ts"),
  "utf8"
);

/** The shared SELECT only, so assertions cannot match a neighbouring helper. */
const ledger = src.slice(
  src.indexOf("export const bookingFinanceSelect"),
  src.indexOf("export const toBookingFinanceRow")
);

/** The controller body, for the assertions that are about the PROJECTION. */
const controller = (() => {
  const whole = fs.readFileSync(
    path.join(__dirname, "..", "src/controllers/providerController.ts"),
    "utf8",
  );
  return whole.slice(
    whole.indexOf("export const getLedger = async"),
    whole.indexOf("export const getPayouts = async"),
  );
})();

/** Comments stripped, so prose describing the fix cannot satisfy a check. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** The shared SELECT — the assertions about the QUERY. */
const code = strip(ledger);

/** The ledger handler — the assertions about the PROJECTION. */
const projection = strip(controller);

/** The canonical earnings DTO, which the projection now reads its fields from. */
const earningsService = strip(
  fs.readFileSync(
    path.join(__dirname, "..", "src/services/finance/providerEarningsService.ts"),
    "utf8",
  ),
);

describe("the ledger reads the actual disbursement", () => {
  it("joins disbursements, scoped to the calling provider", () => {
    expect(code).toMatch(/LEFT JOIN \$\{schema\}\.disbursements/);
    // Scoped by the provider parameter as well as by booking, or one provider's
    // row could attach to another's booking.
    expect(code).toMatch(/d\.worker_uid = \$\{providerParam/);
  });

  it("selects the payout status and the disbursed amount", () => {
    expect(code).toMatch(/d\.status\s+AS payout_status/);
    expect(code).toMatch(/d\.worker_share/);
  });

  it("no longer hardcodes settled", () => {
    expect(controller).not.toMatch(/status:\s*"settled"/);
  });
});

describe("status distinguishes the states §1 requires", () => {
  // These asserted the literal strings inline in the handler and broke when
  // C20 F-03 moved the mapping into `payoutStatus.ts` — a source-shape check
  // failing on an improvement, which is the argument for asserting behaviour.
  // The ledger's mapping is now called directly.

  it("only a RELEASED disbursement is settled", () => {
    expect(ledgerPayoutDialect("RELEASED")).toBe("settled");
    for (const other of ["PENDING", "PROCESSING", "FAILED", null, "ANYTHING"]) {
      expect(ledgerPayoutDialect(other as any)).not.toBe("settled");
    }
  });

  it("a FAILED payout is reported as failed, not settled", () => {
    // The sharpest case: money that failed to pay out was shown as settled.
    expect(ledgerPayoutDialect("FAILED")).toBe("failed");
  });

  it("anything else falls back to pending, not settled", () => {
    expect(ledgerPayoutDialect("PENDING")).toBe("pending");
    expect(ledgerPayoutDialect("PROCESSING")).toBe("pending");
    expect(ledgerPayoutDialect(null)).toBe("pending");
    // An unrecognised status must never read as money that arrived.
    expect(ledgerPayoutDialect("SOMETHING_NEW")).toBe("pending");
  });

  it("the ledger takes its mapping from the one canonical source", () => {
    // TAB 07: the handler now receives an already-canonical PayoutStatus from
    // the domain service, so it maps with `ledgerDialectOf` rather than
    // re-deriving from the raw column. Same single source, one conversion fewer.
    expect(projection).toMatch(/ledgerDialectOf\(t\.payoutStatusCanonical\)/);
    // A second hand-written comparison here is how the third dialect started.
    expect(projection).not.toMatch(/=== ?"RELEASED"/);
  });
});

describe("estimates are labelled", () => {
  it("marks a row with no disbursement as an estimate", () => {
    // final_price x rate is a projection, not a settled figure (§9). The flag is
    // now carried on the canonical DTO, so every earnings surface inherits it
    // instead of the ledger being the only one that labelled anything.
    expect(projection).toMatch(/isEstimate: t\.isEstimate/);
    expect(earningsService).toMatch(/isEstimate: boolean/);
  });

  it("prefers the authoritative worker_share when it exists", () => {
    // The preference itself moved into the one calculator.
    const calculator = strip(
      fs.readFileSync(
        path.join(__dirname, "..", "src/services/finance/financeLedger.ts"),
        "utf8",
      ),
    );
    expect(calculator).toMatch(/recordedShare\s*\?\?\s*derived\.providerPayable/);
    expect(calculator).toMatch(/row\.workerShare != null/);
  });
});

describe("settledAt reflects settlement, not scheduling", () => {
  it("uses released_at rather than the booking schedule", () => {
    // settledAt: r.schedule claimed the money settled when the job was booked.
    expect(code).toMatch(/released_at/);
    expect(code).not.toMatch(/settledAt:\s*r\.schedule/);
  });

  it("is null unless the payout actually released", () => {
    // settledAt is gated on the canonical value being `paid`, which only
    // RELEASED produces — verified here rather than by matching source text.
    expect(projection).toMatch(/t\.payoutStatusCanonical === "paid"/);
    expect(canonicalPayoutStatus("RELEASED")).toBe("paid");
    for (const other of ["PENDING", "PROCESSING", "FAILED", null]) {
      expect(canonicalPayoutStatus(other)).not.toBe("paid");
    }
  });
});

describe("the response still carries an explicit currency", () => {
  it("PHP, and never a dollar symbol", () => {
    // Carried on the canonical DTO now, so every finance surface states it.
    expect(projection).toMatch(/currency: t\.currency/);
    expect(ledger).not.toContain("$" + "{'$'}");
    expect(code).not.toMatch(/["'`]\$\d/);
  });
});
