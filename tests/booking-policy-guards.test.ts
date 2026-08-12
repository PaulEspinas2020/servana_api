/**
 * Policy lives behind the executor, not in a controller.
 *
 * The 48-hour provider cancellation window was enforced in
 * `controllers/bookingCancellationPolicy.ts`. It was correct, and it was
 * checked on the one path that existed — but a controller is transport. A
 * policy there is optional depending on which caller reaches the executor,
 * which is exactly what centralising the lifecycle was supposed to end.
 *
 * These tests assert three things:
 *
 *   1. the rule is DISCOVERABLE — one named constant, one named guard;
 *   2. the executor ENFORCES it, so no backend caller can route around it;
 *   3. the transitions endpoint EVALUATES THE SAME GUARD, so the button a
 *      client draws and the action the executor authorizes cannot disagree.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/db/dbQuery', () => require('./support/bookingDbFake').dbMock);
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: {} }));

import fs from 'fs';
import path from 'path';
import { store, reset } from './support/bookingDbFake';
import {
  transitionBooking,
  getAvailableActions,
  TransitionError,
  BOOKING_GUARDS,
  BOOKING_ACTIONS,
  __resetTransitionSchema,
} from '../src/services/booking/transitionExecutor';
import {
  PROVIDER_CANCEL_WINDOW_HOURS,
  evaluateCancellation,
} from '../src/services/booking/bookingPolicies';

const PROVIDER = 'provider-a';
const BOOKING = 701;

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const seedAccepted = (scheduleIso: string | null) => {
  store.booking = {
    id: BOOKING, status: 'WORKER_ASSIGNED', user_id: 'customer-1',
    worker_uid: PROVIDER, worker_code: '123456', schedule: scheduleIso,
  };
  store.assignments = [{ booking_id: BOOKING, worker_uid: PROVIDER, status: 'ACCEPTED' }];
};

beforeEach(() => {
  reset();
  __resetTransitionSchema();
});

describe('the rule is discoverable', () => {
  it('lives in the domain layer, not in a controller', () => {
    expect(fs.existsSync(path.resolve(__dirname, '../src/services/booking/bookingPolicies.ts'))).toBe(true);
    expect(fs.existsSync(path.resolve(__dirname, '../src/controllers/bookingCancellationPolicy.ts'))).toBe(false);
  });

  it('the window is one named constant', () => {
    expect(PROVIDER_CANCEL_WINDOW_HOURS).toBe(48);
  });

  it('the action names its guard rather than hard-coding hours', () => {
    expect((BOOKING_ACTIONS.PROVIDER_CANCEL as { guard?: string }).guard)
      .toBe('providerCancellationWindow');
    const executor = fs.readFileSync(
      path.resolve(__dirname, '../src/services/booking/transitionExecutor.ts'), 'utf8',
    );
    // No second copy of the threshold anywhere in the machine.
    expect(executor).not.toMatch(/\b48\b\s*\*\s*3_?600_?000/);
    expect(executor).not.toMatch(/hoursUntilStart\s*<\s*48/);
  });
});

describe('the executor enforces the window', () => {
  it('allows a cancellation outside the window', async () => {
    seedAccepted(hoursFromNow(72));
    const result = await transitionBooking({
      action: 'PROVIDER_CANCEL', bookingId: BOOKING,
      actorRole: 'assigned_provider', actorUid: PROVIDER,
    });
    expect(result.toState).toBe('AWAITING_ASSIGNMENT');
  });

  it('refuses inside the window with a SPECIFIC reason, not a generic failure', async () => {
    seedAccepted(hoursFromNow(3));
    const error = await transitionBooking({
      action: 'PROVIDER_CANCEL', bookingId: BOOKING,
      actorRole: 'assigned_provider', actorUid: PROVIDER,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(TransitionError);
    expect(error.code).toBe('POLICY_REFUSED');
    expect(error.detail.reasonCode).toBe('BOOKING_PROVIDER_CANCEL_WINDOW_EXPIRED');
    expect(error.detail.guard).toBe('providerCancellationWindow');
  });

  it('tells the client the deadline so it never recomputes the window', async () => {
    const schedule = hoursFromNow(3);
    seedAccepted(schedule);
    const error = await transitionBooking({
      action: 'PROVIDER_CANCEL', bookingId: BOOKING,
      actorRole: 'assigned_provider', actorUid: PROVIDER,
    }).catch((e) => e);

    const expected = new Date(new Date(schedule).getTime() - 48 * 3_600_000).toISOString();
    expect(error.detail.allowedUntil).toBe(expected);
    expect(error.detail.noticeHours).toBe(48);
  });

  it('fails CLOSED when the booking has no usable schedule', async () => {
    // The 48-hour guarantee cannot be proven, so the cancellation must not slip
    // through — an unprovable policy is a refused one.
    seedAccepted(null);
    const error = await transitionBooking({
      action: 'PROVIDER_CANCEL', bookingId: BOOKING,
      actorRole: 'assigned_provider', actorUid: PROVIDER,
    }).catch((e) => e);

    expect(error.code).toBe('POLICY_REFUSED');
    expect(error.detail.reasonCode).toBe('BOOKING_PROVIDER_CANCEL_SCHEDULE_UNKNOWN');
  });

  it('a refused cancellation writes NOTHING', async () => {
    // The guard runs before any mutation, so a policy refusal cannot leave a
    // half-released booking behind.
    seedAccepted(hoursFromNow(3));
    await transitionBooking({
      action: 'PROVIDER_CANCEL', bookingId: BOOKING,
      actorRole: 'assigned_provider', actorUid: PROVIDER,
    }).catch(() => undefined);

    expect(store.assignments[0].status).toBe('ACCEPTED');
    expect(store.booking).toMatchObject({ worker_uid: PROVIDER, worker_code: '123456' });
    expect(store.transitions).toHaveLength(0);
    expect(store.tracking).toHaveLength(0);
  });

  it('rejects a reason code outside the standardized list', async () => {
    seedAccepted(hoursFromNow(72));
    const error = await transitionBooking({
      action: 'PROVIDER_CANCEL', bookingId: BOOKING,
      actorRole: 'assigned_provider', actorUid: PROVIDER,
      metadata: { reasonCode: 'BECAUSE_I_SAID_SO' },
    }).catch((e) => e);

    expect(error.detail.reasonCode).toBe('BOOKING_PROVIDER_CANCEL_REASON_INVALID');
  });
});

describe('the transitions endpoint answers from the same guard', () => {
  it('reports PROVIDER_CANCEL unavailable, with the reason and the deadline', async () => {
    const schedule = hoursFromNow(3);
    seedAccepted(schedule);

    const actions = await getAvailableActions(BOOKING, PROVIDER, 'assigned_provider');
    const cancel = actions.find((a) => a.action === 'PROVIDER_CANCEL');

    expect(cancel).toBeDefined();
    expect(cancel!.allowed).toBe(false);
    expect(cancel!.reasonCode).toBe('BOOKING_PROVIDER_CANCEL_WINDOW_EXPIRED');
    expect(cancel!.detail?.allowedUntil)
      .toBe(new Date(new Date(schedule).getTime() - 48 * 3_600_000).toISOString());
  });

  it('reports it available outside the window', async () => {
    seedAccepted(hoursFromNow(72));
    const actions = await getAvailableActions(BOOKING, PROVIDER, 'assigned_provider');
    expect(actions.find((a) => a.action === 'PROVIDER_CANCEL')?.allowed).toBe(true);
  });

  /**
   * The property that makes this worth building: UI visibility and executor
   * authorization are the same decision. If they can disagree for ANY schedule,
   * some provider eventually taps a button that returns 409.
   */
  it('never disagrees with the executor, across the window boundary', async () => {
    /**
     * Half-hour offsets, deliberately.
     *
     * The policy floors `hoursUntilStart`, and the two calls below each take
     * their own `new Date()`. A schedule exactly 48 hours out reads as 48 on
     * the first call and 47 on the second the moment any wall-clock elapses
     * between them — so an integer-valued fixture makes this test fail under
     * load and pass in isolation, which teaches everyone to ignore it.
     *
     * Offsetting by half an hour keeps the boundary coverage (47.5 refuses,
     * 48.5 allows) while giving thirty minutes of slack against a floor that
     * genuinely can tick during the test.
     */
    for (const hours of [-10.5, 0.5, 1.5, 47.5, 48.5, 49.5, 72.5, 500.5]) {
      reset();
      __resetTransitionSchema();
      seedAccepted(hoursFromNow(hours));

      const advertised = (await getAvailableActions(BOOKING, PROVIDER, 'assigned_provider'))
        .find((a) => a.action === 'PROVIDER_CANCEL')!;

      const enforced = await transitionBooking({
        action: 'PROVIDER_CANCEL', bookingId: BOOKING,
        actorRole: 'assigned_provider', actorUid: PROVIDER,
      }).then(() => ({ allowed: true, reasonCode: undefined as string | undefined }))
        .catch((e) => ({ allowed: false, reasonCode: e.detail?.reasonCode }));

      expect({ hours, ...advertised, action: undefined, detail: undefined })
        .toMatchObject({ hours, allowed: enforced.allowed });
      if (!enforced.allowed) expect(advertised.reasonCode).toBe(enforced.reasonCode);
    }
  });

  it('offers nothing to a provider who is not the assigned one', async () => {
    seedAccepted(hoursFromNow(72));
    expect(await getAvailableActions(BOOKING, 'provider-b', 'assigned_provider')).toEqual([]);
  });
});

