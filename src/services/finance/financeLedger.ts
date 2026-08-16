/**
 * The financial ledger: one calculator, one append-only event log.
 *
 * ## The two halves, and why both are needed
 *
 * **`computeBookingFinance` is the calculator.** It is a pure function from the
 * source rows — the booking, its payment, its paid additional work, its
 * disbursement — to the canonical financial picture of a booking. Every surface
 * projects from it: the customer's payment screen, the provider's earnings, the
 * admin's reconciliation. Before this, each of those recomputed the same numbers
 * from the same columns and disagreed: `/provider/ledger` hardcoded "settled",
 * `/provider/earnings/summary` counted PROCESSING nowhere, the dashboard summed
 * `final_price` and reported a provider's take as 125% of their pay. Those were
 * fixed one endpoint at a time, which is why they kept recurring. A single
 * function cannot disagree with itself.
 *
 * It is PURE, and deliberately so. It takes a row and returns a projection, so
 * the test suite can exercise every economic case — internal fixer, refund in
 * flight, additional work, failed payout — without a database.
 *
 * **`recordLedgerEvent` is the log.** §74 requires provider earnings to derive
 * from immutable, traceable financial events after eligible booking milestones,
 * never from summing UI cards. `finance_ledger_events` is that record: one row
 * per financial fact, append-only, enforced by a trigger rather than by
 * convention, and idempotent on `event_key` so a webhook retry or a double-click
 * cannot record the same money twice.
 *
 * ## Why the calculator is the truth and the log is the evidence
 *
 * The only database this repository can reach is production, which this work is
 * forbidden to touch — so the event log necessarily starts empty and can only
 * ever cover money that moves from here on. If earnings read the log alone,
 * every provider's history would vanish on the day this shipped. So the
 * calculator derives from the source rows, which exist for all history, and the
 * log records each event as it happens.
 *
 * That is not two truths. They are checked against each other:
 * `LEDGER_EVENT_AMOUNT_MISMATCH` in the reconciliation catalog fails when a
 * recorded event disagrees with what the calculator derives from the same rows,
 * and `COMPLETED_BOOKING_WITHOUT_EARNING` fails when a milestone passed and no
 * event was written. The log is how the calculator is audited; the calculator is
 * how the log stays complete.
 *
 * ## Nothing here moves money
 *
 * `disbursement.service` and `refund.service` remain the only code that calls a
 * processor. This module records what they did and computes what is owed.
 */

import dbQuery from '../../db/dbQuery';
import { db } from '../../config';
import {
  CURRENCY,
  LEDGER_EVENTS,
  PAYMENT_STATES,
  PROVIDER_ECONOMIC_MODELS,
  economicModelFor,
  evaluatePayoutEligibility,
  isCaptured,
  normalizePaymentState,
  splitFor,
  toCentavos,
  toMinorUnits,
  type LedgerEventType,
  type PaymentState,
  type PayoutBlockReason,
  type ProviderEconomicModel,
} from './financePolicy';
import { canonicalPayoutStatus, type PayoutStatus } from '../payoutStatus';

const s = db.schema;

export type Runner = { query: (sql: string, params?: any[]) => Promise<any> };

// ─── Schema ───────────────────────────────────────────────────────────────────

let ensured: Promise<void> | null = null;

/**
 * Creates the event log.
 *
 * Memoised on the PROMISE, not on a boolean, so two concurrent first requests
 * await one DDL run rather than racing two — the same rule
 * `booking/experienceStore.ensureExperienceSchema` follows, and for the same
 * reason: the only reachable database is production, so a migration file alone
 * has the failure mode of code shipping before its DDL.
 * `scripts/migrations/031-finance-ledger.sql` carries the identical statements
 * for the controlled path; both are `IF NOT EXISTS`, so whichever runs first
 * wins and the other is a no-op.
 *
 * A failure THROWS. There is no safe degraded mode for a financial audit log —
 * an event that is silently not recorded is indistinguishable from money that
 * never moved.
 */
