/**
 * INDEPENDENT STATUS DERIVATION PATHS = 0.
 *
 * The certification gate for TAB 04, expressed as a test rather than as a
 * claim. Two functions used to collapse `bookings.status` and
 * `booking_workers.status` independently:
 *
 *   deriveEffectiveBookingStatus   Customer + Provider
 *   mapOperationsStatus            Admin
 *
 * They disagreed. A provider tapped *en route* and the customer app showed
 * EN_ROUTE while the admin portal showed Accepted.
 *
 * Both now delegate to `deriveCanonicalState`. These tests fail if either stops
 * delegating, if a third derivation appears, or if the two disagree about any
 * combination of inputs.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: {} }));
jest.mock('../src/middleware/firebaseApp', () => ({ firebaseAdmin: {}, __esModule: true }));
jest.mock('firebase-admin/auth', () => ({ getAuth: () => ({}) }));

import fs from 'fs';
import path from 'path';
import { deriveEffectiveBookingStatus } from '../src/services/bookingStatusProjection';
import { mapOperationsStatus } from '../src/services/adminBookingService';
import { deriveCanonicalState, BOOKING_STATES, allowedActions, canTransition } from '../src/services/booking/canonicalState';
import { actionsForWorkerStatus } from '../src/controllers/bookingActions';
import { toAdminProjection, toCustomerProjection, toProviderProjection } from '../src/services/booking/projections';
import {
  CANONICAL_CANCELLED,
  DEPRECATED_CANCELLED,
  isCancelledStatus,
  normalizeCancelledStatus,
} from '../src/services/booking/cancellationVocabulary';

const SRC = path.resolve(__dirname, '..', 'src');

/** Source with comments stripped — a docblock naming a thing is not a use of it. */
const codeOf = (rel: string): string =>
  fs
    .readFileSync(path.join(SRC, rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

/** Every booking/worker status combination that occurs in this platform. */
const BOOKING_STATUSES = [
  'PENDING_OTP', 'CONFIRMED', 'PAID', 'WORKER_ASSIGNED', 'COMPLETED',
  'CANCELLED', 'CANCELED', 'EXPIRED', 'REFUNDED', 'FAILED', 'SOMETHING_UNKNOWN', '', null,
];
const WORKER_STATUSES = [
  'ASSIGNED', 'ACCEPTED', 'DECLINED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', '', null,
];

const everyCombination = (): Array<{ bookingStatus: string | null; workerStatus: string | null; workerUid: string | null; hasEscalation: boolean }> => {
  const out = [];
  for (const bookingStatus of BOOKING_STATUSES) {
    for (const workerStatus of WORKER_STATUSES) {
      for (const workerUid of [null, 'provider-uid']) {
        for (const hasEscalation of [false, true]) {
          out.push({ bookingStatus, workerStatus, workerUid, hasEscalation });
        }
      }
    }
  }
  return out;
};

describe('both legacy derivations delegate to the canonical machine', () => {
  it('deriveEffectiveBookingStatus USES the canonical machine', () => {
    const code = codeOf('services/bookingStatusProjection.ts');
    expect(code).toContain('deriveCanonicalState');
    // And no longer decides anything itself: the old body branched on these
    // literals to pick a winner between the two columns.
    expect(code).not.toContain("['CANCELLED', 'CANCELED', 'COMPLETED', 'REFUNDED', 'FAILED', 'EXPIRED']");
  });

  it('mapOperationsStatus USES the canonical machine', () => {
    const code = codeOf('services/adminBookingService.ts');
    const start = code.indexOf('export const mapOperationsStatus');
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start, code.indexOf('\n};', start));
    expect(body).toContain('deriveCanonicalState');
    expect(body).toContain('toAdminProjection');
    // The old ladder is gone — no independent opinion about the columns.
    expect(body).not.toContain("ws === 'IN_PROGRESS'");
    expect(body).not.toContain("bs === 'PENDING_OTP'");
  });

  /**
   * Files permitted to name the worker-lifecycle states without delegating,
   * each with the reason it is not a derivation.
   *
   * My first version of this check was a heuristic — "mentions EN_ROUTE and
   * ARRIVED and does not delegate" — and it flagged six files, none of which
   * collapses anything. They CONSUME the states: a cancellation policy listing
   * the stages a provider may cancel from is not a second opinion about what
   * state a booking is in.
   *
   * A heuristic that cannot tell a consumer from a collapse is not a detector,
   * so this is a reviewed inventory instead. Adding a file fails the test and
   * forces somebody to classify it, which is the point.
   */
  const PERMITTED_CONSUMERS: Record<string, string> = {
    'services/booking/canonicalState.ts':
      'THE collapse. The one place allowed to decide between the two columns.',
    'services/booking/projections.ts':
      'Names every state to label it. Decides nothing.',
    'services/booking/bookingPolicies.ts':
      'Policy: which stages a provider may self-cancel from. Reads the state, does not derive it.',
    'controllers/bookingDisputeView.ts':
      'Presentation: orders the stages for a dispute summary.',
    'controllers/bookingTimeline.ts':
      'Builds timeline events from per-stage timestamps, not from a collapsed status.',
    'controllers/jobCardView.ts':
      'Provider job-card formatting. Consumes the provider lifecycle it is showing.',
    'services/providerCalendarService.ts':
      'Calendar aggregation. Filters on worker status; never reports a booking status.',
    'services/technicianService.ts':
      'Writes the worker lifecycle. It is the producer of one column, not a reader of both.',
    'services/bookingAccessService.ts':
      'Access control: which assignment statuses count as an ACTIVE assignment.',
    'services/bookingResponseConflict.ts':
      'Detects an accept/decline arriving after the assignment already moved on.',
    'chat/chat.repository.ts':
      'Chat lifecycle gating. Reads the provider lifecycle to decide who may still post.',
    'services/booking/adminOpsStatusSql.ts':
      'A derivation, and named as one. The admin LIST must classify in SQL so the ' +
      'status filter and COUNT apply to the filtered set; deriving afterwards in ' +
      'TypeScript would paginate the wrong rows. It is permitted ONLY because it is ' +
      'GENERATED from one branch list and proven equal to deriveCanonicalState over ' +
      'the full cross-product by tests/admin-ops-status-sql.test.ts. That proof is ' +
      'asserted to exist below, so the permission cannot outlive it.',
    'controllers/bookingActions.ts':
      'Provider ACTION metadata (confirmation and code flags). Holds transition ' +
      'knowledge too, which is pinned to the machine by the agreement test below ' +
      'rather than left to drift.',
  };

  it('NO third derivation exists — every file naming the worker lifecycle is a reviewed consumer', () => {
    const unreviewed: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const rel = path.relative(SRC, full).split(path.sep).join('/');
        const code = codeOf(rel);
        const namesPreService = /['"]EN_ROUTE['"]/.test(code) && /['"]ARRIVED['"]/.test(code);
        if (!namesPreService) continue;
        const delegates = /deriveCanonicalState|deriveEffectiveBookingStatus|toAdminProjection|toProviderProjection|toCustomerProjection/.test(code);
        if (delegates) continue;
        if (!(rel in PERMITTED_CONSUMERS)) unreviewed.push(rel);
      }
    };
    walk(SRC);
    expect(unreviewed).toEqual([]);
  });

  /**
   * The one permitted derivation is permitted BY ITS PROOF, not by its name.
   *
   * Without this, deleting the equivalence suite would silently convert a
   * conditional permission into a permanent one, and the "no third derivation"
   * guard would be waving through exactly what it exists to catch.
   */
  it('the permitted SQL derivation still has its equivalence proof', () => {
    const proof = path.join(__dirname, 'admin-ops-status-sql.test.ts');
    expect(fs.existsSync(proof)).toBe(true);
    const body = fs.readFileSync(proof, 'utf8');
    expect(body).toContain('evaluateAdminOpsStatus');
    expect(body).toContain('deriveCanonicalState');
    // It must compare the two over a real cross-product, not on a handful of
    // hand-picked rows.
    expect(body).toContain('disagreements');
    expect(body).toMatch(/toBeGreaterThanOrEqual\(4\d\d\)/);
  });

  it('every permitted consumer still exists — the list cannot rot', () => {
    for (const rel of Object.keys(PERMITTED_CONSUMERS)) {
      expect(fs.existsSync(path.join(SRC, rel))).toBe(true);
    }
  });

  it('the provider ACTION map agrees with the machine about what is possible', () => {
    // `controllers/bookingActions.ts` is a FOURTH place that encodes transition
    // knowledge — an action list keyed on worker status, with the transition
    // graph written out in a comment as "read out of technicianService". It is
    // not a status collapse, so it is not a divergence today; it is a second
    // copy of the same rules, which is how divergence starts.
    //
    // Reconciling it properly belongs with the provider-action work. Until
    // then this pins the two together: if the machine and the action map ever
    // disagree about which actions exist at a stage, this fails.
    const ACTION_TO_MACHINE: Record<string, string> = {
      ACCEPT_ASSIGNMENT: 'accept',
      DECLINE_ASSIGNMENT: 'decline',
      MARK_EN_ROUTE: 'markEnRoute',
      MARK_ARRIVED: 'markArrived',
      START_JOB: 'startJob',
      COMPLETE_JOB: 'complete',
    };

    for (const workerStatus of ['ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'] as const) {
      const canonical = deriveCanonicalState({ bookingStatus: 'CONFIRMED', workerStatus });
      const fromMachine = new Set(allowedActions(canonical, 'assigned_provider'));

      const fromActionMap = actionsForWorkerStatus(workerStatus)
        .map((a) => ACTION_TO_MACHINE[a.code])
        .filter(Boolean);

      for (const action of fromActionMap) {
        // Every action the app is told it can take must be one the machine
        // would actually allow — otherwise the button exists and the request
        // is refused.
        expect(fromMachine.has(action)).toBe(true);
      }
    }
  });

  it('the action map demands the worker code exactly where the machine does', () => {
    const startAction = actionsForWorkerStatus('ARRIVED').find((a) => a.code === 'START_JOB');
    expect(startAction?.requiresCode).toBe(true);

    const verdict = canTransition('ARRIVED', 'IN_PROGRESS', 'assigned_provider');
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) expect(verdict.rule.requires).toContain('worker_code');
  });

  it('the detector DOES fire on a real second collapse (positive fixture)', () => {
    // A list that only ever reports clean is indistinguishable from a broken
    // one. This is the shape the check exists to catch, run against the same
    // predicate.
    const fakeCollapse = `
      export const deriveStatus = (bookingStatus: string, workerStatus: string) => {
        if (workerStatus === 'EN_ROUTE') return 'EN_ROUTE';
        if (workerStatus === 'ARRIVED') return 'ARRIVED';
        return bookingStatus;
      };
    `;
    const namesPreService = /['"]EN_ROUTE['"]/.test(fakeCollapse) && /['"]ARRIVED['"]/.test(fakeCollapse);
    const delegates = /deriveCanonicalState|toAdminProjection/.test(fakeCollapse);
    expect(namesPreService && !delegates).toBe(true);
  });
});

