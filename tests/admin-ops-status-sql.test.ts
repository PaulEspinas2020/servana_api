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
  evaluateAdminCanonicalState,
  adminOpsStatusSql,
  adminCanonicalStateSql,
  normaliseProviderUid,
  isBookingState,
  legacyOpsFor,
  OPS_STATUS_BRANCH_COUNT,
  OPS_STATUS_VALUES,
  CANONICAL_STATE_VALUES,
} from '../src/services/booking/adminOpsStatusSql';
import { deriveCanonicalState, BOOKING_STATES } from '../src/services/booking/canonicalState';
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
    /**
     * ARRIVED, EN_ROUTE and ACCEPTED now have SEPARATE branches and the
     * collapse happens downstream, in `legacyOpsFor`. Sharing one branch was
     * what made two of them unfilterable, so the assertion follows the property
     * rather than the shape it used to have: three distinct predicates, all
     * three still projecting to `accepted` in this legacy expression.
     */
    expect(sql).toContain("la.worker_status = 'ARRIVED'");
    expect(sql).toContain("la.worker_status = 'EN_ROUTE'");
    expect(sql).toContain("la.worker_status = 'ACCEPTED'");
    expect((sql.match(/THEN 'accepted'/g) ?? []).length).toBe(3);

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

/**
 * THE CROSS-SURFACE GATE.
 *
 * Four surfaces now answer "what state is this booking in": the list's display
 * value, the list's FILTER column, the tab counts, and the detail page. They
 * are only trustworthy together if they agree, and they previously did not —
 * the list and the detail disagreed on 107 of 440 combinations.
 *
 * This measures all four against `deriveCanonicalState` over the same
 * cross-product, in one place, so a future edit cannot fix one and drift
 * another.
 */
describe('CROSS-SURFACE PARITY: zero disagreements', () => {
  const canonicalOf = (c: Combination) => deriveCanonicalState({
    bookingStatus: c.bookingStatus,
    workerStatus: c.workerStatus,
    workerUid: c.workerUid,
    hasEscalation: c.hasUnresolvedEscalation,
  });

  const surfaces = {
    /** What the list badge shows, from the SQL-computed canonical column. */
    display: (c: Combination) => evaluateAdminCanonicalState(c),
    /** What the canonical filter matches on. Same column, same expression. */
    filter: (c: Combination) => evaluateAdminCanonicalState(c),
    /** What the tab counts count. Metrics derive in JS from the machine. */
    metric: canonicalOf,
    /** What the detail endpoint reports. */
    detail: canonicalOf,
  };

  it('all four surfaces agree on EVERY combination', () => {
    const combinations = everyCombination();
    const disagreements: string[] = [];

    for (const c of combinations) {
      const answers = Object.entries(surfaces).map(([name, fn]) => [name, fn(c)] as const);
      const distinct = new Set(answers.map(([, v]) => v));
      if (distinct.size > 1) {
        disagreements.push(
          `  status=${c.bookingStatus} worker=${c.workerStatus} `
          + `uid=${c.workerUid ? 'set' : 'null'} esc=${c.hasUnresolvedEscalation} -> `
          + answers.map(([n, v]) => `${n}=${v}`).join(' '),
        );
      }
    }

    expect(
      disagreements.length
        ? `${disagreements.length} disagreements:\n${disagreements.slice(0, 25).join('\n')}`
        : 'CROSS-SURFACE DISAGREEMENTS: 0',
    ).toBe('CROSS-SURFACE DISAGREEMENTS: 0');
  });

  it('the display value collapses to the legacy field, and only there', () => {
    // operationsStatus is COMPATIBILITY ONLY: it must still be derivable from
    // the canonical answer, and it must never be what another surface reads.
    for (const c of everyCombination()) {
      expect(evaluateAdminOpsStatus(c)).toBe(legacyOpsFor(evaluateAdminCanonicalState(c)));
    }
  });

  it('the parity check can fail — a broken surface is detected', () => {
    // Negative fixture. Four functions compared to each other would report
    // agreement forever if they were all the same function by accident.
    const broken = (c: Combination) =>
      (c.bookingStatus === 'COMPLETED' ? 'ASSIGNED' : evaluateAdminCanonicalState(c));
    const found = everyCombination().filter((c) => broken(c) !== surfaces.detail(c));
    expect(found.length).toBeGreaterThan(0);
  });
});

