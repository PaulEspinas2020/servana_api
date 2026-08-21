/**
 * TAB 05 — the surface that decides what work a provider is offered.
 *
 * The mandate asked four questions and these answer them as behaviour rather
 * than prose: is pause idempotent, what replay mechanism applies, is
 * services-overview subsumed by the services list, and may eligibility be
 * cached.
 *
 * ## The one worth reading twice
 *
 * Pause and reactivate are **not** idempotent, and the honest thing is to
 * publish that rather than wish otherwise. The UPDATE's own WHERE clause matches
 * only a row in the opposite state, so the second run changes nothing and the
 * service throws.
 *
 * But the commonest way to reach that throw is a RETRY — a request that
 * committed and then timed out on a flaky link. A client that cannot tell that
 * from a genuine conflict shows an error for an operation that worked. So the
 * two states get DISTINCT codes rather than collapsing onto CONFLICT, and a
 * client can treat them as success-equivalent when retrying.
 */

jest.mock('../src/services/serviceApplicationService', () => ({
  __esModule: true,
  getProviderServicesOverview: jest.fn(),
  evaluateApplicationEligibility: jest.fn(),
  getApplicationsByWorker: jest.fn(),
  getApplicationByWorker: jest.fn(),
  submitApplication: jest.fn(),
  resubmitApplication: jest.fn(),
  cancelApplication: jest.fn(),
}));
jest.mock('../src/services/technicianService', () => ({
  __esModule: true,
  pauseService: jest.fn(),
  reactivateService: jest.fn(),
}));

import { handlers } from '../src/api/v1/domains/providerServices';
import * as applications from '../src/services/serviceApplicationService';
import * as technicianService from '../src/services/technicianService';
import { V1_CONTRACT } from '../src/api/v1/contract';
import { V1_ERROR_STATUS } from '../src/api/v1/errors';
import { SCHEMAS } from '../src/api/v1/openapi';

const pause = technicianService.pauseService as jest.Mock;
const reactivate = technicianService.reactivateService as jest.Mock;
const resubmit = applications.resubmitApplication as jest.Mock;
const getApp = applications.getApplicationByWorker as jest.Mock;
const submit = applications.submitApplication as jest.Mock;

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

const reqFor = (params: Record<string, string> = {}, body: Record<string, unknown> = {}) => ({
  user: { uid: 'prov-1' }, params, query: {}, body, headers: {}, get: () => undefined,
}) as any;

const entry = (id: string) => V1_CONTRACT.find((e) => e.id === id)!;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('pause and reactivate: not idempotent, and honest about it', () => {
  it('a repeated pause answers a DISTINCT code, not a generic conflict', async () => {
    pause.mockRejectedValue(Object.assign(new Error('Service is already paused.'), {
      code: 'SERVICE_ALREADY_PAUSED', statusCode: 409,
    }));
    const { res, sent } = capture();
    await handlers['provider.services.pause'](reqFor({ serviceId: '7' }), res);

    expect(sent.status).toBe(409);
    // The commonest cause is a retry after a commit that timed out. A client
    // must be able to treat this as success-equivalent, which it cannot do if
    // the code is the same one a real conflict uses.
    expect(sent.body.error.code).toBe('PROVIDER_SERVICE_ALREADY_PAUSED');
    expect(sent.body.error.code).not.toBe('CONFLICT');
  });

  it('a repeated reactivate answers its own mirror code', async () => {
    reactivate.mockRejectedValue(Object.assign(new Error('Service is not paused.'), {
      code: 'SERVICE_NOT_PAUSED', statusCode: 409,
    }));
    const { res, sent } = capture();
    await handlers['provider.services.reactivate'](reqFor({ serviceId: '7' }), res);

    expect(sent.body.error.code).toBe('PROVIDER_SERVICE_NOT_PAUSED');
  });

  it('a service that is not the caller\'s is a 404, not a 403', async () => {
    pause.mockRejectedValue(Object.assign(new Error('Service not assigned to this worker.'), {
      code: 'SERVICE_NOT_FOUND', statusCode: 404,
    }));
    const { res, sent } = capture();
    await handlers['provider.services.pause'](reqFor({ serviceId: '7' }), res);

    // 403 would confirm the service exists and belongs to somebody. 404 does not.
    expect(sent.status).toBe(404);
    expect(sent.body.error.code).toBe('NOT_FOUND');
  });

  it('both declare state-predicate as the replay mechanism, and both are non-idempotent', () => {
    for (const id of ['provider.services.pause', 'provider.services.reactivate']) {
      expect(entry(id).idempotent).toBe(false);
      expect(entry(id).replayMechanism).toEqual(['state-predicate']);
      expect(entry(id).replayGuard).toBeTruthy();
    }
  });

  it('both codes are in the published vocabulary at 409', () => {
    expect(V1_ERROR_STATUS.PROVIDER_SERVICE_ALREADY_PAUSED).toBe(409);
    expect(V1_ERROR_STATUS.PROVIDER_SERVICE_NOT_PAUSED).toBe(409);
    expect(entry('provider.services.pause').errors).toContain('PROVIDER_SERVICE_ALREADY_PAUSED');
    expect(entry('provider.services.reactivate').errors).toContain('PROVIDER_SERVICE_NOT_PAUSED');
  });

  it('refuses a non-numeric serviceId BEFORE the query runs', async () => {
    const { res, sent } = capture();
    await handlers['provider.services.pause'](reqFor({ serviceId: 'abc' }), res);

    expect(sent.status).toBe(400);
    // A NaN reaching Postgres is a type error, and §21 forbids putting one on
    // the wire. Refusing here means it never gets the chance.
    expect(pause).not.toHaveBeenCalled();
  });

  it('treats a blank pause reason as absent rather than storing an empty string', async () => {
    pause.mockResolvedValue({ service_id: 7, status: 'paused', pause_reason: null });
    const { res } = capture();
    await handlers['provider.services.pause'](reqFor({ serviceId: '7' }, { reason: '   ' }), res);

    expect(pause).toHaveBeenCalledWith('prov-1', 7, undefined);
  });
});

