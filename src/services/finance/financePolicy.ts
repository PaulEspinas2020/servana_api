/**
 * THE declaration of Servana's financial rules.
 *
 * ## Why this file exists
 *
 * The financial layer was already the most-split domain in the codebase. The
 * 80/20 split had twelve definitions before `revenueSplit.ts`; the payout status
 * had three dialects before `payoutStatus.ts`; the earnings gross had two before
 * `earningsBasis.ts`. Each of those extractions fixed ONE constant. What was
 * still missing was the layer above them — the rules that say WHO earns, WHEN
 * money becomes payable, WHAT a payment state means, and WHICH breaks a
 * reconciliation run must find. Those lived as behaviour scattered across a
 * payout scheduler, a webhook handler, two refund methods and nine inline SQL
 * checks, so no client and no auditor could read the policy anywhere.
 *
 * This module is the thing to read. Like `booking/experiencePolicy.ts` it is
 * pure data and pure functions — no database handle, no Express types, no side
 * effects — so that:
 *
 *   1. the services ENFORCE it,
 *   2. `scripts/generate-finance-docs.ts` EXECUTES it to write
 *      `docs/finance/FINANCE_V1_CONTRACT.md`, and
 *   3. the tests ASSERT against it
 *
 * all from one declaration. A policy described in prose beside its
 * implementation drifts; one that is derived cannot.
 *
 * ## What is deliberately NOT here
 *
 * The RATE. `revenueSplit.ts` owns the 80/20 split and the rounding boundary,
 * and it is imported below rather than restated — a second copy of a rate is the
 * exact defect that file was created to end. Likewise `payoutStatus.ts` owns the
 * 72-hour release window and the display dialects. This module composes those;
 * it does not replace them.
 *
 * Money movement, too. Nothing here calls a processor. The policy decides
 * whether an operation is permitted and what it is worth; `disbursement.service`
 * and `refund.service` remain the only code that moves funds.
 */

import {
  PROVIDER_SHARE_RATE,
  SERVANA_COMMISSION_RATE,
  providerShareOf,
  servanaShareOf,
} from '../revenueSplit';
import { PROVIDER_RELEASE_HOURS } from '../payoutStatus';

// ─── Money ────────────────────────────────────────────────────────────────────

/** The only currency Servana transacts in. Stated once so a DTO cannot invent another. */
export const CURRENCY = 'PHP' as const;

/** Round a PHP amount to centavos. Same boundary rule as `revenueSplit`. */
export const toCentavos = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

/** Minor units, for DTOs that carry integers rather than decimals. */
export const toMinorUnits = (value: unknown): number => Math.round(toCentavos(value) * 100);

// ─── Provider economics ───────────────────────────────────────────────────────

/**
 * How a provider is compensated for a job.
 *
 * These are not provider ROLES. Role 2 and role 4 both describe how a provider
 * signed up — and the two are already read inconsistently elsewhere in this
 * codebase (`adminProviderController` calls role 4 `internal_provider`,
 * `providerProfileComplianceService` calls it `organization_provider`). Neither
 * is a statement about pay. `user_credentials.is_internal_fixer` is, because it
 * is set deliberately by an admin through a permissioned, audited action
 * (`finance_internal_fixer_tagged`), and it is the only flag the reconciliation
 * engine has ever consulted for this question.
 */
export type ProviderEconomicModel = 'EXTERNAL_PROVIDER' | 'INTERNAL_FIXER';

export interface EconomicModelSpec {
  model: ProviderEconomicModel;
  /** Whether a completed job produces a per-job payable to the provider. */
  earnsJobShare: boolean;
  /** The provider's share of gross, or 0. Sourced from `revenueSplit`, never restated. */
  shareRate: number;
  /** Who the service revenue belongs to once captured. */
  revenueOwner: 'split' | 'servana';
  /** Whether a disbursement row may ever be created for this model. */
  payoutEligible: boolean;
  /** Shown to the provider in place of an amount when `earnsJobShare` is false. */
  earningsDisclosure: string;
  description: string;
}

/**
 * The two models, and the one that costs money to get wrong.
 *
 * INTERNAL_FIXER is a Servana employee. The service revenue from their jobs is
 * Servana's, and they are paid a salary through payroll — a system this backend
 * does not model and must not pretend to. Paying them a per-job 80% share on top
 * of a salary is paying twice for the same work.
 *
 * That is not a new rule invented here. The reconciliation engine has carried
 * `INTERNAL_FIXER_JOB_WITH_PROVIDER_PAYOUT` at severity `critical` since it was
 * written, with the description "should be NOT_APPLICABLE", and the permission
 * registry carries `internal_fixer_revenue.view` as a distinct sensitive
 * permission. The rule was declared in two places and enforced in none:
 * `createDisbursement` had no internal-fixer branch, so every such job created a
 * PENDING payout that the hourly scheduler then released, and the reconciliation
 * run flagged it afterwards as a critical break that could not be closed because
 * nothing upstream would stop the next one.
 *
 * `financeLedger.accrueProviderEarning` now refuses at the writer. The
 * reconciliation check stays — it is the detector for rows created before this,
 * and for anyone tagged as an internal fixer after their payouts already exist.
 */
