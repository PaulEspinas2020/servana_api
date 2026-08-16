/**
 * THE booking-code service: issue, verify, count, expire, audit.
 *
 * ## What was here before
 *
 * Two six-digit codes with no lifecycle at all. `bookings.otp_code` was written
 * at creation and rotated by `resendBookingOtp` with no cooldown; `worker_code`
 * was written with the assignment and never rotated. Neither had an expiry, an
 * attempt limit, or a record of having been tried — `bookingService.confirmOtp`
 * documented all three absences explicitly, and preserving them was right for a
 * state-machine migration that was not supposed to change product policy.
 *
 * §63 of this command changes the policy on purpose. Everything the code now has
 * — purpose, issuer, recipient, expiry, resend cooldown, attempt limit, audit —
 * is declared in `experiencePolicy.BOOKING_OTP_PURPOSES` and enforced here.
 *
 * ## Enforced in the DOMAIN SERVICE, not in the v1 handler
 *
 * The release gate is "OTP cannot be replayed or cross-used". A limit that only
 * the canonical endpoint applied would leave `POST /api/:id/confirm-otp` — the
 * path the shipped customer app calls — as an unlimited oracle, so the gate
 * would be met on paper and not in the field. `bookingService.confirmOtp` and
 * `resendBookingOtp` therefore delegate HERE, and both surfaces inherit one
 * policy.
 *
 * ## Verification still ends at the executor
 *
 * This module decides whether a code is ALLOWED to be tried. Whether it MATCHES
 * is still decided by `transitionBooking`, inside the mutating statement, exactly
 * as before — that atomicity is the property the Phase C migration was built to
 * preserve and nothing here weakens it. A pre-check that compared the code first
 * would open the window between proving a credential and using it.
 */

import dbQuery from '../../db/dbQuery';
import { db } from '../../config';
import { generateOTP } from '../../helpers/otp';
import {
  BOOKING_OTP_PURPOSES,
  isBookingOtpPurpose,
  canRequestOtp,
  canVerifyOtp,
  otpAppliesInState,
  type BookingOtpPurpose,
  type ExperienceActor,
} from './experiencePolicy';
import { ensureExperienceSchema } from './experienceStore';
import { emitExperienceEvent } from './experienceEvents';
import { deriveCanonicalState, type BookingState } from './canonicalState';
import { transitionBooking, TransitionError, type TransitionResult } from './transitionExecutor';

const s = db.schema;

// ─── Refusals ─────────────────────────────────────────────────────────────────

export type BookingOtpRefusalCode =
  /** The booking does not exist, or is not this caller's. */
  | 'BOOKING_NOT_FOUND'
  /** This actor may not request, or may not verify, a code of this purpose. */
  | 'OTP_ACTOR_NOT_PERMITTED'
  /** The booking's state is not one in which this purpose is meaningful. */
  | 'OTP_PURPOSE_NOT_APPLICABLE'
  /** A code was issued too recently. `retryAfterSeconds` says when to retry. */
  | 'OTP_RESEND_COOLDOWN'
  /** The per-booking issue ceiling is spent. */
  | 'OTP_RESEND_LIMIT'
  /** The current code is past its window. Request another. */
  | 'OTP_EXPIRED'
  /** Too many wrong answers against the current code. Request another. */
  | 'OTP_ATTEMPTS_EXHAUSTED'
  /** No code has ever been issued for this purpose. */
  | 'OTP_NOT_ISSUED';

export class BookingOtpError extends Error {
  constructor(
    readonly code: BookingOtpRefusalCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BookingOtpError';
  }
}

// ─── The derived credential state ─────────────────────────────────────────────

export interface OtpCredentialState {
  purpose: BookingOtpPurpose;
  /** Whether a code is currently stored on the booking. */
  present: boolean;
  issuedAt: Date | null;
  expiresAt: Date | null;
  expired: boolean;
  /** Failed verifications recorded since the current code was issued. */
  failedAttempts: number;
  attemptsRemaining: number;
  /** Issues recorded for this booking and purpose, ever. */
  issueCount: number;
  /** Seconds a caller must wait before another issue. Zero when free. */
  cooldownRemainingSeconds: number;
}

