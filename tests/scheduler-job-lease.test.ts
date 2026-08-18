/**
 * TAB 08 — schedulers safe under horizontal scale.
 *
 * These prove the lease, not the jobs. The job bodies were not changed; what
 * changed is that each tick now has to win a lease before it runs.
 *
 * Why a fake pool rather than PGlite: `pg_try_advisory_lock` is session-scoped,
 * so proving "two replicas, one winner" needs two SIMULTANEOUS connections.
 * PGlite is single-connection and cannot express that — the same limitation that
 * blocks the booking race suite. The fake models the one behaviour that matters:
 * the first caller to ask for a given key gets it, the next does not.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));

/** Locks held right now, keyed by the hashed lock name. Shared by all clients. */
const heldLocks = new Set<string>();
/** Clients handed out and not yet released — a leak detector. */
let outstandingClients = 0;
/** Every unlock, with the client that issued it, to prove same-connection release. */
const unlockLog: Array<{ clientId: number; key: string }> = [];

let nextClientId = 1;
let failNextConnect = false;

const makeClient = () => {
  const clientId = nextClientId++;
  return {
    clientId,
    query: jest.fn(async (sql: string, params: any[]) => {
      const key = params?.[0];
      if (sql.includes('pg_try_advisory_lock')) {
        if (heldLocks.has(key)) return { rows: [{ locked: false }] };
        heldLocks.add(key);
        return { rows: [{ locked: true }] };
      }
      if (sql.includes('pg_advisory_unlock')) {
        unlockLog.push({ clientId, key });
        heldLocks.delete(key);
        return { rows: [{ unlocked: true }] };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(() => {
      outstandingClients -= 1;
    }),
  };
};

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) },
  pool: {
    connect: jest.fn(async () => {
      if (failNextConnect) {
        failNextConnect = false;
        throw new Error('pool exhausted');
      }
      outstandingClients += 1;
      return makeClient();
    }),
  },
}));

import { withJobLease, schedulerJobStats, __resetJobStats } from '../src/services/scheduler/jobLease';

const flushMicrotasks = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  heldLocks.clear();
  unlockLog.length = 0;
  outstandingClients = 0;
  nextClientId = 1;
  failNextConnect = false;
  __resetJobStats();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('TAB 08 — two replicas execute each logical job once', () => {
  it('the second concurrent replica skips instead of running the body', async () => {
    let running = 0;
    let peakConcurrent = 0;
    let completions = 0;

    // Held open until both replicas have tried, so the second genuinely overlaps
    // the first rather than arriving after it finished.
    let releaseBody: () => void = () => {};
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });

    const body = async () => {
      running += 1;
      peakConcurrent = Math.max(peakConcurrent, running);
      await bodyGate;
      completions += 1;
      running -= 1;
    };

    const replicaA = withJobLease('otp-reminder', body);
    await flushMicrotasks();
    const replicaB = withJobLease('otp-reminder', body);
    await flushMicrotasks();

    releaseBody();
    const [a, b] = await Promise.all([replicaA, replicaB]);

    expect(peakConcurrent).toBe(1);
    expect(completions).toBe(1);
    expect([a, b].sort()).toEqual(['skipped_locked', 'success']);
  });

  it('releases the lease so the NEXT tick can run', async () => {
    const ran: string[] = [];
    await withJobLease('otp-reminder', async () => {
      ran.push('first');
    });
    await withJobLease('otp-reminder', async () => {
      ran.push('second');
    });
    expect(ran).toEqual(['first', 'second']);
    expect(heldLocks.size).toBe(0);
  });

  it('different jobs do not block each other', async () => {
    const ran: string[] = [];
    const a = withJobLease('otp-reminder', async () => {
      ran.push('otp');
    });
    const b = withJobLease('payment-retry', async () => {
      ran.push('payment');
    });
    await Promise.all([a, b]);
    expect(ran.sort()).toEqual(['otp', 'payment']);
  });
});