export const PROVIDER_ECONOMIC_MODELS: Readonly<Record<ProviderEconomicModel, EconomicModelSpec>> =
  Object.freeze({
    EXTERNAL_PROVIDER: {
      model: 'EXTERNAL_PROVIDER',
      earnsJobShare: true,
      shareRate: PROVIDER_SHARE_RATE,
      revenueOwner: 'split',
      payoutEligible: true,
      earningsDisclosure: 'Provider share of the job, released after the payout window.',
      description:
        'A marketplace provider. Earns the standard provider share of everything ' +
        'the customer was charged for the booking, including paid additional work.',
    },
    INTERNAL_FIXER: {
      model: 'INTERNAL_FIXER',
      earnsJobShare: false,
      shareRate: 0,
      revenueOwner: 'servana',
      payoutEligible: false,
      earningsDisclosure:
        'Not applicable — internal fixer work is salaried. Service revenue belongs to Servana.',
      description:
        'A salaried Servana fixer. Service revenue is Servana\'s in full and ' +
        'compensation is payroll, which this backend does not model. No per-job ' +
        'commission is calculated, recorded or paid.',
    },
  });

export const PROVIDER_ECONOMIC_MODEL_NAMES: readonly ProviderEconomicModel[] = Object.freeze([
  'EXTERNAL_PROVIDER',
  'INTERNAL_FIXER',
]);

/**
 * Which model applies to a provider.
 *
 * Takes the flag rather than a uid so this module keeps no database handle —
 * every caller already has the row, and a lookup here would make the policy
 * untestable without a database.
 */
export const economicModelFor = (provider: {
  isInternalFixer?: boolean | null;
}): ProviderEconomicModel =>
  provider?.isInternalFixer === true ? 'INTERNAL_FIXER' : 'EXTERNAL_PROVIDER';

/** What the provider is owed for a gross amount under their model. */
export const providerPayableFor = (model: ProviderEconomicModel, gross: unknown): number =>
  PROVIDER_ECONOMIC_MODELS[model].earnsJobShare ? providerShareOf(toCentavos(gross)) : 0;

/**
 * What Servana retains from a gross amount under the provider's model.
 *
 * Derived by SUBTRACTION for the split model so the two shares always add back
 * to the gross exactly — the same reasoning `splitRevenue` gives for not
 * rounding both sides independently.
 */
export const servanaRevenueFor = (model: ProviderEconomicModel, gross: unknown): number => {
  const total = toCentavos(gross);
  return PROVIDER_ECONOMIC_MODELS[model].earnsJobShare
    ? servanaShareOf(total)
    : total;
};

/** Both sides at once, guaranteed to sum to the gross. */
export const splitFor = (
  model: ProviderEconomicModel,
  gross: unknown,
): { gross: number; providerPayable: number; servanaRevenue: number; commissionRate: number } => {
  const total = toCentavos(gross);
  const providerPayable = providerPayableFor(model, total);
  return {
    gross: total,
    providerPayable,
    servanaRevenue: toCentavos(total - providerPayable),
    commissionRate: PROVIDER_ECONOMIC_MODELS[model].earnsJobShare ? SERVANA_COMMISSION_RATE : 1,
  };
};

// ─── Payment state model ──────────────────────────────────────────────────────

/**
 * Every state `payments.status` can hold.
 *
 * Taken from the writers, not invented: `paymentService` writes PENDING, PAID
 * and FAILED, `refund.service` writes REFUNDING and REFUNDED, and
 * `adminFinanceService.rejectGcashPayment` writes REJECTED. A vocabulary richer
 * than the column would describe states no query can ever return.
 */
export type PaymentState = 'PENDING' | 'PAID' | 'FAILED' | 'REJECTED' | 'REFUNDING' | 'REFUNDED';

export interface PaymentStateSpec {
  state: PaymentState;
  /** Money has reached Servana and has not been fully returned. */
  captured: boolean;
  /** No further transition is possible. */
  terminal: boolean;
  /** Whether a provider earning may accrue against a booking in this state. */
  earningsEligible: boolean;
  description: string;
}

/**
 * Payment state is SEPARATE from booking state and linked to it, never merged.
 *
 * The webhook's own comment makes the rule explicit: "payments.status is
 * settlement truth; bookings.status remains the service lifecycle and is
 * deliberately untouched." A booking can be COMPLETED and unpaid (cash awaiting
 * confirmation) or paid and cancelled (refund pending). Collapsing the two
 * would make one of those unrepresentable.
 */
export const PAYMENT_STATES: Readonly<Record<PaymentState, PaymentStateSpec>> = Object.freeze({
  PENDING: {
    state: 'PENDING',
    captured: false,
    terminal: false,
    earningsEligible: false,
    description: 'Awaiting the customer, the processor, or an admin review.',
  },
  PAID: {
    state: 'PAID',
    captured: true,
    terminal: false,
    earningsEligible: true,
    description: 'Funds captured. The only state a provider earning may accrue from.',
  },
  FAILED: {
    state: 'FAILED',
    captured: false,
    terminal: false,
    earningsEligible: false,
    description: 'The processor declined or abandoned the charge. A new attempt may be started.',
  },
  REJECTED: {
    state: 'REJECTED',
    captured: false,
    terminal: true,
    earningsEligible: false,
    description: 'An admin refused a manually submitted proof of payment.',
  },
  REFUNDING: {
    state: 'REFUNDING',
    captured: true,
    terminal: false,
    earningsEligible: false,
    description:
      'A refund has been claimed against captured funds and its outcome is not yet known. ' +
      'Still captured: the money has not come back yet, and treating it as returned would ' +
      'permit a second refund of the same charge.',
  },
  REFUNDED: {
    state: 'REFUNDED',
    captured: false,
    terminal: true,
    earningsEligible: false,
    description: 'Funds returned to the customer and confirmed by the processor.',
  },
});

