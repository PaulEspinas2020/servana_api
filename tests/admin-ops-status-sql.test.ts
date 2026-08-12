/**
 * The admin list's SQL derivation must agree with the canonical one.
 *
 * TAB 04 reported "2 independent derivations → 1". That was wrong: a third
 * lived in a query string, and it disagreed with the canonical function on
 * **107 of 440** legacy-status combinations. The same booking reported one
 * state in the list and another on its own detail page.
 *
 * The SQL cannot simply be deleted — the status filter and the COUNT must apply
 * to the filtered set at the database level, so deriving in TypeScript
 * afterwards would paginate the wrong rows. What it can be is generated from
 * the same declaration as a reference evaluator, which this suite then diffs
 * against `deriveCanonicalState`.
 *
 *   evaluator ≡ canonical   proven here, over the full cross-product
 *   SQL       ≡ evaluator   by construction, both generated from BRANCHES
 *
 * What is NOT proven is that PostgreSQL evaluates the emitted text exactly as
 * the evaluator does. That needs a real server with the production schema — the
 * same blocker as the concurrency suite. The assertions below pin the emitted
 * SQL to predicates whose semantics are not in question between the two
 * languages, which is the most that can be claimed without a database.
 */

import {
  evaluateAdminOpsStatus,
  adminOpsStatusSql,
  normaliseProviderUid,
  OPS_STATUS_BRANCH_COUNT,
  OPS_STATUS_VALUES,
} from '../src/services/booking/adminOpsStatusSql';
import { deriveCanonicalState } from '../src/services/booking/canonicalState';
import { toAdminProjection } from '../src/services/booking/projections';

/** Every legacy value the platform produces, plus one it does not recognise. */
const BOOKING_STATUSES = [
  'PENDING_OTP', 'CONFIRMED', 'PAID', 'WORKER_ASSIGNED', 'COMPLETED',
  'CANCELLED', 'CANCELED', 'REFUNDED', 'FAILED', 'EXPIRED',
  'SOME_STATUS_THIS_PLATFORM_HAS_NEVER_SEEN',
];

const WORKER_STATUSES = [
  null, 'ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS',
  'COMPLETED', 'DECLINED', 'REASSIGNED', 'CANCELLED', 'CANCELED',
];

interface Combination {
  bookingStatus: string;
  workerStatus: string | null;
  workerUid: string | null;
  hasUnresolvedEscalation: boolean;
}

const everyCombination = (): Combination[] => {
  const out: Combination[] = [];
  for (const bookingStatus of BOOKING_STATUSES) {
    for (const workerStatus of WORKER_STATUSES) {
      for (const workerUid of [null, 'provider-1']) {
        for (const hasUnresolvedEscalation of [false, true]) {
          out.push({ bookingStatus, workerStatus, workerUid, hasUnresolvedEscalation });
        }
      }
    }
  }
  return out;
};

const canonicalOps = (c: Combination) => toAdminProjection(deriveCanonicalState({
  bookingStatus: c.bookingStatus,
  workerStatus: c.workerStatus,
  workerUid: c.workerUid,
  hasEscalation: c.hasUnresolvedEscalation,
})).operationsStatus;

describe('THE GATE: the list derivation agrees with the canonical one', () => {
  it('agrees on EVERY combination', () => {
    const combinations = everyCombination();
    const disagreements = combinations
      .filter((c) => evaluateAdminOpsStatus(c) !== canonicalOps(c))
      .map((c) => `  status=${c.bookingStatus} worker=${c.workerStatus} `
        + `uid=${c.workerUid ? 'set' : 'null'} esc=${c.hasUnresolvedEscalation} → `
        + `list=${evaluateAdminOpsStatus(c)} canonical=${canonicalOps(c)}`);

    expect(
      disagreements.length
        ? `${disagreements.length}/${combinations.length} disagreements:\n${disagreements.slice(0, 25).join('\n')}`
        : `0/${combinations.length} disagreements`,
    ).toBe(`0/${combinations.length} disagreements`);
  });

  it('actually exercises a meaningful cross-product', () => {
    // A gate over three combinations would pass and prove nothing.
    expect(everyCombination().length).toBeGreaterThanOrEqual(400);
  });

  it('the comparison can fail — a broken evaluator is detected', () => {
    // Negative fixture. A gate that only ever reports agreement could be
    // comparing something to itself.
    const broken = (c: Combination) => (c.bookingStatus === 'COMPLETED' ? 'new' : evaluateAdminOpsStatus(c));
    const found = everyCombination().filter((c) => broken(c) !== canonicalOps(c));
    expect(found.length).toBeGreaterThan(0);
  });
});