export async function ensureFinanceLedgerSchema(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await dbQuery.query(
        `CREATE TABLE IF NOT EXISTS ${s}.finance_ledger_events (
           id                    BIGSERIAL PRIMARY KEY,
           event_key             TEXT NOT NULL,
           event_type            TEXT NOT NULL,
           booking_id            INTEGER NOT NULL,
           payment_id            INTEGER,
           disbursement_id       INTEGER,
           additional_request_id INTEGER,
           provider_uid          TEXT,
           customer_uid          TEXT,
           counterparty          TEXT NOT NULL,
           direction             TEXT NOT NULL,
           amount                NUMERIC(12,2) NOT NULL DEFAULT 0,
           currency              TEXT NOT NULL DEFAULT '${CURRENCY}',
           economic_model        TEXT,
           reason_code           TEXT,
           processor_reference   TEXT,
           detail                JSONB,
           occurred_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           recorded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
        [],
      );

      /**
       * The idempotency key, and the reason the writers can be careless.
       *
       * Every caller composes a key from the FACT, not from the attempt —
       * `payment:47:captured`, not `payment:47:captured:try-3`. A PayMongo
       * webhook retry, a double-clicked admin approval and a scheduler that runs
       * twice in one hour all compose the same key and produce one row.
       */
      await dbQuery.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS finance_ledger_event_key_uidx
           ON ${s}.finance_ledger_events (event_key)`,
        [],
      );

      for (const [name, columns] of [
        ['finance_ledger_booking_idx', 'booking_id'],
        ['finance_ledger_provider_idx', 'provider_uid'],
        ['finance_ledger_type_idx', 'event_type'],
        ['finance_ledger_occurred_idx', 'occurred_at DESC'],
      ] as Array<[string, string]>) {
        await dbQuery.query(
          `CREATE INDEX IF NOT EXISTS ${name} ON ${s}.finance_ledger_events (${columns})`,
          [],
        );
      }

      /**
       * Append-only, enforced by the database.
       *
       * "Immutable" as a code convention means "immutable until someone writes an
       * UPDATE". §78 asks for row-level audit of the financial record; a record
       * that can be edited is not audit, it is a draft. The trigger refuses both
       * UPDATE and DELETE — a correction is a new compensating event, which is
       * how ledgers have always worked.
       */
      await dbQuery.query(
        `CREATE OR REPLACE FUNCTION ${s}.finance_ledger_events_append_only()
         RETURNS TRIGGER AS $$
         BEGIN
           RAISE EXCEPTION
             'finance_ledger_events is append-only: % on row % is refused. Record a compensating event instead.',
             TG_OP, COALESCE(OLD.id, NEW.id);
         END;
         $$ LANGUAGE plpgsql`,
        [],
      );
      await dbQuery.query(
        `DROP TRIGGER IF EXISTS trg_finance_ledger_append_only ON ${s}.finance_ledger_events`,
        [],
      );
      await dbQuery.query(
        `CREATE TRIGGER trg_finance_ledger_append_only
           BEFORE UPDATE OR DELETE ON ${s}.finance_ledger_events
           FOR EACH ROW EXECUTE FUNCTION ${s}.finance_ledger_events_append_only()`,
        [],
      );
    })().catch((error) => {
      // Do not memoise a failure — the next request must retry rather than
      // inherit a permanently broken ledger for the life of the process.
      ensured = null;
      throw error;
    });
  }
  return ensured;
}

// ─── Writing events ───────────────────────────────────────────────────────────

export interface LedgerEventInput {
  /** Composed from the FACT, never from the attempt. See the unique index above. */
  eventKey: string;
  type: LedgerEventType;
  bookingId: number;
  paymentId?: number | null;
  disbursementId?: number | null;
  additionalRequestId?: number | null;
  providerUid?: string | null;
  customerUid?: string | null;
  amount?: unknown;
  economicModel?: ProviderEconomicModel | null;
  /** Why, for the events that record a decision rather than a movement. */
  reasonCode?: string | null;
  /** The processor's id. Never disclosed to a provider or customer. */
  processorReference?: string | null;
  detail?: unknown;
  occurredAt?: Date | string | null;
}

/**
 * Records one financial fact. Returns whether this call created the row.
 *
 * `false` is a normal, successful outcome: it means the event was already
 * recorded, which is exactly what a retried webhook should produce.
 *
 * `runner` lets a caller pass the client of an open transaction so the event and
 * the state change it describes commit together. The webhook does this — a
 * payment marked PAID whose capture event was lost to a crash between two
 * statements is precisely the break reconciliation would then have to explain.
 */
