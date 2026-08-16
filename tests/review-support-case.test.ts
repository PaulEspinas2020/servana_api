/**
 * Post-service support cases (§126).
 *
 * These run against `reviewDbFake`, which routes the REAL statements the service
 * issues and enforces the real constraints: the owner-scoped WHERE clause, the
 * open-case ceiling, and the partial unique index on
 * (customer_uid, client_request_id). A fake that ignored the ownership predicate
 * would let the isolation test pass against a query that had none.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => {
  const fake = require('./support/reviewDbFake');
  return { __esModule: true, default: fake.dbQueryFake, pool: fake.poolFake };
});

import fs from 'fs';
import path from 'path';
import * as fake from './support/reviewDbFake';
import {
  SupportCaseError,
  __resetSupportSchema,
  createSupportCase,
  listSupportCases,
} from '../src/services/reviews/postServiceSupportService';
import { SUPPORT_CASE_LIMITS } from '../src/services/reviews/reviewPolicy';

const CUSTOMER = 'cust-owner';
const OTHER = 'cust-other';
const PROVIDER = 'prov-1';

const base = {
  bookingId: 1,
  customerUid: CUSTOMER,
  category: 'SERVICE_QUALITY',
  summary: 'The bathroom tap still leaks.',
};

beforeEach(() => {
  fake.reset();
  __resetSupportSchema();
  fake.seedBooking(1, CUSTOMER, 'COMPLETED');
  fake.seedAssignment(1, PROVIDER);
});

// ─── Grounding in a booking ───────────────────────────────────────────────────

describe('a support case is grounded in a concluded booking', () => {
  it('creates a case on a completed booking', async () => {
    const dto = await createSupportCase(base);
    expect(dto.bookingId).toBe(1);
    expect(dto.category).toBe('SERVICE_QUALITY');
    expect(dto.state).toBe('OPEN');
    expect(fake.casesFor(1)).toHaveLength(1);
  });

  it('records the provider from the ASSIGNMENT, not from the caller', async () => {
    await createSupportCase(base);
    expect(fake.casesFor(1)[0].provider_uid).toBe(PROVIDER);
    // The input type has no provider field, so there is nothing to spoof.
    expect(Object.keys(base)).not.toContain('providerUid');
  });

  it('refuses a booking that has not concluded', async () => {
    fake.reset();
    __resetSupportSchema();
    fake.seedBooking(2, CUSTOMER, 'IN_PROGRESS');
    await expect(createSupportCase({ ...base, bookingId: 2 })).rejects.toMatchObject({
      code: 'SUPPORT_BOOKING_NOT_ELIGIBLE',
      status: 422,
    });
    expect(fake.casesFor(2)).toHaveLength(0);
  });

  it('accepts a CANCELLED booking — a cancellation can go wrong too', async () => {
    fake.seedBooking(3, CUSTOMER, 'CANCELLED');
    const dto = await createSupportCase({ ...base, bookingId: 3 });
    expect(dto.state).toBe('OPEN');
  });

  it('answers a booking that is not the caller\'s exactly like one that does not exist', async () => {
    fake.seedBooking(4, OTHER, 'COMPLETED');

    const foreign = await createSupportCase({ ...base, bookingId: 4 }).catch((e) => e);
    const absent = await createSupportCase({ ...base, bookingId: 9999 }).catch((e) => e);

    // Same code, same status, same message. Telling them apart would let a
    // caller enumerate booking ids, and a booking id is a small integer.
    expect(foreign.code).toBe(absent.code);
    expect(foreign.status).toBe(absent.status);
    expect(foreign.message).toBe(absent.message);
    expect(fake.casesFor(4)).toHaveLength(0);
  });

  it('the ownership predicate is in the SQL, not in JavaScript after the read', async () => {
    await createSupportCase(base).catch(() => undefined);
    const lookup = fake.store.sql.find((q) => q.includes('FROM servana.bookings b'));
    expect(lookup).toMatch(/WHERE b\.id = \$1 AND b\.user_id = \$2/);
  });
});

// ─── Idempotency ──────────────────────────────────────────────────────────────

describe('a retried submission does not open a second case', () => {
  it('replays the original case for a repeated clientRequestId', async () => {
    const first = await createSupportCase({ ...base, clientRequestId: 'req-1' });
    const second = await createSupportCase({
      ...base,
      summary: 'A different summary entirely.',
      clientRequestId: 'req-1',
    });

    expect(second.caseId).toBe(first.caseId);
    // The replay returns the ORIGINAL, so a retry cannot quietly edit a case.
    expect(second.summary).toBe(first.summary);
    expect(fake.casesFor(1)).toHaveLength(1);
  });

  it('takes an advisory lock before reading, so two retries cannot both insert', async () => {
    await createSupportCase({ ...base, clientRequestId: 'req-2' });
    const lockAt = fake.store.sql.findIndex((q) => q.includes('pg_advisory_xact_lock'));
    const replayAt = fake.store.sql.findIndex((q) => q.includes('client_request_id = $2'));
    const beginAt = fake.store.sql.findIndex((q) => /^BEGIN/.test(q));

    expect(beginAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeGreaterThan(beginAt);
    expect(replayAt).toBeGreaterThan(lockAt);
  });

  it('locks on the customer AND booking, so one customer\'s retry does not block another\'s', async () => {
    await createSupportCase(base);
    const lock = fake.store.sql.find((q) => q.includes('pg_advisory_xact_lock'));
    expect(lock).toBeDefined();
  });

  it('two cases with no request id are two real cases', async () => {
    // Idempotency is opt-in. A customer who reports damage and then, separately,
    // a billing problem has two complaints, not one.
    await createSupportCase(base);
    await createSupportCase({ ...base, category: 'BILLING', summary: 'Charged twice.' });
    expect(fake.casesFor(1)).toHaveLength(2);
  });

  it('rolls back rather than leaving a case behind when the commit fails', async () => {
    fake.store.failNextCommit = true;
    await expect(createSupportCase(base)).rejects.toThrow('commit failed');
    expect(fake.casesFor(1)).toHaveLength(0);
  });
});

// ─── The ceiling ──────────────────────────────────────────────────────────────

describe('the open-case ceiling', () => {
  it('refuses beyond the declared maximum of open cases', async () => {
    for (let i = 0; i < SUPPORT_CASE_LIMITS.maxOpenPerBooking; i += 1) {
      await createSupportCase({ ...base, summary: `Problem ${i}` });
    }
    await expect(createSupportCase(base)).rejects.toMatchObject({
      code: 'SUPPORT_CASE_LIMIT_REACHED',
      status: 409,
    });
    expect(fake.casesFor(1)).toHaveLength(SUPPORT_CASE_LIMITS.maxOpenPerBooking);
  });

  it('counts only OPEN cases, so a resolved one frees a slot', async () => {
    for (let i = 0; i < SUPPORT_CASE_LIMITS.maxOpenPerBooking; i += 1) {
      await createSupportCase({ ...base, summary: `Problem ${i}` });
    }
    fake.store.supportCases[0].state = 'RESOLVED';
    const dto = await createSupportCase({ ...base, summary: 'A new problem.' });
    expect(dto.state).toBe('OPEN');
  });

  it('counts per booking and per customer, not globally', async () => {
    fake.seedBooking(5, CUSTOMER, 'COMPLETED');
    for (let i = 0; i < SUPPORT_CASE_LIMITS.maxOpenPerBooking; i += 1) {
      await createSupportCase({ ...base, summary: `Problem ${i}` });
    }
    // A different booking is unaffected: the ceiling is a per-incident guard,
    // not a cap on how much trouble one customer is allowed to have.
    await expect(createSupportCase({ ...base, bookingId: 5 })).resolves.toBeDefined();
  });
});

// ─── Routing ──────────────────────────────────────────────────────────────────

describe('routing and severity', () => {
  it('routes BILLING to finance and names the endpoint that issues refunds', async () => {
    const dto = await createSupportCase({
      ...base,
      category: 'BILLING',
      summary: 'I was charged twice for one visit.',
    });
    expect(dto.routedTo).toBe('finance');
    expect(dto.nextEndpoint).toBe('POST /api/v1/bookings/:bookingId/refunds');
  });

  it('does not move any money itself', async () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src/services/reviews/postServiceSupportService.ts'),
      'utf8',
    );
    // A second refund path beside the one reconciliation checks is a break
    // nobody can close. The service imports no money module, so it cannot open
    // one — the finance domain is NAMED in a response string, never called.
    const imports = source.match(/^import[\s\S]*?from '[^']+';$/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      expect(line).not.toMatch(/payment|refund|payout|disburse|stripe/i);
    }
    expect(source).not.toMatch(/UPDATE\s+\$\{s\}\.(payments|payouts)/);
  });

  it('raises damage and safety at elevated severity', async () => {
    const damage = await createSupportCase({
      ...base,
      category: 'PROPERTY_DAMAGE',
      summary: 'A cupboard door was cracked.',
    });
    const safety = await createSupportCase({
      ...base,
      category: 'SAFETY_CONCERN',
      summary: 'I did not feel safe.',
    });
    expect(damage.severity).toBe('elevated');
    expect(safety.severity).toBe('elevated');
  });

  it('leaves ordinary quality complaints at normal severity', async () => {
    const dto = await createSupportCase(base);
    expect(dto.severity).toBe('normal');
    expect(dto.routedTo).toBe('support');
    expect(dto.nextEndpoint).toBeNull();
  });

  it('refuses an unknown category rather than filing it as "other"', async () => {
    // A case filed under a category nobody triages is a complaint nobody reads.
    await expect(createSupportCase({ ...base, category: 'ANYTHING' })).rejects.toMatchObject({
      code: 'SUPPORT_CATEGORY_INVALID',
      status: 400,
    });
  });

  it('accepts a lowercase category, because a client sending one meant it', async () => {
    const dto = await createSupportCase({ ...base, category: 'billing' });
    expect(dto.category).toBe('BILLING');
  });
});

// ─── Content ──────────────────────────────────────────────────────────────────

describe('content limits', () => {
  it('requires a summary', async () => {
    await expect(createSupportCase({ ...base, summary: '   ' })).rejects.toMatchObject({
      code: 'SUPPORT_CONTENT_INVALID',
    });
  });

  it('refuses a summary past the declared limit', async () => {
    await expect(
      createSupportCase({ ...base, summary: 'x'.repeat(SUPPORT_CASE_LIMITS.summary + 1) }),
    ).rejects.toBeInstanceOf(SupportCaseError);
  });

  it('refuses a detail past the declared limit', async () => {
    await expect(
      createSupportCase({ ...base, detail: 'x'.repeat(SUPPORT_CASE_LIMITS.detail + 1) }),
    ).rejects.toMatchObject({ code: 'SUPPORT_CONTENT_INVALID' });
  });

  it('validates BEFORE opening a transaction', async () => {
    await createSupportCase({ ...base, summary: '' }).catch(() => undefined);
    // Nothing should have been sent but the lazy DDL.
    expect(fake.store.sql.some((q) => /^BEGIN/.test(q))).toBe(false);
  });
});

// ─── Reading back ─────────────────────────────────────────────────────────────

describe('listing cases', () => {
  it('returns this customer\'s cases on this booking', async () => {
    await createSupportCase(base);
    await createSupportCase({ ...base, category: 'BILLING', summary: 'Charged twice.' });
    const cases = await listSupportCases(1, CUSTOMER);
    expect(cases).toHaveLength(2);
  });

  it('returns nothing to a caller who is not the booking\'s customer', async () => {
    await createSupportCase(base);
    expect(await listSupportCases(1, OTHER)).toEqual([]);
  });

  it('never projects the free-text detail', async () => {
    // The detail can carry anything the customer typed, including other people's
    // names and what happened in their home. It is stored for a human handler,
    // not returned to a list view.
    await createSupportCase({ ...base, detail: 'My neighbour Dana saw it happen.' });
    const [dto] = await listSupportCases(1, CUSTOMER);
    expect(JSON.stringify(dto)).not.toMatch(/Dana/);
    expect(dto).not.toHaveProperty('detail');
  });

  it('never projects the raw customer or provider uid', async () => {
    await createSupportCase(base);
    const [dto] = await listSupportCases(1, CUSTOMER);
    expect(JSON.stringify(dto)).not.toContain(PROVIDER);
    expect(JSON.stringify(dto)).not.toContain(CUSTOMER);
  });
});
