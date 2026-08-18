/**
 * The single financial calculator, exercised over every economic case.
 *
 * `computeBookingFinance` is a pure function from the source rows to the
 * canonical financial picture, which is what makes this suite possible without a
 * database — and what makes the "backend is the single financial calculator"
 * gate checkable. Every surface projects from this one function, so a case
 * proven here is proven for the customer's payment screen, the provider's
 * earnings, and the admin's reconciliation simultaneously.
 *
 * The cases below are the ones that were each, at some point, a separate defect
 * in a separate endpoint: additional work dropped from the gross, a recorded
 * share recomputed from a stale price, an internal fixer shown a share, a failed
 * payout reported as settled.
 */

import fs from 'fs';
import path from 'path';
import { LEDGER_EVENTS } from '../src/services/finance/financeLedger';
jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));

import {
  computeBookingFinance,
  asMinorUnits,
  bookingFinanceSelect,
  toBookingFinanceRow,
  eventKeys,
  type BookingFinanceRow,
} from '../src/services/finance/financeLedger';
import { PROVIDER_SHARE_RATE } from '../src/services/revenueSplit';
import { PROVIDER_PAYOUT_WINDOW_HOURS, toCentavos } from '../src/services/finance/financePolicy';

const NOW = new Date('2026-08-13T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

/** A paid, completed, externally-provided booking. The ordinary case. */
const ORDINARY: BookingFinanceRow = {
  bookingId: 42,
  bookingStatus: 'COMPLETED',
  finalPrice: 1500,
  additionalPaid: 0,
  paymentId: 7,
  paymentStatus: 'PAID',
  paymentMethod: 'PAYMONGO',
  paidAt: hoursAgo(100),
  refundedAmount: 0,
  providerUid: 'provider-1',
  isInternalFixer: false,
  assignmentCompletedAt: hoursAgo(90),
  disbursementId: 3,
  workerShare: 1200,
  payoutStatus: 'PENDING',
};

const compute = (overrides: Partial<BookingFinanceRow> = {}, hasBankAccount = true) =>
  computeBookingFinance({ ...ORDINARY, ...overrides }, { now: NOW, hasBankAccount });

// ─── The gross ────────────────────────────────────────────────────────────────

describe('the gross a share is computed from', () => {
  it('is the booking price when there is no additional work', () => {
    const finance = compute();
    expect(finance.gross).toBe(1500);
    expect(finance.basePrice).toBe(1500);
    expect(finance.additionalWork).toBe(0);
  });

  /**
   * On-site upsell is charged through its own checkout and never writes back to
   * `bookings.final_price`. A reader treating final_price as the gross shows a
   * booking amount the provider share is visibly not 80% of — production carried
   * exactly that shape.
   */
  it('includes PAID additional work', () => {
    const finance = compute({ additionalPaid: 3500, workerShare: null, disbursementId: null });
    expect(finance.gross).toBe(5000);
    expect(finance.basePrice).toBe(1500);
    expect(finance.additionalWork).toBe(3500);
    expect(finance.provider.payable).toBe(toCentavos(5000 * PROVIDER_SHARE_RATE));
  });

  it('survives a null price without producing NaN', () => {
    const finance = compute({ finalPrice: null, additionalPaid: null, workerShare: null });
    expect(finance.gross).toBe(0);
    expect(finance.provider.payable).toBe(0);
  });
});

// ─── Recorded versus derived ──────────────────────────────────────────────────

describe('a recorded share beats a derived one', () => {
  it('uses the disbursement figure as authoritative and does not recompute it', () => {
    // 1200 is NOT 80% of 2000 — the disbursement was computed when the price was
    // different. The recorded amount is what the provider is actually owed, and
    // recomputing it here is how a provider comes to be shown one number and
    // paid another.
    const finance = compute({ finalPrice: 2000, workerShare: 1200 });
    expect(finance.provider.payable).toBe(1200);
    expect(finance.provider.isEstimate).toBe(false);
    // Servana's side is the remainder, so the two still add to the gross.
    expect(toCentavos(finance.provider.payable + finance.servana.revenue)).toBe(finance.gross);
  });

  it('derives and LABELS an estimate when no disbursement row exists yet', () => {
    const finance = compute({ disbursementId: null, workerShare: null });
    expect(finance.provider.payable).toBe(toCentavos(1500 * PROVIDER_SHARE_RATE));
    expect(finance.provider.isEstimate).toBe(true);
  });
});

// ─── Internal fixer economics ─────────────────────────────────────────────────

describe('internal fixer economics', () => {
  it('is owed nothing and Servana keeps the whole gross', () => {
    const finance = compute({ isInternalFixer: true, workerShare: null, disbursementId: null });
    expect(finance.provider.economicModel).toBe('INTERNAL_FIXER');
    expect(finance.provider.payable).toBe(0);
    expect(finance.servana.revenue).toBe(1500);
  });

  /**
   * The override that matters. A disbursement row for an internal fixer IS the
   * `INTERNAL_FIXER_JOB_WITH_PROVIDER_PAYOUT` break — reporting its amount as
   * earnings would show a salaried employee money they will never receive, and
   * would make the earnings screen agree with the defect rather than with the
   * policy.
   */
  it('reports zero even when a disbursement row exists for them', () => {
    const finance = compute({ isInternalFixer: true, workerShare: 1200, disbursementId: 3 });
    expect(finance.provider.payable).toBe(0);
    expect(finance.servana.revenue).toBe(1500);
  });

  it('never reports an estimate — there is nothing to estimate', () => {
    const finance = compute({ isInternalFixer: true, workerShare: null, disbursementId: null });
    expect(finance.provider.isEstimate).toBe(false);
  });

  it('carries a sentence explaining the zero, so it is never unexplained', () => {
    expect(compute({ isInternalFixer: true }).provider.withheldReason).toMatch(/salaried/i);
    expect(compute({ isInternalFixer: false }).provider.withheldReason).toBeNull();
  });

  it('is refused a payout regardless of how long ago the job completed', () => {
    const finance = compute({ isInternalFixer: true, assignmentCompletedAt: hoursAgo(1000) });
    expect(finance.payout.eligible).toBe(false);
    expect(finance.payout.blockedBy).toBe('INTERNAL_FIXER_SALARIED');
  });
});

// ─── Payment and refund position ──────────────────────────────────────────────

describe('the payment position', () => {
  it('reports what is still refundable, not what was captured', () => {
    const finance = compute({ refundedAmount: 500 });
    expect(finance.payment.refundable).toBe(1000);
  });

  it('never reports a negative refundable balance', () => {
    expect(compute({ refundedAmount: 99999 }).payment.refundable).toBe(0);
  });

  it('treats REFUNDING as still captured, so a second refund is bounded', () => {
    const finance = compute({ paymentStatus: 'REFUNDING' });
    expect(finance.payment.captured).toBe(true);
    expect(finance.payment.refundable).toBe(1500);
  });

  it('a fully refunded payment has nothing left to return', () => {
    const finance = compute({ paymentStatus: 'REFUNDED', refundedAmount: 1500 });
    expect(finance.payment.captured).toBe(false);
    expect(finance.payment.refundable).toBe(0);
  });
});

// ─── Payout position ──────────────────────────────────────────────────────────

describe('the payout position', () => {
  it('is eligible once the window has passed on a paid, completed job', () => {
    expect(compute().payout.eligible).toBe(true);
  });

  it('reports the window close time computed from the completion, not the schedule', () => {
    const finance = compute({ assignmentCompletedAt: hoursAgo(1) });
    expect(finance.payout.eligibleAt).toBe(
      new Date(NOW.getTime() + (PROVIDER_PAYOUT_WINDOW_HOURS - 1) * 3_600_000).toISOString(),
    );
  });

  /**
   * A failed payout needs intervention rather than patience. Reporting it as
   * pending tells the provider it is on its way — the C20 F-01 defect, in the
   * calculator this time so no endpoint can reintroduce it.
   */
  it('keeps FAILED distinct from PENDING and from PROCESSING', () => {
    expect(compute({ payoutStatus: 'FAILED' }).payout.status).toBe('failed');
    expect(compute({ payoutStatus: 'PROCESSING' }).payout.status).toBe('processing');
    expect(compute({ payoutStatus: 'PENDING' }).payout.status).toBe('pending');
    expect(compute({ payoutStatus: null }).payout.status).toBe('pending');
  });

  it('a released payout is not eligible for a second release', () => {
    const finance = compute({ payoutStatus: 'RELEASED', releasedAt: hoursAgo(2) });
    expect(finance.payout.status).toBe('paid');
    expect(finance.payout.blockedBy).toBe('ALREADY_RELEASED');
    expect(finance.payout.releasedAt).toBe(new Date(hoursAgo(2)).toISOString());
  });

  it('an unpaid booking blocks the payout and names the payment, not the clock', () => {
    expect(compute({ paymentStatus: 'PENDING' }).payout.blockedBy).toBe('PAYMENT_NOT_CAPTURED');
  });

  it('an admin hold blocks it and says so', () => {
    expect(compute({ holdReason: 'Dispute open', holdUntil: null }).payout.blockedBy)
      .toBe('ADMIN_HOLD');
  });
});

// ─── Invariants that must hold for every shape ────────────────────────────────

describe('invariants across every combination', () => {
  const prices = [0, 0.01, 33.33, 1500, 99999.99];
  const additional = [0, 250.55, 3500];
  const models = [false, true];

  it('provider payable and Servana revenue always add back to the gross', () => {
    for (const finalPrice of prices) {
      for (const additionalPaid of additional) {
        for (const isInternalFixer of models) {
          const finance = compute({
            finalPrice,
            additionalPaid,
            isInternalFixer,
            workerShare: null,
            disbursementId: null,
          });
          expect(toCentavos(finance.provider.payable + finance.servana.revenue))
            .toBe(finance.gross);
        }
      }
    }
  });

  it('an internal fixer is owed zero in every combination', () => {
    for (const finalPrice of prices) {
      for (const additionalPaid of additional) {
        expect(compute({ finalPrice, additionalPaid, isInternalFixer: true }).provider.payable)
          .toBe(0);
      }
    }
  });

  it('minor units mirror the decimal amounts exactly', () => {
    for (const finalPrice of prices) {
      const finance = compute({ finalPrice, workerShare: null, disbursementId: null });
      const minor = asMinorUnits(finance);
      expect(minor.gross).toBe(Math.round(finance.gross * 100));
      expect(minor.providerPayable).toBe(Math.round(finance.provider.payable * 100));
      expect(Number.isInteger(minor.gross)).toBe(true);
    }
  });
});

// ─── The shared SELECT ────────────────────────────────────────────────────────

describe('the shared source SELECT', () => {
  const sql = bookingFinanceSelect('servana');

  it('scopes the payment join so a booking with additional work cannot fan out', () => {
    // Without this, a booking carrying both a base payment and an additional-work
    // payment returns several rows, and a reader taking rows[0] can report the
    // additional charge's status as the booking's.
    expect(sql).toContain('p.additional_request_id IS NULL');
  });

  it('sums only PAID additional work', () => {
    // A request can sit at ACCEPTED, IN_PROGRESS or PROCEEDING without the
    // customer having paid. Paying a share of money Servana never collected
    // turns a shortfall into a loss.
    expect(sql).toContain("p_add.status = 'PAID'");
  });

  it('reads the internal fixer flag from user_credentials', () => {
    expect(sql).toContain('is_internal_fixer');
  });

  it('scopes the assignment and disbursement joins to the same provider parameter', () => {
    const scoped = bookingFinanceSelect('servana', '$1');
    expect(scoped).toContain('bw.worker_uid = $1');
    expect(scoped).toContain('d.worker_uid = $1');
  });

  it('maps a database row onto the calculator without losing a column', () => {
    const row = toBookingFinanceRow({
      booking_id: 42, booking_status: 'COMPLETED', final_price: '1500.00',
      additional_paid: '3500.00', payment_id: 7, payment_status: 'PAID',
      payment_method: 'PAYMONGO', paid_at: hoursAgo(100), refunded_amount: '0.00',
      provider_uid: 'provider-1', is_internal_fixer: true,
      assignment_completed_at: hoursAgo(90), disbursement_id: 3,
      worker_share: '1200.00', payout_status: 'PENDING',
    });
    expect(row.bookingId).toBe(42);
    expect(row.isInternalFixer).toBe(true);
    expect(computeBookingFinance(row, { now: NOW }).gross).toBe(5000);
  });
});

// ─── Idempotency keys ─────────────────────────────────────────────────────────

describe('ledger event keys', () => {
  /**
   * Keys are composed from the FACT, never from the attempt. A webhook retry, a
   * double-clicked approval and a scheduler that runs twice must all produce the
   * same key and therefore one row.
   */
  it('the same fact produces the same key every time', () => {
    expect(eventKeys.paymentCaptured(47)).toBe(eventKeys.paymentCaptured(47));
    expect(eventKeys.earningAccrued(42, 'provider-1')).toBe(
      eventKeys.earningAccrued(42, 'provider-1'),
    );
    expect(eventKeys.payoutReleased(3)).toBe(eventKeys.payoutReleased(3));
  });

  it('different facts never collide', () => {
    const keys = [
      eventKeys.paymentCaptured(47),
      eventKeys.additionalWorkCaptured(47),
      eventKeys.paymentRefunded(47, 1),
      eventKeys.paymentRefunded(47, 2),
      eventKeys.earningAccrued(42, 'provider-1'),
      eventKeys.earningWithheld(42, 'provider-1'),
      eventKeys.earningAccrued(42, 'provider-2'),
      eventKeys.internalFixerRevenue(42),
      eventKeys.payoutReleased(3),
      eventKeys.payoutFailed(3, 1),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  /**
   * A refund ATTEMPT is part of the fact, unlike a checkout attempt: two refunds
   * against one payment are two distinct movements of money, and collapsing them
   * onto one key would hide the second.
   */
  it('separate refund attempts are separate facts', () => {
    expect(eventKeys.paymentRefunded(47, 1)).not.toBe(eventKeys.paymentRefunded(47, 2));
  });
});

// ─── Every declared ledger event type must be writable ────────────────────────

describe('the ledger vocabulary has no orphan event types', () => {
  /**
   * The gap this closes.
   *
   * `LEDGER_EVENTS` declares the financial vocabulary. A type declared but never
   * written is a hole in the ledger that reconciliation cannot see: the money
   * still moves through `payments` and `disbursements`, so earnings report it,
   * while the ledger has no row for it and the two can never be balanced against
   * each other. TAB 07's release gate is "ledger reconciliation has zero
   * unexplained breaks" — an orphan type is an unexplained break waiting to be
   * introduced.
   *
   * ## What this can and cannot prove
   *
   * It proves each type is NAMED by a module that imports a ledger writer, so a
   * type nothing could ever record fails. It does not prove the code path is
   * reached at runtime — only an integration test against a real transaction
   * does that, and `finance-idempotency` covers the two highest-value types.
   *
   * The looseness is deliberate. A stricter textual rule — matching `type: 'X'`
   * at a call site — was tried and gave a FALSE POSITIVE: the capture writer
   * chooses with `type: isAdditional ? 'ADDITIONAL_WORK_CAPTURED' : ...`, which
   * a literal-only pattern cannot see. A check that reports a healthy ledger as
   * broken gets switched off, and then it protects nothing.
   */
  const SRC = path.resolve(__dirname, '..', 'src');

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && full.endsWith('.ts') ? [full] : [];
    });

  /**
   * The declaration itself, masked out.
   *
   * The first version of this check counted `financeLedger.ts` as a writer —
   * true, it contains `recordLedgerEvent` — but every type is also DECLARED
   * there, so each one matched its own declaration and the check passed for
   * anything. A deliberately injected orphan type did not fail it.
   *
   * That is the exact defect this sweep exists to find, written into the
   * detector meant to find it, and only a mutation test surfaced it. Masking
   * the `LEDGER_EVENTS` literal is what makes the remaining text evidence of
   * USE rather than of declaration.
   */
  const maskDeclaration = (text: string): string => {
    const start = text.indexOf('LEDGER_EVENTS');
    if (start < 0) return text;
    const open = text.indexOf('{', start);
    if (open < 0) return text;
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') {
        depth -= 1;
        if (depth === 0) return text.slice(0, start) + ' '.repeat(i - start + 1) + text.slice(i + 1);
      }
    }
    return text;
  };

  /** Modules that can append to the ledger, with declarations masked out. */
  const writers = walk(SRC)
    .map((file) => ({ file, text: maskDeclaration(fs.readFileSync(file, 'utf8')) }))
    .filter(({ text }) => /recordLedgerEvent/.test(text));

  const namedByAWriter = (type: string): boolean =>
    writers.some(({ text }) => text.includes(`'${type}'`) || text.includes(`"${type}"`));

  it('finds the ledger writers at all (positive fixture)', () => {
    // A broken walk would find nothing and pass every check below forever.
    expect(writers.length).toBeGreaterThan(3);
  });

  it('every declared event type is USED by a module that can write it', () => {
    const orphans = Object.keys(LEDGER_EVENTS).filter((type) => !namedByAWriter(type));
    expect(orphans).toEqual([]);
  });

  it('would notice a type nothing can record (negative fixture)', () => {
    /**
     * The check that the check works. This name is declared nowhere and used
     * nowhere, so a predicate that always answered "yes" — which the first
     * version of this suite did — fails here.
     */
    expect(namedByAWriter('PROVIDER_BONUS_GRANTED_NOT_A_REAL_TYPE')).toBe(false);
  });

  it('still credits a type chosen conditionally, not just by literal', () => {
    /**
     * `ADDITIONAL_WORK_CAPTURED` is produced by
     * `type: isAdditional ? 'ADDITIONAL_WORK_CAPTURED' : 'PAYMENT_CAPTURED'`.
     * A stricter rule matching `type: 'X'` at a call site reported it as an
     * orphan — a false positive on the money path, which is how a check earns
     * its way into being switched off.
     */
    expect(namedByAWriter('ADDITIONAL_WORK_CAPTURED')).toBe(true);
  });
});
