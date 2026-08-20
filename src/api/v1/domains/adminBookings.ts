/**
 * The canonical admin booking endpoints — TAB 06 wave 1.
 *
 * ## Why these four, and why first
 *
 * The v1 surface carried 105 implemented routes and exactly ONE of them was
 * admin-authenticated. v1 was built for the client applications, so the admin
 * portal could not migrate onto it: there was no admin domain to migrate to.
 * That — not a failed deploy — was the real integration gap.
 *
 * These four were already named `planned` in the contract, with their domain
 * services, replay guards and legacy dispositions written down. They are the
 * portal's highest-traffic screens, and the assignment lifecycle is already
 * canonicalised behind one executor, so v1 adds an envelope and a declared
 * contract rather than new business rules.
 *
 * ## What deliberately does NOT move with them
 *
 * The locks, the state machine, the audit records and the eligibility predicate
 * all stay in the domain services. Every handler here is transport: read the
 * parameters, call the same function the legacy controller calls, translate the
 * refusal into the v1 vocabulary. A transport layer that can disagree with its
 * domain service is a second implementation of the rule, and for booking
 * assignment that second implementation would be the one that skips the
 * override audit.
 *
 * The legacy routes stay mounted and unchanged (§4). Nothing here removes,
 * renames or reshapes them.
 *
 * ## Authorization is declared, not implied
 *
 * `auth: 'admin'` proves role 1. Each of these additionally declares the SAME
 * named permission its legacy twin demands — `bookings.view`,
 * `bookings.assign_provider`, `bookings.reassign_provider` — on the contract
 * entry, and `register.ts` refuses to start if an admin entry declares none.
 * A v1 successor that checked role alone would be a quieter route to the same
 * capability, which is privilege escalation arriving as a migration.
 */

import { Request, Response } from 'express';
import * as svc from '../../../services/adminBookingService';
import { listAssignmentCandidatePool } from '../../../services/providerEligibilityEngine';
import { auditFire } from '../../../services/adminAuditService';
import { ok, sendCaught } from '../envelope';
import { ApiError } from '../errors';
import { V1Handlers } from '../types';

const actorUid = (req: Request): string => String((req as any).user?.uid ?? '');
const requestId = (req: Request): string | null => (req as any).id ?? null;

/**
 * `bookingId` is a path parameter and therefore attacker-supplied.
 *
 * Refused rather than coerced: `Number('12abc')` is `NaN` and `Number('')` is
 * `0`, and both would reach a domain service as a query for a booking that
 * cannot exist. A 400 naming the parameter is the honest answer.
 */
const readBookingId = (req: Request): number => {
  const raw = req.params.bookingId;
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ApiError('VALIDATION_FAILED', 'bookingId must be a positive integer');
  }
  return id;
};

const readNonEmpty = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError('VALIDATION_FAILED', `${field} is required`);
  }
  return value.trim();
};