export const PAYMENT_STATE_NAMES: readonly PaymentState[] = Object.freeze([
  'PENDING',
  'PAID',
  'FAILED',
  'REJECTED',
  'REFUNDING',
  'REFUNDED',
]);

/**
 * The transitions the writers actually perform.
 *
 * Note the two that are deliberately absent. REFUNDED never returns to PAID —
 * the webhook's failure handling says so ("Failure is monotonic"). And FAILED
 * never reaches REFUNDED directly, because there is nothing captured to return.
 * `REFUNDING → PAID` IS present: `refund.service` restores it when the processor
 * DEFINITELY rejected the refund, and only then.
 */
export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentState, readonly PaymentState[]>> =
  Object.freeze({
    PENDING: Object.freeze(['PAID', 'FAILED', 'REJECTED'] as PaymentState[]),
    PAID: Object.freeze(['REFUNDING'] as PaymentState[]),
    FAILED: Object.freeze(['PENDING', 'PAID'] as PaymentState[]),
    REJECTED: Object.freeze([] as PaymentState[]),
    REFUNDING: Object.freeze(['REFUNDED', 'PAID'] as PaymentState[]),
    REFUNDED: Object.freeze([] as PaymentState[]),
  });

export const canTransitionPayment = (from: PaymentState, to: PaymentState): boolean =>
  PAYMENT_TRANSITIONS[from].includes(to);

/** Unknown input is PENDING — the state that permits the least. */
export const normalizePaymentState = (raw: unknown): PaymentState => {
  const value = String(raw ?? '').trim().toUpperCase();
  return (PAYMENT_STATE_NAMES as readonly string[]).includes(value)
    ? (value as PaymentState)
    : 'PENDING';
};

export const isCaptured = (raw: unknown): boolean =>
  PAYMENT_STATES[normalizePaymentState(raw)].captured;

export const isEarningsEligible = (raw: unknown): boolean =>
  PAYMENT_STATES[normalizePaymentState(raw)].earningsEligible;

// ─── The ledger event catalog ─────────────────────────────────────────────────

/**
 * Every financial fact the platform records.
 *
 * These are EVENTS, not balances. A balance can be recomputed and quietly
 * disagree with what was shown yesterday; an append-only event cannot. §74
 * requires provider earnings to derive from immutable, traceable financial
 * events after eligible booking milestones, and this catalog is the closed set
 * of those events.
 */
export type LedgerEventType =
  | 'PAYMENT_CAPTURED'
  | 'ADDITIONAL_WORK_CAPTURED'
  | 'PAYMENT_REFUNDED'
  | 'PROVIDER_EARNING_ACCRUED'
  | 'PROVIDER_EARNING_WITHHELD'
  | 'PROVIDER_PAYOUT_RELEASED'
  | 'PROVIDER_PAYOUT_FAILED'
  | 'INTERNAL_FIXER_REVENUE_RETAINED';

export interface LedgerEventSpec {
  type: LedgerEventType;
  /** Whose ledger the amount moves on. */
  counterparty: 'customer' | 'provider' | 'servana';
  /** Sign, from the counterparty's point of view. */
  direction: 'credit' | 'debit';
  /** Whether the event carries money, or only records a decision. */
  monetary: boolean;
  /** The booking milestone that makes this event legitimate. */
  milestone: string;
  description: string;
}

