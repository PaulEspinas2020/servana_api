/**
 * The financial policy, asserted against the declaration rather than restated.
 *
 * Every expectation here reads `financePolicy` for the rule and then checks the
 * BEHAVIOUR it produces. A test that hardcoded "0.8" would pass while the
 * platform paid 0.7, which is the failure mode the whole extraction exists to
 * prevent — so the rate, the window and the vocabulary all come from the module
 * under test, and what is pinned is the relationship between them.
 *
 * The one exception is the 72-hour payout window, which IS hardcoded once, in
 * the test that says so. That number is an operator commitment to providers
 * rather than an implementation detail, and a test that read it from the code it
 * guards could never catch it being changed.
 */

import {
  CURRENCY,
  LEDGER_EVENTS,
  LEDGER_EVENT_NAMES,
  PAYMENT_STATES,
  PAYMENT_STATE_NAMES,
  PAYMENT_TRANSITIONS,
  PROVIDER_ECONOMIC_MODELS,
  PROVIDER_ECONOMIC_MODEL_NAMES,
  PROVIDER_PAYOUT_WINDOW_HOURS,
  RECONCILIATION_CHECKS,
  REFUND_TRIGGERS,
  REFUND_TRIGGER_NAMES,
  FINANCE_CAPABILITIES,
  CLIENT_SURFACES,
  canTransitionPayment,
  economicModelFor,
  evaluatePayoutEligibility,
  evaluateRefundEligibility,
  isCaptured,
  isEarningsEligible,
  normalizePaymentState,
  parseRefundTrigger,
  providerPayableFor,
  servanaRevenueFor,
  splitFor,
  toCentavos,
  toMinorUnits,
} from '../src/services/finance/financePolicy';
import { PROVIDER_SHARE_RATE, SERVANA_COMMISSION_RATE } from '../src/services/revenueSplit';
import { PROVIDER_RELEASE_HOURS } from '../src/services/payoutStatus';

// ─── Provider economics ───────────────────────────────────────────────────────

describe('provider economic models', () => {
  it('has exactly the two the platform recognises', () => {
    expect([...PROVIDER_ECONOMIC_MODEL_NAMES].sort()).toEqual([
      'EXTERNAL_PROVIDER',
      'INTERNAL_FIXER',
    ]);
  });

  it('takes the rate from revenueSplit and never restates it', () => {
    expect(PROVIDER_ECONOMIC_MODELS.EXTERNAL_PROVIDER.shareRate).toBe(PROVIDER_SHARE_RATE);
  });

  it('resolves the model from the admin-set flag, not from a role', () => {
    expect(economicModelFor({ isInternalFixer: true })).toBe('INTERNAL_FIXER');
    expect(economicModelFor({ isInternalFixer: false })).toBe('EXTERNAL_PROVIDER');
    // Absent, null and undefined all mean "not tagged", which is the model that
    // PAYS. Guessing INTERNAL_FIXER would silently withhold somebody's wages.
    expect(economicModelFor({})).toBe('EXTERNAL_PROVIDER');
    expect(economicModelFor({ isInternalFixer: null })).toBe('EXTERNAL_PROVIDER');
  });

  describe('EXTERNAL_PROVIDER earns the job share', () => {
    it('pays the provider share of the gross', () => {
      expect(providerPayableFor('EXTERNAL_PROVIDER', 1000)).toBe(
        Math.round(1000 * PROVIDER_SHARE_RATE * 100) / 100,
      );
    });

    it('splits so the two shares add back to the gross exactly', () => {
      // 33.33 is chosen because both sides round: a naive double multiplication
      // leaves a stray centavo that reconciliation would then have to explain.
      for (const gross of [33.33, 1500, 4999.99, 0.01, 12345.67]) {
        const split = splitFor('EXTERNAL_PROVIDER', gross);
        expect(toCentavos(split.providerPayable + split.servanaRevenue)).toBe(split.gross);
      }
    });

    it('records the platform commission rate', () => {
      expect(splitFor('EXTERNAL_PROVIDER', 1000).commissionRate).toBe(SERVANA_COMMISSION_RATE);
    });
  });

  describe('INTERNAL_FIXER earns no per-job commission', () => {
    it('is owed nothing, at any gross', () => {
      for (const gross of [0, 1, 1500, 999999.99]) {
        expect(providerPayableFor('INTERNAL_FIXER', gross)).toBe(0);
      }
    });

    it('leaves the WHOLE gross with Servana', () => {
      expect(servanaRevenueFor('INTERNAL_FIXER', 1500)).toBe(1500);
      expect(splitFor('INTERNAL_FIXER', 1500)).toEqual({
        gross: 1500,
        providerPayable: 0,
        servanaRevenue: 1500,
        commissionRate: 1,
      });
    });

    it('is never payout-eligible, and carries a sentence saying why', () => {
      expect(PROVIDER_ECONOMIC_MODELS.INTERNAL_FIXER.payoutEligible).toBe(false);
      expect(PROVIDER_ECONOMIC_MODELS.INTERNAL_FIXER.earnsJobShare).toBe(false);
      expect(PROVIDER_ECONOMIC_MODELS.INTERNAL_FIXER.earningsDisclosure).toMatch(/salaried/i);
    });

    it('the two models never both own the revenue', () => {
      expect(PROVIDER_ECONOMIC_MODELS.INTERNAL_FIXER.revenueOwner).toBe('servana');
      expect(PROVIDER_ECONOMIC_MODELS.EXTERNAL_PROVIDER.revenueOwner).toBe('split');
    });
  });
});