export async function recordLedgerEvent(
  input: LedgerEventInput,
  runner: Runner = dbQuery,
): Promise<boolean> {
  const spec = LEDGER_EVENTS[input.type];
  if (!spec) throw new Error(`financeLedger: unknown event type ${String(input.type)}`);

  const amount = toCentavos(input.amount);
  if (spec.monetary && amount < 0) {
    throw new Error(`financeLedger: ${input.type} cannot carry a negative amount`);
  }

  const result = await runner.query(
    `INSERT INTO ${s}.finance_ledger_events
       (event_key, event_type, booking_id, payment_id, disbursement_id,
        additional_request_id, provider_uid, customer_uid, counterparty, direction,
        amount, currency, economic_model, reason_code, processor_reference, detail, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,COALESCE($17, NOW()))
     ON CONFLICT (event_key) DO NOTHING
     RETURNING id`,
    [
      input.eventKey,
      input.type,
      input.bookingId,
      input.paymentId ?? null,
      input.disbursementId ?? null,
      input.additionalRequestId ?? null,
      input.providerUid ?? null,
      input.customerUid ?? null,
      spec.counterparty,
      spec.direction,
      amount,
      CURRENCY,
      input.economicModel ?? null,
      input.reasonCode ?? null,
      input.processorReference ?? null,
      input.detail == null ? null : JSON.stringify(input.detail),
      input.occurredAt ?? null,
    ],
  );
  return Number(result?.rowCount ?? 0) > 0;
}

/**
 * Records an event without letting a logging failure break the operation.
 *
 * Used ONLY where the caller has already completed an irreversible act — money
 * has moved at the processor — and failing the request afterwards would leave
 * the caller believing it did not. The missing event is then found by
 * `COMPLETED_BOOKING_WITHOUT_EARNING` or `PAYOUT_WITHOUT_EARNING` on the next
 * reconciliation run, which is the whole reason those checks exist.
 *
 * Anywhere the event can share a transaction with the state change, use
 * `recordLedgerEvent` directly instead.
 */
export async function recordLedgerEventBestEffort(
  input: LedgerEventInput,
  runner: Runner = dbQuery,
): Promise<boolean> {
  try {
    await ensureFinanceLedgerSchema();
    return await recordLedgerEvent(input, runner);
  } catch (error) {
    console.error(`[finance-ledger] failed to record ${input.type} for booking ${input.bookingId}:`, error);
    return false;
  }
}

/** The stable key shapes. Centralised so two writers cannot key the same fact differently. */
export const eventKeys = {
  paymentCaptured: (paymentId: number) => `payment:${paymentId}:captured`,
  additionalWorkCaptured: (paymentId: number) => `payment:${paymentId}:additional-captured`,
  paymentRefunded: (paymentId: number, attempt: number) => `payment:${paymentId}:refunded:${attempt}`,
  earningAccrued: (bookingId: number, providerUid: string) => `booking:${bookingId}:earning:${providerUid}`,
  earningWithheld: (bookingId: number, providerUid: string) => `booking:${bookingId}:withheld:${providerUid}`,
  internalFixerRevenue: (bookingId: number) => `booking:${bookingId}:internal-fixer-revenue`,
  payoutReleased: (disbursementId: number) => `disbursement:${disbursementId}:released`,
  payoutFailed: (disbursementId: number, attempt: number) => `disbursement:${disbursementId}:failed:${attempt}`,
} as const;

// ─── The calculator ───────────────────────────────────────────────────────────

/**
 * The raw shape every reader selects.
 *
 * Named as a type rather than assembled ad hoc so a reader cannot quietly omit a
 * column and get a different answer — `additionalPaid` missing is exactly how
 * the earnings screens came to show a booking amount the provider share was
 * visibly not 80% of.
 */
export interface BookingFinanceRow {
  bookingId: number;
  bookingStatus?: string | null;
  /** `final_price`, falling back to `quoted_price` the way checkout does. */
  finalPrice?: unknown;
  /** SUM of PAID additional-work payments. See `earningsBasis.paidAdditionalWorkSql`. */
  additionalPaid?: unknown;
  paymentId?: number | null;
  paymentStatus?: unknown;
  paymentMethod?: string | null;
  paidAt?: string | Date | null;
  refundedAmount?: unknown;
  refundedAt?: string | Date | null;
  providerUid?: string | null;
  isInternalFixer?: boolean | null;
  assignmentCompletedAt?: string | Date | null;
  /** The authoritative provider share, when a disbursement row exists. */
  disbursementId?: number | null;
  workerShare?: unknown;
  servanaShare?: unknown;
  payoutStatus?: unknown;
  releasedAt?: string | Date | null;
  holdReason?: string | null;
  holdUntil?: string | Date | null;
}

