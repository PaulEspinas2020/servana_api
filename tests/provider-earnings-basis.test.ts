/**
 * The gross a provider's earnings are displayed against.
 *
 * `/provider/earnings` showed `bookingAmount = final_price`, while the payout
 * is 80% of `final_price + paid additional work` — `createDisbursement` has
 * summed the extra since it was fixed at the writer, and the fix never reached
 * the readers. So a booking of ₱1,500 carrying ₱3,500 of approved on-site work
 * displayed ₱1,500 beside a ₱4,000 provider share, under copy stating the share
 * is "80% of the booking amount". That reads as 267%.
 *
 * Production already holds that exact shape — bookings 58 and 62, final_price
 * 1500, additional_paid 3500 each. It has never been visible only because no
 * booking has ever reached COMPLETED, which is the filter the earnings query
 * applies. The first completion would have shown it.
 *
 * The reconciliation case below is the one that matters: displayed basis ×
 * PROVIDER_SHARE_RATE must equal the amount actually paid.
 */
import { earningsGross, paidAdditionalWorkSql } from '../src/services/earningsBasis';
import { providerShareOf, PROVIDER_SHARE_RATE } from '../src/services/revenueSplit';

describe('earningsGross', () => {
  it('adds paid additional work to the booking price', () => {
    expect(earningsGross(1500, 3500)).toBe(5000);
  });

  it('is just the booking price when there is no additional work', () => {
    expect(earningsGross(1500, 0)).toBe(1500);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['non-numeric', 'n/a'],
  ])('treats a %s additional total as zero rather than NaN', (_label, value) => {
    // A NaN here would propagate into the displayed amount as "₱NaN".
    expect(earningsGross(1500, value)).toBe(1500);
  });

  it('treats a missing final price as zero', () => {
    expect(earningsGross(null, 3500)).toBe(3500);
    expect(earningsGross(undefined, undefined)).toBe(0);
  });

  it('rounds to centavos', () => {
    expect(earningsGross(1500.005, 0.004)).toBe(1500.01);
  });

  it('pg NUMERIC arrives as a string — it must not concatenate', () => {
    // `SUM(amount)` on a NUMERIC column comes back as a string from pg. String
    // '+' would have produced '15003500'.
    expect(earningsGross('1500', '3500')).toBe(5000);
  });
});

describe('the displayed basis reconciles with what the provider is paid', () => {
  it('share is exactly 80% of the basis now shown', () => {
    // The defect, stated as an assertion: this was 1500 vs a 4000 share.
    const gross = earningsGross(1500, 3500);
    expect(providerShareOf(gross)).toBe(4000);
    expect(Math.round(gross * PROVIDER_SHARE_RATE * 100) / 100).toBe(4000);
  });

  it.each([
    [1500, 3500],
    [800, 0],
    [1200, 450.5],
    [3500, 3500],
  ])('basis %p + %p reconciles with the share', (base, extra) => {
    const gross = earningsGross(base, extra);
    expect(providerShareOf(gross)).toBe(Math.round(gross * PROVIDER_SHARE_RATE * 100) / 100);
  });

  it('would NOT have reconciled under the old basis', () => {
    // Guards the regression: final_price alone against the real payout.
    const oldBasis = 1500;
    const realShare = providerShareOf(earningsGross(1500, 3500));
    expect(providerShareOf(oldBasis)).not.toBe(realShare);
  });
});

describe('paidAdditionalWorkSql', () => {
  const sql = paidAdditionalWorkSql('servana');

  it('counts only PAID additional-work payments', () => {
    // A request can sit at ACCEPTED/IN_PROGRESS/PROCEEDING unpaid. Paying a
    // share of money Servana never collected turns a shortfall into a loss.
    expect(sql).toContain("p_add.status = 'PAID'");
    expect(sql).toContain('p_add.additional_request_id IS NOT NULL');
  });

  it('never counts the base booking payment', () => {
    expect(sql).not.toContain('additional_request_id IS NULL');
  });

  it('coalesces to zero so a booking with no extras is not NULL', () => {
    expect(sql).toContain('COALESCE(');
    expect(sql).toContain(', 0)');
  });

  it('scopes to the booking alias it is given', () => {
    expect(paidAdditionalWorkSql('servana', 'bk')).toContain('p_add.booking_id = bk.id');
  });

  it('uses an alias that cannot collide with the base-payment join', () => {
    // Both readers already LEFT JOIN payments as `p` with
    // additional_request_id IS NULL. Reusing `p` inside the subquery would
    // shadow it and silently change which rows are summed.
    expect(sql).toContain('p_add');
    expect(sql).not.toMatch(/\bpayments p\b(?!_)/);
  });
});