export const LEDGER_EVENTS: Readonly<Record<LedgerEventType, LedgerEventSpec>> = Object.freeze({
  PAYMENT_CAPTURED: {
    type: 'PAYMENT_CAPTURED',
    counterparty: 'servana',
    direction: 'credit',
    monetary: true,
    milestone: 'payments.status → PAID',
    description: 'The customer\'s booking charge reached Servana.',
  },
  ADDITIONAL_WORK_CAPTURED: {
    type: 'ADDITIONAL_WORK_CAPTURED',
    counterparty: 'servana',
    direction: 'credit',
    monetary: true,
    milestone: 'payments.status → PAID with additional_request_id set',
    description:
      'On-site additional work was paid. Recorded separately because it is charged ' +
      'through its own checkout and never writes back to bookings.final_price.',
  },
  PAYMENT_REFUNDED: {
    type: 'PAYMENT_REFUNDED',
    counterparty: 'customer',
    direction: 'credit',
    monetary: true,
    milestone: 'payments.status → REFUNDED',
    description: 'Captured funds were returned to the customer and the processor confirmed it.',
  },
  PROVIDER_EARNING_ACCRUED: {
    type: 'PROVIDER_EARNING_ACCRUED',
    counterparty: 'provider',
    direction: 'credit',
    monetary: true,
    milestone: 'booking_workers.status → COMPLETED',
    description: 'The provider became owed their share of the job. Not yet paid.',
  },
  PROVIDER_EARNING_WITHHELD: {
    type: 'PROVIDER_EARNING_WITHHELD',
    counterparty: 'provider',
    direction: 'credit',
    monetary: false,
    milestone: 'booking_workers.status → COMPLETED',
    description:
      'A completed job produced no provider payable, and why. Written so a job with no ' +
      'earning is an explained zero rather than a gap in the record.',
  },
  PROVIDER_PAYOUT_RELEASED: {
    type: 'PROVIDER_PAYOUT_RELEASED',
    counterparty: 'provider',
    direction: 'debit',
    monetary: true,
    milestone: 'disbursements.status → RELEASED',
    description: 'The accrued earning left Servana toward the provider\'s bank account.',
  },
  PROVIDER_PAYOUT_FAILED: {
    type: 'PROVIDER_PAYOUT_FAILED',
    counterparty: 'provider',
    direction: 'debit',
    monetary: false,
    milestone: 'disbursements.status → FAILED',
    description: 'A release attempt was definitively rejected. The earning remains owed.',
  },
  INTERNAL_FIXER_REVENUE_RETAINED: {
    type: 'INTERNAL_FIXER_REVENUE_RETAINED',
    counterparty: 'servana',
    direction: 'credit',
    monetary: true,
    milestone: 'booking_workers.status → COMPLETED on an internal fixer job',
    description:
      'The full service revenue of an internal fixer job stayed with Servana. The ' +
      'counterpart to the per-job commission that is deliberately not calculated.',
  },
});

export const LEDGER_EVENT_NAMES: readonly LedgerEventType[] = Object.freeze(
  Object.keys(LEDGER_EVENTS) as LedgerEventType[],
);

// ─── Payout policy ────────────────────────────────────────────────────────────

/**
 * Hours between completion and release.
 *
 * Re-exported from `payoutStatus.ts` rather than declared, so the policy, the
 * release scheduler and the expected-arrival date every earnings screen shows
 * are one number. Provider Web once restated it as 48 against a scheduler that
 * released at 72 and told providers their money was due a day early; a second
 * declaration here would be the same defect with a newer file name.
 */
export const PROVIDER_PAYOUT_WINDOW_HOURS = PROVIDER_RELEASE_HOURS;

export type PayoutBlockReason =
  | 'JOB_NOT_COMPLETED'
  | 'PAYMENT_NOT_CAPTURED'
  | 'WITHIN_PAYOUT_WINDOW'
  | 'ADMIN_HOLD'
  | 'NO_BANK_ACCOUNT'
  | 'INTERNAL_FIXER_SALARIED'
  | 'AMOUNT_NOT_POSITIVE'
  | 'ALREADY_RELEASED'
  | 'REFUND_ACTIVE';

export const PAYOUT_BLOCK_REASONS: Readonly<Record<PayoutBlockReason, string>> = Object.freeze({
  JOB_NOT_COMPLETED: 'The assignment has not been completed.',
  PAYMENT_NOT_CAPTURED: 'The customer payment for this booking has not been captured.',
  WITHIN_PAYOUT_WINDOW: `Inside the ${PROVIDER_PAYOUT_WINDOW_HOURS}-hour payout window that follows completion.`,
  ADMIN_HOLD: 'An admin placed a hold on this payout.',
  NO_BANK_ACCOUNT: 'The provider has no registered payout account.',
  INTERNAL_FIXER_SALARIED: 'Internal fixer work is salaried; no per-job payout is due.',
  AMOUNT_NOT_POSITIVE: 'The computed provider share is not a positive amount.',
  ALREADY_RELEASED: 'This payout has already been released.',
  REFUND_ACTIVE: 'A refund is in progress against this booking\'s payment.',
});

export interface PayoutEligibilityInput {
  economicModel: ProviderEconomicModel;
  assignmentCompletedAt: Date | string | null | undefined;
  paymentState: unknown;
  providerPayable: unknown;
  holdReason?: string | null;
  holdUntil?: Date | string | null;
  alreadyReleased?: boolean;
  hasBankAccount?: boolean;
  /** Injected so the decision is testable without freezing the clock globally. */
  now?: Date;
}

export interface PayoutEligibility {
  eligible: boolean;
  /** The FIRST reason that blocks release, in precedence order. Null when eligible. */
  reason: PayoutBlockReason | null;
  message: string | null;
  /** When the window closes. Null when there is no completion to measure from. */
  eligibleAt: string | null;
}

const asDate = (value: Date | string | null | undefined): Date | null => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Whether a provider share may be released, and if not, which rule refused.
 *
 * Ordered by precedence and returns the FIRST refusal rather than a list. A
 * provider told "your payout is held" needs the sentence that is actionable, and
 * an internal fixer must never be told they are merely waiting for a window that
 * will never produce a payment.
 *
 * The hold rule reproduces `processPendingDisbursements` exactly: a hold with no
 * expiry is indefinite, and a hold whose expiry has passed no longer blocks.
 * Restating it differently here would put a second opinion beside the scheduler.
 */