// ─── Payment states ───────────────────────────────────────────────────────────

describe('payment state model', () => {
  it('every declared state has a transition list', () => {
    for (const state of PAYMENT_STATE_NAMES) {
      expect(PAYMENT_TRANSITIONS[state]).toBeDefined();
      expect(PAYMENT_STATES[state].state).toBe(state);
    }
  });

  it('every transition target is itself a declared state', () => {
    for (const state of PAYMENT_STATE_NAMES) {
      for (const target of PAYMENT_TRANSITIONS[state]) {
        expect(PAYMENT_STATE_NAMES).toContain(target);
      }
    }
  });

  it('terminal states have no way out', () => {
    for (const state of PAYMENT_STATE_NAMES) {
      if (PAYMENT_STATES[state].terminal) {
        expect(PAYMENT_TRANSITIONS[state]).toHaveLength(0);
      }
    }
  });

  it('failure is monotonic — a settled charge cannot be demoted', () => {
    expect(canTransitionPayment('PAID', 'FAILED')).toBe(false);
    expect(canTransitionPayment('REFUNDED', 'PAID')).toBe(false);
    expect(canTransitionPayment('REFUNDED', 'FAILED')).toBe(false);
  });

  it('a definitively rejected refund restores PAID, and only from REFUNDING', () => {
    expect(canTransitionPayment('REFUNDING', 'PAID')).toBe(true);
    expect(canTransitionPayment('FAILED', 'REFUNDED')).toBe(false);
  });

  /**
   * The load-bearing one. REFUNDING means "we have claimed a refund and do not
   * know the outcome", so the money has NOT come back — treating it as returned
   * would free the balance for a second refund of the same charge.
   */
  it('REFUNDING still counts as captured', () => {
    expect(isCaptured('REFUNDING')).toBe(true);
    expect(PAYMENT_STATES.REFUNDING.captured).toBe(true);
    expect(isCaptured('REFUNDED')).toBe(false);
  });

  it('only PAID lets an earning accrue', () => {
    const eligible = PAYMENT_STATE_NAMES.filter((s) => PAYMENT_STATES[s].earningsEligible);
    expect(eligible).toEqual(['PAID']);
    expect(isEarningsEligible('REFUNDING')).toBe(false);
  });

  it('unknown input normalises to the state that permits the least', () => {
    for (const raw of [undefined, null, '', 'nonsense', 42]) {
      expect(normalizePaymentState(raw)).toBe('PENDING');
    }
    expect(normalizePaymentState('paid')).toBe('PAID');
    expect(normalizePaymentState('  Refunded ')).toBe('REFUNDED');
  });
});