interface BookingRow {
  id: number;
  user_id: string | null;
  worker_uid: string | null;
  status: string | null;
  worker_status: string | null;
  has_escalation: boolean | null;
  otp_code: string | null;
  worker_code: string | null;
  created_at: Date | string | null;
}

const loadBooking = async (bookingId: number): Promise<BookingRow | null> => {
  const { rows } = await dbQuery.query(
    `SELECT b.id, b.user_id, b.worker_uid, b.status, b.otp_code, b.worker_code, b.created_at,
            (SELECT bw.status FROM ${s}.booking_workers bw
              WHERE bw.booking_id = b.id AND bw.worker_uid = b.worker_uid
              ORDER BY bw.id DESC LIMIT 1) AS worker_status,
            EXISTS (SELECT 1 FROM ${s}.booking_escalations esc
                     WHERE esc.booking_id = b.id AND esc.resolved_at IS NULL) AS has_escalation
       FROM ${s}.bookings b
      WHERE b.id = $1`,
    [bookingId],
  );
  return rows[0] ?? null;
};

const asDate = (v: unknown): Date | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Reads the credential's current state out of the append-only event log.
 *
 * ## The seeding rule, and why it is not a fudge
 *
 * A booking created before this table existed has a code and no `ISSUED` row.
 * Treating that as "no expiry known" would make every pre-existing code
 * immortal, which is the policy this tab was asked to end. Treating it as
 * expired-by-default would lock a customer out with no explanation.
 *
 * So an absent log is seeded from `bookings.created_at`, which is when the code
 * was in fact minted — the booking row and the code are written together. That
 * is a true statement about the credential rather than a convenient one, and the
 * recovery path is the same one a genuinely expired code has: request another.
 */
export async function readCredentialState(
  bookingId: number,
  purpose: BookingOtpPurpose,
  booking?: BookingRow | null,
  now: Date = new Date(),
): Promise<OtpCredentialState> {
  await ensureExperienceSchema();
  const spec = BOOKING_OTP_PURPOSES[purpose];

  const row = booking ?? (await loadBooking(bookingId));
  const present = !!String(row?.[spec.credentialColumn] ?? '').trim();

  const { rows } = await dbQuery.query(
    `SELECT event, created_at
       FROM ${s}.booking_otp_events
      WHERE booking_id = $1 AND purpose = $2
      ORDER BY created_at ASC, id ASC`,
    [bookingId, purpose],
  );

  const issues = rows.filter((r: any) => r.event === 'ISSUED');
  const lastIssueAt = issues.length ? asDate(issues[issues.length - 1].created_at) : null;

  const issuedAt = lastIssueAt ?? asDate(row?.created_at);
  const expiresAt = issuedAt
    ? new Date(issuedAt.getTime() + spec.expiryMinutes * 60_000)
    : null;

  // Only failures AFTER the current code was issued count. A rotation is a
  // fresh credential and a fresh budget — otherwise a resend would hand back a
  // code that was already dead on arrival.
  const failedAttempts = rows.filter(
    (r: any) =>
      r.event === 'FAILED' &&
      (!lastIssueAt || (asDate(r.created_at)?.getTime() ?? 0) >= lastIssueAt.getTime()),
  ).length;

  const cooldownRemainingSeconds = lastIssueAt
    ? Math.max(
        0,
        Math.ceil(
          (lastIssueAt.getTime() + spec.resendCooldownSeconds * 1000 - now.getTime()) / 1000,
        ),
      )
    : 0;

  return {
    purpose,
    present,
    issuedAt,
    expiresAt,
    expired: !!expiresAt && now.getTime() > expiresAt.getTime(),
    failedAttempts,
    attemptsRemaining: Math.max(0, spec.maxVerifyAttempts - failedAttempts),
    issueCount: issues.length,
    cooldownRemainingSeconds,
  };
}