export const evaluatePayoutEligibility = (input: PayoutEligibilityInput): PayoutEligibility => {
  const now = input.now ?? new Date();
  const completedAt = asDate(input.assignmentCompletedAt);
  const eligibleAt = completedAt
    ? new Date(completedAt.getTime() + PROVIDER_PAYOUT_WINDOW_HOURS * 3_600_000)
    : null;

  const refuse = (reason: PayoutBlockReason): PayoutEligibility => ({
    eligible: false,
    reason,
    message: PAYOUT_BLOCK_REASONS[reason],
    eligibleAt: eligibleAt?.toISOString() ?? null,
  });

  if (!PROVIDER_ECONOMIC_MODELS[input.economicModel].payoutEligible) {
    return refuse('INTERNAL_FIXER_SALARIED');
  }
  if (input.alreadyReleased === true) return refuse('ALREADY_RELEASED');
  if (!completedAt) return refuse('JOB_NOT_COMPLETED');

  const paymentState = normalizePaymentState(input.paymentState);
  if (paymentState === 'REFUNDING' || paymentState === 'REFUNDED') return refuse('REFUND_ACTIVE');
  if (!PAYMENT_STATES[paymentState].earningsEligible) return refuse('PAYMENT_NOT_CAPTURED');

  if (toCentavos(input.providerPayable) <= 0) return refuse('AMOUNT_NOT_POSITIVE');

  if (input.holdReason) {
    const until = asDate(input.holdUntil);
    if (!until || until > now) return refuse('ADMIN_HOLD');
  }

  if (input.hasBankAccount === false) return refuse('NO_BANK_ACCOUNT');
  if (eligibleAt && eligibleAt > now) return refuse('WITHIN_PAYOUT_WINDOW');

  return { eligible: true, reason: null, message: null, eligibleAt: eligibleAt?.toISOString() ?? null };
};

// ─── Refund policy ────────────────────────────────────────────────────────────

export type RefundRefusal =
  | 'PAYMENT_NOT_FOUND'
  | 'PAYMENT_NOT_CAPTURED'
  | 'REFUND_ALREADY_SETTLED'
  | 'REFUND_IN_PROGRESS'
  | 'REFUND_EXCEEDS_CAPTURED'
  | 'AMOUNT_NOT_POSITIVE'
  | 'PROVIDER_NOT_PERMITTED'
  | 'OUTCOME_NOT_REFUNDABLE';

export const REFUND_REFUSALS: Readonly<Record<RefundRefusal, string>> = Object.freeze({
  PAYMENT_NOT_FOUND: 'No payment exists for this booking.',
  PAYMENT_NOT_CAPTURED: 'Only a captured payment can be refunded.',
  REFUND_ALREADY_SETTLED: 'This payment has already been refunded.',
  REFUND_IN_PROGRESS: 'A refund is already in progress for this payment.',
  REFUND_EXCEEDS_CAPTURED: 'A refund cannot exceed the amount captured.',
  AMOUNT_NOT_POSITIVE: 'The refund amount must be greater than zero.',
  PROVIDER_NOT_PERMITTED: 'A provider cannot refund a booking they worked.',
  OUTCOME_NOT_REFUNDABLE: 'This booking outcome does not entitle the customer to a refund.',
});

/**
 * The booking outcomes that entitle a customer to a refund, and who may ask.
 *
 * A customer may REQUEST; only an admin may issue. That asymmetry is not a role
 * split of the same operation — a request opens a `finance_refund_reviews` row
 * and an issue moves money — and both go through the same eligibility function
 * below, so the two can never disagree about whether a booking is refundable.
 */
export type RefundTrigger =
  | 'CUSTOMER_CANCELLED'
  | 'PROVIDER_CANCELLED'
  | 'ADMIN_CANCELLED'
  | 'DISPUTE_UPHELD'
  | 'SERVICE_NOT_DELIVERED'
  | 'DUPLICATE_PAYMENT'
  | 'ADMIN_DISCRETION';

export interface RefundTriggerSpec {
  trigger: RefundTrigger;
  /** Who may cite this trigger when opening a refund. */
  initiators: readonly ('customer' | 'admin')[];
  /** Whether the accrued provider earning must be reversed alongside. */
  reversesProviderEarning: boolean;
  description: string;
}

