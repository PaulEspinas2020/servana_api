/**
 * The canonical account endpoints: `/me`, settings, security, customer profile,
 * addresses, provider profile, documents, availability and services.
 *
 * ## Identity is the token, everywhere
 *
 * No handler here accepts a uid in a path, a query or a body. `uidOf(req)` reads
 * the verified token subject and every domain call is scoped to it. That is what
 * makes the account-leakage suite a statement about the code rather than about
 * today's set of routes: there is no parameter to substitute.
 *
 * The ONE exception is the public provider projection, which takes a
 * `providerUid` — and answers it through `providerFieldsVisibleTo('otherCustomer')`,
 * so what a stranger receives is decided by the policy rather than by the query.
 *
 * ## Authorization is not repeated here
 *
 * Sensitivity is decided in `accountPolicy` and applied by the services. These
 * handlers do not compare roles or strip fields; a transport layer that could
 * reach a different conclusion from its policy is a second implementation of it.
 */

import { Request, Response } from 'express';
import * as account from '../../../services/account/accountService';
import * as addresses from '../../../services/account/addressBookService';
import * as providerProfile from '../../../services/account/providerProfileService';
import * as settings from '../../../services/account/accountSettingsService';
import { getCompletion } from '../../../services/account/profileCompletionService';
import { getUserRole } from '../../../chat/chat.repository';
import * as compliance from '../../../services/providerProfileComplianceService';
import * as autoOnlineEngine from '../../../services/providerAutoOnlineEngine';
import { ok, created, sendCaught } from '../envelope';
import { ApiError, type V1ErrorCode } from '../errors';
import { V1Handlers } from '../types';

const uidOf = (req: Request): string => {
  const uid = (req as any).user?.uid as string | undefined;
  if (!uid) throw new ApiError('UNAUTHENTICATED', 'Authentication is required.');
  return uid;
};

const bodyOf = (req: Request): Record<string, unknown> =>
  (req.body ?? {}) as Record<string, unknown>;

const addressIdOf = (req: Request): string => {
  const raw = String(req.params.addressId ?? '').trim();
  // Bounded and character-class checked before it reaches a query. The id is
  // generated `CAD`+6, so anything outside this shape is a probe.
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(raw)) {
    throw ApiError.validation('addressId is not a valid address identifier.');
  }
  return raw;
};

// ─── Error translation ────────────────────────────────────────────────────────

/** Domain refusal → canonical code. Pure renaming; no policy is re-decided. */
const CODE: Record<string, V1ErrorCode> = {
  ACCOUNT_NOT_FOUND: 'NOT_FOUND',
  ACCOUNT_FIELD_NOT_WRITABLE: 'ACCOUNT_FIELD_NOT_WRITABLE',
  ACCOUNT_FIELD_INVALID: 'VALIDATION_FAILED',
  ADDRESS_NOT_FOUND: 'ADDRESS_NOT_FOUND',
  ADDRESS_FIELD_REQUIRED: 'VALIDATION_FAILED',
  ADDRESS_FIELD_TOO_LONG: 'VALIDATION_FAILED',
  ADDRESS_LIMIT_REACHED: 'ADDRESS_LIMIT_REACHED',
  PROVIDER_NOT_FOUND: 'NOT_FOUND',
  PROVIDER_FIELD_NOT_EDITABLE: 'ACCOUNT_FIELD_NOT_WRITABLE',
  PROVIDER_FIELD_INVALID: 'VALIDATION_FAILED',
  SETTING_UNKNOWN: 'VALIDATION_FAILED',
  SETTING_NOT_WRITABLE: 'ACCOUNT_FIELD_NOT_WRITABLE',
  SETTING_INVALID: 'VALIDATION_FAILED',
};

const asApiError = (error: unknown): unknown => {
  const candidate = error as { code?: string; message?: string } | null;
  if (candidate?.code && CODE[candidate.code]) {
    return new ApiError(CODE[candidate.code], candidate.message);
  }
  return error;
};

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * A positive integer document id, or a NOT_FOUND rather than a validation error.
 *
 * Matching the legacy handlers deliberately: a malformed id and an id belonging
 * to somebody else must answer the same way, or the difference between 404 and
 * 422 enumerates which document ids exist.
 */
const documentIdOf = (req: Request): number => {
  const id = Number(req.params.documentId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError('NOT_FOUND', 'Document not found.');
  }
  return id;
};

/**
 * One time-off period, projected from what was STORED.
 *
 * Deliberately not built from the request: a response assembled out of the body
 * agrees with the client by construction, and that is precisely how the
 * partial-day defect survived — the portal sent `startTime`/`endTime`, nothing
 * persisted them, and the reply cheerfully said `allDay`.
 */
