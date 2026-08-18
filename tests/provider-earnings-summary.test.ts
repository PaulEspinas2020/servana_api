/**
 * The earnings summary must not misreport a provider's own money.
 *
 * Command 20 §9 (F-04). Filed as "estimated earnings presented as pending" —
 * a labelling problem. Reading the query proved three arithmetic defects
 * underneath it, all the same shape: money that had already been calculated
 * authoritatively was recomputed from `final_price` instead of being read.
 *
 *   1. ON-SITE UPSELL REVENUE WAS DROPPED. `createDisbursement` computes the
 *      split from `final_price + additional_paid`, and its own comment records
 *      fixing exactly this bug at the writer — "additional work contributed
 *      exactly 0 to provider pay while both frontends told the provider they
 *      would receive 80% of it". The fix never reached this reader.
 *
 *   2. PROCESSING MONEY VANISHED. `total_paid` counted RELEASED only;
 *      `total_pending` counted PENDING/FAILED/no-row. A disbursement being
 *      released is PROCESSING, so it left "pending" without arriving in
 *      "paid" — the provider watched the amount disappear.
 *
 *   3. FAILED WAS COUNTED AS PENDING. That is F-01 in a second endpoint: a
 *      payout needing intervention, shown as one that is on its way.
 *
 * These run the real handler against a mocked pool, so they assert the
 * arithmetic rather than the presence of a string.
 *
 * ## What TAB 07 changed here
 *
 * The three defects were all consequences of the summary having its OWN
 * aggregate SQL — a second implementation beside the transaction list, free to
 * bucket the same rows differently. TAB 07 deleted that query: the summary is
 * now totalled from the same per-booking calculator the list projects from, so
 * the two cannot disagree by construction.
 *
 * The fixtures therefore feed BOOKING ROWS rather than a pre-aggregated row, and
 * the assertions that used to scan the SQL for its CASE arms now assert the
 * bucketing behaviourally — which is what the docblock above always said this
 * suite was for. Every named defect is still covered; none of the numbers moved.
 */