export const REFUND_TRIGGERS: Readonly<Record<RefundTrigger, RefundTriggerSpec>> = Object.freeze({
  CUSTOMER_CANCELLED: {
    trigger: 'CUSTOMER_CANCELLED',
    initiators: Object.freeze(['customer', 'admin'] as const),
    reversesProviderEarning: true,
    description: 'The customer cancelled within the cancellation policy.',
  },
  PROVIDER_CANCELLED: {
    trigger: 'PROVIDER_CANCELLED',
    initiators: Object.freeze(['customer', 'admin'] as const),
    reversesProviderEarning: true,
    description: 'The assigned provider cancelled and no replacement served the booking.',
  },
  ADMIN_CANCELLED: {
    trigger: 'ADMIN_CANCELLED',
    initiators: Object.freeze(['admin'] as const),
    reversesProviderEarning: true,
    description: 'Servana cancelled the booking.',
  },
  DISPUTE_UPHELD: {
    trigger: 'DISPUTE_UPHELD',
    initiators: Object.freeze(['admin'] as const),
    reversesProviderEarning: true,
    description: 'A dispute was resolved in the customer\'s favour.',
  },
  SERVICE_NOT_DELIVERED: {
    trigger: 'SERVICE_NOT_DELIVERED',
    initiators: Object.freeze(['customer', 'admin'] as const),
    reversesProviderEarning: true,
    description: 'The booking was paid and no service was performed.',
  },
  DUPLICATE_PAYMENT: {
    trigger: 'DUPLICATE_PAYMENT',
    initiators: Object.freeze(['customer', 'admin'] as const),
    reversesProviderEarning: false,
    description:
      'The customer was charged twice for one booking. The provider earned once, so ' +
      'the earning is NOT reversed.',
  },
  ADMIN_DISCRETION: {
    trigger: 'ADMIN_DISCRETION',
    initiators: Object.freeze(['admin'] as const),
    reversesProviderEarning: false,
    description:
      'A goodwill refund. Servana absorbs it, so the provider keeps what they earned.',
  },
});

export const REFUND_TRIGGER_NAMES: readonly RefundTrigger[] = Object.freeze(
  Object.keys(REFUND_TRIGGERS) as RefundTrigger[],
);

export const parseRefundTrigger = (raw: unknown): RefundTrigger | null => {
  const value = String(raw ?? '').trim().toUpperCase();
  return (REFUND_TRIGGER_NAMES as readonly string[]).includes(value)
    ? (value as RefundTrigger)
    : null;
};

export interface RefundEligibilityInput {
  paymentState: unknown;
  /** What the customer actually paid, in pesos. */
  capturedAmount: unknown;
  /** What has already been returned against this payment. */
  alreadyRefunded?: unknown;
  /** Omitted means "the whole remaining balance". */
  requestedAmount?: unknown;
  trigger: RefundTrigger;
  actor: 'customer' | 'assigned_provider' | 'admin';
}

export interface RefundEligibility {
  eligible: boolean;
  refusal: RefundRefusal | null;
  message: string | null;
  /** The most that may still be returned against this payment. */
  maxRefundable: number;
  /** What would actually be refunded if this request proceeded. */
  amount: number;
  reversesProviderEarning: boolean;
}

/**
 * One function decides refundability for every caller.
 *
 * §77 asks for centralized refund eligibility and for double refunds to be
 * prevented. Both of those are the same sentence here: `maxRefundable` is
 * captured minus already-refunded, so a second full refund computes a ceiling of
 * zero and is refused by amount rather than by anyone remembering to check.
 * REFUNDING is treated as still-captured for exactly that reason — a refund
 * whose outcome is unknown must not free the balance for a second attempt.
 */
export const evaluateRefundEligibility = (input: RefundEligibilityInput): RefundEligibility => {
  const state = normalizePaymentState(input.paymentState);
  const captured = toCentavos(input.capturedAmount);
  const refunded = toCentavos(input.alreadyRefunded);
  const maxRefundable = Math.max(0, toCentavos(captured - refunded));
  const requested =
    input.requestedAmount === undefined || input.requestedAmount === null
      ? maxRefundable
      : toCentavos(input.requestedAmount);

  const refuse = (refusal: RefundRefusal): RefundEligibility => ({
    eligible: false,
    refusal,
    message: REFUND_REFUSALS[refusal],
    maxRefundable,
    amount: 0,
    reversesProviderEarning: REFUND_TRIGGERS[input.trigger].reversesProviderEarning,
  });

  if (input.actor === 'assigned_provider') return refuse('PROVIDER_NOT_PERMITTED');
  if (!REFUND_TRIGGERS[input.trigger].initiators.includes(input.actor)) {
    return refuse('OUTCOME_NOT_REFUNDABLE');
  }
  if (state === 'REFUNDED') return refuse('REFUND_ALREADY_SETTLED');
  if (state === 'REFUNDING') return refuse('REFUND_IN_PROGRESS');
  if (!PAYMENT_STATES[state].captured) return refuse('PAYMENT_NOT_CAPTURED');
  if (requested <= 0) return refuse('AMOUNT_NOT_POSITIVE');
  if (requested > maxRefundable) return refuse('REFUND_EXCEEDS_CAPTURED');

  return {
    eligible: true,
    refusal: null,
    message: null,
    maxRefundable,
    amount: requested,
    reversesProviderEarning: REFUND_TRIGGERS[input.trigger].reversesProviderEarning,
  };
};

// ─── Reconciliation check catalog ─────────────────────────────────────────────

export interface ReconciliationCheckSpec {
  code: string;
  severity: 'info' | 'warning' | 'critical';
  /** What the check looks for, in one sentence. */
  detects: string;
  /** What an operator does about it. A break nobody can act on is noise. */
  remediation: string;
  /** Whether this check is required by §78 of the TAB 07 command. */
  requiredBySpec: boolean;
}

/**
 * Every break a reconciliation run can find.
 *
 * The engine in `adminFinanceService.runReconciliation` implemented nine checks
 * as anonymous closures with their codes written inline, so nothing could list
 * them, the admin UI could not label them, and §78's four required checks could
 * not be shown to be present. They are declared here and the engine is asserted
 * against this catalog by `tests/finance-reconciliation.test.ts`, which is what
 * makes "zero unexplained breaks" a checkable claim rather than a hope.
 */