const recordEvent = async (
  bookingId: number,
  purpose: BookingOtpPurpose,
  event: 'ISSUED' | 'VERIFIED' | 'FAILED',
  actor: ExperienceActor,
  actorUid: string | null,
  detail?: Record<string, unknown>,
): Promise<void> => {
  await dbQuery.query(
    `INSERT INTO ${s}.booking_otp_events
       (booking_id, purpose, event, actor_uid, actor_role, detail)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [bookingId, purpose, event, actorUid, actor, detail ? JSON.stringify(detail) : null],
  );
};

/**
 * The canonical state, from the same derivation every other surface uses.
 *
 * `workerUid` is passed explicitly rather than omitted: `null` means "looked and
 * found nobody" and `undefined` means "did not look", and the derivation gives
 * different answers for WORKER_ASSIGNED depending on which it was told. This
 * query always looks.
 */
const stateOf = (row: BookingRow): BookingState =>
  deriveCanonicalState({
    bookingStatus: row.status,
    workerStatus: row.worker_status,
    workerUid: row.worker_uid ?? null,
    hasEscalation: !!row.has_escalation,
  });

export const parsePurpose = (value: unknown): BookingOtpPurpose => {
  if (value === undefined || value === null || value === '') return 'BOOKING_CONFIRMATION';
  if (!isBookingOtpPurpose(value)) {
    throw new BookingOtpError(
      'OTP_PURPOSE_NOT_APPLICABLE',
      `Unknown code purpose. Expected one of ${Object.keys(BOOKING_OTP_PURPOSES).join(', ')}.`,
    );
  }
  return value;
};

// ─── Request ──────────────────────────────────────────────────────────────────

export interface RequestOtpResult {
  bookingId: number;
  purpose: BookingOtpPurpose;
  /** How the recipient gets it. Never the code. */
  delivery: 'email' | 'booking_detail';
  recipient: 'customer';
  expiresAt: string;
  resendAvailableAt: string;
  issuesRemaining: number;
  attemptsRemaining: number;
}

/**
 * Mints a fresh code for one booking and one purpose.
 *
 * The plaintext is written to the booking column and NEVER returned, logged, or
 * placed in an event detail. `delivery` tells the caller how the recipient will
 * receive it so a client can render the right sentence without being told the
 * secret.
 */
export async function requestBookingOtp(params: {
  bookingId: number;
  purpose: BookingOtpPurpose;
  actor: ExperienceActor;
  actorUid: string | null;
  now?: Date;
  /** Injected so the email path is testable without a mail server. */
  deliver?: (bookingId: number, code: string, row: BookingRow) => Promise<void>;
}): Promise<RequestOtpResult> {
  const { bookingId, purpose, actor, actorUid } = params;
  const now = params.now ?? new Date();
  const spec = BOOKING_OTP_PURPOSES[purpose];

  await ensureExperienceSchema();

  const row = await loadBooking(bookingId);
  if (!row) throw new BookingOtpError('BOOKING_NOT_FOUND', 'No booking with that id.');

  // A provider may not rotate the code they are required to be TOLD. This is
  // the one authorization rule in this file that is not about ownership, and it
  // is the reason the two purposes cannot share an endpoint policy.
  if (!canRequestOtp(purpose, actor)) {
    throw new BookingOtpError(
      'OTP_ACTOR_NOT_PERMITTED',
      `A ${actor.replace('_', ' ')} may not request the ${purpose} code for a booking.`,
      { permitted: spec.requestableBy },
    );
  }

  const state = stateOf(row);
  if (!otpAppliesInState(purpose, state)) {
    throw new BookingOtpError(
      'OTP_PURPOSE_NOT_APPLICABLE',
      'This booking is not at a stage where that code is used.',
      { state, validStates: spec.validStates },
    );
  }

  const credential = await readCredentialState(bookingId, purpose, row, now);

  if (credential.cooldownRemainingSeconds > 0) {
    throw new BookingOtpError(
      'OTP_RESEND_COOLDOWN',
      `Another code can be sent in ${credential.cooldownRemainingSeconds} seconds.`,
      {
        retryAfterSeconds: credential.cooldownRemainingSeconds,
        cooldownSeconds: spec.resendCooldownSeconds,
      },
    );
  }
  if (credential.issueCount >= spec.maxIssues) {
    throw new BookingOtpError(
      'OTP_RESEND_LIMIT',
      'This booking has had the maximum number of codes issued. Contact support.',
      { maxIssues: spec.maxIssues },
    );
  }

  const code = generateOTP();

  /**
   * Rotate, then record. In that order deliberately.
   *
   * If the UPDATE succeeds and the event insert fails, the log under-reports an
   * issue: the cooldown is shorter than it should be and the expiry is read from
   * the previous issue, so the code looks OLDER than it is. Every one of those
   * errs toward refusing a valid code, which is recoverable.
   *
   * The other order is not: an event with no rotation would age out a code that
   * is still live on the booking, and the customer holding it would be told it
   * had expired when it had not.
   */
  await dbQuery.query(
    `UPDATE ${s}.bookings SET ${spec.credentialColumn} = $1 WHERE id = $2`,
    [code, bookingId],
  );
  await recordEvent(bookingId, purpose, 'ISSUED', actor, actorUid, {
    delivery: spec.delivery,
    expiryMinutes: spec.expiryMinutes,
  });

  await emitExperienceEvent({
    bookingId,
    event: 'otp.issued',
    actor,
    actorUid,
    title: 'Verification code issued',
    description: `A ${purpose === 'SERVICE_START' ? 'service start' : 'booking confirmation'} code was issued.`,
    detail: { purpose, delivery: spec.delivery },
  });

  if (params.deliver) {
    // Best-effort, exactly as `resendBookingOtp` always was: the code IS rotated
    // whether or not the mail goes out, and failing here would leave the
    // customer holding a code that no longer works.
    try {
      await params.deliver(bookingId, code, row);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[booking-otp] delivery failed for booking ${bookingId}:`, error);
    }
  }

  const expiresAt = new Date(now.getTime() + spec.expiryMinutes * 60_000);
  return {
    bookingId,
    purpose,
    delivery: spec.delivery,
    recipient: spec.recipient,
    expiresAt: expiresAt.toISOString(),
    resendAvailableAt: new Date(now.getTime() + spec.resendCooldownSeconds * 1000).toISOString(),
    issuesRemaining: Math.max(0, spec.maxIssues - (credential.issueCount + 1)),
    attemptsRemaining: spec.maxVerifyAttempts,
  };
}

