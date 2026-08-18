/**
 * Duplicate-submission protection on POST /api/bookings.
 *
 * ServanaClient has generated an idempotency key per booking draft since it was
 * written, sends it as `X-Idempotency-Key`, and holds it until the backend
 * confirms (draft_repository.getOrCreateIdempotencyKey / clearIdempotencyKey).
 * The endpoint read the header nowhere.
 *
 * So a retried submit created a SECOND booking and a second payment row. That is
 * not hypothetical: the app targets Philippine mobile networks, submit is the
 * slowest call in the flow, and the client's entire recovery layer exists
 * because requests there are expected to time out and be retried. A timeout that
 * had actually succeeded server-side charged the customer twice and dispatched
 * two providers to the same job.
 *
 * The admin create-booking flow has had this since it was written — it requires
 * `idempotencyKey` in the body and rejects calls without one. The customer path
 * was simply never given the same treatment, so both now share one table and one
 * module rather than growing a second implementation (§9, §17).
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

import fs from 'fs';
import path from 'path';
import dbQuery from '../src/db/dbQuery';
import {
  normaliseIdempotencyKey,
  findBookingByIdempotencyKey,
  recordIdempotentBooking,
  MAX_IDEMPOTENCY_KEY_LENGTH,
} from '../src/services/bookingIdempotency';

const q = dbQuery.query as jest.Mock;
const SRC = path.join(__dirname, '..', 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

beforeEach(() => q.mockReset());

describe('key normalisation', () => {
  it('accepts an ordinary key', () => {
    expect(normaliseIdempotencyKey('draft-abc-123')).toBe('draft-abc-123');
  });

  it('trims surrounding whitespace', () => {
    expect(normaliseIdempotencyKey('  k  ')).toBe('k');
  });

  it.each([undefined, null, '', '   ', 42, {}, []])(
    'treats %p as absent rather than throwing',
    (v) => {
      expect(normaliseIdempotencyKey(v as any)).toBeNull();
    },
  );

  it('rejects a key longer than the column', () => {
    // Silently truncating would make two different requests collide on the
    // same stored key, which is worse than no protection.
    const tooLong = 'x'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1);
    expect(normaliseIdempotencyKey(tooLong)).toBeNull();
    expect(normaliseIdempotencyKey('x'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH))).not.toBeNull();
  });
});

describe('finding an earlier submission', () => {
  it('returns the booking a replayed key already created', async () => {
    q.mockResolvedValueOnce({ rowCount: 1, rows: [{ booking_id: 4242 }] });
    await expect(findBookingByIdempotencyKey('k', 'uid-A')).resolves.toBe(4242);
  });

  it('returns null when the key is new', async () => {
    q.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(findBookingByIdempotencyKey('k', 'uid-A')).resolves.toBeNull();
  });

  it('scopes the lookup to the actor', async () => {
    // Without this, two customers sharing a key value would read each other's
    // bookings — the lookup would be a cross-user read dressed as a retry.
    q.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await findBookingByIdempotencyKey('k', 'uid-A');
    const [sql, params] = q.mock.calls[0];
    expect(sql).toContain('actor_uid = $2');
    expect(params).toEqual(['k', 'uid-A']);
  });

  it('does not query at all without a key', async () => {
    await expect(findBookingByIdempotencyKey(null, 'uid-A')).resolves.toBeNull();
    expect(q).not.toHaveBeenCalled();
  });

  it('does not query at all without an actor', async () => {
    await expect(findBookingByIdempotencyKey('k', null)).resolves.toBeNull();
    expect(q).not.toHaveBeenCalled();
  });
});

describe('recording a submission', () => {
  it('writes the key against the booking', async () => {
    q.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await recordIdempotentBooking('k', 'uid-A', 77);
    const [sql, params] = q.mock.calls[0];
    expect(sql).toContain('INSERT INTO servana.booking_create_idempotency');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(params).toEqual(['k', 'uid-A', 77]);
  });

  it('a write failure never fails the booking', async () => {
    // The booking exists. Reporting failure because bookkeeping did not persist
    // would make the customer retry a request that already succeeded — causing
    // the exact duplicate this module prevents.
    q.mockRejectedValueOnce(new Error('unique violation'));
    await expect(recordIdempotentBooking('k', 'uid-A', 77)).resolves.toBeUndefined();
  });

  it.each([
    [null, 'uid-A', 77],
    ['k', null, 77],
    ['k', 'uid-A', null],
  ])('skips the write when any part is missing (%p, %p, %p)', async (k, a, b) => {
    await recordIdempotentBooking(k as any, a as any, b as any);
    expect(q).not.toHaveBeenCalled();
  });
});

describe('the controller wiring', () => {
  const controller = read('controllers', 'bookingController.ts');
  const createFn = controller.slice(
    controller.indexOf('export const createBooking'),
    controller.indexOf('export const confirmOtp'),
  );

  it('reads the header the client actually sends', () => {
    expect(createFn).toMatch(/req\.header\(\s*'X-Idempotency-Key'\s*\)/);
  });

  it('checks BEFORE creating, not after', () => {
    // Checking afterwards would mean the duplicate already exists.
    expect(createFn.indexOf('findBookingByIdempotencyKey')).toBeLessThan(
      createFn.indexOf('bookingService.createBooking'),
    );
  });

  it('a replay returns the original booking, not an error', () => {
    // A retry is the client asking "did that land?". The honest answer is the
    // booking it created, and a 200 makes the retry indistinguishable from the
    // first success — which is the whole point.
    expect(createFn).toMatch(/idempotentReplay:\s*true/);
    expect(createFn).toContain('getBookingById(alreadyCreated)');
  });

  it('passes the key into the transactional service write', () => {
    expect(createFn).toMatch(
      /bookingService\.createBooking\(\s*userId,\s*validatedPayload,\s*idempotencyKey/,
    );
    expect(createFn.indexOf('validateCustomerBookingCreatePayload(req.body)')).toBeLessThan(
      createFn.indexOf('bookingService.createBooking'),
    );
    expect(createFn).not.toContain('recordIdempotentBooking(');
  });

  it('a concurrent uniqueness loser returns the winning booking', () => {
    expect(createFn).toContain("e?.code === '23505'");
    expect(createFn).toContain("includes('idempotency')");
    expect(createFn).toContain('findBookingByIdempotencyKey(idempotencyKey, userId)');
  });

  it('a key whose booking has vanished is a 409, not a silent re-create', () => {
    // Falling through would duplicate; pretending success would lie.
    expect(createFn).toContain('IDEMPOTENCY_KEY_REUSED');
    expect(createFn).toContain('409');
  });

  it('a request without a key still works', () => {
    // Older clients send none. Rejecting them would break every shipped app to
    // fix a duplicate-submission bug.
    expect(createFn).not.toMatch(/idempotencyKey is required/);
    expect(createFn).not.toMatch(/if \(!idempotencyKey\)[\s\S]{0,80}return res\.status\(400\)/);
  });
});

describe('the admin flow shares this table, and still works', () => {
  const admin = read('services', 'adminCreateBookingService.ts');
  const baseline = fs
    .readFileSync(path.resolve(__dirname, '../scripts/baseline/000-baseline.sql'), 'utf8')
    .replace(/\r\n/g, '\n');

  it('the column is named for any actor, not just admins', () => {
    /**
     * Asserted against the baseline since TAB 02 removed the bootstrap. The rename
     * is COMPLETE in production: the column is `actor_uid`.
     *
     * The constraint NAME still reads
     * `booking_create_idempotency_idempotency_key_admin_actor_uid_key`, because
     * Postgres does not rename a constraint when you rename the column under it.
     * That is cosmetic — the constraint covers (idempotency_key, actor_uid) — but
     * it is the kind of leftover that makes a grep for `admin_actor_uid` look
     * alarming, so it is written down rather than left to be rediscovered.
     */
    const m = /CREATE TABLE servana\.booking_create_idempotency \(([\s\S]*?)\n\);/.exec(baseline);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/^\s+actor_uid character varying\(256\) NOT NULL/m);
    expect(m![1]).not.toMatch(/^\s+admin_actor_uid/m);
    expect(baseline).toMatch(/UNIQUE \(idempotency_key, actor_uid\)/);
  });

  it('every idempotency query uses the new name', () => {
    const idempotencyQueries = admin
      .split('\n')
      .filter((l) => l.includes('idempotency_key'));
    expect(idempotencyQueries.length).toBeGreaterThan(0);
    for (const line of idempotencyQueries) {
      expect(line).not.toContain('admin_actor_uid');
    }
  });

  it('the boot-time rename is gone, because it is already done', () => {
    /**
     * The bootstrap carried `RENAME COLUMN admin_actor_uid TO actor_uid`, guarded
     * by an information_schema check because Postgres has no IF EXISTS on RENAME
     * and the function ran on every start.
     *
     * Production completed it — the baseline above proves that — so the statement
     * had nothing left to do. A one-time rename living in a boot path is exactly
     * the class TAB 02 removes: it must run once, it cannot say whether it has,
     * and it re-asks the catalog on every restart forever.
     */
    expect(admin).not.toContain('RENAME COLUMN');
    expect(admin).not.toMatch(/information_schema\.columns/);
  });

  it('booking_workers.admin_actor_uid is NOT renamed', () => {
    // Different table, different meaning — it records which admin made an
    // assignment. Renaming it would have been a silent data-model change.
    const m = /CREATE TABLE servana\.booking_workers \(([\s\S]*?)\n\);/.exec(baseline);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/^\s+admin_actor_uid/m);
  });
});