export const RECONCILIATION_CHECKS: readonly ReconciliationCheckSpec[] = Object.freeze([
  {
    code: 'GCASH_PENDING_REVIEW_OVER_SLA',
    severity: 'warning',
    detects: 'A GCash proof of payment has waited longer than the review SLA.',
    remediation: 'Review the proof in the GCash queue and approve or reject it.',
    requiredBySpec: false,
  },
  {
    code: 'CASH_PAYMENT_UNCONFIRMED_OVER_SLA',
    severity: 'warning',
    detects: 'A cash payment was never confirmed within the SLA.',
    remediation: 'Confirm collection with the provider, then mark the payment paid.',
    requiredBySpec: false,
  },
  {
    code: 'PAYMONGO_FAILED_PAYMENT',
    severity: 'critical',
    detects: 'A PayMongo charge failed and has not been reviewed.',
    remediation: 'Contact the customer to restart checkout, or cancel the booking.',
    requiredBySpec: false,
  },
  {
    code: 'PAYMONGO_CHECKOUT_WITHOUT_FINAL_STATUS',
    severity: 'warning',
    detects: 'A checkout session has had no terminal outcome for longer than the stale window.',
    remediation: 'Query the session at PayMongo and settle the local row to match.',
    requiredBySpec: true,
  },
  {
    code: 'RELEASED_PAYOUT_WITHOUT_PAID_PAYMENT',
    severity: 'critical',
    detects: 'Money left Servana for a booking that was never paid for.',
    remediation: 'Recover the payout or record the write-off; find why the guard was bypassed.',
    requiredBySpec: true,
  },
  {
    code: 'DUPLICATE_PAYOUT_FOR_BOOKING',
    severity: 'critical',
    detects: 'More than one live disbursement exists for one booking.',
    remediation: 'Cancel the duplicate before it releases; reverse it if it already did.',
    requiredBySpec: true,
  },
  {
    code: 'INTERNAL_FIXER_JOB_WITH_PROVIDER_PAYOUT',
    severity: 'critical',
    detects: 'A salaried internal fixer has a per-job provider payout.',
    remediation:
      'Hold and void the payout. Since the writer now refuses these, a new row means ' +
      'the provider was tagged as an internal fixer after the job was completed.',
    requiredBySpec: false,
  },
  {
    code: 'PAYOUT_FAILED_PROVIDER_ERROR',
    severity: 'critical',
    detects: 'A payout has exhausted its automatic retries.',
    remediation: 'Check the provider\'s bank details, then retry the payout manually.',
    requiredBySpec: false,
  },
  {
    code: 'REFUND_APPROVED_WITH_RELEASED_PAYOUT',
    severity: 'critical',
    detects: 'A refund was approved after the provider payout for the same booking was released.',
    remediation: 'Recover the provider share manually; the processor cannot reverse it.',
    requiredBySpec: false,
  },
  {
    code: 'ORPHANED_PAYMENT_WITHOUT_BOOKING',
    severity: 'critical',
    detects: 'A captured payment references no booking, or one that no longer exists.',
    remediation: 'Identify the payer from the processor record and re-link or refund.',
    requiredBySpec: true,
  },
  {
    code: 'COMPLETED_BOOKING_WITHOUT_EARNING',
    severity: 'critical',
    detects:
      'A paid, completed booking produced no provider earning and no recorded reason for withholding one.',
    remediation:
      'Run the earning accrual for the booking. An internal fixer job is NOT this break — ' +
      'those carry a PROVIDER_EARNING_WITHHELD event that explains the zero.',
    requiredBySpec: true,
  },
  {
    code: 'PAYOUT_WITHOUT_EARNING',
    severity: 'critical',
    detects: 'A disbursement exists with no accrued earning event behind it.',
    remediation: 'Hold the payout and establish what it was for before it releases.',
    requiredBySpec: true,
  },
  {
    code: 'REFUND_EXCEEDS_CAPTURED_AMOUNT',
    severity: 'critical',
    detects: 'Refunds against a payment total more than was ever captured.',
    remediation: 'Reclaim the excess from the processor; investigate the duplicate refund path.',
    requiredBySpec: true,
  },
  {
    code: 'LEDGER_EVENT_AMOUNT_MISMATCH',
    severity: 'critical',
    detects:
      'A recorded ledger event disagrees with the amount the canonical calculator derives ' +
      'from the same source rows.',
    remediation:
      'Do not edit the event — it is the immutable record. Establish which writer produced ' +
      'the disagreement and correct the source row.',
    requiredBySpec: false,
  },
]);

export const RECONCILIATION_CHECK_CODES: readonly string[] = Object.freeze(
  RECONCILIATION_CHECKS.map((c) => c.code),
);

// ─── The cross-platform caller matrix ─────────────────────────────────────────

export type ClientSurface =
  | 'customerMobile'
  | 'customerWeb'
  | 'providerMobile'
  | 'providerWeb'
  | 'admin';