describe('resubmit protects a reviewer decision the provider never saw', () => {
  it('requires expectedVersion, and does not reach the service without it', async () => {
    const { res, sent } = capture();
    await handlers['provider.serviceApplications.resubmit'](
      reqFor({ applicationId: 'app-1' }, { clientRequestId: 'client-request-id-01' }), res,
    );

    expect(sent.status).toBe(400);
    expect(resubmit).not.toHaveBeenCalled();
  });

  it('a version mismatch is STALE_STATE, not a validation error', async () => {
    resubmit.mockRejectedValue(Object.assign(new Error('Application changed'), {
      code: 'VERSION_CONFLICT', statusCode: 409,
    }));
    const { res, sent } = capture();
    await handlers['provider.serviceApplications.resubmit'](
      reqFor({ applicationId: 'app-1' }, { clientRequestId: 'client-request-id-01', expectedVersion: 1 }), res,
    );

    // Nothing about the request was malformed — the world moved. STALE_STATE is
    // the code a client already reloads on.
    expect(sent.body.error.code).toBe('STALE_STATE');
    expect(sent.body.error.code).not.toBe('VALIDATION_FAILED');
  });

  it('declares client-request-id AND row-lock, because both are doing work', () => {
    expect(entry('provider.serviceApplications.resubmit').replayMechanism)
      .toEqual(['client-request-id', 'row-lock']);
  });
});

describe('an application id names a resource, never an identity', () => {
  it('passes the caller uid alongside the id, so scoping happens in SQL', async () => {
    getApp.mockResolvedValue({ id: 'app-1', status: 'submitted', version: 1 });
    const { res } = capture();
    await handlers['provider.serviceApplications.get'](reqFor({ applicationId: 'app-1' }), res);

    expect(getApp).toHaveBeenCalledWith('app-1', 'prov-1');
  });

  it('refuses a malformed id as NOT_FOUND rather than probing the database', async () => {
    const { res, sent } = capture();
    await handlers['provider.serviceApplications.get'](reqFor({ applicationId: "' OR 1=1--" }), res);

    expect(sent.status).toBe(404);
    expect(getApp).not.toHaveBeenCalled();
  });

  it('the submit rejects a non-positive serviceId before any write', async () => {
    const { res, sent } = capture();
    await handlers['provider.serviceApplications.create'](
      reqFor({}, { serviceId: -1, clientRequestId: 'client-request-id-01', requirementsVersion: 1 }), res,
    );
    expect(sent.status).toBe(400);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('the mandate questions, answered in the published contract', () => {
  it('services-overview is NOT subsumed: it is a different projection, and both are published', () => {
    const overview = entry('provider.services.overview');
    const list = entry('provider.services.list');
    expect(overview.responseSchema).toBe('ProviderServicesOverview');
    expect(list.responseSchema).not.toBe(overview.responseSchema);
    // The overview carries the readiness verdict and the applications; the list
    // is four fields for a chip. Neither can be built from the other.
    expect(overview.notes).toMatch(/NOT subsumed/);
  });

  it('eligibility publishes its caching answer, because the mandate asked', () => {
    const schema = SCHEMAS.ServiceApplicationEligibility as any;
    // "Specify eligibility's semantics: whether it is a read a client may cache,
    // and for how long." The answer is no, and the reason travels with it.
    expect(schema.description).toMatch(/DO NOT CACHE/);
    expect(entry('provider.services.eligibility').notes).toMatch(/do NOT cache/i);
  });

  it('the withdraw operation exists — the eighth in a cluster listed as seven paths', () => {
    const withdraw = entry('provider.serviceApplications.withdraw');
    expect(withdraw.method).toBe('delete');
    // GET and DELETE share one path, so counting paths undercounts the work.
    expect(withdraw.path).toBe(entry('provider.serviceApplications.get').path);
  });

  it('every write in this cluster names a replay mechanism', () => {
    const writes = V1_CONTRACT.filter(
      (e) => e.domain === 'provider-services' && !e.idempotent && e.status === 'implemented',
    );
    expect(writes.length).toBeGreaterThanOrEqual(5);
    for (const w of writes) {
      expect(Array.isArray(w.replayMechanism)).toBe(true);
      expect(w.replayMechanism!.length).toBeGreaterThan(0);
    }
  });
});