export interface BookingFinance {
  bookingId: number;
  currency: typeof CURRENCY;

  /** What the customer was charged, in full. Base price plus PAID additional work. */
  gross: number;
  basePrice: number;
  additionalWork: number;

  payment: {
    paymentId: number | null;
    state: PaymentState;
    captured: boolean;
    method: string | null;
    paidAt: string | null;
    refundedAmount: number;
    refundedAt: string | null;
    /** Still returnable. Captured minus already refunded, never below zero. */
    refundable: number;
  };

  provider: {
    uid: string | null;
    economicModel: ProviderEconomicModel;
    /** What the provider is owed. Zero for an internal fixer, always. */
    payable: number;
    /** Whether `payable` came from a disbursement row or was derived. */
    isEstimate: boolean;
    /** Present when the model earns nothing, so a zero is never unexplained. */
    withheldReason: string | null;
  };

  servana: {
    /** Everything not owed to the provider. The whole gross for an internal fixer. */
    revenue: number;
    commissionRate: number;
  };

  payout: {
    disbursementId: number | null;
    status: PayoutStatus;
    releasedAt: string | null;
    eligible: boolean;
    blockedBy: PayoutBlockReason | null;
    blockedReason: string | null;
    /** When the 72-hour window closes. */
    eligibleAt: string | null;
  };
}

const iso = (value: unknown): string | null => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * THE financial calculator. Pure, total, and the only place these numbers exist.
 *
 * Two rules it encodes that were each previously a per-endpoint decision:
 *
 *   1. **The gross includes paid additional work.** On-site upsell is charged
 *      through its own checkout and never writes back to `bookings.final_price`,
 *      so any reader treating `final_price` as the gross silently drops it.
 *      `createDisbursement` always knew; the readers did not.
 *   2. **A recorded share beats a derived one.** Where a disbursement exists its
 *      `worker_share` is the authoritative figure and is used as-is. Only a
 *      completed booking with no disbursement row yet is derived, and it is
 *      flagged `isEstimate` rather than presented beside settled fact as though
 *      it were one.
 *
 * The internal fixer case overrides both: their payable is zero regardless of
 * what any disbursement row says, because a row that exists for one of them is
 * the `INTERNAL_FIXER_JOB_WITH_PROVIDER_PAYOUT` break, and reporting its amount
 * as earnings would show a salaried employee money they will never receive.
 */
export function computeBookingFinance(
  row: BookingFinanceRow,
  options: { now?: Date; hasBankAccount?: boolean } = {},
): BookingFinance {
  const basePrice = toCentavos(row.finalPrice);
  const additionalWork = toCentavos(row.additionalPaid);
  const gross = toCentavos(basePrice + additionalWork);

  const paymentState = normalizePaymentState(row.paymentStatus);
  const captured = isCaptured(paymentState);
  const refundedAmount = toCentavos(row.refundedAmount);

  const economicModel = economicModelFor({ isInternalFixer: row.isInternalFixer });
  const modelSpec = PROVIDER_ECONOMIC_MODELS[economicModel];

  // The recorded share, when there is one and the model may hold one.
  const recordedShare =
    modelSpec.earnsJobShare && row.workerShare != null ? toCentavos(row.workerShare) : null;
  const derived = splitFor(economicModel, gross);
  const payable = recordedShare ?? derived.providerPayable;
  const servanaRevenue = recordedShare != null
    ? toCentavos(gross - recordedShare)
    : derived.servanaRevenue;

  const payoutStatus = canonicalPayoutStatus(row.payoutStatus);
  const eligibility = evaluatePayoutEligibility({
    economicModel,
    assignmentCompletedAt: row.assignmentCompletedAt ?? null,
    paymentState,
    providerPayable: payable,
    holdReason: row.holdReason ?? null,
    holdUntil: (row.holdUntil as Date | string | null) ?? null,
    alreadyReleased: payoutStatus === 'paid',
    hasBankAccount: options.hasBankAccount,
    now: options.now,
  });

  return {
    bookingId: Number(row.bookingId),
    currency: CURRENCY,
    gross,
    basePrice,
    additionalWork,
    payment: {
      paymentId: row.paymentId == null ? null : Number(row.paymentId),
      state: paymentState,
      captured,
      method: row.paymentMethod ? String(row.paymentMethod).toLowerCase() : null,
      paidAt: iso(row.paidAt),
      refundedAmount,
      refundedAt: iso(row.refundedAt),
      refundable: captured ? Math.max(0, toCentavos(gross - refundedAmount)) : 0,
    },
    provider: {
      uid: row.providerUid ?? null,
      economicModel,
      payable: modelSpec.earnsJobShare ? payable : 0,
      isEstimate: modelSpec.earnsJobShare && recordedShare == null,
      withheldReason: modelSpec.earnsJobShare ? null : modelSpec.earningsDisclosure,
    },
    servana: {
      revenue: modelSpec.earnsJobShare ? servanaRevenue : gross,
      commissionRate: derived.commissionRate,
    },
    payout: {
      disbursementId: row.disbursementId == null ? null : Number(row.disbursementId),
      status: payoutStatus,
      releasedAt: iso(row.releasedAt),
      eligible: eligibility.eligible,
      blockedBy: eligibility.reason,
      blockedReason: eligibility.message,
      eligibleAt: eligibility.eligibleAt,
    },
  };
}

