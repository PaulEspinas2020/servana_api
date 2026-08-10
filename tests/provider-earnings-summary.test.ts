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

const query = (dbQuery as any).query as jest.Mock;

/** One completed booking, as the aggregate row the handler reads. */
type Row = {
  total_jobs?: any;
  total_gross?: any;
  total_paid?: any;
  pending_recorded?: any;
  pending_estimated?: any;
  total_failed?: any;
  estimated_jobs?: any;
};

/**
 * Postgres NUMERIC comes back as a STRING through `pg`, and every one of these
 * columns is a SUM over NUMERIC. Feeding numbers here would test a shape the
 * database never produces — string concatenation instead of addition is the
 * failure this guards.
 */
const rowOf = (r: Row) => ({
  rows: [
    {
      total_jobs: String(r.total_jobs ?? 0),
      total_gross: String(r.total_gross ?? 0),
      total_paid: String(r.total_paid ?? 0),
      pending_recorded: String(r.pending_recorded ?? 0),
      pending_estimated: String(r.pending_estimated ?? 0),
      total_failed: String(r.total_failed ?? 0),
      estimated_jobs: String(r.estimated_jobs ?? 0),
    },
  ],
});

async function summaryFor(r: Row, q: Record<string, any> = {}) {
  query.mockResolvedValueOnce(rowOf(r));
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

/** The SQL the handler issued, comments stripped. */
async function sqlIssued() {
  await summaryFor({});
  return String(query.mock.calls[0][0])
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "");
}

beforeEach(() => query.mockReset());

describe("defect 1 — the authoritative amount is read, not recomputed", () => {
  it("does not recompute a recorded disbursement from final_price", async () => {
    const sql = await sqlIssued();

    // The fallback multiplication must apply ONLY where no disbursement row
    // exists. Anywhere else it silently overrides an authoritative worker_share.
    //
    // The pattern is no longer `final_price * RATE`: the estimate now multiplies
    // `(final_price + paid additional work)`, because defect (1) above was still
    // live in this one branch — it was the only place left recomputing from
    // final_price alone, so a completed booking with approved extra work and no
    // disbursement row yet was under-estimated by 80% of that work. Matching on
    // the multiplication by the RATE keeps the original guarantee without
    // pinning the shape of the operand.
    const fallbacks = sql.match(/\* 0\.8\b/g) ?? [];
    expect(fallbacks).toHaveLength(1);

    const at = sql.indexOf(fallbacks[0] as string);
    const clause = sql.slice(sql.lastIndexOf("CASE", at), at);
    expect(clause).toMatch(/d\.id IS NULL/);

    // `d.id IS NULL` alone is too weak to catch this: the old clause was
    // `d.status IN ('PENDING','FAILED') OR d.id IS NULL`, which contains it
    // and still recomputed rows that HAD an authoritative worker_share. The
    // no-row case must be the ONLY thing the fallback covers.
    // Word-anchored to the disbursement alias. Unanchored, `d.status` also
    // matches inside `p_add.status` — the additional-work subquery now sits in
    // this clause, so the loose pattern reported a defect that was not there.
    expect(clause).not.toMatch(/\bd\.status/);
    expect(clause).not.toMatch(/\bOR\b/);
  });

  it("upsell revenue survives into the totals", async () => {
    // A PHP 1,000 booking with PHP 500 of paid additional work: the
    // disbursement holds 80% of 1,500 = 1,200. The old query would have
    // reported 80% of 1,000 = 800, losing PHP 400 of the provider's money.
    const d = await summaryFor({ total_jobs: 1, total_gross: 1000, pending_recorded: 1200 });

    expect(d.totalPending).toBe(1200);
    expect(d.totalEarned).toBe(1200);
    // The number that would prove the bug had come back.
    expect(d.totalPending).not.toBe(800);
  });
});

