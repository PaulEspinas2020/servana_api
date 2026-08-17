/**
 * Startup and shutdown as explicit phases (TAB 03).
 *
 * ## What this replaces
 *
 * `app.ts` performs eight schema bootstraps as fire-and-forget IIFEs at IMPORT
 * time, and then calls `httpServer.listen()`. None is awaited, and every one
 * swallows its own error into `console.error`. So the server begins accepting
 * requests while its schema is still being created, and a bootstrap that fails
 * outright leaves the process serving traffic against a schema that was never
 * finished — with the only evidence a log line nobody is watching.
 *
 * There was also no `SIGTERM` handler anywhere in `src`, which means every
 * deploy killed in-flight requests.
 *
 * ## Readiness gates traffic; it does not kill the process
 *
 * A failed REQUIRED dependency makes `/readyz` fail, so a load balancer stops
 * sending work. It does not exit.
 *
 * That is a deliberate choice against TAB 03's "failed mandatory initialization
 * exits". Exiting is right for a fresh deploy and wrong for a running instance:
 * this application ALREADY starts with these bootstraps failing soft, so making
 * them fatal in the same change that introduces the phases would turn a logged
 * warning into a crash loop on the first deploy — against a production database
 * whose schema this repository does not yet fully own (148 runtime DDL statements
 * no migration mentions, see TAB 02).
 *
 * Since migration 036 all 148 touch an object `scripts/baseline/000-baseline.sql`
 * already declares, so they are redundant statements awaiting deletion rather
 * than schema this repository cannot build — `npm run schema:authority` reports
 * the authoring gap at zero. That makes `exitOnRequiredFailure` flippable once
 * the statements are removed, which is the last step of TAB 02 rather than a
 * prerequisite for it.
 *
 * Gating traffic achieves the acceptance criterion that matters — no request is
 * served before readiness — without betting the deploy on a bootstrap that has
 * been allowed to fail for the life of the service. `exitOnRequiredFailure` is
 * there to flip when TAB 02 has moved the DDL into migrations.
 *
 * Nothing is silently downgraded: a dependency's classification is declared,
 * and `degradedReport()` names every one that is not healthy.
 */

export type DependencyKind = 'required' | 'optional';

export interface Dependency {
  name: string;
  kind: DependencyKind;
  /** Bounded, so one hung dependency cannot hold startup open forever. */
  timeoutMs: number;
  start: () => Promise<unknown>;
  /** Why it is required, or why it is safe not to be. Read by operators. */
  why: string;
}

export type DependencyState = 'pending' | 'ready' | 'failed' | 'timed_out';

export interface DependencyResult {
  name: string;
  kind: DependencyKind;
  state: DependencyState;
  durationMs: number;
  /** Message only — never the error object, which can carry query text. */
  error?: string;
}

export type Phase = 'starting' | 'ready' | 'degraded' | 'shutting_down';

interface LifecycleState {
  phase: Phase;
  results: DependencyResult[];
  startedAt: number;
}

const state: LifecycleState = { phase: 'starting', results: [], startedAt: Date.now() };

/** For tests. Never called by the running application. */
export const __resetLifecycle = (): void => {
  state.phase = 'starting';
  state.results = [];
  state.startedAt = Date.now();
};