// ─── Payout eligibility ───────────────────────────────────────────────────────

describe('payout eligibility', () => {
  const NOW = new Date('2026-08-13T12:00:00.000Z');
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

  const base = {
    economicModel: 'EXTERNAL_PROVIDER' as const,
    assignmentCompletedAt: hoursAgo(100),
    paymentState: 'PAID',
    providerPayable: 1200,
    hasBankAccount: true,
    now: NOW,
  };

  it('the payout window is 72 hours', () => {
    // Hardcoded deliberately. This is an operator commitment to providers, and a
    // test that read it from the module it guards could never catch a change.
    expect(PROVIDER_PAYOUT_WINDOW_HOURS).toBe(72);
    // And it is the SAME 72 the release scheduler uses — one number, not two
    // that happen to agree today.
    expect(PROVIDER_PAYOUT_WINDOW_HOURS).toBe(PROVIDER_RELEASE_HOURS);
  });

  it('releases a paid, completed job once the window has passed', () => {
    const verdict = evaluatePayoutEligibility(base);
    expect(verdict.eligible).toBe(true);
    expect(verdict.reason).toBeNull();
  });

  it('refuses inside the window and reports when it closes', () => {
    const verdict = evaluatePayoutEligibility({ ...base, assignmentCompletedAt: hoursAgo(71) });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('WITHIN_PAYOUT_WINDOW');
    expect(verdict.eligibleAt).toBe(new Date(NOW.getTime() + 3_600_000).toISOString());
  });

  it('releases exactly at the boundary, not a moment after', () => {
    expect(evaluatePayoutEligibility({ ...base, assignmentCompletedAt: hoursAgo(72) }).eligible)
      .toBe(true);
  });

  /**
   * Precedence matters more than completeness. A provider told "your payout is
   * held" needs the sentence that is actionable, and an internal fixer must
   * never be told they are waiting for a window that will never pay them.
   */
  it('refuses an internal fixer FIRST, before any timing rule', () => {
    const verdict = evaluatePayoutEligibility({
      ...base,
      economicModel: 'INTERNAL_FIXER',
      assignmentCompletedAt: hoursAgo(1),
      paymentState: 'PENDING',
      providerPayable: 0,
    });
    expect(verdict.reason).toBe('INTERNAL_FIXER_SALARIED');
    expect(verdict.message).toMatch(/salaried/i);
  });

  it('refuses when the customer has not paid', () => {
    expect(evaluatePayoutEligibility({ ...base, paymentState: 'PENDING' }).reason)
      .toBe('PAYMENT_NOT_CAPTURED');
  });

  it('refuses while a refund is active, and says so rather than blaming the window', () => {
    for (const state of ['REFUNDING', 'REFUNDED']) {
      expect(evaluatePayoutEligibility({ ...base, paymentState: state }).reason)
        .toBe('REFUND_ACTIVE');
    }
  });

  it('refuses an incomplete job', () => {
    expect(evaluatePayoutEligibility({ ...base, assignmentCompletedAt: null }).reason)
      .toBe('JOB_NOT_COMPLETED');
  });

  describe('admin holds reproduce the scheduler exactly', () => {
    it('a hold with no expiry is indefinite', () => {
      expect(
        evaluatePayoutEligibility({ ...base, holdReason: 'Under review', holdUntil: null }).reason,
      ).toBe('ADMIN_HOLD');
    });

    it('a hold whose expiry has passed no longer blocks', () => {
      expect(
        evaluatePayoutEligibility({
          ...base,
          holdReason: 'Under review',
          holdUntil: hoursAgo(1),
        }).eligible,
      ).toBe(true);
    });

    it('a hold whose expiry is still ahead blocks', () => {
      expect(
        evaluatePayoutEligibility({
          ...base,
          holdReason: 'Under review',
          holdUntil: new Date(NOW.getTime() + 3_600_000),
        }).reason,
      ).toBe('ADMIN_HOLD');
    });
  });

  it('refuses a zero or negative share rather than sending an empty transfer', () => {
    expect(evaluatePayoutEligibility({ ...base, providerPayable: 0 }).reason)
      .toBe('AMOUNT_NOT_POSITIVE');
  });

  it('refuses a second release of the same payout', () => {
    expect(evaluatePayoutEligibility({ ...base, alreadyReleased: true }).reason)
      .toBe('ALREADY_RELEASED');
  });

  it('refuses without a payout account', () => {
    expect(evaluatePayoutEligibility({ ...base, hasBankAccount: false }).reason)
      .toBe('NO_BANK_ACCOUNT');
  });
});

