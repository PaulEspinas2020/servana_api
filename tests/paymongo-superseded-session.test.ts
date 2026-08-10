/**
 * A payment against a SUPERSEDED checkout session must still be recorded.
 *
 * `payments.provider_payment_id` holds the checkout session id (`cs_…`) while a
 * payment is PENDING, and the webhook finds the row by it. When a session is
 * superseded — the stored one is over two hours old, or FAILED, or was built
 * for a different return origin — the create path OVERWRITES
 * `provider_payment_id` and `raw_response` with the new session's. The old id
 * then existed nowhere on the row.
 *
 * The old session stays payable at PayMongo. Pay it from an old tab or a second
 * device and the webhook matched nothing: the UPDATE missed, the duplicate-event
 * fallback missed (it only read `provider_payment_id` and the two
 * `raw_response` paths, all now holding the NEW session), and the handler threw
 * "PayMongo checkout session not found" → 500 → PayMongo retries forever. The
 * customer was charged and the booking was never marked PAID.
 *
 * Verified against the production database before fixing: with only the new id
 * on the row, an event for the old session matched no row; with the old id
 * preserved it matched, and the `ROUND(amount * 100)` guard still refused an
 * event whose amount disagreed.
 *
 * These are source assertions because the defect lives entirely in SQL
 * predicates — a test that stubbed the query RESULT would have passed against
 * the broken version, which is the trap `c3-status-and-payout-regressions`
 * documents.
 */
import fs from 'fs';
import path from 'path';

/** Source with comments stripped, so prose cannot satisfy an assertion. */
const readCode = (rel: string): string =>
  fs
    .readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*/, '').replace(/^\s*\/\/.*/, '').replace(/^\s*\*.*/, ''))
    .join('\n');

const service = readCode('services/paymentService.ts');

/**
 * The superseded-id predicate, as written in every query that must carry it.
 *
 * Containment (`@>`), NOT `$1 = ANY(COALESCE(col, '{}'))`. Both are correct
 * logically, but wrapping the column in COALESCE makes the GIN index unusable —
 * proved on the production planner, which fell back to a Seq Scan even with
 * seqscan disabled. `NULL @> ARRAY[x]` is NULL, which WHERE treats as false, so
 * the COALESCE bought nothing.
 */
const MATCH = /superseded_session_ids @> ARRAY\[\$1\]/g;

describe('the old session id survives being superseded', () => {
  it('is appended when a booking checkout is replaced', () => {
    expect(service).toMatch(/array_append\(COALESCE\(superseded_session_ids, '\{\}'\), provider_payment_id\)/);
  });

  it('is appended at BOTH create paths, not just the booking one', () => {
    // Additional work has its own checkout with its own supersede branch.
    // Fixing only the booking path leaves upsell payments losable.
    const appends = service.match(/array_append\(COALESCE\(superseded_session_ids/g) ?? [];
    expect(appends.length).toBe(2);
  });

  it('only ever appends a checkout session id, never a pay_ id', () => {
    // After settlement provider_payment_id deliberately holds the refundable
    // pay_ id. Appending that would let a refund event match as a checkout.
    const guards = service.match(/provider_payment_id LIKE 'cs_%'/g) ?? [];
    expect(guards.length).toBe(2);
  });

  it('does not append the id it is replacing with', () => {
    // Re-running a create with the same session must not accumulate duplicates.
    const guards = service.match(/provider_payment_id <> \$\d/g) ?? [];
    expect(guards.length).toBe(2);
  });
});

describe('every webhook match consults the superseded ids', () => {
  it('all four queries carry the predicate', () => {
    // paid UPDATE, paid duplicate-fallback SELECT, failed UPDATE,
    // failed fallback SELECT. Missing one leaves a live money path broken.
    expect((service.match(MATCH) ?? []).length).toBe(4);
  });

  it('the paid UPDATE matches on it', () => {
    const q = service.match(/UPDATE [^`]*SET status = 'PAID'[\s\S]{0,700}?RETURNING/);
    expect(q).not.toBeNull();
    expect(q![0]).toMatch(MATCH);
  });

  it('the failed UPDATE matches on it', () => {
    const q = service.match(/SET status = 'FAILED', webhook_event_id[\s\S]{0,600}?RETURNING/);
    expect(q).not.toBeNull();
    expect(q![0]).toMatch(MATCH);
  });

  it('keeps the amount guard on the paid path', () => {
    // Widening WHICH rows can match must not widen what may be settled. An
    // event whose amount disagrees with the row is still refused.
    const q = service.match(/UPDATE [^`]*SET status = 'PAID'[\s\S]{0,700}?RETURNING/);
    expect(q![0]).toMatch(/ROUND\(amount \* 100\) = \$5/);
  });

  it('keeps the status guard on the paid path', () => {
    const q = service.match(/UPDATE [^`]*SET status = 'PAID'[\s\S]{0,700}?RETURNING/);
    expect(q![0]).toMatch(/status IN \('PENDING', 'FAILED'\)/);
  });

  it('keeps failure monotonic', () => {
    // A delayed failure for a superseded session must not demote a charge that
    // has since settled.
    const q = service.match(/SET status = 'FAILED', webhook_event_id[\s\S]{0,600}?RETURNING/);
    expect(q![0]).toMatch(/status = 'PENDING'/);
  });
});

describe('the migration that backs it', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'migrations', '020-payment-superseded-sessions.sql'),
    'utf8',
  );

  it('adds the column idempotently', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS superseded_session_ids TEXT\[\]/);
  });

  it('indexes it for the ANY() lookup', () => {
    expect(sql).toMatch(/USING GIN \(superseded_session_ids\)/);
  });

  it('leaves it nullable — COALESCE handles the empty case', () => {
    expect(sql).not.toMatch(/superseded_session_ids TEXT\[\] NOT NULL/);
  });
});

describe('the match must stay index-usable', () => {
  it('uses containment, not ANY(COALESCE(...))', () => {
    // Verified on the production planner: `@>` gives a Bitmap Index Scan on
    // idx_payments_superseded_session_ids, while `= ANY(COALESCE(col,'{}'))`
    // gives a Seq Scan even with enable_seqscan off — the column is wrapped in
    // a function, so the index cannot serve it. Today the table is 111 rows and
    // it would not matter; it will.
    expect(service).not.toMatch(/ANY\(COALESCE\(superseded_session_ids/);
    expect((service.match(/superseded_session_ids @> ARRAY/g) ?? []).length).toBe(4);
  });
});