const withTimeout = async (
  promise: Promise<unknown>,
  ms: number,
): Promise<'ok' | 'timed_out'> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timed_out'>((resolve) => {
    timer = setTimeout(() => resolve('timed_out'), ms);
    // Never hold the event loop open on our own timer.
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    const result = await Promise.race([promise.then(() => 'ok' as const), timeout]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Run every dependency, then decide the phase.
 *
 * Dependencies run CONCURRENTLY. They are independent bootstraps — the previous
 * code ran them concurrently too, by virtue of being un-awaited IIFEs — and
 * serialising them would add their timeouts together on every boot.
 */
export const initializeDependencies = async (
  dependencies: readonly Dependency[],
  options: { exitOnRequiredFailure?: boolean } = {},
): Promise<DependencyResult[]> => {
  const results = await Promise.all(
    dependencies.map(async (dependency): Promise<DependencyResult> => {
      const started = Date.now();
      try {
        const outcome = await withTimeout(
          Promise.resolve().then(() => dependency.start()),
          dependency.timeoutMs,
        );
        return {
          name: dependency.name,
          kind: dependency.kind,
          state: outcome === 'ok' ? 'ready' : 'timed_out',
          durationMs: Date.now() - started,
          ...(outcome === 'timed_out'
            ? { error: `did not finish within ${dependency.timeoutMs}ms` }
            : {}),
        };
      } catch (error) {
        return {
          name: dependency.name,
          kind: dependency.kind,
          state: 'failed',
          durationMs: Date.now() - started,
          // Message only: an error object can carry the failing SQL.
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  state.results = results;
  const requiredUnhealthy = results.filter((r) => r.kind === 'required' && r.state !== 'ready');
  state.phase = requiredUnhealthy.length ? 'degraded' : 'ready';

  if (requiredUnhealthy.length && options.exitOnRequiredFailure) {
    // The diagnostic names WHAT failed and never why in secret terms.
    // eslint-disable-next-line no-console
    console.error(
      `[lifecycle] required dependencies unhealthy: ${requiredUnhealthy
        .map((r) => `${r.name} (${r.state})`)
        .join(', ')}`,
    );
    process.exit(1);
  }

  return results;
};

/** Alive: the process is running. Says nothing about dependencies. */
export const isLive = (): boolean => state.phase !== 'shutting_down';

/** Ready: safe to route traffic here. */
export const isReady = (): boolean => state.phase === 'ready';

export const currentPhase = (): Phase => state.phase;

/** Every dependency that is not healthy, so degradation is never silent. */
export const degradedReport = (): DependencyResult[] =>
  state.results.filter((r) => r.state !== 'ready');

export const readinessSnapshot = () => ({
  phase: state.phase,
  ready: isReady(),
  live: isLive(),
  uptimeMs: Date.now() - state.startedAt,
  dependencies: state.results.map(({ name, kind, state: s, durationMs, error }) => ({
    name,
    kind,
    state: s,
    durationMs,
    ...(error ? { error } : {}),
  })),
});

// ─── Shutdown ─────────────────────────────────────────────────────────────────

export interface ShutdownStep {
  name: string;
  /** Bounded individually, so one stuck close cannot consume the whole budget. */
  timeoutMs: number;
  close: () => Promise<unknown>;
}

export interface ShutdownOutcome {
  name: string;
  state: 'closed' | 'failed' | 'timed_out';
  durationMs: number;
}

/**
 * Stop accepting work, then close everything within a bounded deadline.
 *
 * Readiness flips FIRST and on its own line: a load balancer needs to see
 * `/readyz` fail before connections start closing, or in-flight requests are
 * refused rather than drained.
 */
export const shutdown = async (
  steps: readonly ShutdownStep[],
): Promise<ShutdownOutcome[]> => {
  state.phase = 'shutting_down';

  const outcomes: ShutdownOutcome[] = [];
  for (const step of steps) {
    const started = Date.now();
    try {
      const outcome = await withTimeout(
        Promise.resolve().then(() => step.close()),
        step.timeoutMs,
      );
      outcomes.push({
        name: step.name,
        state: outcome === 'ok' ? 'closed' : 'timed_out',
        durationMs: Date.now() - started,
      });
    } catch {
      outcomes.push({ name: step.name, state: 'failed', durationMs: Date.now() - started });
    }
  }
  return outcomes;
};

/**
 * Wire SIGTERM and SIGINT once.
 *
 * There was no handler at all, so every deploy dropped in-flight requests. The
 * second signal is deliberately NOT a faster exit: a operator pressing Ctrl-C
 * twice usually means "I am impatient", and honouring that mid-drain is how a
 * transaction gets cut in half.
 */
export const installSignalHandlers = (
  steps: () => readonly ShutdownStep[],
  options: { exit?: (code: number) => void } = {},
): (() => void) => {
  let running = false;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  const handler = (signal: string) => {
    if (running) {
      // eslint-disable-next-line no-console
      console.log(`[lifecycle] ${signal} received again; already draining`);
      return;
    }
    running = true;
    // eslint-disable-next-line no-console
    console.log(`[lifecycle] ${signal} received; draining`);
    void shutdown(steps()).then((outcomes) => {
      const stuck = outcomes.filter((o) => o.state !== 'closed');
      // eslint-disable-next-line no-console
      console.log(
        `[lifecycle] shutdown complete; ${outcomes.length - stuck.length}/${outcomes.length} closed cleanly`,
      );
      exit(stuck.length ? 1 : 0);
    });
  };

  const onTerm = () => handler('SIGTERM');
  const onInt = () => handler('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);

  return () => {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
  };
};