/** Minor-unit mirror, for DTOs that carry integers. */
export const asMinorUnits = (finance: BookingFinance) => ({
  gross: toMinorUnits(finance.gross),
  basePrice: toMinorUnits(finance.basePrice),
  additionalWork: toMinorUnits(finance.additionalWork),
  providerPayable: toMinorUnits(finance.provider.payable),
  servanaRevenue: toMinorUnits(finance.servana.revenue),
  refundedAmount: toMinorUnits(finance.payment.refundedAmount),
  refundable: toMinorUnits(finance.payment.refundable),
});

// ─── Reading the source rows ──────────────────────────────────────────────────

/**
 * The SELECT every reader shares.
 *
 * A fragment rather than a view: the repository has no applied-migration path to
 * production, so a view would be one more object that may or may not exist.
 * Callers add their own WHERE and ORDER BY; the columns and the joins are fixed
 * here so two readers cannot join `payments` differently and get different
 * answers for one booking.
 *
 * `additional_request_id IS NULL` on the payment join is load-bearing: a booking
 * carrying both a base payment and an additional-work payment otherwise fans out
 * to several rows, and a reader taking rows[0] can report the additional
 * charge's status as the booking's.
 */
export const bookingFinanceSelect = (schema: string | undefined, providerParam?: string): string => `
  SELECT b.id                             AS booking_id,
         b.status                         AS booking_status,
         b.schedule,
         so.level_2                       AS service_name,
         COALESCE(b.final_price, b.quoted_price) AS final_price,
         b.payment_method,
         b.worker_uid                     AS provider_uid,
         b.user_id                        AS customer_uid,
         COALESCE(uc.is_internal_fixer, false) AS is_internal_fixer,
         p.id                             AS payment_id,
         p.status                         AS payment_status,
         p.paid_at,
         COALESCE(p.refunded_amount, 0)   AS refunded_amount,
         p.refunded_at,
         bw.completed_at                  AS assignment_completed_at,
         d.id                             AS disbursement_id,
         d.worker_share,
         d.servana_share,
         d.status                         AS payout_status,
         d.released_at,
         d.hold_reason,
         d.hold_until,
         COALESCE((
           SELECT SUM(p_add.amount)
             FROM ${schema}.payments p_add
            WHERE p_add.booking_id = b.id
              AND p_add.additional_request_id IS NOT NULL
              AND p_add.status = 'PAID'
         ), 0)                            AS additional_paid
    FROM ${schema}.bookings b
    LEFT JOIN ${schema}.service_options so ON so.id = b.service_option_id
    LEFT JOIN ${schema}.user_credentials uc ON uc.uid = b.worker_uid
    LEFT JOIN ${schema}.payments p
           ON p.booking_id = b.id AND p.additional_request_id IS NULL
    LEFT JOIN ${schema}.booking_workers bw
           ON bw.booking_id = b.id AND bw.worker_uid = ${providerParam ?? 'b.worker_uid'}
    LEFT JOIN ${schema}.disbursements d
           ON d.booking_id = b.id AND d.worker_uid = ${providerParam ?? 'b.worker_uid'}`;

