/**
 * A provider who relinquishes a job gets the same answer as for a booking that
 * does not exist.
 *
 * ## The rule
 *
 * The Master Command's Provider A / Provider B leakage rule, applied to the
 * moment the assignment moves. Three things must be true at once:
 *
 *   1. Provider A, once relinquished, cannot READ the job — not a staged card,
 *      not an empty husk, nothing;
 *   2. Provider A cannot ACT on it;
 *   3. Provider B has nothing before their assignment row exists.
 *
 * ## Why staging alone was not enough
 *
 * `disclosureLevelFor('DECLINED')` already returned `none`, so the customer's
 * name, phone and address were withheld. The card still came back. An empty
 * card confirms the booking exists, that it is still live, and roughly when it
 * was scheduled — which is exactly the kind of oracle "not found" exists to
 * deny. Staging answers "how much"; scoping answers "at all", and the rule
 * needs both.
 */

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: {} }));

import fs from 'fs';
import path from 'path';

import dbQuery from '../src/db/dbQuery';
import { getJobCardsByWorker, getJobCardByWorker } from '../src/services/technicianService';
import {
  READABLE_WORKER_STATUSES,
  READABLE_WORKER_STATUS_SQL,
  RELINQUISHED_WORKER_STATUSES,
  OPERATIONAL_WORKER_STATUSES,
  disclosureLevelFor,
} from '../src/controllers/providerDisclosure';

const q = dbQuery.query as jest.Mock;

const SRC = path.join(__dirname, '..', 'src');
const codeOf = (rel: string): string => fs
  .readFileSync(path.join(SRC, rel), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const PROVIDER_A = 'provider-a-uid';   // the outgoing provider
const PROVIDER_B = 'provider-b-uid';   // the incoming provider
const BOOKING = 4242;

/**
 * A database that honours BOTH scoping predicates the query carries: the
 * booking pointer and the assignment status.
 *
 * Modelled on what PostgreSQL does with `WHERE b.worker_uid = $1` and an INNER
 * `JOIN LATERAL` over `booking_workers` — if neither matches, no row.
 */
const mountAssignment = (row: {
  bookingWorkerUid: string | null;
  assignments: Array<{ uid: string; status: string }>;
}) => {
  q.mockReset();
  q.mockImplementation((sql: string, params: any[] = []) => {
    if (!/FROM servana\.bookings b/.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });

    const uid = params[0];
    const bookingId = params[1] ?? null;

    const pointerMatches = row.bookingWorkerUid === uid;
    const assignment = row.assignments.find((a) => a.uid === uid);
    const statusReadable = assignment
      ? READABLE_WORKER_STATUSES.includes(assignment.status.toUpperCase())
      : false;
    const idMatches = bookingId === null || bookingId === BOOKING;

    const visible = pointerMatches && statusReadable && idMatches
      ? [{
        booking_id: BOOKING, id: BOOKING, worker_uid: uid,
        status: 'WORKER_ASSIGNED', worker_status: assignment!.status,
        has_escalation: false, schedule: '2026-09-01T10:00:00.000Z',
        customer_id: 'cust-1', first_name: 'Maria', last_name: 'Santos',
        phone_number: '+639171234567', address_one: '45 Ayala Avenue',
        post_town: 'Makati', country: 'PH',
      }]
      : [];
    return Promise.resolve({ rows: visible, rowCount: visible.length });
  });
};

// ─── 1. The read scope is declared once ───────────────────────────────────────

describe('who may read a job is one declaration', () => {
  it('readable and relinquished do not overlap', () => {
    for (const status of [...RELINQUISHED_WORKER_STATUSES]) {
      expect(READABLE_WORKER_STATUSES).not.toContain(status);
    }
  });

  it('keeps every operational status readable, plus the offer and the record', () => {
    for (const status of [...OPERATIONAL_WORKER_STATUSES]) {
      expect(READABLE_WORKER_STATUSES).toContain(status);
    }
    // ASSIGNED is the offer — withholding it means nobody can ever accept.
    expect(READABLE_WORKER_STATUSES).toContain('ASSIGNED');
    // COMPLETED is the record. The payout window is 72 hours; a job that
    // vanished when it finished would be a support ticket, not a privacy win.
    expect(READABLE_WORKER_STATUSES).toContain('COMPLETED');
  });

  it('every readable status also earns a disclosure level above nothing', () => {
    // The two decisions have to agree: a status you may read is a status the
    // staging has an answer for.
    for (const status of READABLE_WORKER_STATUSES) {
      expect(disclosureLevelFor(status)).not.toBe('none');
    }
  });

  it('emits a SQL list, so a query cannot widen the scope by retyping', () => {
    expect(READABLE_WORKER_STATUS_SQL).toContain("'ASSIGNED'");
    expect(READABLE_WORKER_STATUS_SQL).toContain("'COMPLETED'");
    expect(READABLE_WORKER_STATUS_SQL).not.toContain("'DECLINED'");
    expect(READABLE_WORKER_STATUS_SQL).not.toContain("'REASSIGNED'");
  });
});

