/**
 * TAB 06 — presence, location and safety.
 *
 * The book asks for unusual care here, and names why: *"an incident report that
 * fails silently is worse than one that was never offered."* These assert the
 * three properties that follow from that.
 *
 *   1. A location ping CANNOT change availability. The legacy route accepts
 *      `isOnline` and writes it through; the canonical one does not carry the
 *      field, and echoes back whatever presence already held.
 *   2. Going OFFLINE survives every restriction. `go-online` carries the
 *      active-provider rung and `go-offline` deliberately does not — a provider
 *      trapped online has no workaround.
 *   3. A retried incident report is a SUCCESS, not a conflict. It returns the
 *      original with 200, and mutates nothing — not even `reportedAt`, which is
 *      the moment a provider says something happened.
 */

jest.mock('../src/services/providerOperationalAvailabilityService', () => ({
  __esModule: true,
  getStatus: jest.fn(),
  setOnline: jest.fn(),
  setOffline: jest.fn(),
}));
jest.mock('../src/services/technicianService', () => ({
  __esModule: true,
  upsertWorkerLocation: jest.fn(),
}));
jest.mock('../src/services/providerSafetyService', () => {
  const actual = jest.requireActual('../src/services/providerSafetyService');
  return { ...actual, submitIncident: jest.fn(), listIncidents: jest.fn(), recordCheckIn: jest.fn() };
});

import { handlers } from '../src/api/v1/domains/providerPresence';
import * as availability from '../src/services/providerOperationalAvailabilityService';
import * as technicianService from '../src/services/technicianService';
import * as safety from '../src/services/providerSafetyService';
import { V1_CONTRACT } from '../src/api/v1/contract';
import { SCHEMAS } from '../src/api/v1/openapi';

const getStatus = availability.getStatus as jest.Mock;
const setOnline = availability.setOnline as jest.Mock;
const setOffline = availability.setOffline as jest.Mock;
const upsertLocation = technicianService.upsertWorkerLocation as jest.Mock;
const submitIncident = safety.submitIncident as jest.Mock;

const capture = () => {
  const sent: any = { status: 200, body: undefined, headers: {} };
  const res: any = {
    status(c: number) { sent.status = c; return res; },
    json(b: any) { sent.body = b; return res; },
    set(n: string, v: string) { sent.headers[n] = v; return res; },
    setHeader(n: string, v: string) { sent.headers[n] = v; return res; },
    getHeader(n: string) { return sent.headers[n]; },
    headersSent: false,
  };
  return { res, sent };
};

const reqFor = (body: Record<string, unknown> = {}, query: Record<string, unknown> = {}) => ({
  user: { uid: 'prov-1' }, params: {}, query, body, headers: {}, get: () => undefined,
}) as any;

const entry = (id: string) => V1_CONTRACT.find((e) => e.id === id)!;
const online = (isOnline: boolean) => ({
  availabilityStatus: isOnline ? 'online' : 'offline',
  availabilitySource: 'provider_explicit',
  changedByUid: null, changedByRole: null, changedAt: null,
  reason: null, version: 1, updatedAt: null,
});

beforeEach(() => jest.clearAllMocks());

describe('a location ping cannot change whether a provider is working', () => {
  it('writes back the CURRENT presence rather than anything from the body', async () => {
    getStatus.mockResolvedValue(online(true));
    upsertLocation.mockResolvedValue(undefined);
    const { res } = capture();

    // A client sending isOnline:false — as the legacy body permits — must not
    // take this provider offline through a transport route.
    await handlers['provider.location.report'](
      reqFor({ latitude: 14.5547, longitude: 121.0245, isOnline: false }), res,
    );

    expect(upsertLocation).toHaveBeenCalledWith({
      uid: 'prov-1', latitude: 14.5547, longitude: 121.0245, is_online: true,
    });
  });

  it('carries the presence through unchanged when the provider is offline too', async () => {
    getStatus.mockResolvedValue(online(false));
    upsertLocation.mockResolvedValue(undefined);
    const { res, sent } = capture();

    await handlers['provider.location.report'](
      reqFor({ latitude: 1, longitude: 2, isOnline: true }), res,
    );

    expect(upsertLocation).toHaveBeenCalledWith(
      expect.objectContaining({ is_online: false }),
    );
    expect(sent.body.data.isOnline).toBe(false);
  });

  it('the published request schema does not accept isOnline at all', () => {
    const schema = SCHEMAS.ProviderLocationReport as any;
    expect(Object.keys(schema.properties)).toEqual(['latitude', 'longitude']);
    // Strict, so a client that keeps sending the legacy field is told rather
    // than silently ignored.
    expect(schema.additionalProperties).toBe(false);
  });

  it('refuses a fabricated coordinate rather than storing it', async () => {
    getStatus.mockResolvedValue(online(true));
    const { res, sent } = capture();
    await handlers['provider.location.report'](reqFor({ latitude: 999, longitude: 0 }), res);

    // §39 forbids fabricating a location. A latitude of 999 in a geospatial
    // index is one nobody can later tell from a real fix.
    expect(sent.status).toBe(400);
    expect(upsertLocation).not.toHaveBeenCalled();
  });

  it('refuses a missing coordinate rather than defaulting it to zero', async () => {
    getStatus.mockResolvedValue(online(true));
    const { res, sent } = capture();
    await handlers['provider.location.report'](reqFor({ latitude: 14.5 }), res);

    // 0,0 is a real place in the Gulf of Guinea. Defaulting to it is worse than
    // refusing, because it looks like data.
    expect(sent.status).toBe(400);
    expect(upsertLocation).not.toHaveBeenCalled();
  });
});

