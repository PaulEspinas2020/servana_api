jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
jest.mock('../src/helpers/mailer', () => ({ send: jest.fn() }));
jest.mock('../src/services/user.service', () => ({ getUserInfoByBookingId: jest.fn() }));
jest.mock('../src/services/notification.service', () => ({ createNotification: jest.fn() }));
jest.mock('../src/services/additional.service', () => ({ additionalService: {} }));

import dbQuery from '../src/db/dbQuery';
import fs from 'fs';
import path from 'path';
import {
  approvePayment,
  markCashPaid,
  submitGcash,
} from '../src/services/paymentService';

const query = dbQuery.query as jest.Mock;

beforeEach(() => query.mockReset());

describe('payment method integrity', () => {
  test('GCash evidence cannot rewrite another chosen method', async () => {
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(submitGcash(7, 'REF-1')).rejects.toThrow(
      'not configured for GCash',
    );
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("AND method='GCASH'");
    expect(sql).not.toContain("SET method='GCASH'");
  });

  test('manual approval is restricted to GCash', async () => {
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(approvePayment(8)).rejects.toThrow('Only a GCash');
    expect(query.mock.calls[0][0]).toContain("AND method='GCASH'");
  });

  test('manual GCash approval preserves the original payment time on a replay', async () => {
    // Same shape and same gap as the cash path. Both set status='PAID' with no
    // status guard, so a repeat moved `paid_at` forward on a row that was already
    // paid. Fixing only the path the worker app calls would leave the identical
    // defect for the next reader to find.
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(approvePayment(12)).rejects.toThrow('Only a GCash');
    const [sql] = query.mock.calls[0];
    expect(sql).toContain('COALESCE(paid_at, NOW())');
    expect(sql).not.toMatch(/paid_at\s*=\s*NOW\(\)/);
  });

  test('cash settlement preserves the original collection time on a replay', async () => {
    // This is money, and `paid_at` is the answer to "when was the cash taken".
    // The unguarded form re-ran against an already-PAID row and moved the
    // timestamp forward, so a double tap on a slow connection silently rewrote
    // it. COALESCE makes a repeat produce the identical end state, which is the
    // contract's own definition of idempotent and what lets this path name a
    // replay guard when it gains a v1 entry.
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(markCashPaid(11)).rejects.toThrow('not configured for cash');
    const [sql] = query.mock.calls[0];
    expect(sql).toContain('COALESCE(paid_at, NOW())');
    expect(sql).not.toMatch(/paid_at\s*=\s*NOW\(\)/);
  });

  test('cash settlement cannot rewrite a PayMongo booking', async () => {
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(markCashPaid(9)).rejects.toThrow('not configured for cash');
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("AND method='CASH'");
    expect(sql).not.toContain("SET method='CASH'");
  });
});

test('an unmatched failed webhook is retried instead of acknowledged', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'paymentService.ts'),
    'utf8',
  );
  const failedBranch = source.slice(
    source.indexOf('eventType === "checkout_session.payment.failed"'),
    source.indexOf('// Send payment failed email'),
  );
  expect(failedBranch).toContain('RETURNING booking_id');
  expect(failedBranch).toContain('if (!failedUpdate.rowCount)');
  expect(failedBranch).toContain('PayMongo checkout session not found');
});