const timeOffDto = (t: any) => ({
  id: String(t.id),
  startDate: t.startDate,
  endDate: t.endDate,
  allDay: t.allDay,
  startTime: t.startTime,
  endTime: t.endTime,
  reason: t.reason ?? 'other',
  note: t.note,
  createdAt: t.createdAt,
});

export const handlers: V1Handlers = {
  /**
   * Change the account record.
   *
   * Only the fields `ME_WRITABLE_FIELDS` declares are accepted, and an
   * unwritable one is REFUSED by name rather than dropped — silently ignoring
   * `email` leaves the caller believing they changed a verified identifier.
   */
  'me.patch': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await account.patchAccount(uidOf(req), bodyOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'me.patch', asApiError(error));
    }
  },

  'me.settings.get': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await settings.getSettings(uidOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'me.settings.get', asApiError(error));
    }
  },

  /** A PARTIAL update. Unnamed settings keep their value; unknown keys refuse. */
  'me.settings.patch': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await settings.patchSettings(uidOf(req), bodyOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'me.settings.patch', asApiError(error));
    }
  },

  /**
   * Security POSTURE. Read-only by design — every action has its own endpoint
   * with its own proof of possession, listed in the response so a client does
   * not have to hardcode where they live.
   */
  'me.security.get': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await settings.getSecurity(uidOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'me.security.get', asApiError(error));
    }
  },

  /**
   * What is left before this account is usable, derived by the backend.
   *
   * Answers for whichever role the account holds. One endpoint, because a
   * welcome card that computes this itself shows a green tick over an account
   * that cannot take work.
   */
  'me.completion.get': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await getCompletion(uidOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'me.completion.get', asApiError(error));
    }
  },

  // ── Customer ───────────────────────────────────────────────────────────────

  'customer.profile.get': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await account.getCustomerProfile(uidOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'customer.profile.get', asApiError(error));
    }
  },

  'customer.profile.patch': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await account.patchCustomerProfile(uidOf(req), bodyOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'customer.profile.patch', asApiError(error));
    }
  },

  /** Every address the caller owns, default first. No uid parameter exists. */
  'customer.addresses.list': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const list = await addresses.listAddresses(uid);
      return ok(res, req, list, {
        // The default, surfaced in meta so checkout needs one call rather than
        // scanning the list and picking the first `isDefault` it finds.
        defaultAddressId: list.find((a) => a.isDefault)?.addressId ?? null,
        count: list.length,
      });
    } catch (error) {
      return sendCaught(res, req, 'customer.addresses.list', asApiError(error));
    }
  },

  'customer.addresses.create': async (req: Request, res: Response) => {
    try {
      return created(res, req, await addresses.createAddress(uidOf(req), bodyOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'customer.addresses.create', asApiError(error));
    }
  },

  'customer.addresses.update': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      return ok(res, req, await addresses.updateAddress(uid, addressIdOf(req), bodyOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'customer.addresses.update', asApiError(error));
    }
  },

  'customer.addresses.delete': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      return ok(res, req, await addresses.deleteAddress(uid, addressIdOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'customer.addresses.delete', asApiError(error));
    }
  },

  /**
   * Promote one address to default. Atomic, and idempotent: setting the current
   * default again reaches the same end state.
   */
  'customer.addresses.setDefault': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      return ok(res, req, await addresses.setDefaultAddress(uid, addressIdOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'customer.addresses.setDefault', asApiError(error));
    }
  },

  // ── Provider ───────────────────────────────────────────────────────────────

  /** The caller's OWN provider profile. Seat `self`, so private fields resolve. */
  'provider.profile.get': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      return ok(res, req, await providerProfile.getProviderProfile(uid, 'self'));
    } catch (error) {
      return sendCaught(res, req, 'provider.profile.get', asApiError(error));
    }
  },

  /**
   * Propose a change to a reviewable public field.
   *
   * Not a write: the compliance service queues a revision, and a `clientRequestId`
   * is required so a retry on a flaky connection does not queue a second copy
   * for a human to review.
   */
  'provider.profile.patch': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const body = bodyOf(req);
      const { clientRequestId, ...fields } = body as Record<string, unknown>;
      return ok(
        res,
        req,
        await providerProfile.patchProviderProfile(uid, fields, String(clientRequestId ?? '')),
      );
    } catch (error) {
      return sendCaught(res, req, 'provider.profile.patch', asApiError(error));
    }
  },

  /**
   * The PUBLIC provider projection.
   *
   * The only handler that names another account, and the only one that needs to:
   * a customer choosing a provider has to see something. What they see is decided
   * by `providerFieldsVisibleTo('otherCustomer')`, which requires the field's
   * classification AND its `customerVisible` flag to agree — so a private field
   * cannot reach here by being forgotten.
   */
  'provider.publicProfile.get': async (req: Request, res: Response) => {
    try {
      const providerUid = String(req.params.providerUid ?? '').trim();
      if (!/^[A-Za-z0-9_-]{4,128}$/.test(providerUid)) {
        throw ApiError.validation('providerUid is not a valid identifier.');
      }
      const viewerUid = (req as any).user?.uid as string | undefined;
      const seat = viewerUid && viewerUid === providerUid ? 'self' : 'otherCustomer';
      return ok(res, req, await providerProfile.getProviderProfile(providerUid, seat));
    } catch (error) {
      return sendCaught(res, req, 'provider.publicProfile.get', asApiError(error));
    }
  },

  /**
   * Documents as REVIEW STATE. Never a URL, never a storage path.
   *
   * Driven by the document CATALOG rather than by the rows, so a required
   * document that has never been submitted appears as `missing` — a list built
   * from rows alone shows an empty screen to a provider who has everything left
   * to do.
   */
  'provider.documents.list': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const documents = await providerProfile.listDocuments(uid);
      return ok(res, req, documents, {
        requiredOutstanding: documents.filter(
          (d) => d.required && !['approved', 'accepted', 'verified'].includes(String(d.status).toLowerCase()),
        ).length,
      });
    } catch (error) {
      return sendCaught(res, req, 'provider.documents.list', asApiError(error));
    }
  },

  /**
   * The document CATALOG: what may be submitted, and which are required.
   *
   * Static policy, not the caller's rows. It is provider-scoped rather than
   * public because the requirement set is part of how onboarding works, and a
   * public catalog invites building a checklist screen against an endpoint
   * nobody has to be signed in to read.
   */
  'provider.documents.types': async (req: Request, res: Response) => {
    try {
      return ok(res, req, {
        version: 1,
        documentTypes: compliance.DOCUMENT_TYPE_CATALOG,
      });
    } catch (error) {
      return sendCaught(res, req, 'provider.documents.types', asApiError(error));
    }
  },

  /**
   * Submit one document.
   *
   * ## The side effect is part of the endpoint
   *
   * The legacy handler calls `autoOnlineEngine.evaluateProvider` after a
   * successful upload, fire-and-forget. It is easy to read as logging and it is
   * not: submitting the last outstanding requirement is what makes a provider
   * eligible to be online, and an endpoint that stores the document without
   * re-evaluating leaves them blocked until something else happens to trigger
   * it. Carried here deliberately, with the same swallow — a failure to
   * re-evaluate must not fail an upload that succeeded.
   */
  'provider.documents.create': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const body = bodyOf(req);

      const replacement = body.replacementForId == null ? null : Number(body.replacementForId);
      if (replacement != null && (!Number.isInteger(replacement) || replacement <= 0)) {
        throw ApiError.validation('replacementForId is invalid.');
      }

      const document = await compliance.uploadDocument(uid, {
        documentTypeId: String(body.documentTypeId ?? ''),
        fileName: String(body.fileName ?? ''),
        file: String(body.file ?? ''),
        clientRequestId: String(body.clientRequestId ?? ''),
        issueDate: body.issueDate == null ? null : String(body.issueDate),
        expiresAt: body.expiresAt == null ? null : String(body.expiresAt),
        identifierLast4: body.identifierLast4 == null ? null : String(body.identifierLast4),
        replacementForId: replacement,
      });

      autoOnlineEngine.evaluateProvider(uid, 'system', uid).catch(() => {});
      return created(res, req, document);
    } catch (error) {
      return sendCaught(res, req, 'provider.documents.create', asApiError(error));
    }
  },

  /**
   * A short-lived signed URL for one document the caller owns.
   *
   * The no-store headers travel WITH the handler, not with the route. This is
   * the only v1 response that contains a private storage URL, and a browser or
   * intermediary that retains it turns a 15-minute grant into a durable one.
   */
  'provider.documents.preview': async (req: Request, res: Response) => {
    try {
      const id = documentIdOf(req);
      res.set('Cache-Control', 'private, no-store, max-age=0');
      res.set('Pragma', 'no-cache');
      return ok(res, req, await compliance.getDocumentPreview(uidOf(req), id));
    } catch (error) {
      return sendCaught(res, req, 'provider.documents.preview', asApiError(error));
    }
  },

  /** Withdraw one document. Re-evaluates online eligibility, as upload does. */
  'provider.documents.delete': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const id = documentIdOf(req);
      await compliance.deleteDocument(uid, id);
      // Deleting a document can make a provider ineligible, which is the same
      // reason upload re-evaluates. Omitting it here would leave someone online
      // against a requirement they have just withdrawn.
      autoOnlineEngine.evaluateProvider(uid, 'system', uid).catch(() => {});
      return ok(res, req, { deleted: true });
    } catch (error) {
      return sendCaught(res, req, 'provider.documents.delete', asApiError(error));
    }
  },

  /** The same engine matching consumes. That equality is the release gate. */
  'provider.availability.get': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await providerProfile.getAvailability(uidOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'provider.availability.get', asApiError(error));
    }
  },

  /**
   * Change availability.
   *
   * DELEGATES to the same `providerAvailabilityEngine.saveWeeklySchedule` the
   * legacy `PUT /worker/availability` calls, including its optimistic-concurrency
   * `expectedVersion`. A second writer here would be a second source for the
   * thing matching selects on.
   */
  'provider.availability.patch': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const body = bodyOf(req);
      if (!Array.isArray(body.slots)) {
        throw ApiError.validation('slots must be an array of availability windows.');
      }
      const engine = await import('../../../services/providerAvailabilityEngine');
      const result = await engine.saveWeeklySchedule(
        uid,
        body.slots as never,
        typeof body.timezone === 'string' ? body.timezone : 'Asia/Manila',
        uid,
        body.expectedVersion as never,
      );
      return ok(res, req, { ...await providerProfile.getAvailability(uid), ...result });
    } catch (error) {
      return sendCaught(res, req, 'provider.availability.patch', asApiError(error));
    }
  },

  /** Active time off only. A cancelled period is history, not a commitment. */
  'provider.timeOff.list': async (req: Request, res: Response) => {
    try {
      const engine = await import('../../../services/providerAvailabilityEngine');
      const all = await engine.listTimeOff(uidOf(req));
      return ok(res, req, {
        timeOff: all.filter((t) => t.status === 'active').map(timeOffDto),
      });
    } catch (error) {
      return sendCaught(res, req, 'provider.timeOff.list', asApiError(error));
    }
  },

  /**
   * Book time off, and say what it collides with.
   *
   * ## The conflict notice is the endpoint, not decoration
   *
   * Time off is created even when it overlaps confirmed bookings — a provider
   * who is ill must be able to say so, and refusing would leave them with no
   * way to record it. But the work is still assigned to them. The legacy
   * handler returns `bookingConflicts` and a sentence saying so in as many
   * words, because the alternative is a provider who assumes leave cancels
   * their jobs and simply does not turn up.
   *
   * Carried verbatim. A v1 endpoint that stored the period and returned a bare
   * 201 would be strictly worse than the route it replaces.
   *
   * ## And the partial-day fields are passed on
   *
   * They were destructured and then dropped once already (C22 §17): the web
   * portal shipped a partial-day form the whole time, a provider asking for two
   * hours off lost the entire day, and the response told them it was all-day
   * because it echoed the REQUEST. This reports what was STORED, for the same
   * reason — a response built from the request agrees with the client by
   * construction, which is exactly how that defect stayed invisible.
   */
  'provider.timeOff.create': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const body = bodyOf(req);

      if (!body.startDate || !body.endDate || !body.reason) {
        throw ApiError.validation('startDate, endDate and reason are required.');
      }

      const engine = await import('../../../services/providerAvailabilityEngine');
      const record = await engine.createTimeOff(
        uid,
        {
          startDate: body.startDate,
          endDate: body.endDate,
          reason: body.reason,
          allDay: body.allDay,
          startTime: body.startTime,
          endTime: body.endTime,
          note: body.note,
        } as never,
        uid,
      );

      const conflicts = record.bookingConflicts ?? [];
      return created(res, req, {
        ...timeOffDto(record),
        bookingConflicts: conflicts,
        conflictNotice:
          conflicts.length > 0
            ? 'Your time off is saved, but these bookings are still assigned to ' +
              'you. Creating time off does not cancel accepted work — open each ' +
              'booking to cancel or request a reschedule.'
            : null,
      });
    } catch (error) {
      return sendCaught(res, req, 'provider.timeOff.create', asApiError(error));
    }
  },

  /** Cancel one period. A malformed id is a 404, never a 422. */
  'provider.timeOff.cancel': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const id = Number(req.params.timeOffId);
      if (!Number.isInteger(id) || id <= 0) {
        throw new ApiError('NOT_FOUND', 'Time-off period not found.');
      }
      const engine = await import('../../../services/providerAvailabilityEngine');
      await engine.cancelTimeOff(uid, id, uid);
      return ok(res, req, { cancelled: true });
    } catch (error) {
      return sendCaught(res, req, 'provider.timeOff.cancel', asApiError(error));
    }
  },

  /** Keyed on `services.id`, the Catalog V2 canonical specific-service identity. */
  'provider.services.list': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const services = await providerProfile.listServices(uid);
      return ok(res, req, services, {
        activeCount: services.filter((service) => service.isActive).length,
      });
    } catch (error) {
      return sendCaught(res, req, 'provider.services.list', asApiError(error));
    }
  },
};
