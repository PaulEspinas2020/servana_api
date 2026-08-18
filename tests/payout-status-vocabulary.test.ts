/**
 * One canonical payout status, three preserved dialects.
 *
 * Command 20 §1 (F-03), carried from C17-02. Three hand-written functions read
 * the SAME `disbursements.status` column and answered three different words:
 *
 *   normalizePayoutStatus  →  disbursed / failed_or_on_hold / pending / processing
 *   _mapPayoutStatus       →  paid      / failed            / pending
 *   getLedger              →  settled   / failed            / pending
 *
 * The third is mine: the F-01 fix had to stop the ledger hardcoding `settled`,
 * and introduced `settled` as a value doing it.
 *
 * The dialects are DELIBERATELY unchanged. Five surfaces consume them, and
 * renaming a value silently changes what a provider is told about their own
 * money. What changed is that all three now derive from one canonical value, so
 * they cannot drift apart again.
 *
 * The first group below is therefore the important one: it pins each dialect
 * against the ORIGINAL implementation, copied verbatim from git history. If a
 * future edit "tidies" a dialect, these fail.
 */
import {
  canonicalPayoutStatus,
  earningsPayoutDialect,
  payoutsPayoutDialect,
  ledgerPayoutDialect,
  PayoutStatus,
} from "../src/services/payoutStatus";

/**
 * The three functions exactly as they stood at a78b15d, before F-03. Not
 * imported — copied — so the comparison survives the originals being deleted.
 */
const ORIGINAL_normalizePayoutStatus = (raw: string | null | undefined): string => {
  if (!raw) return "pending";
  const s = raw.toLowerCase();
  if (s === "released") return "disbursed";
  if (s === "failed") return "failed_or_on_hold";
  return s;
};

const ORIGINAL_mapPayoutStatus = (raw: string): string => {
  const s = (raw || "").toUpperCase();
  if (s === "RELEASED") return "paid";
  if (s === "FAILED") return "failed";
  if (s === "PROCESSING") return "pending";
  return "pending";
};

const ORIGINAL_ledger = (raw: any): string => {
  const payoutStatus = String(raw ?? "").toUpperCase();
  return payoutStatus === "RELEASED"
    ? "settled"
    : payoutStatus === "FAILED"
      ? "failed"
      : "pending";
};

/**
 * Every value `disbursements.status` can hold, plus the shapes a row can
 * actually arrive in: no row at all (null), and a value nobody planned for.
 */
const INPUTS = [
  "PENDING",
  "PROCESSING",
  "RELEASED",
  "FAILED",
  "pending",
  "released",
  null,
  undefined,
  "",
  "SOMETHING_NEW",
];

describe("no dialect changed — this is what protects the other platforms", () => {
  it.each(INPUTS)("earnings dialect matches the original for %p", (raw) => {
    expect(earningsPayoutDialect(raw as any)).toBe(
      ORIGINAL_normalizePayoutStatus(raw as any)
    );
  });

  it.each(INPUTS)("payouts dialect matches the original for %p", (raw) => {
    expect(payoutsPayoutDialect(raw as any)).toBe(ORIGINAL_mapPayoutStatus(raw as any));
  });

  it.each(INPUTS)("ledger dialect matches the original for %p", (raw) => {
    expect(ledgerPayoutDialect(raw as any)).toBe(ORIGINAL_ledger(raw));
  });

  it("still emits the literals other platforms branch on", () => {
    // Servana.com.ph's provider-payout-status.mapper branches on 'disbursed'
    // and 'failed_or_on_hold'; ServanaWorker's dashboard store on the same two.
    // A rename here is a silent behaviour change on two live money screens.
    expect(earningsPayoutDialect("RELEASED")).toBe("disbursed");
    expect(earningsPayoutDialect("FAILED")).toBe("failed_or_on_hold");
    expect(payoutsPayoutDialect("RELEASED")).toBe("paid");
    expect(ledgerPayoutDialect("RELEASED")).toBe("settled");
  });
});