/** Maps a database row onto the calculator's input. One mapping, every reader. */
export const toBookingFinanceRow = (r: any): BookingFinanceRow => ({
  bookingId: Number(r.booking_id ?? r.id),
  bookingStatus: r.booking_status ?? r.status ?? null,
  finalPrice: r.final_price,
  additionalPaid: r.additional_paid,
  paymentId: r.payment_id ?? null,
  paymentStatus: r.payment_status,
  paymentMethod: r.payment_method ?? null,
  paidAt: r.paid_at ?? null,
  refundedAmount: r.refunded_amount,
  refundedAt: r.refunded_at ?? null,
  providerUid: r.provider_uid ?? null,
  isInternalFixer: r.is_internal_fixer === true,
  assignmentCompletedAt: r.assignment_completed_at ?? null,
  disbursementId: r.disbursement_id ?? null,
  workerShare: r.worker_share,
  servanaShare: r.servana_share,
  payoutStatus: r.payout_status,
  releasedAt: r.released_at ?? null,
  holdReason: r.hold_reason ?? null,
  holdUntil: r.hold_until ?? null,
});

/** The canonical financial picture of one booking, or null if it does not exist. */
export async function deriveBookingFinance(
  bookingId: number,
  options: { now?: Date } = {},
): Promise<{ finance: BookingFinance; customerUid: string | null } | null> {
  const result = await dbQuery.query(
    `${bookingFinanceSelect(s)} WHERE b.id = $1 LIMIT 1`,
    [bookingId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    finance: computeBookingFinance(toBookingFinanceRow(row), options),
    customerUid: row.customer_uid ?? null,
  };
}

/** Every recorded event for a booking, oldest first. The audit trail, unprojected. */
export async function listBookingLedgerEvents(bookingId: number): Promise<any[]> {
  await ensureFinanceLedgerSchema();
  const result = await dbQuery.query(
    `SELECT id, event_key, event_type, booking_id, payment_id, disbursement_id,
            additional_request_id, provider_uid, counterparty, direction, amount,
            currency, economic_model, reason_code, occurred_at, recorded_at
       FROM ${s}.finance_ledger_events
      WHERE booking_id = $1
      ORDER BY occurred_at ASC, id ASC`,
    [bookingId],
  );
  return result.rows;
}

// ─── Milestone writers ────────────────────────────────────────────────────────

/**
 * Records that a customer payment was captured.
 *
 * Called from every capture path — the PayMongo webhook, the admin GCash
 * approval and the cash confirmation. Before this, only the two ADMIN paths
 * wrote anything to a ledger at all (`adminFinanceService.createLedgerEntry`),
 * so online payments — the majority of Servana's volume — were absent from the
 * "revenue ledger" entirely and any reconciliation over it was reconciling a
 * minority of the money.
 */
export async function recordPaymentCaptured(
  input: {
    bookingId: number;
    paymentId: number;
    amount: unknown;
    additionalRequestId?: number | null;
    customerUid?: string | null;
    providerUid?: string | null;
    processorReference?: string | null;
    occurredAt?: Date | string | null;
  },
  runner: Runner = dbQuery,
): Promise<boolean> {
  const isAdditional = input.additionalRequestId != null;
  return recordLedgerEvent(
    {
      eventKey: isAdditional
        ? eventKeys.additionalWorkCaptured(input.paymentId)
        : eventKeys.paymentCaptured(input.paymentId),
      type: isAdditional ? 'ADDITIONAL_WORK_CAPTURED' : 'PAYMENT_CAPTURED',
      bookingId: input.bookingId,
      paymentId: input.paymentId,
      additionalRequestId: input.additionalRequestId ?? null,
      customerUid: input.customerUid ?? null,
      providerUid: input.providerUid ?? null,
      amount: input.amount,
      processorReference: input.processorReference ?? null,
      occurredAt: input.occurredAt ?? null,
    },
    runner,
  );
}

/** Records that captured funds went back to the customer. */
export async function recordPaymentRefunded(
  input: {
    bookingId: number;
    paymentId: number;
    refundAttempt: number;
    amount: unknown;
    customerUid?: string | null;
    processorReference?: string | null;
    reasonCode?: string | null;
  },
  runner: Runner = dbQuery,
): Promise<boolean> {
  return recordLedgerEvent(
    {
      eventKey: eventKeys.paymentRefunded(input.paymentId, input.refundAttempt),
      type: 'PAYMENT_REFUNDED',
      bookingId: input.bookingId,
      paymentId: input.paymentId,
      customerUid: input.customerUid ?? null,
      amount: input.amount,
      reasonCode: input.reasonCode ?? null,
      processorReference: input.processorReference ?? null,
    },
    runner,
  );
}

/**
 * Records what a completed job earned the provider — including when it earned
 * nothing, and why.
 *
 * The `WITHHELD` branch is the point. A completed internal-fixer job that simply
 * had no earning event would be indistinguishable from a completed job whose
 * accrual was dropped by a bug, and `COMPLETED_BOOKING_WITHOUT_EARNING` would
 * flag both. Writing an explained zero is what lets reconciliation tell the
 * designed case from the defect.
 */
export async function recordEarningOutcome(
  input: {
    bookingId: number;
    providerUid: string;
    economicModel: ProviderEconomicModel;
    payable: unknown;
    gross: unknown;
    disbursementId?: number | null;
    occurredAt?: Date | string | null;
  },
  runner: Runner = dbQuery,
): Promise<boolean> {
  const spec = PROVIDER_ECONOMIC_MODELS[input.economicModel];

  if (spec.earnsJobShare) {
    return recordLedgerEvent(
      {
        eventKey: eventKeys.earningAccrued(input.bookingId, input.providerUid),
        type: 'PROVIDER_EARNING_ACCRUED',
        bookingId: input.bookingId,
        providerUid: input.providerUid,
        disbursementId: input.disbursementId ?? null,
        amount: input.payable,
        economicModel: input.economicModel,
        detail: { gross: toCentavos(input.gross) },
        occurredAt: input.occurredAt ?? null,
      },
      runner,
    );
  }

  const withheld = await recordLedgerEvent(
    {
      eventKey: eventKeys.earningWithheld(input.bookingId, input.providerUid),
      type: 'PROVIDER_EARNING_WITHHELD',
      bookingId: input.bookingId,
      providerUid: input.providerUid,
      amount: 0,
      economicModel: input.economicModel,
      reasonCode: 'INTERNAL_FIXER_SALARIED',
      detail: { gross: toCentavos(input.gross), disclosure: spec.earningsDisclosure },
      occurredAt: input.occurredAt ?? null,
    },
    runner,
  );

  // The counterpart: the revenue that stayed with Servana instead of being split.
  // Recorded so internal fixer revenue is VISIBLE in the ledger rather than
  // merely absent from it — `internal_fixer_revenue.view` exists as a permission
  // precisely because that revenue is meant to be reportable.
  await recordLedgerEvent(
    {
      eventKey: eventKeys.internalFixerRevenue(input.bookingId),
      type: 'INTERNAL_FIXER_REVENUE_RETAINED',
      bookingId: input.bookingId,
      providerUid: input.providerUid,
      amount: input.gross,
      economicModel: input.economicModel,
      occurredAt: input.occurredAt ?? null,
    },
    runner,
  );

  return withheld;
}

/** Records that an accrued earning left Servana. */
export async function recordPayoutReleased(
  input: {
    bookingId: number;
    disbursementId: number;
    providerUid: string;
    amount: unknown;
    processorReference?: string | null;
  },
  runner: Runner = dbQuery,
): Promise<boolean> {
  return recordLedgerEvent(
    {
      eventKey: eventKeys.payoutReleased(input.disbursementId),
      type: 'PROVIDER_PAYOUT_RELEASED',
      bookingId: input.bookingId,
      disbursementId: input.disbursementId,
      providerUid: input.providerUid,
      amount: input.amount,
      processorReference: input.processorReference ?? null,
    },
    runner,
  );
}

/** Records a definitively rejected release attempt. The earning remains owed. */
export async function recordPayoutFailed(
  input: {
    bookingId: number;
    disbursementId: number;
    providerUid: string;
    attempt: number;
    reasonCode: string;
  },
  runner: Runner = dbQuery,
): Promise<boolean> {
  return recordLedgerEvent(
    {
      eventKey: eventKeys.payoutFailed(input.disbursementId, input.attempt),
      type: 'PROVIDER_PAYOUT_FAILED',
      bookingId: input.bookingId,
      disbursementId: input.disbursementId,
      providerUid: input.providerUid,
      amount: 0,
      reasonCode: input.reasonCode,
    },
    runner,
  );
}

/** Re-exported so consumers need one import for the vocabulary and the store. */
export { PAYMENT_STATES, LEDGER_EVENTS };