describe('the four defect classes this replaced', () => {
  const ops = (bookingStatus: string, workerStatus: string | null, workerUid: string | null = 'provider-1') =>
    evaluateAdminOpsStatus({ bookingStatus, workerStatus, workerUid, hasUnresolvedEscalation: false });

  it('a CLOSED assignment is not an assignment', () => {
    // The worst of the four: the list showed Assigned for a booking whose
    // provider had declined, so the queue needing attention was the one hidden.
    for (const closed of ['DECLINED', 'REASSIGNED', 'CANCELLED', 'CANCELED']) {
      expect(ops('WORKER_ASSIGNED', closed)).toBe('awaiting_assignment');
      expect(ops('CONFIRMED', closed)).toBe('awaiting_assignment');
      expect(ops('PAID', closed)).toBe('awaiting_assignment');
    }
  });

  it('EN_ROUTE and ARRIVED collapse to accepted, NOT to assigned', () => {
    // They previously matched no branch and fell through to `assigned`, while
    // the detail endpoint said `accepted` for the same row.
    for (const state of ['EN_ROUTE', 'ARRIVED', 'ACCEPTED']) {
      expect(ops('WORKER_ASSIGNED', state)).toBe('accepted');
      expect(ops('CONFIRMED', state)).toBe('accepted');
      expect(ops('CONFIRMED', state, null)).toBe('accepted');
    }
  });

  it('terminal payment states are cancelled, not new', () => {
    // They fell through to `new`, putting dead bookings at the top of intake.
    for (const dead of ['REFUNDED', 'FAILED', 'EXPIRED']) {
      expect(ops(dead, null)).toBe('cancelled');
      expect(ops(dead, 'ACCEPTED')).toBe('cancelled');
    }
  });

  it('an unrecognised status surfaces for assignment rather than as new', () => {
    expect(ops('SOMETHING_NEW', null, null)).toBe('awaiting_assignment');
  });
});

describe('ordering inside the expression is load-bearing', () => {
  it('an open escalation outranks a terminal state', () => {
    expect(evaluateAdminOpsStatus({
      bookingStatus: 'COMPLETED', workerStatus: 'COMPLETED',
      workerUid: 'p', hasUnresolvedEscalation: true,
    })).toBe('disputed');
  });

  it('a RESOLVED escalation does not', () => {
    // The detail endpoint counted every escalation row including resolved ones,
    // so a settled dispute pinned the booking at `disputed` forever.
    expect(evaluateAdminOpsStatus({
      bookingStatus: 'COMPLETED', workerStatus: 'COMPLETED',
      workerUid: 'p', hasUnresolvedEscalation: false,
    })).toBe('completed');
  });

  it('a closed assignment is tested BEFORE bookings.status', () => {
    // Reversing these two puts the row back on `assigned`, which is the defect.
    expect(evaluateAdminOpsStatus({
      bookingStatus: 'WORKER_ASSIGNED', workerStatus: 'DECLINED',
      workerUid: 'p', hasUnresolvedEscalation: false,
    })).toBe('awaiting_assignment');
  });
});

describe('worker_uid is normalised identically on both paths', () => {
  it('an empty or whitespace uid is not a provider', () => {
    // The old SQL tested `worker_uid = ''` in one branch and ignored it in
    // another, so the same value produced different answers by route taken.
    expect(normaliseProviderUid('')).toBeNull();
    expect(normaliseProviderUid('   ')).toBeNull();
    expect(normaliseProviderUid(null)).toBeNull();
    expect(normaliseProviderUid(undefined)).toBeNull();
    expect(normaliseProviderUid(' provider-1 ')).toBe('provider-1');
  });

  it('WORKER_ASSIGNED with an empty uid is awaiting, not assigned', () => {
    expect(evaluateAdminOpsStatus({
      bookingStatus: 'WORKER_ASSIGNED', workerStatus: null,
      workerUid: normaliseProviderUid(''), hasUnresolvedEscalation: false,
    })).toBe('awaiting_assignment');
  });
});

describe('the emitted SQL', () => {
  const sql = adminOpsStatusSql({ schema: 'servana', bookingAlias: 'b', assignmentAlias: 'la' });

  it('emits one WHEN per declared branch', () => {
    // If the generator ever stops emitting a branch, the SQL and the evaluator
    // part company silently — the equivalence test above would still pass,
    // because it only measures the evaluator.
    expect((sql.match(/\n\s+WHEN /g) ?? []).length).toBe(OPS_STATUS_BRANCH_COUNT);
  });

  it('carries the branches the four defect classes depend on', () => {
    expect(sql).toContain("la.worker_status IN ('ARRIVED','EN_ROUTE','ACCEPTED')");
    expect(sql).toContain("la.worker_status IN ('DECLINED','REASSIGNED','CANCELLED','CANCELED')");
    expect(sql).toContain("b.status IN ('REFUNDED','FAILED')");
    expect(sql).toContain("b.status = 'EXPIRED'");
    expect(sql).toContain("ELSE 'awaiting_assignment'");
  });

  it('normalises worker_uid inside the expression, not at the call site', () => {
    expect(sql).toContain("NULLIF(TRIM(COALESCE(b.worker_uid, '')), '')");
  });

  it('only filters escalations that are still open', () => {
    expect(sql).toContain('esc.resolved_at IS NULL');
  });

  it('substitutes the schema rather than hard-coding one', () => {
    expect(adminOpsStatusSql({ schema: 'other_schema', bookingAlias: 'b', assignmentAlias: 'la' }))
      .toContain('other_schema.booking_escalations');
    expect(sql).not.toContain('other_schema');
  });

  it('publishes its own value domain, so the filter cannot drift from it', () => {
    expect([...OPS_STATUS_VALUES].sort()).toEqual([
      'accepted', 'assigned', 'awaiting_assignment', 'cancelled',
      'completed', 'disputed', 'in_progress', 'new',
    ]);
  });
});
