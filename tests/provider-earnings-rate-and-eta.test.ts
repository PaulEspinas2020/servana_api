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
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'controllers', 'providerController.ts'),
    'utf8',
  );

  it('computes the release date in SQL from the shared constant', () => {
    expect(src).toMatch(/INTERVAL '\$\{PROVIDER_RELEASE_HOURS\} hours'/);
    // No literal hour count anywhere near the earnings queries.
    expect(src).not.toMatch(/INTERVAL '(48|72) hours'/);
  });

  it('emits expectedArrivalAt on the list and the detail', () => {
    const hits = src.match(/expectedArrivalAt/g) ?? [];
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
