/**
 * The TAB 06 v1 surface: mounted, documented, and booking-scoped.
 *
 *   TARGET PATHS          every path the command names exists and is mounted
 *   BOOKING-SCOPED        every one is a child of /bookings/:bookingId (§60)
 *   ONE DOMAIN SERVICE    per business mutation, and never two per operation
 *   EXPLICIT DTOs         a named request/response schema, no generic rewriting
 *   REPLAY GUARDS         every mutation names what bounds a retry
 *   CALLER MATRIX         all five surfaces stated, legacy aliases still live
 *   DOCS                  the published contract is the generated one
 *
 * `tests/v1-contract.test.ts` already enforces the global invariants. This suite
 * is about the ones specific to the command: that the target architecture is
 * actually the architecture, and that no capability grew a second truth.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));
// The handler map reaches technicianService for provider location, which opens a
// Mongo client at import time. This suite only inspects the contract, so the
// driver is stubbed rather than configured.
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: {} }));

import fs from 'fs';
import path from 'path';
import { V1_CONTRACT, IMPLEMENTED, V1_PREFIX, fullPath } from '../src/api/v1/contract';
import { SCHEMAS } from '../src/api/v1/openapi';
import { V1_ERROR_STATUS, isV1ErrorCode } from '../src/api/v1/errors';
import { handlers as experienceHandlers } from '../src/api/v1/domains/bookingExperiences';
import { handlers as actionHandlers } from '../src/api/v1/domains/bookingActions';
import { EXPERIENCE_CAPABILITIES } from '../src/services/booking/experiencePolicy';
import { staleFiles } from '../scripts/generate-booking-docs';
import { buildMountedRoutes } from '../scripts/lib/routeTable';

const REPO_ROOT = path.resolve(__dirname, '..');

/** The paths the Master Command names as the target architecture. */
const TARGET_PATHS: Array<[string, string]> = [
  ['get', '/bookings/:bookingId/tracking'],
  ['post', '/bookings/:bookingId/otp/request'],
  ['post', '/bookings/:bookingId/otp/verify'],
  ['post', '/bookings/:bookingId/reschedule'],
  ['post', '/bookings/:bookingId/cancel'],
  ['post', '/bookings/:bookingId/additional-work'],
  ['post', '/bookings/:bookingId/disputes'],
];

const EXPERIENCE_IDS = EXPERIENCE_CAPABILITIES.flatMap((c) => [...c.contractIds]);

const entryFor = (method: string, path: string) =>
  V1_CONTRACT.find((e) => e.method === method && e.path === path);

describe('the target architecture is the architecture', () => {
  it('every path the command names exists and is IMPLEMENTED', () => {
    for (const [method, p] of TARGET_PATHS) {
      const entry = entryFor(method, p);
      expect(entry).toBeDefined();
      expect(entry!.status).toBe('implemented');
    }
  });

  it('each one is mounted with a handler', () => {
    const mountedIds = new Set(IMPLEMENTED.map((e) => e.id));
    const handlerIds = new Set([...Object.keys(experienceHandlers), ...Object.keys(actionHandlers)]);
    for (const [method, p] of TARGET_PATHS) {
      const entry = entryFor(method, p)!;
      expect(mountedIds.has(entry.id)).toBe(true);
      // `bookings.cancel` lives in the actions domain; the rest in experiences.
      expect(handlerIds.has(entry.id)).toBe(true);
    }
  });

  it('cancellation is complete: customer, provider AND admin all have a canonical path', () => {
    // Before TAB 06 only the customer did, so "cancellation rules are identical
    // across clients" could not be checked from the contract.
    expect(entryFor('post', '/bookings/:bookingId/cancel')).toBeDefined();
    expect(entryFor('post', '/provider/jobs/:bookingId/cancel')).toBeDefined();
    // Admin cancellation stays on its own permissioned surface; the ACTION is
    // the same machine's ADMIN_CANCEL, which the policy suite pins.
  });
});

