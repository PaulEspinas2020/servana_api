/**
 * v1 time off says what it collides with.
 *
 * ## Why this is a suite and not a line in the router test
 *
 * Time off is created even when it overlaps CONFIRMED bookings. That is
 * deliberate — a provider who is ill must be able to record it, and refusing
 * would leave them with no way to say so. But the work is still assigned to
 * them, and the legacy handler therefore returns `bookingConflicts` plus a
 * sentence saying, in as many words, that creating time off does not cancel
 * accepted work.
 *
 * A v1 endpoint that stored the period and answered a bare 201 would be
 * strictly WORSE than the route it replaces: a provider would book leave,
 * receive a clean success, and not turn up to jobs still assigned to them. It
 * would also pass every contract check, every schema check and the route test,
 * because all of those care about shape.
 *
 * ## The second thing being defended
 *
 * The response is built from what was STORED, never from the request. That is
 * not stylistic. The partial-day defect (C22 §17) survived precisely because
 * the reply echoed the body: the portal sent `startTime`/`endTime`, nothing
 * persisted them, and the response cheerfully reported `allDay` — so the client
 * and the server agreed, and both were wrong.
 */

import express from 'express';

import { startTestServer, request, type TestServer } from './support/httpTestServer';

import * as engine from '../src/services/providerAvailabilityEngine';
import { handlers } from '../src/api/v1/domains/account';

jest.mock('../src/services/providerAvailabilityEngine', () => ({
  listTimeOff: jest.fn(),
  createTimeOff: jest.fn(),
  cancelTimeOff: jest.fn(),
}));

const eng = engine as jest.Mocked<typeof engine>;
const UID = 'worker-under-test';

const buildApp = () => {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as any).user = { uid: UID };
    next();
  });
  a.get('/time-off', handlers['provider.timeOff.list'] as any);
  a.post('/time-off', handlers['provider.timeOff.create'] as any);
  a.delete('/time-off/:timeOffId', handlers['provider.timeOff.cancel'] as any);
  return a;
};

let server: TestServer;
const get = (p: string) => request(server.base, 'GET', p);
const post = (p: string, body: unknown) => request(server.base, 'POST', p, { body });
const del = (p: string) => request(server.base, 'DELETE', p);

beforeAll(async () => {
  server = await startTestServer(buildApp());
});
afterAll(async () => {
  await server.close();
});

const stored = (over: Record<string, unknown> = {}) => ({
  id: 3,
  startDate: '2026-09-01',
  endDate: '2026-09-02',
  allDay: true,
  startTime: null,
  endTime: null,
  reason: 'sick',
  note: null,
  createdAt: null,
  bookingConflicts: [],
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  (eng.createTimeOff as jest.Mock).mockResolvedValue(stored());
  (eng.cancelTimeOff as jest.Mock).mockResolvedValue(undefined);
  (eng.listTimeOff as jest.Mock).mockResolvedValue([stored({ status: 'active' })]);
});

describe('a collision is reported, not swallowed', () => {
  it('names the conflicting bookings and says leave does not cancel them', async () => {
    (eng.createTimeOff as jest.Mock).mockResolvedValue(
      stored({ bookingConflicts: [{ bookingId: 104, scheduleAt: '2026-09-01T02:00:00.000Z' }] }),
    );

    const res = await post('/time-off', {
      startDate: '2026-09-01', endDate: '2026-09-02', reason: 'sick',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.bookingConflicts).toHaveLength(1);
    expect(res.body.data.conflictNotice).toContain('does not cancel accepted work');
  });

  it('and the period is still CREATED — the notice is a warning, not a refusal', async () => {
    // Refusing would leave a provider who is ill with no way to record it.
    (eng.createTimeOff as jest.Mock).mockResolvedValue(
      stored({ bookingConflicts: [{ bookingId: 104 }] }),
    );

    const res = await post('/time-off', {
      startDate: '2026-09-01', endDate: '2026-09-02', reason: 'sick',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe('3');
  });

  it('no collision means no notice at all', async () => {
    // A permanent banner is a banner nobody reads.
    const res = await post('/time-off', {
      startDate: '2026-09-01', endDate: '2026-09-02', reason: 'sick',
    });

    expect(res.body.data.bookingConflicts).toEqual([]);
    expect(res.body.data.conflictNotice).toBeNull();
  });
});

describe('the response reports what was stored', () => {
  it('partial-day fields reach the engine rather than being dropped', async () => {
    // They were destructured and then dropped once already. The portal shipped
    // a partial-day form the whole time and a provider asking for two hours
    // off lost the entire day.
    await post('/time-off', {
      startDate: '2026-09-01',
      endDate: '2026-09-01',
      reason: 'appointment',
      allDay: false,
      startTime: '13:00',
      endTime: '15:00',
      note: 'dentist',
    });

    expect(eng.createTimeOff).toHaveBeenCalledWith(
      UID,
      expect.objectContaining({
        allDay: false, startTime: '13:00', endTime: '15:00', note: 'dentist',
      }),
      UID,
    );
  });

  it('and the reply is the STORED row, not the request', async () => {
    // The engine says all-day; the request asked for partial. The response must
    // side with the engine, or the client and the server agree and both are
    // wrong — which is exactly how the original defect stayed invisible.
    (eng.createTimeOff as jest.Mock).mockResolvedValue(
      stored({ allDay: true, startTime: null, endTime: null }),
    );

    const res = await post('/time-off', {
      startDate: '2026-09-01', endDate: '2026-09-01', reason: 'appointment',
      allDay: false, startTime: '13:00', endTime: '15:00',
    });

    expect(res.body.data.allDay).toBe(true);
    expect(res.body.data.startTime).toBeNull();
  });
});

describe('the list is active periods only', () => {
  it('a cancelled period is history, not a commitment', async () => {
    (eng.listTimeOff as jest.Mock).mockResolvedValue([
      stored({ id: 3, status: 'active' }),
      stored({ id: 4, status: 'cancelled' }),
    ]);

    const res = await get('/time-off');

    expect(res.status).toBe(200);
    expect(res.body.data.timeOff).toHaveLength(1);
    expect(res.body.data.timeOff[0].id).toBe('3');
  });
});

describe('validation and identity', () => {
  it('refuses a request missing the required fields, before touching the engine', async () => {
    const res = await post('/time-off', { startDate: '2026-09-01' });

    expect(res.status).toBe(400);
    expect(eng.createTimeOff).not.toHaveBeenCalled();
  });

  it('a malformed id is a 404, never a 422', async () => {
    // A 422 for a malformed id and a 404 for someone else's would let a caller
    // separate "no such period" from "not yours".
    for (const id of ['abc', '0', '-2']) {
      const res = await del(`/time-off/${id}`);
      expect(res.status).toBe(404);
    }
    expect(eng.cancelTimeOff).not.toHaveBeenCalled();
  });

  it('cancels as the caller, for the caller — no body names an owner', async () => {
    const res = await del('/time-off/3');

    expect(res.status).toBe(200);
    expect(eng.cancelTimeOff).toHaveBeenCalledWith(UID, 3, UID);
  });
});