describe('the lease releases correctly', () => {
  it('unlocks on the SAME connection that locked', async () => {
    /**
     * The trap this guards: a session advisory lock belongs to one connection.
     * Unlocking through the pool helper would take a DIFFERENT connection and
     * unlock nothing — the lock would leak until the process exits and the job
     * would never run again on that replica.
     */
    await withJobLease('otp-reminder', async () => {});
    expect(unlockLog).toHaveLength(1);
    expect(unlockLog[0].clientId).toBe(1);
  });

  it('releases the lease and the client even when the job throws', async () => {
    await withJobLease('otp-reminder', async () => {
      throw new Error('boom');
    });
    expect(heldLocks.size).toBe(0);
    expect(outstandingClients).toBe(0);
  });

  it('never leaks a pooled client across success, failure and skip', async () => {
    await withJobLease('a', async () => {});
    await withJobLease('b', async () => {
      throw new Error('x');
    });
    const held = withJobLease('c', async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    await flushMicrotasks();
    await withJobLease('c', async () => {}); // skipped
    await held;
    expect(outstandingClients).toBe(0);
  });
});

describe('failed work is visible without log archaeology', () => {
  it('records success with a duration', async () => {
    await withJobLease('otp-reminder', async () => {});
    const stat = schedulerJobStats().find((s) => s.job === 'otp-reminder')!;
    expect(stat.last.outcome).toBe('success');
    expect(stat.success).toBe(1);
    expect(typeof stat.last.durationMs).toBe('number');
  });

  it('records the failure message, and does NOT throw out of the tick', async () => {
    // node-cron has no error channel; a throw here would vanish silently.
    await expect(
      withJobLease('otp-reminder', async () => {
        throw new Error('smtp refused');
      }),
    ).resolves.toBe('failure');

    const stat = schedulerJobStats().find((s) => s.job === 'otp-reminder')!;
    expect(stat.last.outcome).toBe('failure');
    expect(stat.last.error).toBe('smtp refused');
    expect(stat.failure).toBe(1);
  });

  it('counts a skip separately from a failure — a skip is normal under scale', async () => {
    const held = withJobLease('otp-reminder', async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    await flushMicrotasks();
    await withJobLease('otp-reminder', async () => {});
    await held;

    const stat = schedulerJobStats().find((s) => s.job === 'otp-reminder')!;
    expect(stat.skipped).toBe(1);
    expect(stat.failure).toBe(0);
  });

  it('reports a lease it could not even attempt, rather than running unguarded', async () => {
    // Running without the lease is precisely what this module prevents, so a
    // pool failure must NOT fall through into the job body.
    let bodyRan = false;
    failNextConnect = true;
    const outcome = await withJobLease('otp-reminder', async () => {
      bodyRan = true;
    });
    expect(outcome).toBe('failure');
    expect(bodyRan).toBe(false);
    expect(schedulerJobStats()[0].last.error).toMatch(/lease connection failed/);
  });
});

describe('the job registry', () => {
  const { SCHEDULED_JOBS } = require('../src/scheduler');

  it('declares every cron job with a lease identity', () => {
    expect(SCHEDULED_JOBS.length).toBe(6);
    for (const job of SCHEDULED_JOBS) {
      expect(typeof job.name).toBe('string');
      expect(job.name.length).toBeGreaterThan(0);
      expect(typeof job.schedule).toBe('string');
      expect(typeof job.run).toBe('function');
      expect(job.duplicateEffect.length).toBeGreaterThan(20);
    }
  });

  it('lease names are unique — two names means two locks means both run', () => {
    const names = SCHEDULED_JOBS.map((j: any) => j.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps the operational timezone on the daily summary', () => {
    // Without it the 07:00 summary follows host UTC and lands at 15:00 Manila.
    const daily = SCHEDULED_JOBS.find((j: any) => j.name === 'daily-admin-booking-summary');
    expect(daily.options?.timezone).toBe('Asia/Manila');
  });

  it('names the jobs whose duplicate effect is user-visible', () => {
    // The lease exists for these two. If a future edit makes one of them safe on
    // its own, this is the note to update — not delete.
    const visible = SCHEDULED_JOBS.filter((j: any) => /DUPLICATE/.test(j.duplicateEffect)).map(
      (j: any) => j.name,
    );
    expect(visible).toContain('otp-reminder');
    expect(visible).toContain('payment-retry');
  });
});