describe('the guard registry is honest', () => {
  /** A context with everything a guard may read, defaults that pass. */
  const guardCtx = (o: { schedule?: string | null } = {}) => ({
    bookingId: BOOKING,
    bookingStatus: 'WORKER_ASSIGNED',
    workerStatus: 'ACCEPTED',
    schedule: o.schedule ?? hoursFromNow(500),
    now: new Date(),
    metadata: {},
    query: async () => ({ rows: [{ settled: true }], rowCount: 1 }),
  });

  it('every guard named by an action exists', () => {
    for (const [, spec] of Object.entries(BOOKING_ACTIONS)) {
      const name = (spec as { guard?: string }).guard;
      if (name) expect(Object.keys(BOOKING_GUARDS)).toContain(name);
    }
  });

  it('a guard returns a reason code whenever it refuses', async () => {
    // A refusal with no reason is indistinguishable from a bug at the client.
    const refused = await BOOKING_GUARDS.providerCancellationWindow(
      guardCtx({ schedule: hoursFromNow(1) }),
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBeTruthy();
    expect(refused.message).toBeTruthy();
  });

  it('the guard delegates to the policy rather than reimplementing it', async () => {
    // Same inputs, same verdict — if the guard ever grew its own arithmetic
    // this would drift the moment the constant changed. Half-hour offsets for
    // the same floor-boundary reason as the parity test above.
    for (const hours of [1.5, 47.5, 48.5, 49.5]) {
      const schedule = hoursFromNow(hours);
      const policy = evaluateCancellation({
        workerStatus: 'ACCEPTED', schedule, now: new Date(),
      });
      const guard = await BOOKING_GUARDS.providerCancellationWindow(guardCtx({ schedule }));
      expect(guard.allowed).toBe(policy.canCancel);
    }
  });

  it('every guard is reachable through the same context shape', async () => {
    // Both guards take one GuardContext. A guard needing data reads it through
    // ctx.query on the caller's connection; one that does not simply ignores
    // it. That uniformity is what lets the executor and getAvailableActions
    // run the identical registry.
    for (const name of Object.keys(BOOKING_GUARDS) as Array<keyof typeof BOOKING_GUARDS>) {
      const verdict = await BOOKING_GUARDS[name](guardCtx({ schedule: hoursFromNow(500) }));
      expect(typeof verdict.allowed).toBe('boolean');
    }
  });
});

/**
 * ASSIGN and REASSIGN both end at ASSIGNED, and are not the same operation.
 *
 * `from` separates them structurally: ADMIN_ASSIGN only from
 * AWAITING_ASSIGNMENT, ADMIN_REASSIGN only from a live assignment. These
 * assertions cover the other half — that each does what its name says, so the
 * timeline keeps the distinction between
 *
 *   Assigned Provider A
 *   Reassigned Provider A → Provider B
 *
 * which cannot be reconstructed once it is lost.
 */
describe('assign and reassign are not interchangeable', () => {
  const seedUnassigned = () => {
    store.booking = {
      id: BOOKING, status: 'CONFIRMED', user_id: 'customer-1',
      worker_uid: null, schedule: hoursFromNow(72),
    };
    store.assignments = [];
  };

  it('ADMIN_ASSIGN places a provider on an unassigned booking', async () => {
    seedUnassigned();
    const result = await transitionBooking({
      action: 'ADMIN_ASSIGN', bookingId: BOOKING, actorRole: 'admin', actorUid: 'admin-1',
      metadata: { providerUid: 'provider-x' },
    });
    expect(result.fromState).toBe('AWAITING_ASSIGNMENT');
    expect(store.transitions[0]).toMatchObject({ action: 'ADMIN_ASSIGN', to_state: 'ASSIGNED' });
  });

  it('ADMIN_ASSIGN is refused when a provider is already on the booking', async () => {
    seedAccepted(hoursFromNow(72));
    const error = await transitionBooking({
      action: 'ADMIN_ASSIGN', bookingId: BOOKING, actorRole: 'admin', actorUid: 'admin-1',
      metadata: { providerUid: 'provider-x' },
    }).catch((e) => e);

    expect(error).toBeInstanceOf(TransitionError);
    // Refused by `from` before it can silently become a reassignment.
    expect(store.transitions).toHaveLength(0);
    expect(store.assignments[0].status).toBe('ACCEPTED');
  });

  it('ADMIN_REASSIGN is refused when there is nothing to replace', async () => {
    seedUnassigned();
    const error = await transitionBooking({
      action: 'ADMIN_REASSIGN', bookingId: BOOKING, actorRole: 'admin', actorUid: 'admin-1',
      metadata: { providerUid: 'provider-x' },
    }).catch((e) => e);

    expect(error).toBeInstanceOf(TransitionError);
    expect(store.transitions).toHaveLength(0);
  });

  it('ADMIN_REASSIGN closes the outgoing assignment rather than overwriting it', async () => {
    seedAccepted(hoursFromNow(72));
    await transitionBooking({
      action: 'ADMIN_REASSIGN', bookingId: BOOKING, actorRole: 'admin', actorUid: 'admin-1',
      metadata: { providerUid: 'provider-b' },
    });

    // The old provider's row survives as history; TAB 05 depends on an
    // assignment row being terminal rather than mutated.
    //
    // DECLINED, not REASSIGNED, and deliberately: auto-assignment excludes
    // providers whose row on this booking says DECLINED, so the accurate word
    // would make the provider an admin just removed eligible to be assigned
    // straight back. The distinction lives in the transition row instead.
    const outgoing = store.assignments.find((a) => a.worker_uid === PROVIDER);
    expect(outgoing?.status).toBe('DECLINED');
    expect(store.booking?.worker_uid).toBe('provider-b');
    expect(store.transitions[0]).toMatchObject({ action: 'ADMIN_REASSIGN' });
  });

  it('the timeline records WHICH operation happened', async () => {
    // Both end at ASSIGNED. Only the action name distinguishes them, which is
    // why the executor takes an action rather than a destination state.
    seedUnassigned();
    await transitionBooking({
      action: 'ADMIN_ASSIGN', bookingId: BOOKING, actorRole: 'admin', actorUid: 'admin-1',
      metadata: { providerUid: 'provider-x' },
    });
    await transitionBooking({
      action: 'ADMIN_REASSIGN', bookingId: BOOKING, actorRole: 'admin', actorUid: 'admin-1',
      metadata: { providerUid: 'provider-y' },
    });

    expect(store.transitions.map((t) => t.action)).toEqual(['ADMIN_ASSIGN', 'ADMIN_REASSIGN']);
    expect(store.transitions.map((t) => t.to_state)).toEqual(['ASSIGNED', 'ASSIGNED']);
  });
});

/**
 * Roles 2 AND 4 are provider roles.
 *
 * A `role === 2` check is wrong and has been written that way more than once,
 * which is why `constants/providerRoles` exists. My first version of the
 * transitions handler derived the actor role from `role === 1` and would have
 * shown every role-4 provider an empty action list — no error, just a screen
 * with no buttons.
 *
 * This is a permanent regression on the CLASS, not on that one handler: no v1
 * handler may decide provider-ness from a role literal when a shared predicate
 * exists.
 */
describe('no v1 handler infers provider-ness from a role literal', () => {
  const V1 = path.resolve(__dirname, '../src/api/v1');

  const tsFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...tsFiles(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  };

  /** Comments stripped: a docblock explaining role 2 is not a role check. */
  const codeOf = (file: string): string =>
    fs.readFileSync(file, 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('finds v1 handler files at all (positive fixture)', () => {
    // A guard that scans an empty directory reports clean forever.
    expect(tsFiles(V1).length).toBeGreaterThan(5);
  });

  it('no comparison of a role field against a numeric literal', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(V1)) {
      const code = codeOf(file);
      // role === 2, role_id == 4, Number(user.role) === 2, and so on.
      const match = code.match(/\brole(_id)?\b\s*[!=]==?\s*['"]?\d/g);
      if (match) {
        offenders.push(`${path.basename(file)} — ${match.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the detector fires on the shape it forbids (positive fixture)', () => {
    const broken = "const actorRole = req.user?.role_id === 1 ? 'customer' : 'assigned_provider';";
    expect(/\brole(_id)?\b\s*[!=]==?\s*['"]?\d/.test(broken)).toBe(true);
  });

  it('the transitions handler uses the shared predicate', () => {
    const handler = codeOf(path.join(V1, 'domains/bookingActions.ts'));
    expect(handler).toContain('isProviderRole(');
  });
});

/**
 * ─── RAW bookings.status READS ARE ALLOW-LISTED ──────────────────────────────
 *
 * A guard reading `ctx.bookingStatus` is reading the raw column, not the
 * canonical state. Two do, both for the same narrow reason: the canonical
 * derivation does not faithfully represent the distinction they need.
 *
 * The risk is drift. If guards may casually consult the raw status, the
 * canonical machine slowly regains a second source of truth — which is the
 * condition this entire command existed to remove. So the list is closed, and
 * every entry carries the reason it cannot use the canonical state.
 */
describe('raw bookings.status reads are allow-listed', () => {
  const RAW_STATUS_READERS: Record<string, string> = {
    bookingAwaitsOtpConfirmation:
      'PAID-unconfirmed and CONFIRMED both derive to AWAITING_ASSIGNMENT, so the '
      + 'canonical state cannot say whether confirmation is still open.',
    customerCancellationStage:
      'AWAITING_COMPLETION and REVIEWED are not canonical states; deriving first '
      + 'maps them to AWAITING_ASSIGNMENT, from which cancelling IS permitted — '
      + 'which would newly allow cancelling them.',
  };

  const executor = fs.readFileSync(
    path.resolve(__dirname, '../src/services/booking/transitionExecutor.ts'), 'utf8',
  );

  /** The body of each guard, comments removed. */
  const guardBodies = (): Record<string, string> => {
    const stripped = executor
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const registry = stripped.slice(
      stripped.indexOf('export const BOOKING_GUARDS'),
      stripped.indexOf('export const BOOKING_ACTIONS'),
    );
    const out: Record<string, string> = {};
    const names = Object.keys(BOOKING_GUARDS);
    names.forEach((name, i) => {
      const start = registry.indexOf(`${name}:`);
      const nextStarts = names
        .map((n) => registry.indexOf(`${n}:`))
        .filter((idx) => idx > start);
      const end = nextStarts.length ? Math.min(...nextStarts) : registry.length;
      out[name] = registry.slice(start, end);
    });
    return out;
  };

  it('only allow-listed guards read the raw status', () => {
    const offenders = Object.entries(guardBodies())
      .filter(([name, body]) => /ctx\.bookingStatus/.test(body) && !(name in RAW_STATUS_READERS))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it('every allow-listed reader actually reads it (the list cannot rot)', () => {
    // An entry that no longer reads the raw status is a stale exemption, and a
    // stale exemption is how the next one gets waved through.
    const bodies = guardBodies();
    for (const name of Object.keys(RAW_STATUS_READERS)) {
      expect(bodies[name]).toBeDefined();
      expect(bodies[name]).toMatch(/ctx\.bookingStatus/);
    }
  });

  it('every entry states why the canonical state will not do', () => {
    for (const [, reason] of Object.entries(RAW_STATUS_READERS)) {
      expect(reason.length).toBeGreaterThan(60);
    }
  });

  it('the detector finds a raw read at all (positive fixture)', () => {
    // If the slicing broke, every guard would look clean forever.
    const bodies = guardBodies();
    const readers = Object.values(bodies).filter((b) => /ctx\.bookingStatus/.test(b));
    expect(readers.length).toBe(Object.keys(RAW_STATUS_READERS).length);
  });

  it('no guard derives canonical state for itself', () => {
    // Reading the raw column for a narrow, documented reason is one thing.
    // Deriving state inside a guard is a second machine.
    for (const [, body] of Object.entries(guardBodies())) {
      expect(body).not.toContain('deriveCanonicalState');
      expect(body).not.toContain('canTransition');
    }
  });
});

/**
 * ─── TWO LOCK CLASSES, ONE ACQUISITION ORDER ─────────────────────────────────
 *
 * D4 gave assignment a second lock. The booking row lock serialises actions on
 * ONE booking; it does nothing across two bookings that share a provider, so
 * two admins assigning the same provider to two overlapping bookings both pass
 * the ±2-hour conflict check and both commit. The provider-scoped advisory
 * lock is what makes that check mean anything.
 *
 * Once two lock classes exist, inconsistent acquisition order is a deadlock
 * vector. Legacy took them provider-then-booking; the executor takes them
 * booking-then-provider. One order is chosen and enforced here, because
 * "both locks are present" is not the property that matters.
 */
describe('lock acquisition order is fixed', () => {
  /**
   * Comment-stripped. The docblock beside the lock explains the mechanism and
   * names `pg_advisory_xact_lock` in prose, which would otherwise be counted
   * as a second call site and would sit at the wrong offset for an ordering
   * comparison.
   */
  const executor = fs.readFileSync(
    path.resolve(__dirname, '../src/services/booking/transitionExecutor.ts'), 'utf8',
  )
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

  it('the booking row lock is taken BEFORE the provider advisory lock', () => {
    const bookingLock = executor.indexOf('await loadForUpdate(client, input.bookingId');
    const advisory = executor.indexOf('pg_advisory_xact_lock');

    expect(bookingLock).toBeGreaterThan(-1);
    expect(advisory).toBeGreaterThan(-1);
    expect(bookingLock).toBeLessThan(advisory);
  });

  it('there is exactly ONE place that takes the advisory lock', () => {
    // Two call sites is two chances to get the order wrong.
    const sites = executor.split('\n').filter((l) => l.includes('pg_advisory_xact_lock'));
    expect(sites).toHaveLength(1);
  });

  it('the advisory lock happens inside the transaction it protects', () => {
    // `pg_advisory_xact_lock` releases at COMMIT. Taken outside the executor's
    // transaction it would protect nothing that the executor writes — which is
    // precisely why the conflict check had to move in with it.
    const begin = executor.indexOf("client.query('BEGIN')");
    const advisory = executor.indexOf('pg_advisory_xact_lock');
    const commit = executor.lastIndexOf("client.query('COMMIT')");
    expect(begin).toBeLessThan(advisory);
    expect(advisory).toBeLessThan(commit);
  });

  it('the conflict check runs AFTER the advisory lock, never before', () => {
    // Checking first and locking second is the race with extra steps.
    //
    // Asserted on the CALL GRAPH, not on file position: the validator is
    // *defined* above `transitionBooking` and *called* from inside
    // `applyState`, so comparing offsets would compare the wrong thing and
    // fail a correct implementation.
    const advisory = executor.indexOf('pg_advisory_xact_lock');
    const applyCall = executor.indexOf('await applyState(client, loaded, toState, input)');
    expect(advisory).toBeGreaterThan(-1);
    expect(advisory).toBeLessThan(applyCall);

    // And the conflict check is reachable only from inside applyState.
    const callSites = executor.split('\n').filter((l) => l.includes('assertAssignableProvider('));
    expect(callSites).toHaveLength(2); // one declaration, one call
    const call = callSites.find((l) => !l.includes('async function'))!;
    expect(call).toContain('await assertAssignableProvider(client, loaded.id, nextProvider)');

    const applyState = executor.slice(executor.indexOf('async function applyState'));
    const assignBranch = applyState.slice(
      applyState.indexOf("case 'ASSIGNED': {"),
      applyState.indexOf("case 'ACCEPTED': {"),
    );
    expect(assignBranch).toContain('assertAssignableProvider(');
  });

  it('the lock key is derived server-side, never taken from the request', () => {
    // `advisoryLock` names a REQUIREMENT; the executor decides what it locks.
    // An `advisoryLockKey?: string` would let a caller name any lock it liked.
    expect(executor).toContain("`servana-provider-assignment:${target}`");
    expect(executor).not.toMatch(/advisoryLockKey/);
    expect(executor).toContain("export type AdvisoryLockRequirement = 'PROVIDER_ASSIGNMENT';");
  });

  it('only the assignment actions require it', () => {
    const declared = Object.entries(BOOKING_ACTIONS)
      .filter(([, spec]) => (spec as { advisoryLock?: unknown }).advisoryLock)
      .map(([name]) => name)
      .sort();
    expect(declared).toEqual(['ADMIN_ASSIGN', 'ADMIN_REASSIGN']);
  });

  it('no legacy path still takes the locks the other way round', () => {
    // The deadlock this prevents needs TWO paths. There is now one.
    const admin = fs.readFileSync(
      path.resolve(__dirname, '../src/services/adminBookingService.ts'), 'utf8',
    );
    const assignFn = admin.slice(
      admin.indexOf('export const adminAssignProvider'),
      admin.indexOf('export const adminReassignProvider'),
    );
    expect(assignFn).not.toContain('pg_advisory_xact_lock');
  });
});

/**
 * ─── PROVIDER ROLE LITERALS ARE FORBIDDEN IN CANONICAL ASSIGNMENT CODE ───────
 *
 * Roles 2 AND 4 are providers. `adminAssignProvider` asked `role::int = 2`, so
 * an admin could not assign a role-4 provider and was told "Provider not
 * found" — while the SAME FILE used `IN (2, 4)` a few functions earlier.
 *
 * The v1 handler detector already covers this class for `src/api/v1`. This
 * extends it to the canonical assignment writer, which is where getting it
 * wrong denies a real provider real work.
 */
describe('canonical assignment code uses the provider-role helper', () => {
  const codeOnly = (rel: string): string =>
    fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('the executor writes no role literal', () => {
    const executor = codeOnly('src/services/booking/transitionExecutor.ts');
    expect(executor).not.toMatch(/role::int\s*=\s*\d/);
    expect(executor).not.toMatch(/role::int\s+IN\s*\(/);
    expect(executor).toContain("providerRoleSqlPredicate('role')");
  });

  it('the helper is derived from the canonical set, not retyped', () => {
    const roles = codeOnly('src/constants/providerRoles.ts');
    expect(roles).toContain('providerRoleSqlList');
    // Built by mapping PROVIDER_ROLES — not a hand-written '2, 4'.
    expect(roles).toContain('[...PROVIDER_ROLES]');
    expect(roles).not.toMatch(/return\s*['"]2,\s*4['"]/);
  });

  it('it refuses to inline a non-numeric role', () => {
    // The values are interpolated into SQL. They come from this module, but a
    // future non-numeric member must fail loudly rather than become an
    // injection point.
    const roles = codeOnly('src/constants/providerRoles.ts');
    expect(roles).toContain('Number.isInteger(n)');
    expect(roles).toContain('Non-numeric provider role cannot be inlined into SQL');
  });

  it('the detector fires on the shape it forbids (positive fixture)', () => {
    expect(/role::int\s*=\s*\d/.test("WHERE uid = $1 AND role::int = 2")).toBe(true);
  });
});