describe('the two projections never disagree, over every input combination', () => {
  const combos = everyCombination();

  it(`agrees on all ${combos.length} combinations`, () => {
    const disagreements: string[] = [];
    for (const combo of combos) {
      const canonical = deriveCanonicalState(combo);

      const admin = mapOperationsStatus(combo.bookingStatus, combo.workerStatus, combo.workerUid, combo.hasEscalation);
      const adminFromCanonical = toAdminProjection(canonical).operationsStatus;
      if (admin !== adminFromCanonical) {
        disagreements.push(`admin ${JSON.stringify(combo)} → ${admin} vs ${adminFromCanonical}`);
      }

      // The customer/provider projection cannot see escalation or workerUid, so
      // it is compared on the derivation it CAN see. What matters is that it
      // never reports a pre-service state the canonical machine disagrees with.
      const effective = deriveEffectiveBookingStatus(combo.bookingStatus, combo.workerStatus);
      const canonicalNoContext = deriveCanonicalState({
        bookingStatus: combo.bookingStatus,
        workerStatus: combo.workerStatus,
      });
      if (['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED'].includes(effective)) {
        if (effective !== canonicalNoContext) {
          disagreements.push(`effective ${JSON.stringify(combo)} → ${effective} vs ${canonicalNoContext}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('EN_ROUTE and ARRIVED reach Customer and Provider intact', () => {
    for (const state of ['EN_ROUTE', 'ARRIVED'] as const) {
      expect(deriveEffectiveBookingStatus('CONFIRMED', state)).toBe(state);
      expect(toCustomerProjection(state).canonicalState).toBe(state);
      expect(toProviderProjection(state).canonicalState).toBe(state);
    }
  });

  it('Admin receives the full state alongside the collapsed legacy field', () => {
    for (const state of ['EN_ROUTE', 'ARRIVED'] as const) {
      const dto = toAdminProjection(state);
      expect(dto.canonicalState).toBe(state);        // the truth
      expect(dto.operationsStatus).toBe('accepted');  // compatibility debt
      expect(dto.stateIsCollapsedInLegacyField).toBe(true);
    }
  });

  it('the wiring did not change what Admin sees for any state it could already express', () => {
    // Regression guard on the compatibility boundary: only EN_ROUTE and ARRIVED
    // may be reported as something other than themselves.
    const EXPECTED: Record<string, string> = {
      PENDING_OTP: 'new',
      AWAITING_ASSIGNMENT: 'awaiting_assignment',
      ASSIGNED: 'assigned',
      ACCEPTED: 'accepted',
      IN_PROGRESS: 'in_progress',
      COMPLETED: 'completed',
      CANCELLED: 'cancelled',
      DISPUTED: 'disputed',
      EXPIRED: 'cancelled',
      EN_ROUTE: 'accepted',
      ARRIVED: 'accepted',
    };
    for (const state of BOOKING_STATES) {
      expect(toAdminProjection(state).operationsStatus).toBe(EXPECTED[state]);
    }
  });
});

/**
 * A closed assignment row is not an assignment.
 *
 * `declineJob` clears `bookings.worker_uid` and closes the `booking_workers`
 * row, but it never rewrites `bookings.status` — the booking stays at
 * WORKER_ASSIGNED. The derivation read only that column, so it answered
 * ASSIGNED for a booking with no provider on it. Two consequences, both live:
 * the machine allowed the provider who had just declined to accept the same
 * job, and the admin list labelled the row Assigned while nobody was.
 *
 * These assertions pin the corrected answers on both sides of the change, so a
 * future edit that restores the old reading fails here rather than in
 * production.
 */
describe('an ended assignment does not read as ASSIGNED', () => {
  it.each(['DECLINED', 'REASSIGNED', 'CANCELLED', 'CANCELED'])(
    'a %s assignment row leaves the booking AWAITING_ASSIGNMENT',
    (workerStatus) => {
      expect(deriveCanonicalState({ bookingStatus: 'WORKER_ASSIGNED', workerStatus }))
        .toBe('AWAITING_ASSIGNMENT');
    },
  );

  it('WORKER_ASSIGNED with worker_uid NULL is awaiting, not assigned', () => {
    expect(deriveCanonicalState({ bookingStatus: 'WORKER_ASSIGNED', workerStatus: null, workerUid: null }))
      .toBe('AWAITING_ASSIGNMENT');
  });

  it('WORKER_ASSIGNED with a provider is still ASSIGNED', () => {
    expect(deriveCanonicalState({ bookingStatus: 'WORKER_ASSIGNED', workerStatus: 'ASSIGNED', workerUid: 'p1' }))
      .toBe('ASSIGNED');
  });

  it('a caller that did NOT supply worker_uid keeps the old answer', () => {
    // `undefined` is "I did not look", not "there is nobody". Guessing from a
    // field the two-argument caller never supplies would change a wire value
    // on the strength of missing data.
    expect(deriveCanonicalState({ bookingStatus: 'WORKER_ASSIGNED', workerStatus: null }))
      .toBe('ASSIGNED');
  });

  it('the customer/provider wire value is unchanged either way', () => {
    // ASSIGNED and AWAITING_ASSIGNMENT both project to the raw booking status,
    // so no client sees a different string because of this correction.
    expect(deriveEffectiveBookingStatus('WORKER_ASSIGNED', 'DECLINED')).toBe('WORKER_ASSIGNED');
    expect(deriveEffectiveBookingStatus('WORKER_ASSIGNED', 'ASSIGNED')).toBe('WORKER_ASSIGNED');
  });

  it('Admin DOES change, from assigned to awaiting_assignment', () => {
    // The one visible change, pinned deliberately rather than discovered later.
    expect(mapOperationsStatus('WORKER_ASSIGNED', 'DECLINED', null)).toBe('awaiting_assignment');
    expect(mapOperationsStatus('WORKER_ASSIGNED', 'ASSIGNED', 'p1')).toBe('assigned');
  });

  /**
   * TAB 04 SMOKE GATE — shipping with the backend, not waiting for the portal
   * `canonicalState` patch. See docs/TAB04_OPEN_GAPS.md.
   *
   * Stated end to end in one assertion so the shipped behaviour is legible as
   * one fact rather than assembled from four.
   */
  it('SMOKE GATE: closed assignment + no worker + WORKER_ASSIGNED', () => {
    const raw = { bookingStatus: 'WORKER_ASSIGNED', workerStatus: 'DECLINED', workerUid: null };

    const canonical = deriveCanonicalState(raw);
    expect(canonical).toBe('AWAITING_ASSIGNMENT');
    expect(toAdminProjection(canonical).operationsStatus).toBe('awaiting_assignment');
    expect(mapOperationsStatus(raw.bookingStatus, raw.workerStatus, raw.workerUid))
      .toBe('awaiting_assignment');

    // And the value the live portal receives is one it already renders — this
    // is what makes it safe to ship ahead of the portal patch, unlike the
    // EN_ROUTE / ARRIVED collapse.
    expect(toAdminProjection(canonical).stateIsCollapsedInLegacyField).toBe(false);
  });
});

describe('one spelling of cancelled', () => {
  it('reads both spellings as cancelled', () => {
    for (const spelling of [CANONICAL_CANCELLED, DEPRECATED_CANCELLED, 'cancelled', 'canceled']) {
      expect(isCancelledStatus(spelling)).toBe(true);
      expect(normalizeCancelledStatus(spelling)).toBe(CANONICAL_CANCELLED);
    }
  });

  it('does not treat anything else as cancelled', () => {
    for (const other of ['COMPLETED', 'CANCEL', 'CANCELLING', '', null, undefined]) {
      expect(isCancelledStatus(other)).toBe(false);
    }
  });

  it('passes non-cancelled statuses through, upper-cased', () => {
    expect(normalizeCancelledStatus('confirmed')).toBe('CONFIRMED');
  });

  it('the canonical machine returns ONE spelling whichever it reads', () => {
    expect(deriveCanonicalState({ bookingStatus: 'CANCELLED', workerStatus: null })).toBe('CANCELLED');
    expect(deriveCanonicalState({ bookingStatus: 'CANCELED', workerStatus: null })).toBe('CANCELLED');
  });

  it('NEW canonical code never WRITES the deprecated spelling', () => {
    // The guard the operator asked for. Scoped to the canonical modules — the
    // legacy tree still contains 28 sites and rewriting them is a separate,
    // riskier change than this command should make.
    for (const rel of [
      'services/booking/canonicalState.ts',
      'services/booking/projections.ts',
      'services/bookingStatusProjection.ts',
    ]) {
      const code = codeOf(rel);
      // Reading it is required and expected; WRITING it is not. A write looks
      // like an assignment or a SQL SET, never a membership test.
      expect(code).not.toMatch(/=\s*['"]CANCELED['"]/);
      expect(code).not.toMatch(/SET\s+status\s*=\s*['"]CANCELED['"]/i);
    }

    // `cancellationVocabulary` is excluded on purpose: it is the ONE module
    // allowed to name the deprecated spelling, because declaring it is how
    // every other module avoids hard-coding it. Excluding it is not a hole —
    // the assertion below pins that the declaration is all it does.
    const vocab = codeOf('services/booking/cancellationVocabulary.ts');
    expect(vocab).toContain("DEPRECATED_CANCELLED = 'CANCELED'");
    expect(vocab).not.toMatch(/SET\s+status\s*=/i);
  });

  it('the compatibility boundary is explicit about preserving the raw spelling', () => {
    // Customer and provider clients still receive whichever spelling the row
    // holds, because normalising there would be a wire change on a value they
    // may branch on.
    expect(deriveEffectiveBookingStatus('CANCELED', 'ACCEPTED')).toBe('CANCELED');
    expect(deriveEffectiveBookingStatus('CANCELLED', 'ACCEPTED')).toBe('CANCELLED');
  });
});
