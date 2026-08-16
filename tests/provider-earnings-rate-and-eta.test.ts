/**
 * The rate and the release date travel WITH the data.
 *
 * Provider Web restated both locally: `PROVIDER_SHARE_PERCENT = 80` in the
 * share mapper, a second `0.80` in the additional-work facade, and its own
 * release-window arithmetic. That last one drifted to 48 hours against a
 * scheduler releasing at 72, so providers were told their money was due a day
 * early. A number only the backend decides must not be restated by a client.
 */
import { PROVIDER_RELEASE_HOURS } from '../src/services/payoutStatus';
import { PROVIDER_SHARE_PERCENT, PROVIDER_SHARE_RATE } from '../src/services/revenueSplit';

describe('PROVIDER_RELEASE_HOURS', () => {
  it('is 72', () => {
    expect(PROVIDER_RELEASE_HOURS).toBe(72);
  });

  it('is NOT 48 — the cancellation-notice window is a different rule', () => {
    // bookingCancellationPolicy.ts requires 48 h notice to CANCEL. Conflating
    // the two is what produced the wrong payout copy.
    expect(PROVIDER_RELEASE_HOURS).not.toBe(48);
  });

  it('is the value the release scheduler runs on', () => {
    // Reading the source rather than the constant: the point is that
    // disbursement.service no longer holds its own literal.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'services', 'disbursement.service.ts'),
      'utf8',
    );
    expect(src).toMatch(/RELEASE_HOURS\s*=\s*PROVIDER_RELEASE_HOURS/);
    expect(src).not.toMatch(/RELEASE_HOURS\s*=\s*\d+/);
  });
});

describe('the earnings endpoints publish what clients previously guessed', () => {
  const read = (...parts: string[]) =>
    require('fs').readFileSync(require('path').join(__dirname, '..', ...parts), 'utf8');

  /**
   * TAB 07 moved the earnings queries out of the controller into
   * `services/finance/providerEarningsService`, and the expected-arrival date
   * out of SQL into `evaluatePayoutEligibility`. The guarantee is unchanged and
   * is now stronger: the date is computed ONCE, in the policy, from the same
   * constant the release scheduler runs on.
   */
  const src = read('src', 'controllers', 'providerController.ts');
  const earnings = read('src', 'services', 'finance', 'providerEarningsService.ts');
  const policy = read('src', 'services', 'finance', 'financePolicy.ts');

  it('computes the release date from the shared constant, never a literal', () => {
    expect(earnings).toMatch(/INTERVAL '\$\{PROVIDER_PAYOUT_WINDOW_HOURS\} hours'/);
    expect(earnings).not.toMatch(/INTERVAL '(48|72) hours'/);
    // And the window itself is re-exported, not re-declared.
    expect(policy).toMatch(/PROVIDER_PAYOUT_WINDOW_HOURS = PROVIDER_RELEASE_HOURS/);
    expect(policy).not.toMatch(/PROVIDER_PAYOUT_WINDOW_HOURS\s*=\s*\d+/);
  });

  it('emits expectedArrivalAt on the list and the detail', () => {
    // One DTO now serves both, so the field is declared once and populated once
    // - which is what stopped the list and the detail disagreeing.
    const hits = earnings.match(/expectedArrivalAt/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it('emits providerSharePercent on additional requests', () => {
    expect(src).toMatch(/providerSharePercent: PROVIDER_SHARE_PERCENT/);
  });

  it('never hardcodes the rate as a literal in the controller', () => {
    // Every occurrence must come from revenueSplit.
    expect(src).not.toMatch(/providerSharePercent:\s*80\b/);
  });
});

describe('the rate itself', () => {
  it('is derived from the single rate definition', () => {
    expect(PROVIDER_SHARE_PERCENT).toBe(Math.round(PROVIDER_SHARE_RATE * 100));
    expect(PROVIDER_SHARE_PERCENT).toBe(80);
  });
});