export const handlers: V1Handlers = {
  /**
   * The operations list.
   *
   * An unrecognised `canonicalState` is REFUSED rather than ignored, matching
   * the legacy route exactly. A filter that silently matches nothing reads to
   * an operator as "there are no such bookings", which is a different and worse
   * answer than "you asked the wrong question".
   */
  'admin.bookings.list': async (req: Request, res: Response) => {
    try {
      const q = req.query as Record<string, string | undefined>;

      if (q.canonicalState && !svc.isBookingState(q.canonicalState)) {
        throw new ApiError(
          'VALIDATION_FAILED',
          `Unknown booking state "${q.canonicalState}"`,
        );
      }

      const result = await svc.getAdminBookings({
        search: q.search,
        canonicalState: q.canonicalState,
        operationsStatus: q.operationsStatus,
        paymentMethod: q.paymentMethod,
        paymentStatus: q.paymentStatus,
        serviceId: q.serviceId ? Number(q.serviceId) : undefined,
        fromDate: q.fromDate,
        toDate: q.toDate,
        page: q.page ? Number(q.page) : 1,
        limit: q.limit ? Number(q.limit) : 25,
        isUnassigned: q.isUnassigned === 'true',
        isLate: q.isLate === 'true',
        hasDispute: q.hasDispute === 'true',
        needsAdminAction: q.needsAdminAction === 'true',
      } as Parameters<typeof svc.getAdminBookings>[0]);

      return ok(res, req, result);
    } catch (err) {
      return sendCaught(res, req, 'admin.bookings.list', err);
    }
  },

  /**
   * The assignment candidate pool.
   *
   * Read-only, but it is the PREVIEW of a mutation, so it must qualify
   * providers with the predicate the assign call commits with — both run
   * `PROVIDER_CAPABILITY_SQL`. A preview narrower than its committer does not
   * fail safe: it hides assignable providers from the operator deciding.
   *
   * The audit record carries the pool's SHAPE, not merely its size, because
   * reconstructing months later whether supply was healthy at the moment of an
   * assignment is impossible from a count alone.
   */
  'admin.bookings.assignmentCandidates': async (req: Request, res: Response) => {
    try {
      const bookingId = readBookingId(req);
      const { candidates, diagnostics } = await listAssignmentCandidatePool(String(bookingId));

      auditFire({
        action: 'assignment_candidates_viewed',
        actionCategory: 'booking',
        outcome: 'success',
        actorUid: actorUid(req),
        actorType: 'admin',
        entityType: 'booking',
        entityId: String(bookingId),
        after: {
          candidateCount: candidates.length,
          eligibleCount: candidates.filter((c: { eligible?: boolean }) => c.eligible).length,
        },
        requestId: requestId(req),
        source: 'admin_portal',
      });

      // Diagnostics ride in `meta`, not spliced into `data`. The legacy route
      // put them in a sibling key for the same reason: the array under `data`
      // is what a client parses, and widening it later is a breaking change.
      return ok(res, req, candidates, { diagnostics } as never);
    } catch (err) {
      return sendCaught(res, req, 'admin.bookings.assignmentCandidates', err);
    }
  },

  /**
   * Assign a provider to an unassigned booking.
   *
   * Role-specific by AUTHORIZATION rather than by truth: only an admin may name
   * another actor as the provider. A provider accepting their own job goes
   * through `provider.jobs.accept`, which derives identity from the token and
   * can never name somebody else.
   */
  'admin.bookings.assign': async (req: Request, res: Response) => {
    try {
      const bookingId = readBookingId(req);
      const providerUid = readNonEmpty((req.body ?? {}).providerUid, 'providerUid');
      const reason =
        typeof (req.body ?? {}).reason === 'string' ? (req.body as any).reason : undefined;

      const result = await svc.adminAssignProvider(bookingId, providerUid, actorUid(req), reason);

      auditFire({
        action: 'booking_assigned',
        actionCategory: 'booking',
        outcome: 'success',
        actorUid: actorUid(req),
        actorType: 'admin',
        entityType: 'booking',
        entityId: String(bookingId),
        after: { providerUid },
        reason: reason ?? null,
        requestId: requestId(req),
        source: 'admin_portal',
      });

      return ok(res, req, result);
    } catch (err) {
      return sendCaught(res, req, 'admin.bookings.assign', err);
    }
  },

  /**
   * Move an assigned booking from one provider to another.
   *
   * `reason` is mandatory here and optional on assign, and that asymmetry is
   * deliberate rather than an oversight carried forward: taking a job away from
   * a provider who already has it is an override, and an override without a
   * stated reason is an audit record that cannot answer the only question it
   * will ever be asked.
   *
   * A separate permission from assign — `bookings.reassign_provider` — which is
   * why this is a separate endpoint rather than an assign with a different body.
   */
  'admin.bookings.reassign': async (req: Request, res: Response) => {
    try {
      const bookingId = readBookingId(req);
      const toProviderUid = readNonEmpty((req.body ?? {}).toProviderUid, 'toProviderUid');
      const reason = readNonEmpty((req.body ?? {}).reason, 'reason');

      const result = await svc.adminReassignProvider(
        bookingId,
        toProviderUid,
        actorUid(req),
        reason,
      );

      auditFire({
        action: 'booking_reassigned',
        actionCategory: 'booking',
        outcome: 'success',
        actorUid: actorUid(req),
        actorType: 'admin',
        entityType: 'booking',
        entityId: String(bookingId),
        after: { providerUid: toProviderUid },
        reason,
        requestId: requestId(req),
        source: 'admin_portal',
      });

      return ok(res, req, result);
    } catch (err) {
      return sendCaught(res, req, 'admin.bookings.reassign', err);
    }
  },
};
