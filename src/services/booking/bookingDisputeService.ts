/**
 * Disputes: one record, on the booking, for all three actors.
 *
 * ## Built on the table that already exists
 *
 * Servana has had disputes since the admin portal shipped: `booking_escalations`
 * (reason_code, reason, severity, assigned_team, actor_uid, resolved_at), a
 * `dispute_opened` timeline event, and a `hasDispute` filter that derives
 * `'disputed'` from an unresolved row. `deriveCanonicalState` reads the same
 * fact and returns DISPUTED.
 *
 * What did NOT exist was a way for anybody except an admin to open one. The
 * provider surface (`controllers/bookingDisputeView`) was explicitly built as
 * "the safe entry and status summary only — opening is later". This is later.
 *
 * A second table was the obvious wrong answer: it would have given admin and
 * provider two different answers to "is this booking disputed?", and the admin
 * portal, the canonical state derivation and the payout hold all read the first
 * one.
 *
 * ## What §66 adds to the row
 *
 * - `category`       the standardized vocabulary, separate from the free-form
 *                    `reason_code` admins have been writing for months.
 * - `opened_by_role` which seat raised it — `actor_uid` alone cannot say.
 * - `state_snapshot` the service and financial state AT THE MOMENT OF OPENING.
 *                    A dispute argued three weeks later is argued against a
 *                    booking that has since moved, and "what did it look like
 *                    when they complained" is otherwise unrecoverable.
 *
 * ## Duplicate prevention has two layers, deliberately
 *
 * The policy check refuses a second open dispute with a reason a client can
 * render. The partial unique index in `experienceStore` refuses it in the
 * database. The first is the good error message; the second is the one that
 * holds when two people press the button in the same second — a check followed
 * by an insert is a race, and §68 asks for one authoritative outcome.
 */

import dbQuery from '../../db/dbQuery';
import { db } from '../../config';
import { deriveCanonicalState, type BookingState } from './canonicalState';
import {
  evaluateDisputeOpening,
  DISPUTE_CATEGORIES,
  DISPUTE_SEVERITIES,
  DISPUTABLE_STATES,
  type DisputeCategory,
  type DisputeRefusal,
  type DisputeSeverity,
  type ExperienceActor,
} from './experiencePolicy';
import { ensureExperienceSchema, isUniqueViolation } from './experienceStore';
import { emitExperienceEvent } from './experienceEvents';

const s = db.schema;

export class DisputeError extends Error {
  constructor(
    readonly code: DisputeRefusal | 'BOOKING_NOT_FOUND',
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DisputeError';
  }
}

/**
 * The service and financial state, frozen at opening.
 *
 * Payment STATUS and method, never an amount, a reference or a payer. §66 asks
 * for "current financial/service state" so an investigator can see what stage
 * the money was at; it does not ask for the payment record, and a snapshot is
 * copied into a row that more people can read than can read `payments`.
 */
export interface DisputeStateSnapshot {
  state: BookingState;
  bookingStatus: string | null;
  workerStatus: string | null;
  hasAssignment: boolean;
  scheduledAt: string | null;
  paymentStatus: string | null;
  paymentMethod: string | null;
  capturedAt: string;
}

export interface DisputeRecord {
  id: number;
  bookingId: number;
  category: string | null;
  severity: string;
  state: 'OPEN' | 'RESOLVED';
  openedByRole: string | null;
  /** True only for the caller who raised it. */
  openedByYou: boolean;
  openedAt: string | null;
  resolvedAt: string | null;
  stateSnapshot: DisputeStateSnapshot | null;
}

const iso = (v: unknown): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * Projects a row for a reader.
 *
 * `reason`, `assigned_team` and `actor_uid` are never projected. They are the
 * ADMIN record: free text one party typed about another, internal routing, and
 * a person's identity. `controllers/bookingDisputeView` established that rule
 * for the provider surface and it applies to every surface — a customer reading
 * a provider's complaint verbatim is the same failure in the other direction.
 */
const project = (row: any, callerUid: string | null): DisputeRecord => ({
  id: row.id,
  bookingId: row.booking_id,
  category: row.category ?? null,
  severity: row.severity ?? 'normal',
  state: row.resolved_at ? 'RESOLVED' : 'OPEN',
  openedByRole: row.opened_by_role ?? null,
  openedByYou: !!callerUid && String(row.actor_uid ?? '') === callerUid,
  openedAt: iso(row.created_at),
  resolvedAt: iso(row.resolved_at),
  stateSnapshot: row.state_snapshot ?? null,
});

interface BookingFacts {
  state: BookingState;
  snapshot: DisputeStateSnapshot;
}