// ─── 2. Provider A, after relinquishing ───────────────────────────────────────

describe('the outgoing provider is refused, not merely stripped', () => {
  it('reads nothing once reassigned away', async () => {
    // ADMIN_REASSIGN moves the pointer to B and closes A's row as DECLINED.
    mountAssignment({
      bookingWorkerUid: PROVIDER_B,
      assignments: [{ uid: PROVIDER_A, status: 'DECLINED' }, { uid: PROVIDER_B, status: 'ASSIGNED' }],
    });

    expect(await getJobCardsByWorker(PROVIDER_A)).toEqual([]);
    expect(await getJobCardByWorker(PROVIDER_A, BOOKING)).toBeNull();
  });

  it('reads nothing after declining, even while the row survives', async () => {
    /**
     * PROVIDER_DECLINE clears `bookings.worker_uid` — "the full release, not
     * just the pointer" — so this is belt and braces. It is asserted anyway
     * because the assignment row REMAINS as history, and a future query that
     * scoped on the row alone would hand the job straight back.
     */
    mountAssignment({
      bookingWorkerUid: PROVIDER_A,
      assignments: [{ uid: PROVIDER_A, status: 'DECLINED' }],
    });
    expect(await getJobCardsByWorker(PROVIDER_A)).toEqual([]);
  });

  it('reads nothing once the booking is cancelled under either spelling', async () => {
    for (const spelling of ['CANCELED', 'CANCELLED']) {
      mountAssignment({
        bookingWorkerUid: PROVIDER_A,
        assignments: [{ uid: PROVIDER_A, status: spelling }],
      });
      expect(await getJobCardsByWorker(PROVIDER_A)).toEqual([]);
    }
  });

  it('gets the SAME answer as for a booking that never existed', async () => {
    // The oracle this closes: a different answer would confirm the booking
    // exists and is somebody else's.
    mountAssignment({
      bookingWorkerUid: PROVIDER_B,
      assignments: [{ uid: PROVIDER_A, status: 'REASSIGNED' }],
    });
    const relinquished = await getJobCardByWorker(PROVIDER_A, BOOKING);
    const nonexistent = await getJobCardByWorker(PROVIDER_A, 999999);
    expect(relinquished).toBe(nonexistent);
    expect(relinquished).toBeNull();
  });

  it('still reads work they actually completed', async () => {
    // The payout window is 72 hours. Scoping is not amnesia.
    mountAssignment({
      bookingWorkerUid: PROVIDER_A,
      assignments: [{ uid: PROVIDER_A, status: 'COMPLETED' }],
    });
    expect(await getJobCardsByWorker(PROVIDER_A)).toHaveLength(1);
  });
});

// ─── 3. Provider B, before and after the handover ─────────────────────────────

describe('the incoming provider has nothing before the assignment exists', () => {
  it('cannot read the job while it is still A\'s', async () => {
    mountAssignment({
      bookingWorkerUid: PROVIDER_A,
      assignments: [{ uid: PROVIDER_A, status: 'ACCEPTED' }],
    });
    expect(await getJobCardsByWorker(PROVIDER_B)).toEqual([]);
    expect(await getJobCardByWorker(PROVIDER_B, BOOKING)).toBeNull();
  });

  it('reads it once the authoritative assignment begins', async () => {
    mountAssignment({
      bookingWorkerUid: PROVIDER_B,
      assignments: [{ uid: PROVIDER_A, status: 'DECLINED' }, { uid: PROVIDER_B, status: 'ASSIGNED' }],
    });
    const cards = await getJobCardsByWorker(PROVIDER_B);
    expect(cards).toHaveLength(1);
    // And at the ASSIGNED floor: an admin handover does not pre-authorise the
    // incoming provider to the customer's door.
    expect(disclosureLevelFor(cards[0].worker_status)).toBe('area');
  });
});