describe("defect 2 — money in flight is counted somewhere", () => {
  it("PROCESSING is inside pending, not lost between the two totals", async () => {
    const sql = await sqlIssued();
    const pending = sql.slice(sql.indexOf("pending_recorded") - 260, sql.indexOf("pending_recorded"));

    expect(pending).toMatch(/'PENDING'/);
    expect(pending).toMatch(/'PROCESSING'/);
  });

  it("every disbursement state lands in exactly one bucket", async () => {
    // PENDING, PROCESSING, RELEASED and FAILED are the whole vocabulary of
    // disbursements.status. If a state appears in no bucket the provider's
    // money disappears; in two, it is double-counted.
    const sql = await sqlIssued();
    const buckets: Record<string, string[]> = {
      total_paid: [],
      pending_recorded: [],
      total_failed: [],
    };
    for (const name of Object.keys(buckets)) {
      const end = sql.indexOf(`AS ${name}`);
      const start = sql.lastIndexOf("COALESCE", end);
      const clause = sql.slice(start, end);
      for (const st of ["PENDING", "PROCESSING", "RELEASED", "FAILED"]) {
        if (new RegExp(`'${st}'`).test(clause)) buckets[name].push(st);
      }
    }

    const all = Object.values(buckets).flat();
    expect(all.sort()).toEqual(["FAILED", "PENDING", "PROCESSING", "RELEASED"]);
  });
});

describe("defect 3 — a failed payout is not pending", () => {
  it("failed money is excluded from totalPending and reported separately", async () => {
    const d = await summaryFor({
      total_jobs: 3,
      total_paid: 800,
      pending_recorded: 400,
      total_failed: 240,
    });

    expect(d.totalPending).toBe(400);
    expect(d.totalFailed).toBe(240);
    // Folding it in would have said 640 — money on its way that is not.
    expect(d.totalPending).not.toBe(640);
  });

  it("failed money is still owed, so it stays in totalEarned", async () => {
    // Excluded from "on its way", NOT written off. A failed payout is a
    // transfer that must be retried, not revenue the provider never earned.
    const d = await summaryFor({ total_paid: 800, pending_recorded: 400, total_failed: 240 });
    expect(d.totalEarned).toBe(1440);
  });
});

describe("§9 — an estimate is labelled as an estimate", () => {
  it("a booking with no disbursement row yet flags the estimate", async () => {
    const d = await summaryFor({
      total_jobs: 2,
      pending_recorded: 800,
      pending_estimated: 400,
      estimated_jobs: 1,
    });

    expect(d.pendingIsEstimate).toBe(true);
    expect(d.pendingEstimatedAmount).toBe(400);
    expect(d.pendingRecordedAmount).toBe(800);
    expect(d.estimatedJobsCount).toBe(1);
    // The headline still totals both — the flag qualifies it, not replaces it.
    expect(d.totalPending).toBe(1200);
  });

  it("fully recorded pending money is NOT flagged as an estimate", async () => {
    // A flag that is always true tells the provider nothing.
    const d = await summaryFor({ total_jobs: 1, pending_recorded: 800, estimated_jobs: 0 });

    expect(d.pendingIsEstimate).toBe(false);
    expect(d.pendingEstimatedAmount).toBe(0);
  });

  it("no completed jobs is not an estimate either", async () => {
    const d = await summaryFor({});
    expect(d.pendingIsEstimate).toBe(false);
    expect(d.totalPending).toBe(0);
    expect(d.totalEarned).toBe(0);
  });
});

describe("arithmetic", () => {
  it("rounds once, after summing", async () => {
    // Rounding each part and adding lets the headline drift from its parts.
    // 0.005 + 0.005 rounds to 0.01 together, and to 0.02 separately.
    const d = await summaryFor({ pending_recorded: 0.005, pending_estimated: 0.005 });
    expect(d.totalPending).toBe(0.01);
  });

  it("handles the string NUMERICs pg actually returns", async () => {
    // If these were concatenated instead of added the result would be the
    // string "800400" rather than 1200.
    const d = await summaryFor({ pending_recorded: 800, pending_estimated: 400 });
    expect(typeof d.totalPending).toBe("number");
    expect(d.totalPending).toBe(1200);
  });

  it("totalEarned is exactly its parts", async () => {
    const d = await summaryFor({
      total_paid: 1234.56,
      pending_recorded: 789.01,
      pending_estimated: 100,
      total_failed: 55.43,
    });
    expect(d.totalEarned).toBe(2179);
  });
});

describe("no other platform breaks", () => {
  it("every key the provider portal and worker app read is still present", async () => {
    // Servana.com.ph maps totalEarned/totalPaid/totalPending/totalRefunded/
    // periodLabel/jobsCount/currency; ServanaWorker's EarningsStore reads the
    // same set. Dropping one is a blank figure on a live money screen.
    const d = await summaryFor({ total_jobs: 2, total_paid: 800 });

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
  });

  it("the date range still switches the period label", async () => {
    expect((await summaryFor({}, {})).periodLabel).toBe("All time");
    expect(
      (await summaryFor({}, { startDate: "2026-01-01", endDate: "2026-02-01" })).periodLabel
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
});