jest.mock("../src/db/dbQuery", () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
jest.mock("../src/config", () => ({
  __esModule: true,
  db: { schema: "test" },
  firebaseConfig: { storageBucket: "test-bucket" },
  mongoConfig: { db: "test" },
  isProduction: false,
}));
// providerController pulls in technicianService, which opens a MongoClient and
// initialises Firebase Admin at module load. Without these the suite dies on
// import before a single assertion runs. Nothing here reaches a real service —
// and the real env file must never be sourced, its unquoted `&` echoes secrets.
jest.mock("../src/db/mongodbQuery", () => ({
  __esModule: true,
  default: { collection: jest.fn() },
  mongoClient: { db: jest.fn() },
}));
jest.mock("../src/middleware/firebaseApp", () => ({
  __esModule: true,
  default: {},
  adminAuth: {},
  adminStorage: { bucket: jest.fn() },
}));
jest.mock("../src/helpers/firebaseStorageUploader", () => ({
  __esModule: true,
  uploadFileToStorage: jest.fn(),
}));
jest.mock("../src/services/firebaseFunctions.service", () => ({
  __esModule: true,
  updateFirebasePassword: jest.fn(),
  revokeTokenInFirebase: jest.fn(),
  getFirebaseUserByUid: jest.fn(),
}));

import dbQuery from "../src/db/dbQuery";
import { getEarningsSummary } from "../src/controllers/providerController";
import { PROVIDER_SHARE_RATE } from "../src/services/revenueSplit";

const query = (dbQuery as any).query as jest.Mock;

/**
 * One completed booking, as the source row the calculator reads.
 *
 * Postgres NUMERIC comes back as a STRING through `pg`, and `final_price`,
 * `worker_share` and the additional-work SUM are all NUMERIC. Feeding numbers
 * here would test a shape the database never produces — string concatenation
 * instead of addition is the failure this guards, and it is the reason every
 * money field below is stringified.
 */
type Booking = {
  id?: number;
  finalPrice?: number;
  additionalPaid?: number;
  /** null means no disbursement row yet — the estimate case. */
  workerShare?: number | null;
  payoutStatus?: string | null;
  paymentStatus?: string;
};

const bookingRow = (b: Booking = {}, index = 0) => {
  const hasDisbursement = b.workerShare !== null && b.workerShare !== undefined;
  return {
    booking_id: b.id ?? index + 1,
    booking_status: "COMPLETED",
    schedule: "2026-08-01T09:00:00.000Z",
    service_name: "Aircon Cleaning",
    final_price: String(b.finalPrice ?? 0),
    additional_paid: String(b.additionalPaid ?? 0),
    payment_id: 7,
    payment_status: b.paymentStatus ?? "PAID",
    payment_method: "PAYMONGO",
    paid_at: "2026-08-01T10:00:00.000Z",
    refunded_amount: "0.00",
    provider_uid: "worker-A",
    is_internal_fixer: false,
    assignment_completed_at: "2026-08-01T12:00:00.000Z",
    disbursement_id: hasDisbursement ? 3 + index : null,
    worker_share: hasDisbursement ? String(b.workerShare) : null,
    servana_share: null,
    payout_status: b.payoutStatus ?? null,
    released_at: null,
    hold_reason: null,
    hold_until: null,
  };
};

async function summaryFor(bookings: Booking[], q: Record<string, any> = {}) {
  query.mockResolvedValue({
    rows: bookings.map(bookingRow),
    rowCount: bookings.length,
  });
  const req: any = { user: { uid: "worker-A" }, query: q };
  let payload: any;
  const res: any = {
    status: () => res,
    json: (b: any) => {
      payload = b;
      return res;
    },
  };
  await getEarningsSummary(req, res);
  return payload.data;
}

beforeEach(() => query.mockReset());

describe("defect 1 — the authoritative amount is read, not recomputed", () => {
  it("does not recompute a recorded disbursement from final_price", async () => {
    /**
     * The disbursement holds 1,200 while 80% of the CURRENT final_price would be
     * 1,600. The recorded figure must win: recomputing it is how a provider comes
     * to be shown one number and paid another.
     *
     * This used to be asserted by scanning the SQL for a single `* 0.8` guarded
     * by `d.id IS NULL`. The fallback now lives in one calculator rather than in
     * a CASE arm, so the guarantee is asserted directly.
     */
    const d = await summaryFor([{ finalPrice: 2000, workerShare: 1200, payoutStatus: "PENDING" }]);

    expect(d.totalPending).toBe(1200);
    expect(d.totalPending).not.toBe(2000 * PROVIDER_SHARE_RATE);
    expect(d.pendingRecordedAmount).toBe(1200);
    expect(d.pendingEstimatedAmount).toBe(0);
  });

  it("estimates from final_price ONLY where no disbursement row exists", async () => {
    const d = await summaryFor([{ finalPrice: 1000, workerShare: null }]);

    expect(d.pendingEstimatedAmount).toBe(1000 * PROVIDER_SHARE_RATE);
    expect(d.pendingRecordedAmount).toBe(0);
    expect(d.pendingIsEstimate).toBe(true);
  });

  it("upsell revenue survives into the totals", async () => {
    // A PHP 1,000 booking with PHP 500 of paid additional work: the
    // disbursement holds 80% of 1,500 = 1,200. The old query would have
    // reported 80% of 1,000 = 800, losing PHP 400 of the provider's money.
    const d = await summaryFor([
      { finalPrice: 1000, additionalPaid: 500, workerShare: 1200, payoutStatus: "PENDING" },
    ]);

    expect(d.totalPending).toBe(1200);
    expect(d.totalEarned).toBe(1200);
    // The number that would prove the bug had come back.
    expect(d.totalPending).not.toBe(800);
  });

  it("upsell revenue survives into the ESTIMATE too", async () => {
    // The one branch the original fix had not reached: a completed booking with
    // approved extra work and no disbursement row yet was under-estimated by
    // 80% of that work.
    const d = await summaryFor([
      { finalPrice: 1000, additionalPaid: 500, workerShare: null },
    ]);

    expect(d.pendingEstimatedAmount).toBe(1500 * PROVIDER_SHARE_RATE);
    expect(d.pendingEstimatedAmount).not.toBe(1000 * PROVIDER_SHARE_RATE);
  });
});

describe("defect 2 — money in flight is counted somewhere", () => {
  it("PROCESSING is inside pending, not lost between the two totals", async () => {
    const d = await summaryFor([{ finalPrice: 1000, workerShare: 800, payoutStatus: "PROCESSING" }]);

    expect(d.totalPending).toBe(800);
    expect(d.totalPaid).toBe(0);
    expect(d.totalEarned).toBe(800);
  });

  it("every disbursement state lands in exactly one bucket", async () => {
    /**
     * PENDING, PROCESSING, RELEASED and FAILED are the whole vocabulary of
     * `disbursements.status`. If a state appears in no bucket the provider's
     * money disappears; in two, it is double-counted.
     *
     * Asserted by SUMMING rather than by reading CASE arms: each state gets a
     * distinct amount, so the bucket totals identify exactly where each landed.
     */
    const d = await summaryFor([
      { id: 1, finalPrice: 1000, workerShare: 100, payoutStatus: "PENDING" },
      { id: 2, finalPrice: 1000, workerShare: 20, payoutStatus: "PROCESSING" },
      { id: 3, finalPrice: 1000, workerShare: 3, payoutStatus: "RELEASED" },
      { id: 4, finalPrice: 1000, workerShare: 0.4, payoutStatus: "FAILED" },
    ]);

    expect(d.totalPaid).toBe(3);
    expect(d.totalPending).toBe(120);
    expect(d.totalFailed).toBe(0.4);
    // Every peso is accounted for exactly once.
    expect(d.totalEarned).toBe(123.4);
  });
});

describe("defect 3 — a failed payout is not pending", () => {
  it("failed money is excluded from totalPending and reported separately", async () => {
    const d = await summaryFor([
      { id: 1, finalPrice: 1000, workerShare: 800, payoutStatus: "RELEASED" },
      { id: 2, finalPrice: 500, workerShare: 400, payoutStatus: "PENDING" },
      { id: 3, finalPrice: 300, workerShare: 240, payoutStatus: "FAILED" },
    ]);

    expect(d.totalPending).toBe(400);
    expect(d.totalFailed).toBe(240);
    // Folding it in would have said 640 — money on its way that is not.
    expect(d.totalPending).not.toBe(640);
  });

  it("failed money is still owed, so it stays in totalEarned", async () => {
    // Excluded from "on its way", NOT written off. A failed payout is a
    // transfer that must be retried, not revenue the provider never earned.
    const d = await summaryFor([
      { id: 1, finalPrice: 1000, workerShare: 800, payoutStatus: "RELEASED" },
      { id: 2, finalPrice: 500, workerShare: 400, payoutStatus: "PENDING" },
      { id: 3, finalPrice: 300, workerShare: 240, payoutStatus: "FAILED" },
    ]);
    expect(d.totalEarned).toBe(1440);
  });
});

describe("§9 — an estimate is labelled as an estimate", () => {
  it("a booking with no disbursement row yet flags the estimate", async () => {
    const d = await summaryFor([
      { id: 1, finalPrice: 1000, workerShare: 800, payoutStatus: "PENDING" },
      { id: 2, finalPrice: 500, workerShare: null },
    ]);

    expect(d.pendingIsEstimate).toBe(true);
    expect(d.pendingEstimatedAmount).toBe(400);
    expect(d.pendingRecordedAmount).toBe(800);
    expect(d.estimatedJobsCount).toBe(1);
    // The headline still totals both — the flag qualifies it, not replaces it.
    expect(d.totalPending).toBe(1200);
  });

  it("fully recorded pending money is NOT flagged as an estimate", async () => {
    // A flag that is always true tells the provider nothing.
    const d = await summaryFor([{ finalPrice: 1000, workerShare: 800, payoutStatus: "PENDING" }]);

    expect(d.pendingIsEstimate).toBe(false);
    expect(d.pendingEstimatedAmount).toBe(0);
  });

  it("no completed jobs is not an estimate either", async () => {
    const d = await summaryFor([]);
    expect(d.pendingIsEstimate).toBe(false);
    expect(d.totalPending).toBe(0);
    expect(d.totalEarned).toBe(0);
  });
});

describe("arithmetic", () => {
  /**
   * The rounding boundary MOVED in TAB 07, deliberately.
   *
   * The old aggregate summed raw NUMERICs in SQL and rounded once at the end,
   * because it was the only thing computing the number. Now the summary is the
   * sum of the SAME per-booking amounts the transaction list displays — so the
   * boundary has to be the per-booking amount, or the headline would differ from
   * the visible rows beneath it by a centavo. That is the same complaint the
   * original rule was written to prevent, pointing the other way.
   *
   * Nothing is lost in practice: `disbursements.worker_share` is NUMERIC(12,2),
   * so a sub-centavo share cannot exist in the column. Only the ESTIMATE path
   * can produce one, and an estimate that agrees with the row it is estimated
   * from is worth more than a hundredth of a peso.
   */
  it("the headline equals the sum of the rows the provider can see", async () => {
    const bookings = [
      { id: 1, finalPrice: 1000.55, workerShare: null },
      { id: 2, finalPrice: 2000.55, workerShare: null },
      { id: 3, finalPrice: 3000.55, workerShare: null },
    ];
    const d = await summaryFor(bookings);

    const { listEarningsTransactions } = await import(
      "../src/services/finance/providerEarningsService"
    );
    query.mockResolvedValue({ rows: bookings.map(bookingRow), rowCount: bookings.length });
    const rows = await listEarningsTransactions("worker-A");

    const visible = rows.reduce((sum, r) => sum + r.providerShareAmount, 0);
    expect(d.totalPending).toBe(Math.round(visible * 100) / 100);
  });

  it("rounds once when adding its own buckets together", async () => {
    // The part of the original rule that still holds: the headline is rounded
    // after the buckets are added, not by adding pre-rounded bucket totals.
    const d = await summaryFor([
      { id: 1, finalPrice: 1000, workerShare: 800.004, payoutStatus: "PENDING" },
      { id: 2, finalPrice: 500, workerShare: 400.004, payoutStatus: "RELEASED" },
    ]);
    expect(d.totalEarned).toBe(
      Math.round((d.totalPaid + d.totalPending + d.totalFailed) * 100) / 100,
    );
  });

  it("handles the string NUMERICs pg actually returns", async () => {
    // If these were concatenated instead of added the result would be the
    // string "800400" rather than 1200.
    const d = await summaryFor([
      { id: 1, finalPrice: 1000, workerShare: 800, payoutStatus: "PENDING" },
      { id: 2, finalPrice: 500, workerShare: 400, payoutStatus: "PENDING" },
    ]);
    expect(typeof d.totalPending).toBe("number");
    expect(d.totalPending).toBe(1200);
  });

  it("totalEarned is exactly its parts", async () => {
    const d = await summaryFor([
      { id: 1, finalPrice: 2000, workerShare: 1234.56, payoutStatus: "RELEASED" },
      { id: 2, finalPrice: 1000, workerShare: 789.01, payoutStatus: "PENDING" },
      { id: 3, finalPrice: 125, workerShare: null },
      { id: 4, finalPrice: 100, workerShare: 55.43, payoutStatus: "FAILED" },
    ]);
    expect(d.totalEarned).toBe(2179);
    // And it is exactly the sum of the four buckets it is presented beside.
    expect(d.totalEarned).toBe(
      Math.round((d.totalPaid + d.totalPending + d.totalFailed) * 100) / 100,
    );
  });
});

describe("a refunded booking is not money the provider is owed", () => {
  it("reports it as refunded rather than pending", async () => {
    // TAB 07. The provider is not owed a share of money the customer got back,
    // and the previous query had no refund branch at all — it counted the share
    // as pending forever.
    const d = await summaryFor([
      { id: 1, finalPrice: 1000, workerShare: 800, payoutStatus: "PENDING", paymentStatus: "REFUNDED" },
    ]);

    expect(d.totalRefunded).toBe(800);
    expect(d.totalPending).toBe(0);
  });
});

describe("no other platform breaks", () => {
  it("every key the provider portal and worker app read is still present", async () => {
    // Servana.com.ph maps totalEarned/totalPaid/totalPending/totalRefunded/
    // periodLabel/jobsCount/currency; ServanaWorker's EarningsStore reads the
    // same set. Dropping one is a blank figure on a live money screen.
    const d = await summaryFor([
      { id: 1, finalPrice: 1000, workerShare: 800, payoutStatus: "RELEASED" },
      { id: 2, finalPrice: 500, workerShare: 400, payoutStatus: "PENDING" },
    ]);

    for (const key of [
      "totalEarned",
      "totalPaid",
      "totalPending",
      "totalRefunded",
      "periodLabel",
      "currency",
      "jobsCount",
    ]) {
      expect(d).toHaveProperty(key);
    }
    expect(typeof d.totalEarned).toBe("number");
    expect(d.currency).toBe("PHP");
    expect(d.jobsCount).toBe(2);
  });

  it("the date range still switches the period label", async () => {
    expect((await summaryFor([], {})).periodLabel).toBe("All time");
    expect(
      (await summaryFor([], { startDate: "2026-01-01", endDate: "2026-02-01" })).periodLabel
    ).toBe("Custom range");
  });

  it("an invalid date range is still rejected before querying", async () => {
    const req: any = {
      user: { uid: "worker-A" },
      query: { startDate: "not-a-date", endDate: "2026-02-01" },
    };
    let code = 0;
    const res: any = { status: (c: number) => ((code = c), res), json: () => res };
    await getEarningsSummary(req, res);

    expect(code).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it("a half-specified range is rejected too", async () => {
    // TAB 07: previously a lone startDate was silently ignored and the summary
    // answered for all time, which is a different question from the one asked.
    const req: any = { user: { uid: "worker-A" }, query: { startDate: "2026-01-01" } };
    let code = 0;
    const res: any = { status: (c: number) => ((code = c), res), json: () => res };
    await getEarningsSummary(req, res);

    expect(code).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
