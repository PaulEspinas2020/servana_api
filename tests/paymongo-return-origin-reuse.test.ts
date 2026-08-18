/**
 * A stored checkout session may only be reused for the origin it was built for.
 *
 * `3ef4518` resolves the return origin per request, but all THREE checkout
 * paths reused a PENDING PayMongo session for two hours without consulting it:
 *
 *   paymentService.createCheckoutSession   (booking)
 *   paymentService.createPayment           (additional work)
 *   additional.service.generatePayment     (a third path that short-circuits
 *                                           before createPayment is called)
 *
 * The failure is quiet and expensive to diagnose: the checkout still works and
 * the customer still pays, they are simply returned to a different application
 * than the one they started from. The third path is the nastiest — fixing only
 * the two inside paymentService leaves it defeating them.
 *
 * NULL means "the configured default", which is what every caller sending no
 * `Origin` resolves to (native mobile, the scheduler's retry job). Two defaults
 * must therefore match, or mobile would mint a fresh session on every call.
 */
import fs from 'fs';
import path from 'path';
import { returnOriginMatches } from '../src/services/paymentReturnOrigin';

const CLIENT = 'https://client.servana.com.ph';
const OTHER = 'https://admin.servana.com.ph';

/**
 * Reads a source file with COMMENTS STRIPPED.
 *
 * Without this, these assertions pass against PROSE. The comment above the
 * third reuse path quotes its SQL predicate verbatim to explain why `=` would
 * be wrong — so deleting the actual SQL left this suite green, matching the
 * explanation of the rule instead of the rule. Found by mutation, not by
 * inspection.
 *
 * `c3-status-and-payout-regressions.test.ts` documents the same trap, and its
 * CRLF lesson applies here: these files carry carriage returns, so the split
 * must tolerate them.
 */
const readCode = (rel: string): string =>
  fs
    .readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*/, '').replace(/^\s*\/\/.*/, '').replace(/^\s*\*.*/, ''))
    .join('\n');

describe('the comment stripper itself', () => {
  // These assertions are worthless if the stripper silently no-ops, which is
  // exactly how the trap above went unnoticed. Positive and negative fixtures.
  it('strips a SQL comment that quotes the predicate', () => {
    const out = 'SELECT 1 -- AND return_origin IS NOT DISTINCT FROM $2'.replace(/--.*/, '');
    expect(out).toContain('SELECT 1');
    expect(out).not.toContain('return_origin');
  });

  it('strips a whole-line JS comment', () => {
    expect('   // return_origin IS NOT DISTINCT FROM $2'.replace(/^\s*\/\/.*/, '')).toBe('');
  });

  it('strips a JSDoc continuation line', () => {
    expect('   * return_origin IS NOT DISTINCT FROM $2'.replace(/^\s*\*.*/, '')).toBe('');
  });
});

describe('returnOriginMatches', () => {
  it('matches two defaults, so mobile keeps reusing its session', () => {
    expect(returnOriginMatches(null, undefined)).toBe(true);
    expect(returnOriginMatches(undefined, undefined)).toBe(true);
    expect(returnOriginMatches(null, null)).toBe(true);
  });

  it('matches an identical allowlisted origin', () => {
    expect(returnOriginMatches(CLIENT, CLIENT)).toBe(true);
  });

  it('refuses a session built for the default when a web origin asks', () => {
    // The payer would land on the configured default instead of the portal.
    expect(returnOriginMatches(null, CLIENT)).toBe(false);
  });

  it('refuses a session built for a web origin when mobile asks', () => {
    // The reverse: a mobile payer sent to the web portal's return page.
    expect(returnOriginMatches(CLIENT, undefined)).toBe(false);
  });

  it('refuses two different origins', () => {
    expect(returnOriginMatches(CLIENT, OTHER)).toBe(false);
  });

  it('treats null and undefined as the same value on either side', () => {
    // Rows written before the column existed read as NULL; a caller that
    // resolved to the default passes undefined. They are the same thing.
    expect(returnOriginMatches(undefined, null)).toBe(true);
  });

  it('does not coerce an empty string to the default', () => {
    // An empty stored value is not "the default" — it is a bad write, and
    // reusing on it would hand back a session with unknown return URLs.
    expect(returnOriginMatches('', null)).toBe(false);
  });
});

describe('every reuse path consults the origin', () => {
  const paymentService = readCode('services/paymentService.ts');
  const additionalService = readCode('services/additional.service.ts');

  it('booking checkout gates reuse inside the if(), not merely nearby', () => {
    // The first version of this matched the `const originMatches = ...`
    // assignment, so deleting `&& originMatches` from the condition left it
    // green — a detector blind to the defect it exists for.
    const guard = paymentService.match(/if \(paymentStatus === "PENDING"[\s\S]{0,400}?\)\s*\{/);
    expect(guard).not.toBeNull();
    expect(guard![0]).toContain('originMatches');
  });

  it('additional-work checkout gates reuse on the origin', () => {
    expect(paymentService).toMatch(/returnOriginMatches\(\s*existing\.return_origin/);
  });

  it('the third path filters in SQL, and with IS NOT DISTINCT FROM', () => {
    // `= $2` would never match a NULL stored origin against a default caller,
    // so mobile would mint a new session on every single call.
    expect(additionalService).toMatch(/return_origin IS NOT DISTINCT FROM \$2/);
    expect(additionalService).not.toMatch(/return_origin\s*=\s*\$2/);
  });

  it('stores the origin everywhere a session is created', () => {
    // One UPDATE in createCheckoutSession, one UPDATE and one INSERT in
    // createPayment. A path that writes a session without recording its origin
    // reads back as "the default" and is then wrongly reused.
    const writes = paymentService.match(/return_origin\s*=\s*\$\d/g) ?? [];
    expect(writes.length).toBe(2);
    expect(paymentService).toMatch(/checkout_attempt,\s*return_origin\)/);
  });

  it('never stores a caller-supplied string', () => {
    // Only `options?.returnOrigin`, which resolvePaymentReturnOrigin has
    // already reduced to an allowlist entry or undefined.
    expect(paymentService).not.toMatch(/return_origin[^)]*req\.headers/);
    expect(paymentService).toMatch(/options\?\.returnOrigin \?\? null/);
  });
});

describe('the migration that backs it', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'migrations', '018-payment-return-origin.sql'),
    'utf8',
  );

  it('adds the column idempotently', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS return_origin TEXT/);
  });

  it('leaves it nullable — NULL is the meaningful "default" value', () => {
    // A NOT NULL default would have to invent a value for every existing row
    // and for every mobile checkout, which is exactly the wrong shape here.
    expect(sql).not.toMatch(/return_origin TEXT NOT NULL/);
  });
});
