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

  it('records only AFTER the booking exists', () => {
    // Recording first would poison the key when a create fails, so the
    // customer could never retry.
    expect(createFn.indexOf('bookingService.createBooking')).toBeLessThan(
      createFn.indexOf('recordIdempotentBooking'),
    );
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

  it('the column is named for any actor, not just admins', () => {
    expect(admin).toMatch(/actor_uid\s+VARCHAR\(256\)\s+NOT NULL/);
    expect(admin).toMatch(/UNIQUE \(idempotency_key, actor_uid\)/);
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

  it('existing installs are migrated at boot, idempotently', () => {
    // Postgres has no IF EXISTS on RENAME COLUMN, and this function runs on
    // every start — so the catalog is checked first and the rename is skipped
    // once done.
    expect(admin).toContain('RENAME COLUMN admin_actor_uid TO actor_uid');
    expect(admin).toContain("column_name = 'actor_uid'");
    expect(admin).toMatch(/information_schema\.columns/);
  });

  it('booking_workers.admin_actor_uid is NOT renamed', () => {
    // Different table, different meaning — it records which admin made an
    // assignment. Renaming it would have been a silent data-model change.
    expect(admin).toMatch(
      /ALTER TABLE \$\{s\}\.booking_workers ADD COLUMN IF NOT EXISTS admin_actor_uid/,
    );
  });
});