describe('a provider can always go offline', () => {
  it('go-offline carries NO active-provider rung, matching the legacy chain', () => {
    // DENY_ALL sets canGoOffline: true even for a denied account. A stricter
    // successor here would strand a suspended provider as available.
    expect(entry('provider.presence.goOffline').activeProvider).toBeUndefined();
  });

  it('go-online DOES carry it, so the asymmetry is deliberate rather than forgotten', () => {
    expect(entry('provider.presence.goOnline').activeProvider).toBe(true);
  });

  it('going offline reaches the service with the explicit provider source', async () => {
    setOffline.mockResolvedValue(undefined);
    const { res, sent } = capture();
    await handlers['provider.presence.goOffline'](reqFor(), res);

    expect(setOffline).toHaveBeenCalledWith('prov-1', 'provider_explicit', 'prov-1', 'provider', null);
    expect(sent.body.data.isOnline).toBe(false);
  });

  it('going online without coordinates passes null rather than 0,0', async () => {
    setOnline.mockResolvedValue(undefined);
    const { res } = capture();
    await handlers['provider.presence.goOnline'](reqFor(), res);

    // The legacy controller coerces a missing coordinate to 0 and then tests for
    // `!== 0`, which is a real place. Passing null says "no fix" plainly.
    expect(setOnline).toHaveBeenCalledWith('prov-1', 'provider_explicit', 'prov-1', 'provider', null, null);
  });

  it('both presence writes are declared idempotent, because they are', () => {
    expect(entry('provider.presence.goOnline').idempotent).toBe(true);
    expect(entry('provider.presence.goOffline').idempotent).toBe(true);
  });
});

describe('a retried incident report is a success, not a conflict', () => {
  it('replays the original with 200 rather than refusing with 409', async () => {
    submitIncident.mockResolvedValue({
      incidentId: 'inc-1', providerSafeReference: 'SAF-2026-ABCDE',
      state: 'submitted', replayed: true,
    });
    const { res, sent } = capture();
    await handlers['provider.safety.incidents.create'](reqFor({
      clientIncidentId: 'inc-client-1', category: 'aggression',
      severity: 'level_2', description: 'Customer became aggressive.',
    }), res);

    // The legacy route answers 409 and keeps doing so. Here a retry after a
    // commit that timed out on a doorstep must NOT read as "your report was
    // never filed".
    expect(sent.status).toBe(200);
    expect(sent.body.data.replayed).toBe(true);
    expect(sent.body.data.incidentId).toBe('inc-1');
    expect(sent.body.error).toBeUndefined();
  });

  it('a first report answers 201, so a client can still tell them apart', async () => {
    submitIncident.mockResolvedValue({
      incidentId: 'inc-2', providerSafeReference: 'SAF-2026-FGHIJ',
      state: 'submitted', replayed: false,
    });
    const { res, sent } = capture();
    await handlers['provider.safety.incidents.create'](reqFor({
      clientIncidentId: 'inc-client-2', category: 'aggression',
      severity: 'level_2', description: 'Customer became aggressive.',
    }), res);

    expect(sent.status).toBe(201);
    expect(sent.body.data.replayed).toBe(false);
  });

  it('declares client-request-id AND unique-constraint, because both are load-bearing', () => {
    // The upsert alone collapses the ordinary sequential retry. The index is
    // what makes it hold under genuine concurrency, which is the case a
    // doorstep retry actually produces.
    expect(entry('provider.safety.incidents.create').replayMechanism)
      .toEqual(['client-request-id', 'unique-constraint']);
  });

  it('answers all three of late, out-of-order and twice, as the mandate asks', () => {
    const notes = entry('provider.safety.incidents.create').notes ?? '';
    expect(notes).toMatch(/LATE/);
    expect(notes).toMatch(/OUT OF ORDER/);
    expect(notes).toMatch(/TWICE/);
  });
});

describe('the check-in declares its replay mechanism rather than staying silent', () => {
  it('is none-accepted, with the reason recorded', () => {
    const e = entry('provider.safety.checkIn');
    // "none-accepted is an acceptable answer and the clients will honour it;
    // silence is not."
    expect(e.replayMechanism).toEqual(['none-accepted']);
    expect(e.replayGuard).toMatch(/discard|DISCARD/);
  });

  it('every safety and presence write declares one', () => {
    const writes = V1_CONTRACT.filter(
      (e) => e.domain === 'provider-presence' && !e.idempotent && e.status === 'implemented',
    );
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(Array.isArray(w.replayMechanism)).toBe(true);
      expect(w.replayMechanism!.length).toBeGreaterThan(0);
    }
  });
});

describe('location retention and access are published, not left to be inferred', () => {
  it('the contract states who may read a provider location', () => {
    const notes = entry('provider.location.report').notes ?? '';
    expect(notes).toMatch(/RETENTION AND ACCESS/);
    // A customer reaches it only through a booking they own, while it is live.
    expect(notes).toMatch(/booking they/);
  });

  it('no route in this domain returns another provider\'s location', () => {
    const domain = V1_CONTRACT.filter((e) => e.domain === 'provider-presence');
    for (const e of domain) {
      expect(e.path).not.toMatch(/:providerUid|:workerId|:uid/);
    }
  });
});