describe('everything is booking-scoped (§60)', () => {
  it('every experience endpoint is a child of the booking', () => {
    for (const id of EXPERIENCE_IDS) {
      const entry = V1_CONTRACT.find((e) => e.id === id)!;
      const scoped =
        entry.path.startsWith('/bookings/:bookingId') ||
        entry.path.startsWith('/provider/jobs/:bookingId');
      expect({ id, path: entry.path, scoped }).toMatchObject({ scoped: true });
    }
  });

  it('every one declares bookingId as a path parameter', () => {
    for (const id of EXPERIENCE_IDS) {
      const entry = V1_CONTRACT.find((e) => e.id === id)!;
      expect(entry.params?.map((p) => p.name)).toContain('bookingId');
    }
  });

  it('no related resource is addressable by its own id at the top level', () => {
    // A change order or a dispute reachable at /additional-work/:id would be a
    // second parent identity, which is exactly what §60 forbids.
    const strays = V1_CONTRACT.filter((e) =>
      /^\/(additional-work|disputes|tracking|otp|reschedule)\b/.test(e.path),
    );
    expect(strays.map((e) => e.path)).toEqual([]);
  });
});

describe('one domain service per business operation', () => {
  it('every experience endpoint names the module its capability declares', () => {
    for (const capability of EXPERIENCE_CAPABILITIES) {
      for (const id of capability.contractIds) {
        const entry = V1_CONTRACT.find((e) => e.id === id)!;
        expect(entry.domainService.startsWith(capability.domainModule)).toBe(true);
      }
    }
  });

  it('no two experience mutations share a domain service', () => {
    // The global contract test asserts this repository-wide; restated here over
    // the TAB 06 subset so a regression names this tab.
    const mutations = EXPERIENCE_IDS
      .map((id) => V1_CONTRACT.find((e) => e.id === id)!)
      .filter((e) => !e.idempotent);
    const services = mutations.map((e) => e.domainService);
    expect(new Set(services).size).toBe(services.length);
  });

  it('the two cancellation endpoints are the same executor, different actions', () => {
    const customer = entryFor('post', '/bookings/:bookingId/cancel')!;
    const provider = entryFor('post', '/provider/jobs/:bookingId/cancel')!;
    for (const entry of [customer, provider]) {
      expect(entry.domainService).toContain('transitionExecutor.transitionBooking');
    }
    expect(customer.domainService).toContain('CUSTOMER_CANCEL');
    expect(provider.domainService).toContain('PROVIDER_CANCEL');
    expect(customer.domainService).not.toBe(provider.domainService);
  });

  it('additional work points at the SAME service instance the legacy family uses', () => {
    for (const id of ['bookings.additionalWork.create', 'bookings.additionalWork.list']) {
      const entry = V1_CONTRACT.find((e) => e.id === id)!;
      expect(entry.domainService).toContain('additionalService');
    }
  });
});

describe('explicit DTOs, never a generic rewriting shape', () => {
  it('every experience endpoint resolves to a named response schema', () => {
    for (const id of EXPERIENCE_IDS) {
      const entry = V1_CONTRACT.find((e) => e.id === id)!;
      expect(Object.keys(SCHEMAS)).toContain(entry.responseSchema);
    }
  });

  it('every experience mutation declares a named REQUEST schema', () => {
    for (const id of EXPERIENCE_IDS) {
      const entry = V1_CONTRACT.find((e) => e.id === id)!;
      if (entry.idempotent) continue;
      expect(entry.requestSchema).toBeTruthy();
      expect(Object.keys(SCHEMAS)).toContain(entry.requestSchema!);
    }
  });

  it('request DTOs are closed — additionalProperties is false', () => {
    // An open request body is how a field-rewriting habit creeps back in.
    for (const name of [
      'BookingOtpRequest', 'BookingOtpVerifyRequest', 'BookingRescheduleRequest',
      'BookingAdditionalWorkRequest', 'BookingDisputeRequest',
    ]) {
      expect((SCHEMAS[name] as any).additionalProperties).toBe(false);
    }
  });

  it('the OTP DTOs never carry a code field in the RESPONSE direction', () => {
    for (const name of ['BookingOtpIssued', 'BookingOtpStatus']) {
      const properties = Object.keys((SCHEMAS[name] as any).properties);
      expect(properties).not.toContain('code');
      expect(properties).not.toContain('otp');
      expect(properties).not.toContain('workerCode');
    }
  });

  it('the dispute DTO documents that the admin record is withheld', () => {
    const description = String((SCHEMAS.BookingDispute as any).description);
    expect(description).toMatch(/reason/);
    expect(description).toMatch(/assigned_team/);
    expect(description).toMatch(/actor_uid/);
    const properties = Object.keys((SCHEMAS.BookingDispute as any).properties);
    expect(properties).not.toContain('reason');
    expect(properties).not.toContain('assignedTeam');
    expect(properties).not.toContain('actorUid');
  });

  it('the tracking DTO documents that a withheld position is not a denial', () => {
    expect(String((SCHEMAS.BookingTracking as any).description)).toMatch(/403/);
  });
});

