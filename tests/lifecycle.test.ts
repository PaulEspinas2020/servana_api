/**
 * Startup and shutdown phases (TAB 03).
 *
 * Every failure class TAB 03 names is exercised here, because the whole point
 * of the module is what happens when something goes wrong — and none of those
 * paths runs in a healthy boot.
 */

import {
  initializeDependencies,
  installSignalHandlers,
  isLive,
  isReady,
  currentPhase,
  degradedReport,
  readinessSnapshot,
  shutdown,
  __resetLifecycle,
  type Dependency,
} from '../src/lifecycle';

const dep = (over: Partial<Dependency> & Pick<Dependency, 'name'>): Dependency => ({
  kind: 'optional',
  timeoutMs: 500,
  start: async () => undefined,
  why: 'test fixture',
  ...over,
});

beforeEach(() => __resetLifecycle());

describe('readiness gates traffic', () => {
  it('is not ready before dependencies have run', () => {
    expect(currentPhase()).toBe('starting');
    expect(isReady()).toBe(false);
    // Liveness is separate: the process is up even though it is not ready.
    expect(isLive()).toBe(true);
  });

  it('becomes ready when every required dependency succeeds', async () => {
    await initializeDependencies([
      dep({ name: 'schema', kind: 'required' }),
      dep({ name: 'cache', kind: 'optional' }),
    ]);
    expect(isReady()).toBe(true);
    expect(degradedReport()).toEqual([]);
  });

  it('a failed REQUIRED dependency withholds readiness', async () => {
    await initializeDependencies([
      dep({
        name: 'primary-database',
        kind: 'required',
        start: async () => { throw new Error('connection refused'); },
      }),
    ]);
    expect(isReady()).toBe(false);
    expect(currentPhase()).toBe('degraded');
    // Still LIVE — the process should not be killed and restarted in a loop.
    expect(isLive()).toBe(true);
  });

  it('a failed OPTIONAL dependency does not withhold readiness, but is reported', async () => {
    await initializeDependencies([
      dep({ name: 'schema', kind: 'required' }),
      dep({
        name: 'analytics',
        kind: 'optional',
        start: async () => { throw new Error('vendor down'); },
      }),
    ]);
    expect(isReady()).toBe(true);
    // Degraded, and NOT hidden — TAB 03: "mark optional integrations degraded
    // without hiding them".
    expect(degradedReport().map((d) => d.name)).toEqual(['analytics']);
  });

  it('bounds a hung dependency instead of holding startup open', async () => {
    const results = await initializeDependencies([
      dep({
        name: 'stuck',
        kind: 'required',
        timeoutMs: 20,
        start: () => new Promise(() => undefined),
      }),
    ]);
    expect(results[0].state).toBe('timed_out');
    expect(isReady()).toBe(false);
  });

  it('never puts an error object in the snapshot — message only', async () => {
    /**
     * An error from a failed bootstrap can carry the failing SQL, and the
     * readiness endpoint is the one place an operator points a browser at.
     */
    await initializeDependencies([
      dep({
        name: 'schema',
        kind: 'required',
        start: async () => { throw new Error('relation "servana.secret" does not exist'); },
      }),
    ]);
    const snapshot = readinessSnapshot();
    expect(typeof snapshot.dependencies[0].error).toBe('string');
    expect(JSON.stringify(snapshot)).not.toContain('stack');
  });
});

describe('shutdown', () => {
  it('stops readiness FIRST, so traffic drains before sockets close', async () => {
    await initializeDependencies([dep({ name: 'schema', kind: 'required' })]);
    expect(isReady()).toBe(true);

    const order: string[] = [];
    await shutdown([
      {
        name: 'http',
        timeoutMs: 100,
        close: async () => { order.push(`ready=${isReady()}`); },
      },
    ]);

    // The first close already saw readiness false.
    expect(order).toEqual(['ready=false']);
    expect(isLive()).toBe(false);
  });

  it('bounds a stuck close rather than hanging the deploy', async () => {
    const outcomes = await shutdown([
      { name: 'stuck-pool', timeoutMs: 20, close: () => new Promise(() => undefined) },
      { name: 'fast', timeoutMs: 100, close: async () => undefined },
    ]);
    expect(outcomes[0].state).toBe('timed_out');
    // The stuck step does not prevent the rest from closing.
    expect(outcomes[1].state).toBe('closed');
  });

  it('a throwing close is recorded, not swallowed into success', async () => {
    const outcomes = await shutdown([
      { name: 'bad', timeoutMs: 50, close: async () => { throw new Error('nope'); } },
    ]);
    expect(outcomes[0].state).toBe('failed');
  });
});

describe('signal handling', () => {
  it('drains once on SIGTERM and ignores a repeat', async () => {
    /**
     * A second Ctrl-C usually means impatience. Honouring it mid-drain is how a
     * transaction gets cut in half, so the repeat is logged and ignored.
     */
    const closed: string[] = [];
    const exits: number[] = [];
    const uninstall = installSignalHandlers(
      () => [{ name: 'http', timeoutMs: 50, close: async () => { closed.push('http'); } }],
      { exit: (code) => exits.push(code) },
    );

    try {
      process.emit('SIGTERM' as NodeJS.Signals);
      process.emit('SIGTERM' as NodeJS.Signals);
      await new Promise((r) => setTimeout(r, 60));
      expect(closed).toEqual(['http']);
      expect(exits).toEqual([0]);
    } finally {
      uninstall();
    }
  });

  it('exits non-zero when something did not close cleanly', async () => {
    const exits: number[] = [];
    const uninstall = installSignalHandlers(
      () => [{ name: 'stuck', timeoutMs: 10, close: () => new Promise(() => undefined) }],
      { exit: (code) => exits.push(code) },
    );
    try {
      process.emit('SIGTERM' as NodeJS.Signals);
      await new Promise((r) => setTimeout(r, 60));
      expect(exits).toEqual([1]);
    } finally {
      uninstall();
    }
  });
});
