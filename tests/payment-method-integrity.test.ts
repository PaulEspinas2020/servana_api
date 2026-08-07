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