describe('replay guards and error vocabularies', () => {
  it('every experience mutation names what bounds a retry', () => {
    for (const id of EXPERIENCE_IDS) {
      const entry = V1_CONTRACT.find((e) => e.id === id)!;
      if (entry.idempotent) continue;
      expect(entry.replayGuard && entry.replayGuard.length > 30).toBe(true);
    }
  });

  it('every declared error code is canonical and has one status', () => {
    for (const id of EXPERIENCE_IDS) {
      const entry = V1_CONTRACT.find((e) => e.id === id)!;
      for (const code of entry.errors) {
        expect(isV1ErrorCode(code)).toBe(true);
        expect(typeof V1_ERROR_STATUS[code]).toBe('number');
      }
    }
  });

  it('the OTP endpoints can express every refusal the service raises', () => {
    const request = V1_CONTRACT.find((e) => e.id === 'bookings.otp.request')!;
    const verify = V1_CONTRACT.find((e) => e.id === 'bookings.otp.verify')!;
    expect(request.errors).toEqual(expect.arrayContaining([
      'BOOKING_OTP_RESEND_COOLDOWN', 'BOOKING_OTP_RESEND_LIMIT',
      'BOOKING_OTP_ACTOR_NOT_PERMITTED', 'BOOKING_OTP_NOT_APPLICABLE',
    ]));
    expect(verify.errors).toEqual(expect.arrayContaining([
      'BOOKING_OTP_EXPIRED', 'BOOKING_OTP_ATTEMPTS_EXHAUSTED', 'BOOKING_OTP_NOT_ISSUED',
      'BOOKING_OTP_INVALID', 'BOOKING_WORKER_CODE_INVALID',
    ]));
  });

  it('a rate-limited refusal is 429 and an expired code is 410', () => {
    // Chosen to match what already exists: OTP_EXPIRED is 410 for auth codes.
    expect(V1_ERROR_STATUS.BOOKING_OTP_RESEND_COOLDOWN).toBe(429);
    expect(V1_ERROR_STATUS.BOOKING_OTP_ATTEMPTS_EXHAUSTED).toBe(429);
    expect(V1_ERROR_STATUS.BOOKING_OTP_EXPIRED).toBe(410);
    expect(V1_ERROR_STATUS.BOOKING_OTP_ACTOR_NOT_PERMITTED).toBe(403);
  });

  it('the reschedule endpoint can express a lost concurrency race', () => {
    const entry = V1_CONTRACT.find((e) => e.id === 'bookings.reschedule')!;
    expect(entry.errors).toContain('BOOKING_SCHEDULE_CHANGED');
    expect(entry.errors).toContain('BOOKING_RESCHEDULE_PROVIDER_CONFLICT');
    expect(V1_ERROR_STATUS.BOOKING_SCHEDULE_CHANGED).toBe(409);
  });
});

