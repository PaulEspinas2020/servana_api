/**
 * Command 3 regressions — three defects that were live in production and were
 * invisible because each one failed by returning a plausible value.
 *
 *  1. `getWorkerDashboard().cancelled` was permanently 0. It counted the parent
 *     booking's spelling ('CANCELLED') against the child assignment table, which
 *     is only ever written 'CANCELED'. Zero looks like "no cancellations".
 *
 *  2. `getDashboard().activeJob` was permanently null while a job was running.
 *     Nothing writes `bookings.status = 'IN_PROGRESS'` — startJob writes that to
 *     booking_workers only — so the filter matched nothing. Null looks like
 *     "not working right now".
 *
 *  3. An admin payout hold moved the money anyway. `holdPayout` writes
 *     hold_reason/hold_until and leaves status = 'PENDING'; the release job
 *     selected on status and elapsed time alone. The hold succeeded, was
 *     audit-logged, and had no effect on money movement.
 *
 * All three lived in SQL predicates, so these are static assertions over the
 * source rather than behavioural tests with a mocked driver: a test that stubbed
 * the query RESULT would have passed against every one of the broken versions.
 * Reading the source is also what lets this run with no database, no Mongo and
 * no environment — the services import a MongoClient at module load, so
 * importing them here would require standing up infrastructure to assert on a
 * string.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', 'src');

const read = (rel: string) =>
  fs.readFileSync(path.join(SRC, rel), 'utf8');

/** Collapse whitespace so assertions do not depend on SQL indentation. */
const flat = (s: string) => s.replace(/\s+/g, ' ');

/**
 * Strip `--` SQL comments and `//` JS comments so prose cannot satisfy a test.
 *
 * No `$` anchor: these files have CRLF endings, and after splitting on `\n` each
 * line still ends with `\r`. `.` does not match `\r`, so `.*$` never reaches the
 * end of the string and the replace silently does nothing — which had these very
 * assertions passing against the WORDS "only ever written 'CANCELED'" in a
 * comment rather than against the SQL. `--.*` needs no anchor, because `.`
 * already stops at the line break.
 */
const code = (s: string) =>
  s
    .split('\n')
    .map((l) => l.replace(/--.*/, '').replace(/^\s*\/\/.*/, ''))
    .join('\n');

describe('the helper itself', () => {
  // Every assertion below depends on comments being gone. When the stripper
  // silently no-ops, the suite still passes — against prose. It did exactly that
  // until the CRLF bug above was found, so the stripper gets its own fixtures.
  test('strips SQL comments, including on CRLF lines', () => {
    expect(code("SELECT 1 -- mentions 'CANCELED'\r\nFROM t")).not.toContain('CANCELED');
    expect(code("SELECT 1 -- mentions 'CANCELED'\nFROM t")).not.toContain('CANCELED');
  });

  test('strips whole-line JS comments', () => {
    expect(code("  // writes 'IN_PROGRESS' to booking_workers\r\nconst x = 1;"))
      .not.toContain('IN_PROGRESS');
  });

  test('keeps the code either side of a stripped comment', () => {
    const out = code("WHERE d.status = 'PENDING' -- a note\r\n  AND hold_reason IS NULL");
    expect(out).toContain("'PENDING'");
    expect(out).toContain('hold_reason IS NULL');
    expect(out).not.toContain('a note');
  });
});

describe('worker dashboard — cancelled job count', () => {
  const src = flat(code(read('services/technicianService.ts')));

  test('counts the spelling booking_workers is actually written with', () => {
    const m = src.match(/SELECT COUNT\(\*\) AS total_jobs[\s\S]{0,400}?booking_workers bw/);
    expect(m).not.toBeNull();
    const q = m![0];

    // bookingService.ts:659 writes 'CANCELED' (single L) to booking_workers.
    expect(q).toContain("'CANCELED'");
  });

  test("does not count ONLY the parent booking's double-L spelling", () => {
    const m = src.match(/SELECT COUNT\(\*\) AS total_jobs[\s\S]{0,400}?booking_workers bw/);
    const q = m![0];

    // The original read: CASE WHEN bw.status = 'CANCELLED'. If the single-L
    // spelling is absent the counter is dead again.
    const hasSingleL = /'CANCELED'/.test(q);
    expect(hasSingleL).toBe(true);
  });
});