const loadBookingFacts = async (bookingId: number): Promise<BookingFacts | null> => {
  const { rows } = await dbQuery.query(
    `SELECT b.id, b.status, b.schedule, b.worker_uid,
            (SELECT bw.status FROM ${s}.booking_workers bw
              WHERE bw.booking_id = b.id AND bw.worker_uid = b.worker_uid
              ORDER BY bw.id DESC LIMIT 1) AS worker_status,
            EXISTS (SELECT 1 FROM ${s}.booking_escalations esc
                     WHERE esc.booking_id = b.id AND esc.resolved_at IS NULL) AS has_escalation,
            (SELECT UPPER(COALESCE(p.status, '')) FROM ${s}.payments p
              WHERE p.booking_id = b.id ORDER BY p.id DESC LIMIT 1) AS payment_status,
            (SELECT UPPER(COALESCE(p.method, '')) FROM ${s}.payments p
              WHERE p.booking_id = b.id ORDER BY p.id DESC LIMIT 1) AS payment_method
       FROM ${s}.bookings b
      WHERE b.id = $1`,
    [bookingId],
  );
  const row = rows[0];
  if (!row) return null;

  const state = deriveCanonicalState({
    bookingStatus: row.status,
    workerStatus: row.worker_status,
    workerUid: row.worker_uid ?? null,
    hasEscalation: !!row.has_escalation,
  });

  return {
    state,
    snapshot: {
      state,
      bookingStatus: row.status ?? null,
      workerStatus: row.worker_status ?? null,
      hasAssignment: !!row.worker_uid,
      scheduledAt: iso(row.schedule),
      paymentStatus: row.payment_status || null,
      paymentMethod: row.payment_method || null,
      capturedAt: new Date().toISOString(),
    },
  };
};

const hasOpenDispute = async (bookingId: number): Promise<boolean> => {
  const { rows } = await dbQuery.query(
    `SELECT 1 FROM ${s}.booking_escalations
      WHERE booking_id = $1 AND resolved_at IS NULL LIMIT 1`,
    [bookingId],
  );
  return rows.length > 0;
};

export interface OpenDisputeParams {
  bookingId: number;
  category: string;
  reason: string;
  severity?: string;
  actor: ExperienceActor;
  actorUid: string | null;
  /** Free-form references the reporter attached. Ids only, never file contents. */
  evidence?: unknown;
}

export async function openDispute(params: OpenDisputeParams): Promise<DisputeRecord> {
  const { bookingId, category, reason, actor, actorUid } = params;

  await ensureExperienceSchema();

  const facts = await loadBookingFacts(bookingId);
  if (!facts) throw new DisputeError('BOOKING_NOT_FOUND', 'No booking with that id.');

  const verdict = evaluateDisputeOpening({
    state: facts.state,
    hasOpenDispute: await hasOpenDispute(bookingId),
    category,
    reason,
  });

  if (!verdict.allowed) {
    const MESSAGES: Record<DisputeRefusal, string> = {
      ALREADY_OPEN: 'This booking already has an open dispute under review.',
      NOT_YET_ACTIONABLE: 'This booking is not yet at a stage where a dispute can be raised.',
      CATEGORY_INVALID: 'That is not one of the standardized dispute categories.',
      REASON_REQUIRED: 'A description of the problem is required.',
    };
    throw new DisputeError(verdict.refusal!, MESSAGES[verdict.refusal!], {
      state: facts.state,
      disputableStates: DISPUTABLE_STATES,
      categories: DISPUTE_CATEGORIES,
    });
  }

  const severity: DisputeSeverity = (DISPUTE_SEVERITIES as readonly string[]).includes(
    String(params.severity),
  )
    ? (params.severity as DisputeSeverity)
    : 'normal';

  const snapshot = {
    ...facts.snapshot,
    // Evidence travels INSIDE the snapshot rather than in its own column: it is
    // part of what was true at opening, and it keeps `booking_escalations` at
    // the three added columns the admin portal has to learn about.
    ...(params.evidence === undefined ? {} : { evidence: params.evidence }),
  };

  let row: any;
  try {
    const inserted = await dbQuery.query(
      `INSERT INTO ${s}.booking_escalations
         (booking_id, reason_code, reason, severity, actor_uid, category, opened_by_role, state_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        bookingId,
        // `reason_code` carries the category too. The admin portal already
        // filters and groups on that column, so writing only the new `category`
        // would make every canonically-opened dispute invisible to the tools
        // operations already use.
        category,
        reason,
        severity,
        actorUid,
        category as DisputeCategory,
        actor,
        JSON.stringify(snapshot),
      ],
    );
    row = inserted.rows[0];
  } catch (error) {
    // The database's own duplicate refusal, reported with the SAME code the
    // policy check would have used. Two people pressing the button together
    // must not get two different answers depending on who lost the race.
    if (isUniqueViolation(error)) {
      throw new DisputeError(
        'ALREADY_OPEN',
        'This booking already has an open dispute under review.',
        { raced: true },
      );
    }
    throw error;
  }

  await emitExperienceEvent({
    bookingId,
    event: 'disputes.opened',
    actor,
    actorUid,
    title: `Dispute opened (${severity})`,
    // The free text is NOT put in the description: the timeline is read by the
    // other party, and one party's account of the other belongs in the admin
    // record it was written into.
    description: `Category: ${category}`,
    detail: { category, severity, disputeId: row.id, state: facts.state },
  });

  return project(row, actorUid);
}

/**
 * The disputes on a booking, newest first.
 *
 * Every entitled caller sees the same rows and the same fields. What differs by
 * role is `openedByYou`, which is computed per caller and is the only
 * caller-dependent value in the projection.
 */
export async function listDisputes(
  bookingId: number,
  callerUid: string | null,
): Promise<DisputeRecord[]> {
  await ensureExperienceSchema();
  const { rows } = await dbQuery.query(
    `SELECT id, booking_id, category, severity, actor_uid, opened_by_role,
            state_snapshot, resolved_at, created_at
       FROM ${s}.booking_escalations
      WHERE booking_id = $1
      ORDER BY created_at DESC, id DESC`,
    [bookingId],
  );
  return rows.map((r: any) => project(r, callerUid));
}