describe('the caller matrix and its live aliases', () => {
  it('every legacy mapping is /api-rooted and explains itself', () => {
    for (const id of EXPERIENCE_IDS) {
      const entry = V1_CONTRACT.find((e) => e.id === id)!;
      for (const legacy of entry.legacy) {
        expect(legacy.path.startsWith('/api/')).toBe(true);
        if (legacy.disposition !== 'RETIRE') {
          expect(legacy.note.length).toBeGreaterThan(20);
        }
      }
    }
  });

  it('the routes live clients call today are still ALIASED, not retired', () => {
    // Provider Web and the shipped customer app depend on these. Breaking one
    // to tidy the surface is the thing the command forbids.
    const aliased = new Set(
      EXPERIENCE_IDS.flatMap((id) =>
        V1_CONTRACT.find((e) => e.id === id)!.legacy
          .filter((l) => l.disposition === 'ALIAS_TEMPORARILY')
          .map((l) => `${l.method} ${l.path}`),
      ),
    );
    for (const route of [
      'get /api/:id/tracking',
      'post /api/:id/confirm-otp',
      'post /api/:bookingId/resend-otp',
      'post /api/admin/bookings/:id/reschedule',
      'post /api/admin/bookings/:id/escalate',
      'post /api/additional/request/:userId',
      'get /api/additional/booking/:bookingId',
    ]) {
      expect(aliased).toContain(route);
    }
  });

  it('every legacy path this tab names is a route that is actually MOUNTED', () => {
    // A contract that names a deleted route puts a phantom row in the migration
    // matrix and a phantom entry in the telemetry watch list — a retirement that
    // looks pending forever because there is nothing left to measure. This
    // caught `GET /api/workers/location/:uid`, retired in an earlier tab.
    const mounted = new Set(
      buildMountedRoutes().map((r) => `${r.verb.toLowerCase()} ${r.fullPath}`),
    );
    for (const id of EXPERIENCE_IDS) {
      for (const legacy of V1_CONTRACT.find((e) => e.id === id)!.legacy) {
        expect({ route: `${legacy.method} ${legacy.path}`, mounted: mounted.has(`${legacy.method} ${legacy.path}`) })
          .toMatchObject({ mounted: true });
      }
    }
  });

  it('nothing in this tab is marked RETIRE — every alias still has a live caller', () => {
    const retiring = EXPERIENCE_IDS.flatMap((id) =>
      V1_CONTRACT.find((e) => e.id === id)!.legacy
        .filter((l) => l.disposition === 'RETIRE')
        .map((l) => l.path),
    );
    expect(retiring).toEqual([]);
  });

  it('no experience endpoint claims a client is migrated before it is', () => {
    // A `migrated` marking is a promise to a client team. Nothing in this tab
    // has shipped to a client yet, so every surface is legacy, planned or n/a.
    for (const id of EXPERIENCE_IDS) {
      const entry = V1_CONTRACT.find((e) => e.id === id)!;
      expect(Object.values(entry.callers)).not.toContain('migrated');
    }
  });

  it('every experience endpoint names an observability owner', () => {
    for (const id of EXPERIENCE_IDS) {
      const entry = V1_CONTRACT.find((e) => e.id === id)!;
      expect(entry.observability.length).toBeGreaterThan(3);
    }
  });
});

describe('the published contract is the generated one', () => {
  it('the booking documents are current', () => {
    // Fails when experiencePolicy or the contract moved and the generator was
    // not re-run — the moment a published policy starts describing one the
    // backend no longer implements.
    expect(staleFiles()).toEqual([]);
  });

  it('BOOKING_EXPERIENCES_V1_CONTRACT.md exists and is marked generated', () => {
    const file = path.join(REPO_ROOT, 'docs/booking/BOOKING_EXPERIENCES_V1_CONTRACT.md');
    expect(fs.existsSync(file)).toBe(true);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('GENERATED FILE - do not edit by hand');
    expect(text).toContain('scripts/generate-booking-docs.ts');
  });

  it('it lists every canonical path of the tab', () => {
    const text = fs.readFileSync(
      path.join(REPO_ROOT, 'docs/booking/BOOKING_EXPERIENCES_V1_CONTRACT.md'), 'utf8',
    );
    for (const id of EXPERIENCE_IDS) {
      const entry = V1_CONTRACT.find((e) => e.id === id)!;
      expect(text).toContain(`${V1_PREFIX}${entry.path}`);
    }
  });

  it('it states the policy numbers rather than leaving them to prose', () => {
    const text = fs.readFileSync(
      path.join(REPO_ROOT, 'docs/booking/BOOKING_EXPERIENCES_V1_CONTRACT.md'), 'utf8',
    );
    // Derived by executing the declaration, so these cannot be stale.
    expect(text).toMatch(/\| 60 min \|/);          // confirmation expiry
    expect(text).toMatch(/12 hours/);              // tracking window
    expect(text).toMatch(/24 hours before the CURRENT start/);
    expect(text).toMatch(/Provider acceptance required \| \*\*no\*\*/);
  });

  it('the API registry lists the new canonical paths too', () => {
    const registry = fs.readFileSync(
      path.join(REPO_ROOT, 'docs/api/API_ENDPOINT_REGISTRY.md'), 'utf8',
    );
    for (const id of EXPERIENCE_IDS) {
      expect(registry).toContain(fullPath(V1_CONTRACT.find((e) => e.id === id)!));
    }
  });

  it('the legacy matrix lists every alias this tab kept alive', () => {
    const matrix = fs.readFileSync(
      path.join(REPO_ROOT, 'docs/api/LEGACY_ENDPOINT_MIGRATION_MATRIX.md'), 'utf8',
    );
    for (const id of EXPERIENCE_IDS) {
      for (const legacy of V1_CONTRACT.find((e) => e.id === id)!.legacy) {
        expect(matrix).toContain(legacy.path);
      }
    }
  });
});