describe('CANONICAL FILTERING reaches the states the board shows', () => {
  /** Rows the canonical filter would match for a given state. */
  const matching = (state: string) =>
    everyCombination().filter((c) => evaluateAdminCanonicalState(c) === state);

  it('EN_ROUTE and ARRIVED are filterable, not merely visible', () => {
    // The whole point. Under the legacy filter both were unreachable: they
    // collapsed into `accepted` and could not be asked for.
    expect(matching('EN_ROUTE').length).toBeGreaterThan(0);
    expect(matching('ARRIVED').length).toBeGreaterThan(0);

    // And they are DISTINCT sets — a filter returning the same rows for both
    // would be the collapse wearing a canonical name.
    const enRoute = new Set(matching('EN_ROUTE').map((c) => JSON.stringify(c)));
    const arrived = matching('ARRIVED').map((c) => JSON.stringify(c));
    expect(arrived.some((k) => enRoute.has(k))).toBe(false);
  });

  it('a closed assignment is filterable as AWAITING_ASSIGNMENT', () => {
    // The operational case: these bookings need a provider NOW, and they were
    // previously filed under `assigned` where nobody was looking.
    for (const closed of ['DECLINED', 'REASSIGNED', 'CANCELLED', 'CANCELED']) {
      for (const booking of ['WORKER_ASSIGNED', 'CONFIRMED', 'PAID']) {
        expect(evaluateAdminCanonicalState({
          bookingStatus: booking, workerStatus: closed,
          workerUid: 'provider-1', hasUnresolvedEscalation: false,
        })).toBe('AWAITING_ASSIGNMENT');
      }
    }
    expect(matching('AWAITING_ASSIGNMENT').length).toBeGreaterThan(0);
  });

  it('REFUNDED, FAILED and EXPIRED are filterable as closed, not as new', () => {
    for (const dead of ['REFUNDED', 'FAILED']) {
      expect(evaluateAdminCanonicalState({
        bookingStatus: dead, workerStatus: null, workerUid: null, hasUnresolvedEscalation: false,
      })).toBe('CANCELLED');
    }
    // EXPIRED keeps its own canonical identity and is separately filterable,
    // even though it DISPLAYS as cancelled — Admin has no badge for it.
    expect(evaluateAdminCanonicalState({
      bookingStatus: 'EXPIRED', workerStatus: null, workerUid: null, hasUnresolvedEscalation: false,
    })).toBe('EXPIRED');
    expect(legacyOpsFor('EXPIRED')).toBe('cancelled');
  });

  it('every filterable state is one the machine knows', () => {
    for (const state of CANONICAL_STATE_VALUES) {
      expect(isBookingState(state)).toBe(true);
    }
  });

  it('rejects a state the machine does not know', () => {
    // The boundary check the controller uses. A silently-empty board reads as
    // "no such bookings" rather than "wrong question".
    for (const bad of ['ACCEPTED_MAYBE', 'accepted', '', null, undefined, 42]) {
      expect(isBookingState(bad)).toBe(false);
    }
  });
});

describe('the emitted CANONICAL SQL', () => {
  const sql = adminCanonicalStateSql({ schema: 'servana', bookingAlias: 'b', assignmentAlias: 'la' });

  it('emits one WHEN per declared branch, like its legacy sibling', () => {
    expect((sql.match(/\n\s+WHEN /g) ?? []).length).toBe(OPS_STATUS_BRANCH_COUNT);
  });

  it('gives EN_ROUTE and ARRIVED separate branches', () => {
    // Sharing one branch is what made them unfilterable. The legacy collapse
    // now happens once, downstream, where it is declared.
    expect(sql).toContain("la.worker_status = 'ARRIVED'");
    expect(sql).toContain("la.worker_status = 'EN_ROUTE'");
    expect(sql).toContain("THEN 'EN_ROUTE'");
    expect(sql).toContain("THEN 'ARRIVED'");
  });

  it('emits canonical states, never legacy values', () => {
    for (const legacy of OPS_STATUS_VALUES) {
      expect(sql).not.toContain(`THEN '${legacy}'`);
    }
  });

  it('is generated from the SAME branches as the legacy expression', () => {
    /**
     * Same predicates, different projection. If the two ever diverge in shape,
     * somebody has hand-written a fourth source of truth — which is exactly how
     * the third one arrived.
     *
     * Compared by blanking every projected literal rather than by extracting
     * predicates with a regex: the WORKER_ASSIGNED branch emits a NESTED CASE,
     * and a lazy `WHEN ... THEN` match runs straight into it. Structure is the
     * property here, so normalise the values away and compare everything else.
     */
    const legacySql = adminOpsStatusSql({ schema: 'servana', bookingAlias: 'b', assignmentAlias: 'la' });
    const skeleton = (t: string) => t.replace(/THEN '[a-zA-Z_]+'/g, "THEN 'X'")
      .replace(/ELSE '[a-zA-Z_]+'/g, "ELSE 'X'");

    expect(skeleton(sql)).toBe(skeleton(legacySql));
    // And the two really do differ before normalisation, or this proves nothing.
    expect(sql).not.toBe(legacySql);
  });

  it('every state it can emit is a real canonical state', () => {
    const emitted = [...sql.matchAll(/THEN '([A-Z_]+)'/g)].map((m) => m[1]);
    expect(emitted.length).toBeGreaterThan(0);
    for (const state of emitted) {
      expect(BOOKING_STATES as readonly string[]).toContain(state);
    }
  });
});