// ─── Verify ───────────────────────────────────────────────────────────────────

export interface VerifyOtpResult {
  bookingId: number;
  purpose: BookingOtpPurpose;
  transition: TransitionResult;
  attemptsRemaining: number;
}

/**
 * Spends an attempt against the current code.
 *
 * The order is: policy first, executor second, audit third.
 *
 *   1. actor and state — refusals that cost no attempt, because being asked the
 *      wrong question is not a wrong answer;
 *   2. expiry and attempt budget — refusals that also cost no attempt, since the
 *      budget is already gone;
 *   3. `transitionBooking`, which compares the code inside the write;
 *   4. a FAILED or VERIFIED event either way.
 *
 * Step 4 is what makes the limit real. An attempt that is not recorded is an
 * attempt that did not happen as far as the next call is concerned, so the
 * record is written before the error is rethrown.
 */
export async function verifyBookingOtp(params: {
  bookingId: number;
  purpose: BookingOtpPurpose;
  code: string;
  actor: ExperienceActor;
  actorUid: string | null;
  expectedState?: BookingState;
  idempotencyKey?: string | null;
  correlationId?: string;
  now?: Date;
  /**
   * Set by `bookingService.confirmOtp`, which runs the assignment itself.
   *
   * Confirming a booking releases it to the matching engine, and that step must
   * happen exactly once per confirmation whichever route was called. The legacy
   * function owns the call on its own path; every other caller gets it from
   * here. A boolean rather than two functions, because the alternative is a
   * confirmation that assigns on one route and not the other.
   */
  skipPostConfirmationAssignment?: boolean;
}): Promise<VerifyOtpResult> {
  const { bookingId, purpose, code, actor, actorUid } = params;
  const now = params.now ?? new Date();
  const spec = BOOKING_OTP_PURPOSES[purpose];

  await ensureExperienceSchema();

  const row = await loadBooking(bookingId);
  if (!row) throw new BookingOtpError('BOOKING_NOT_FOUND', 'No booking with that id.');

  if (!canVerifyOtp(purpose, actor)) {
    throw new BookingOtpError(
      'OTP_ACTOR_NOT_PERMITTED',
      `A ${actor.replace('_', ' ')} may not present the ${purpose} code.`,
      { permitted: spec.verifiableBy },
    );
  }

  const state = stateOf(row);
  if (!otpAppliesInState(purpose, state)) {
    throw new BookingOtpError(
      'OTP_PURPOSE_NOT_APPLICABLE',
      'This booking is not at a stage where that code is used.',
      { state, validStates: spec.validStates },
    );
  }

  const credential = await readCredentialState(bookingId, purpose, row, now);
  if (!credential.present) {
    throw new BookingOtpError('OTP_NOT_ISSUED', 'No code has been issued for this booking yet.');
  }
  if (credential.attemptsRemaining <= 0) {
    throw new BookingOtpError(
      'OTP_ATTEMPTS_EXHAUSTED',
      'Too many incorrect codes. Request a new one.',
      { maxVerifyAttempts: spec.maxVerifyAttempts },
    );
  }
  if (credential.expired) {
    throw new BookingOtpError('OTP_EXPIRED', 'That code has expired. Request a new one.', {
      expiresAt: credential.expiresAt?.toISOString() ?? null,
      expiryMinutes: spec.expiryMinutes,
    });
  }

  /**
   * The metadata field the executor reads is chosen by the PURPOSE.
   *
   * `CUSTOMER_CONFIRM_OTP` requires `metadata.otp`; `PROVIDER_START` requires
   * `metadata.workerCode`. Sending the code under the wrong key is precisely
   * cross-use, and it fails here rather than being compared against the wrong
   * column — the purpose picks the field, and the caller never does.
   */
  const metadata: Record<string, unknown> =
    spec.credentialColumn === 'otp_code' ? { otp: code } : { workerCode: code };

  try {
    const transition = await transitionBooking({
      bookingId,
      action: spec.action,
      actorUid,
      // `ExperienceActor` is a strict subset of the machine's `Actor` — it omits
      // only `system`, which never presents a credential.
      actorRole: actor,
      expectedState: params.expectedState,
      idempotencyKey: params.idempotencyKey ?? undefined,
      metadata,
      correlationId: params.correlationId,
    });

    await recordEvent(bookingId, purpose, 'VERIFIED', actor, actorUid, {
      idempotentReplay: transition.idempotentReplay,
    });
    await emitExperienceEvent({
      bookingId,
      event: 'otp.verified',
      actor,
      actorUid,
      title: 'Verification code accepted',
      detail: { purpose, action: spec.action },
    });

    /**
     * A confirmed booking is released to the matching engine.
     *
     * Post-commit and unable to fail the verification, exactly as it has always
     * been: the customer is told their booking is confirmed because it is, and
     * a booking that finds no provider surfaces to an admin as awaiting
     * assignment rather than as an error the customer cannot act on.
     *
     * Imported lazily — `bookingService` imports this module back for the legacy
     * delegation, and both directions being lazy is what keeps that from being a
     * load-order hazard.
     */
    if (purpose === 'BOOKING_CONFIRMATION' && !params.skipPostConfirmationAssignment) {
      const { runPostConfirmationAssignment } = await import('../bookingService');
      await runPostConfirmationAssignment(bookingId);
    }

    return {
      bookingId,
      purpose,
      transition,
      attemptsRemaining: spec.maxVerifyAttempts,
    };
  } catch (error) {
    /**
     * Only a WRONG CODE spends an attempt.
     *
     * The executor raises a dedicated code for a zero-row credential comparison
     * precisely because state, authorization and terminality are all validated
     * before the statement runs. Charging an attempt for an invalid transition
     * would let anyone burn a customer's budget by calling at the wrong moment.
     */
    const wrongCode =
      error instanceof TransitionError &&
      (error.code === 'BOOKING_OTP_INVALID' || error.code === 'WORKER_CODE_INVALID');

    if (wrongCode) {
      await recordEvent(bookingId, purpose, 'FAILED', actor, actorUid, {});
      await emitExperienceEvent({
        bookingId,
        event: 'otp.failed',
        actor,
        actorUid,
        title: 'Verification code rejected',
        detail: {
          purpose,
          attemptsRemaining: Math.max(0, credential.attemptsRemaining - 1),
        },
      });
    }
    throw error;
  }
}