export const CLIENT_SURFACES: readonly ClientSurface[] = Object.freeze([
  'customerMobile',
  'customerWeb',
  'providerMobile',
  'providerWeb',
  'admin',
]);

export interface FinanceCapability {
  key: string;
  title: string;
  /** The canonical v1 contract ids that serve it. */
  contractIds: readonly string[];
  /** The ONE domain module behind every one of those endpoints. */
  domainModule: string;
  /** Surfaces that perform this business operation at all. */
  surfaces: readonly ClientSurface[];
  /**
   * Why a role-specific endpoint survives, or the assertion that none does.
   *
   * The command's cross-platform centralization rule asks for exactly this
   * sentence per capability, so it is a required field rather than a comment.
   */
  roleSplitRationale: string;
}

export const FINANCE_CAPABILITIES: readonly FinanceCapability[] = Object.freeze([
  {
    key: 'paymentIntent',
    title: 'Start or resume a booking payment',
    contractIds: ['bookings.payments.intent'],
    domainModule: 'services/finance/bookingPaymentService',
    surfaces: Object.freeze(['customerMobile', 'customerWeb', 'admin'] as ClientSurface[]),
    roleSplitRationale:
      'No role split. One booking-scoped endpoint; the caller\'s relationship to the ' +
      'booking is resolved by `assertBookingAccess`, and an admin starting a payment on ' +
      'a customer\'s behalf runs the identical `createCheckoutSession` call. A provider ' +
      'is refused — they are never a party to the customer\'s charge.',
  },
  {
    key: 'paymentView',
    title: 'Read a booking\'s payment and price breakdown',
    contractIds: ['bookings.payments.get'],
    domainModule: 'services/finance/bookingPaymentService',
    surfaces: Object.freeze([
      'customerMobile',
      'customerWeb',
      'providerMobile',
      'providerWeb',
      'admin',
    ] as ClientSurface[]),
    roleSplitRationale:
      'No role split, but the DTO is FIELD-SCOPED by actor from one declaration: a ' +
      'provider sees their own share and never the processor reference or the ' +
      'customer\'s method, and a customer sees what they paid and never the provider ' +
      'share. One endpoint, one calculator, one projection function — not three ' +
      'endpoints that could each compute a different total.',
  },
  {
    key: 'refund',
    title: 'Refund a booking payment',
    contractIds: ['bookings.refunds.create'],
    domainModule: 'services/finance/bookingPaymentService',
    surfaces: Object.freeze(['customerMobile', 'customerWeb', 'admin'] as ClientSurface[]),
    roleSplitRationale:
      'One endpoint, two outcomes decided by the actor: a customer REQUESTS (opening a ' +
      'refund review) and an admin ISSUES (moving money). Both call ' +
      '`evaluateRefundEligibility` first, so a request can never be accepted for a ' +
      'booking an issue would refuse. A provider is refused outright.',
  },
  {
    key: 'earningsSummary',
    title: 'Provider earnings summary',
    contractIds: ['provider.earnings.summary'],
    domainModule: 'services/finance/providerEarningsService',
    surfaces: Object.freeze(['providerMobile', 'providerWeb'] as ClientSurface[]),
    roleSplitRationale:
      'No role split. Provider Web and Provider Mobile call the same path and receive ' +
      'the same DTO from the same aggregate query, which is what makes "earnings match ' +
      'exactly" a property rather than a coincidence of two implementations.',
  },
  {
    key: 'earningsTransactions',
    title: 'Provider earnings transactions',
    contractIds: [
      // TAB 10: the single-transaction DETAIL the list links to. Held in the
      // SAME capability as the list because they are one screen and one
      // service, and retiring the list without the detail would leave a row
      // a provider can see and cannot open.
      'provider.earnings.transaction',
      'provider.earnings.transactions',
    ],
    domainModule: 'services/finance/providerEarningsService',
    surfaces: Object.freeze(['providerMobile', 'providerWeb'] as ClientSurface[]),
    roleSplitRationale:
      'No role split. Replaces three legacy shapes — `/provider/earnings`, ' +
      '`/provider/ledger` and the job-card earnings fields — that read the same columns ' +
      'and answered in three vocabularies.',
  },
  {
    key: 'payouts',
    title: 'Provider payouts',
    contractIds: ['provider.earnings.payouts'],
    domainModule: 'services/finance/providerEarningsService',
    surfaces: Object.freeze(['providerMobile', 'providerWeb'] as ClientSurface[]),
    roleSplitRationale:
      'No role split. The provider\'s own payouts only; the subject is the token, never ' +
      'a uid in the path. Admin payout administration is a genuinely different ' +
      'operation — it can hold, retry and see processor references — and lives under ' +
      '/admin/finance with its own permissions.',
  },
  {
    key: 'reconciliation',
    title: 'Admin ledger reconciliation',
    contractIds: ['admin.finance.reconciliation'],
    domainModule: 'services/finance/financeReconciliationService',
    surfaces: Object.freeze(['admin'] as ClientSurface[]),
    roleSplitRationale:
      'Admin only, and legitimately so: it reads across every booking, provider and ' +
      'payment on the platform. It reconciles the SAME ledger the provider and ' +
      'customer endpoints project from, so an admin investigating a break and a ' +
      'provider reading their earnings are looking at one set of records.',
  },
]);