describe('provider dashboard', () => {
  const src = flat(code(read('controllers/providerController.ts')));

  test('active job does not filter on a bookings.status value that is never written', () => {
    // technicianService.ts:1139 writes IN_PROGRESS to booking_workers only.
    expect(src).not.toMatch(/b\.status\s*=\s*'IN_PROGRESS'/);
  });

  test('active job reads the assignment row instead', () => {
    expect(src).toMatch(/booking_workers[^|]{0,200}'IN_PROGRESS'/);
  });

  test('earnings come from worker_share, not the gross customer price', () => {
    const m = src.match(/SELECT[^`]{0,600}completed_today[^`]{0,900}?WHERE b\.worker_uid/);
    expect(m).not.toBeNull();
    const q = m![0];

    // final_price is what the CUSTOMER paid. Summing it reported the provider's
    // take as 125% of what they are actually disbursed.
    expect(q).not.toMatch(/SUM\(final_price\)/);
    expect(q).toContain('worker_share');
  });
});

describe('payout release — admin hold', () => {
  const src = flat(code(read('services/disbursement.service.ts')));

  const releaseQuery = () => {
    const m = src.match(/SELECT d\.\*[\s\S]*?WHERE d\.status = 'PENDING'[\s\S]{0,600}?`/);
    expect(m).not.toBeNull();
    return m![0];
  };

  test('the release query considers the hold at all', () => {
    expect(releaseQuery()).toContain('hold_reason');
  });

  test('an indefinite hold (no expiry) does not age out', () => {
    const q = releaseQuery();
    // holdUntil is optional — adminFinanceController passes `holdUntil ?? null`
    // — so a hold with no expiry means "hold indefinitely". A predicate written
    // only as `hold_until IS NULL OR hold_until <= NOW()` would release it
    // immediately, which is the naive fix and is wrong.
    expect(q).toMatch(/hold_reason IS NULL/);
    expect(q).toMatch(/hold_until IS NOT NULL/);
  });

  test('a hold whose expiry has passed still releases', () => {
    expect(releaseQuery()).toMatch(/hold_until <= NOW\(\)/);
  });
});

describe('disbursement basis — additional work', () => {
  const src = flat(code(read('services/disbursement.service.ts')));

  test('the payable basis includes paid additional work', () => {
    // booking_additional_requests charges the customer through its own PayMongo
    // checkout and never writes back to bookings.final_price. The split was
    // computed from final_price alone, so on-site upsells contributed exactly 0
    // to provider pay while both frontends promised 80% of them.
    expect(src).toContain('additional_paid');
    expect(src).toMatch(/payableBasis/);
    expect(src).not.toMatch(/computeSplit\(Number\(final_price\)\)/);
  });

  test('it counts money received, not merely work agreed', () => {
    // A request can be ACCEPTED, IN_PROGRESS or PROCEEDING with the customer
    // having paid nothing. Paying a share of uncollected money turns a
    // shortfall into a loss, so the sum keys on the PAYMENT row.
    const sub = src.match(/SELECT SUM\(p\.amount\)[\s\S]{0,320}?\)/);
    expect(sub).not.toBeNull();
    expect(sub![0]).toMatch(/p\.status = 'PAID'/);
    expect(sub![0]).toMatch(/p\.additional_request_id IS NOT NULL/);
    // Not the request table, whose status does not evidence payment.
    expect(sub![0]).not.toMatch(/booking_additional_requests/);
  });
});

describe('cancelled spelling normalisation', () => {
  const bookingSvc = flat(code(read('services/bookingService.ts')));
  const adminSvc = flat(code(read('services/adminBookingService.ts')));

  test('nothing WRITES the single-L spelling to booking_workers any more', () => {
    // Two spellings of one state is how getWorkerDashboard came to report zero
    // cancellations forever. 'CANCELLED' is canonical, matching bookings.status.
    for (const src of [bookingSvc, adminSvc]) {
      expect(src).not.toMatch(/booking_workers SET status = 'CANCELED'/);
    }
    expect(bookingSvc).toMatch(/booking_workers SET status = 'CANCELLED'/);
  });

  test('READS still accept both, for rows written before normalisation', () => {
    // A query matching only the canonical spelling against un-normalised data
    // reintroduces exactly the bug this replaced. Reads stay tolerant until the
    // migration has run everywhere.
    const provider = flat(code(read('controllers/providerController.ts')));
    expect(provider).toMatch(/'CANCELED','CANCELLED'/);
  });

  test('the dashboard counter still matches both', () => {
    const tech = flat(code(read('services/technicianService.ts')));
    const m = tech.match(/AS total_jobs[\s\S]{0,400}?booking_workers bw/);
    expect(m![0]).toMatch(/IN \('CANCELED', 'CANCELLED'\)/);
  });
});