// ─── 4. Every surface scopes the same way ─────────────────────────────────────

describe('the leakage rule reaches every provider surface TAB 05 owns', () => {
  it('the job-card query filters on the shared readable list', () => {
    const code = codeOf('services/technicianService.ts');
    expect(code).toContain('AND bw.status IN (${READABLE_WORKER_STATUS_SQL})');
    // The old hand-written list included the relinquished statuses.
    expect(code).not.toContain("'IN_PROGRESS','COMPLETED','CANCELED','CANCELLED','DECLINED'");
  });

  it('Provider Web\'s job list filters on it too, in an INNER lateral join', () => {
    /**
     * INNER, deliberately: an assignment row that does not qualify removes the
     * booking from the list rather than returning it with a null status.
     */
    const code = codeOf('controllers/providerController.ts');
    expect(code).toContain('READABLE_WORKER_STATUS_SQL');
    expect(code).toContain('JOIN LATERAL (');
    expect(code).not.toContain('LEFT JOIN LATERAL (\n    SELECT bw1.status');
  });

  it('the booking detail already refused a relinquished provider', () => {
    // Its authorization is a join, not a filter applied afterwards, so a
    // declined provider gets 404 and never reaches the staging at all.
    const code = codeOf('controllers/providerController.ts');
    expect(code).toContain("bw.status IN ('ASSIGNED','ACCEPTED','EN_ROUTE','ARRIVED','IN_PROGRESS','COMPLETED')");
  });

  it('the calendar excludes relinquished work from its status lists', () => {
    const code = codeOf('services/providerCalendarService.ts');
    const lists = code
      .split(String.fromCharCode(10))
      .filter((l: string) => /^const (CONFIRMED|AWAITING)_WORKER_STATUSES/.test(l))
      .join(' ');
    for (const status of [...RELINQUISHED_WORKER_STATUSES]) {
      expect(lists).not.toContain(status);
    }
  });

  it('earnings expose only COMPLETED work — the sanitized historical view', () => {
    /**
     * The audit trail a provider is allowed to keep: what they finished and
     * what they are owed. It cannot reveal a job that is now somebody else's,
     * because a reassigned booking is not COMPLETED for the outgoing provider.
     */
    // TAB 07 moved the earnings queries into the canonical domain service. The
    // filter is the same filter and is now applied in ONE place for both the
    // legacy and the v1 earnings paths, so neither can widen without the other.
    const code = codeOf('services/finance/providerEarningsService.ts');
    expect(code).toContain("WHERE b.worker_uid = $1 AND b.status = 'COMPLETED'");
  });

  it('lifecycle actions re-authorize from the LOCKED assignment row', () => {
    // Reading is scoped by query; acting is scoped by the executor, which
    // resolves the actor against the row it holds a lock on.
    const executor = codeOf('services/booking/transitionExecutor.ts');
    expect(executor).toContain('FOR UPDATE');
    expect(executor).toContain('NOT_AUTHORIZED');
  });
});

// ─── 5. Nothing is deleted to achieve this ────────────────────────────────────

describe('history is preserved, not erased', () => {
  it('the outgoing assignment row is closed, never removed', () => {
    /**
     * The distinction the whole design rests on: the row still answers "was
     * this provider ever on this job, and when did it end" for an audit or a
     * payout dispute. What changes is that no CURRENT-provider surface reads
     * it.
     */
    const executor = codeOf('services/booking/transitionExecutor.ts');
    expect(executor).not.toMatch(/DELETE FROM \$\{s\}\.booking_workers/);
    expect(executor).toContain("'DECLINED'");
  });

  it('the scoping is a filter on reads, not a mutation', () => {
    const technician = codeOf('services/technicianService.ts');
    const jobCardQuery = technician.slice(
      technician.indexOf('export const getJobCardsByWorker'),
    );
    expect(jobCardQuery).toContain('SELECT');
    expect(jobCardQuery.slice(0, jobCardQuery.indexOf('};')))
      .not.toMatch(/\b(DELETE|UPDATE)\b/);
  });
});