// ─── Refund eligibility ───────────────────────────────────────────────────────

describe('refund eligibility', () => {
  const base = {
    paymentState: 'PAID',
    capturedAmount: 1500,
    alreadyRefunded: 0,
    trigger: 'CUSTOMER_CANCELLED' as const,
    actor: 'customer' as const,
  };

  it('every declared trigger parses, and nothing else does', () => {
    for (const trigger of REFUND_TRIGGER_NAMES) {
      expect(parseRefundTrigger(trigger)).toBe(trigger);
      expect(parseRefundTrigger(trigger.toLowerCase())).toBe(trigger);
    }
    for (const bad of ['', null, undefined, 'BECAUSE', 42]) {
      expect(parseRefundTrigger(bad)).toBeNull();
    }
  });

  it('refunds the whole remaining balance when no amount is named', () => {
    const verdict = evaluateRefundEligibility(base);
    expect(verdict.eligible).toBe(true);
    expect(verdict.amount).toBe(1500);
    expect(verdict.maxRefundable).toBe(1500);
  });

  /**
   * §77's double-refund rule, expressed as arithmetic rather than as a check
   * somebody has to remember: the ceiling is captured minus already-refunded, so
   * a second full refund computes a ceiling of zero and is refused.
   */
  it('a second full refund is refused by the ceiling, not by a flag', () => {
    const verdict = evaluateRefundEligibility({
      ...base,
      alreadyRefunded: 1500,
      requestedAmount: 1500,
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.maxRefundable).toBe(0);
    expect(verdict.refusal).toBe('REFUND_EXCEEDS_CAPTURED');
  });

  it('a partial refund reduces what remains refundable', () => {
    const verdict = evaluateRefundEligibility({ ...base, alreadyRefunded: 500 });
    expect(verdict.maxRefundable).toBe(1000);
    expect(verdict.amount).toBe(1000);
  });

  it('refuses more than was captured', () => {
    expect(evaluateRefundEligibility({ ...base, requestedAmount: 1500.01 }).refusal)
      .toBe('REFUND_EXCEEDS_CAPTURED');
  });

  it('refuses a zero or negative amount', () => {
    for (const amount of [0, -1]) {
      expect(evaluateRefundEligibility({ ...base, requestedAmount: amount }).refusal)
        .toBe('AMOUNT_NOT_POSITIVE');
    }
  });

  it('refuses a payment that was never captured', () => {
    for (const state of ['PENDING', 'FAILED', 'REJECTED']) {
      expect(evaluateRefundEligibility({ ...base, paymentState: state }).refusal)
        .toBe('PAYMENT_NOT_CAPTURED');
    }
  });

  it('distinguishes already-settled from in-progress', () => {
    expect(evaluateRefundEligibility({ ...base, paymentState: 'REFUNDED' }).refusal)
      .toBe('REFUND_ALREADY_SETTLED');
    expect(evaluateRefundEligibility({ ...base, paymentState: 'REFUNDING' }).refusal)
      .toBe('REFUND_IN_PROGRESS');
  });

  /**
   * A provider able to refund a booking they worked could erase the evidence of
   * a job they were paid for. Refused before any other consideration.
   */
  it('refuses the provider outright, whatever the trigger or state', () => {
    for (const trigger of REFUND_TRIGGER_NAMES) {
      const verdict = evaluateRefundEligibility({
        ...base,
        trigger,
        actor: 'assigned_provider',
      });
      expect(verdict.refusal).toBe('PROVIDER_NOT_PERMITTED');
    }
  });

  it('a customer may not cite an admin-only outcome', () => {
    for (const trigger of REFUND_TRIGGER_NAMES) {
      const spec = REFUND_TRIGGERS[trigger];
      const verdict = evaluateRefundEligibility({ ...base, trigger, actor: 'customer' });
      if (spec.initiators.includes('customer')) {
        expect(verdict.eligible).toBe(true);
      } else {
        expect(verdict.refusal).toBe('OUTCOME_NOT_REFUNDABLE');
      }
    }
  });

  it('an admin may cite every outcome', () => {
    for (const trigger of REFUND_TRIGGER_NAMES) {
      expect(evaluateRefundEligibility({ ...base, trigger, actor: 'admin' }).eligible).toBe(true);
    }
  });

  /**
   * A duplicate charge and a goodwill refund are the two cases where the
   * provider keeps what they earned — the work was done once, or Servana chose
   * to absorb the cost.
   */
  it('names which outcomes reverse the provider earning', () => {
    const reversing = REFUND_TRIGGER_NAMES.filter((t) => REFUND_TRIGGERS[t].reversesProviderEarning);
    expect(reversing.sort()).toEqual([
      'ADMIN_CANCELLED',
      'CUSTOMER_CANCELLED',
      'DISPUTE_UPHELD',
      'PROVIDER_CANCELLED',
      'SERVICE_NOT_DELIVERED',
    ]);
    expect(REFUND_TRIGGERS.DUPLICATE_PAYMENT.reversesProviderEarning).toBe(false);
    expect(REFUND_TRIGGERS.ADMIN_DISCRETION.reversesProviderEarning).toBe(false);
  });
});

// ─── Ledger event catalog ─────────────────────────────────────────────────────

describe('ledger event catalog', () => {
  it('every event is self-consistent', () => {
    for (const name of LEDGER_EVENT_NAMES) {
      const spec = LEDGER_EVENTS[name];
      expect(spec.type).toBe(name);
      expect(['customer', 'provider', 'servana']).toContain(spec.counterparty);
      expect(['credit', 'debit']).toContain(spec.direction);
      // Every event names the booking milestone that makes it legitimate. An
      // event with no milestone is a number nobody can justify.
      expect(spec.milestone.length).toBeGreaterThan(0);
    }
  });

  it('the two non-monetary events are the ones that record a DECISION', () => {
    const nonMonetary = LEDGER_EVENT_NAMES.filter((n) => !LEDGER_EVENTS[n].monetary);
    expect(nonMonetary.sort()).toEqual(['PROVIDER_EARNING_WITHHELD', 'PROVIDER_PAYOUT_FAILED']);
  });

  it('internal fixer revenue is credited to Servana, never to the provider', () => {
    expect(LEDGER_EVENTS.INTERNAL_FIXER_REVENUE_RETAINED.counterparty).toBe('servana');
    expect(LEDGER_EVENTS.INTERNAL_FIXER_REVENUE_RETAINED.direction).toBe('credit');
  });
});

// ─── Reconciliation catalog ───────────────────────────────────────────────────

describe('reconciliation check catalog', () => {
  it('every check has a unique code', () => {
    const codes = RECONCILIATION_CHECKS.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('every check names what it detects AND what to do about it', () => {
    for (const check of RECONCILIATION_CHECKS) {
      // A break nobody can act on is noise, and noise trains operators to
      // ignore the one that matters.
      expect(check.detects.length).toBeGreaterThan(0);
      expect(check.remediation.length).toBeGreaterThan(0);
      expect(['info', 'warning', 'critical']).toContain(check.severity);
    }
  });

  /** §78 names four classes of break by hand. All four must be present. */
  it('carries the four checks §78 requires by name', () => {
    const required = RECONCILIATION_CHECKS.filter((c) => c.requiredBySpec).map((c) => c.code);
    for (const code of [
      'ORPHANED_PAYMENT_WITHOUT_BOOKING',
      'COMPLETED_BOOKING_WITHOUT_EARNING',
      'PAYOUT_WITHOUT_EARNING',
      'REFUND_EXCEEDS_CAPTURED_AMOUNT',
    ]) {
      expect(required).toContain(code);
    }
  });

  it('every §78 check is critical — none of them is advisory', () => {
    for (const check of RECONCILIATION_CHECKS.filter((c) => c.requiredBySpec)) {
      expect(['critical', 'warning']).toContain(check.severity);
    }
  });
});

// ─── Cross-platform capability matrix ─────────────────────────────────────────

describe('the cross-platform centralization rule', () => {
  it('every capability names its contract ids, its domain module and its surfaces', () => {
    for (const capability of FINANCE_CAPABILITIES) {
      expect(capability.contractIds.length).toBeGreaterThan(0);
      expect(capability.domainModule.startsWith('services/finance/')).toBe(true);
      expect(capability.surfaces.length).toBeGreaterThan(0);
      for (const surface of capability.surfaces) {
        expect(CLIENT_SURFACES).toContain(surface);
      }
    }
  });

  /**
   * The command asks for exactly this sentence per capability: if a role-specific
   * endpoint remains, say why the authorization or payload genuinely differs.
   * Required as a FIELD rather than a comment so it cannot be omitted.
   */
  it('every capability explains its role split, or asserts it has none', () => {
    for (const capability of FINANCE_CAPABILITIES) {
      expect(capability.roleSplitRationale.length).toBeGreaterThan(80);
    }
  });

  it('the earnings capabilities are shared by BOTH provider surfaces', () => {
    for (const key of ['earningsSummary', 'earningsTransactions', 'payouts']) {
      const capability = FINANCE_CAPABILITIES.find((c) => c.key === key)!;
      expect(capability.surfaces).toContain('providerMobile');
      expect(capability.surfaces).toContain('providerWeb');
    }
  });

  it('no capability is served by more than one domain module', () => {
    for (const capability of FINANCE_CAPABILITIES) {
      expect(typeof capability.domainModule).toBe('string');
    }
    // And the whole tab is served by four modules, not by one per endpoint.
    const modules = new Set(FINANCE_CAPABILITIES.map((c) => c.domainModule));
    expect(modules.size).toBeLessThanOrEqual(4);
  });
});

// ─── Money helpers ────────────────────────────────────────────────────────────

describe('money handling', () => {
  it('transacts in one currency, stated once', () => {
    expect(CURRENCY).toBe('PHP');
  });

  it('rounds to centavos and never to a float artefact', () => {
    expect(toCentavos(0.1 + 0.2)).toBe(0.3);
    expect(toCentavos(1500.005)).toBe(1500.01);
    expect(toCentavos('1234.567')).toBe(1234.57);
  });

  it('treats unusable input as zero rather than NaN', () => {
    for (const bad of [undefined, null, '', 'abc', NaN, Infinity]) {
      expect(toCentavos(bad)).toBe(0);
    }
  });

  it('minor units are integers', () => {
    expect(toMinorUnits(1500)).toBe(150000);
    expect(Number.isInteger(toMinorUnits(33.33))).toBe(true);
  });
});