describe("the canonical value keeps what the dialects lose", () => {
  it("distinguishes PROCESSING from PENDING — §1", () => {
    // Two of the three dialects collapse these, so a payout actively being
    // released looks identical to one that has not started.
    expect(payoutsPayoutDialect("PROCESSING")).toBe(payoutsPayoutDialect("PENDING"));
    expect(ledgerPayoutDialect("PROCESSING")).toBe(ledgerPayoutDialect("PENDING"));

    expect(canonicalPayoutStatus("PROCESSING")).toBe("processing");
    expect(canonicalPayoutStatus("PENDING")).toBe("pending");
  });

  it("maps the whole disbursement vocabulary", () => {
    expect(canonicalPayoutStatus("PENDING")).toBe("pending");
    expect(canonicalPayoutStatus("PROCESSING")).toBe("processing");
    expect(canonicalPayoutStatus("RELEASED")).toBe("paid");
    expect(canonicalPayoutStatus("FAILED")).toBe("failed");
  });

  it("is case- and whitespace-insensitive", () => {
    for (const v of ["released", "Released", " RELEASED ", "rElEaSeD"]) {
      expect(canonicalPayoutStatus(v)).toBe("paid");
    }
  });

  it("no disbursement row is pending, not unknown", () => {
    // A completed booking with nothing calculated yet is genuinely awaiting
    // payout. Calling it unknown would put a warning on an ordinary state.
    expect(canonicalPayoutStatus(null)).toBe("pending");
    expect(canonicalPayoutStatus(undefined)).toBe("pending");
    expect(canonicalPayoutStatus("")).toBe("pending");
    expect(canonicalPayoutStatus("   ")).toBe("pending");
  });

  it("an unrecognised value is unknown, never silently paid", () => {
    // The failure that matters: a new DB status defaulting to a settled-looking
    // value would tell a provider money arrived when nothing is known about it.
    for (const v of ["ON_HOLD", "REVERSED", "garbage", 42, {}]) {
      const c = canonicalPayoutStatus(v);
      expect(c).toBe("unknown");
      expect(c).not.toBe("paid");
    }
  });

  it("never invents a state the data cannot record", () => {
    // §1 also names available, held, reversed and disputed. disbursements.status
    // is only PENDING/PROCESSING/RELEASED/FAILED, so this module must not claim
    // to distinguish them — holds and disputes live in booking_escalations.
    const produced = new Set<PayoutStatus>(
      INPUTS.map((v) => canonicalPayoutStatus(v as any))
    );
    for (const invented of ["available", "held", "reversed", "disputed"]) {
      expect(produced.has(invented as PayoutStatus)).toBe(false);
    }
  });
});

describe("the controller has one source, not three", () => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src/controllers/providerController.ts"),
    "utf8"
  );
  /** Comments stripped, so prose describing the fix cannot satisfy a check. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("no longer hand-writes any of the three mappings", () => {
    // The literal each dialect used to be written with, inline in the handler.
    expect(code).not.toMatch(/if \(s === "released"\) return "disbursed"/);
    expect(code).not.toMatch(/if \(s === "RELEASED"\)\s+return "paid"/);
    expect(code).not.toMatch(/payoutStatus === "RELEASED" \? "settled"/);
  });

  it("every payout status decision goes through payoutStatus.ts", () => {
    expect(code).toMatch(/from '\.\.\/services\/payoutStatus'/);
    // No handler may compare against a raw disbursement status itself — that is
    // how a fourth dialect starts.
    const comparisons = code.match(/=== ?"(RELEASED|PROCESSING)"/g) ?? [];
    expect(comparisons).toHaveLength(0);
  });

  it("all four payout-bearing responses report the canonical value", () => {
    /**
     * TAB 07 moved two of the four into the canonical earnings DTO, so counting
     * occurrences in the controller alone would now under-report. The claim is
     * about the RESPONSES, not about one file: /provider/earnings and
     * /provider/earnings/:id project the shared transaction DTO, while
     * /provider/ledger and /provider/payouts still map in the controller.
     */
    const earnings = fs.readFileSync(
      path.join(__dirname, "..", "src/services/finance/providerEarningsService.ts"),
      "utf8"
    );
    // Declared on the DTO and populated from the one canonical source.
    expect(earnings).toMatch(/payoutStatusCanonical: PayoutStatus/);
    expect(earnings).toMatch(/payoutStatusCanonical: canonicalPayoutStatus/);

    const inController = code.match(/payoutStatusCanonical:/g) ?? [];
    expect(inController.length).toBe(2);
  });
});
