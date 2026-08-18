/**
 * An in-process HTTP server for suites that exercise a real router over a real
 * socket, without the keep-alive race that made one of them flake.
 *
 * ## The race
 *
 * `http.Server` closes an idle keep-alive connection after
 * `keepAliveTimeout`, which defaults to **5 seconds**. Node's `fetch` (undici)
 * pools connections and reuses them. Under a saturated full-suite run the gap
 * between two requests in the same suite can exceed five seconds, and if the
 * server's timer fires at the moment undici dispatches on that socket, the
 * request rejects — `ECONNRESET` / socket hang up — *before any assertion
 * runs*.
 *
 * That is exactly the shape of the enumeration-uniformity flake in
 * `v1-auth-security.test.ts`: only ever under load, never reproducible in
 * isolation, and — the detail that identified it — **no Expected/Received diff
 * on either occurrence**, while other failures in the same runs printed theirs
 * normally. An assertion mismatch always prints a diff. A thrown error does
 * not.
 *
 * ## The fix, and what it is not
 *
 * Two independent measures, because one alone leaves a window:
 *
 *   1. the server's keep-alive timeout is raised well past any plausible
 *      inter-request gap, so the timer cannot fire mid-suite;
 *   2. every request asks for `Connection: close`, so there is no pooled
 *      socket to race over in the first place.
 *
 * This changes ONLY the test harness. No production limiter threshold, timeout
 * or assertion is relaxed — a security test that was made to stop failing by
 * weakening it is an oracle with a green tick next to it.
 *
 * ## It also preserves evidence
 *
 * `request()` catches transport failures and rethrows them naming the method,
 * the path and the underlying cause. If anything of this shape recurs, the
 * next run says what happened instead of leaving a bare rejection.
 */

import http from 'http';
import type { AddressInfo } from 'net';
import type { Express } from 'express';

export interface TestServer {
  base: string;
  server: http.Server;
  close: () => Promise<void>;
}

/** Comfortably longer than any inter-request gap a loaded suite can produce. */
const KEEP_ALIVE_MS = 120_000;

export async function startTestServer(app: Express): Promise<TestServer> {
  const server = http.createServer(app);
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  // Must exceed keepAliveTimeout or Node closes the socket while headers are
  // still arriving, which is the same failure wearing a different name.
  server.headersTimeout = KEEP_ALIVE_MS + 10_000;

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    server,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface TestResponse {
  status: number;
  raw: string;
  body: any;
  headers: Headers;
  /** Rate-limit headers, so a 429 explains itself rather than being inferred. */
  limits: { limit: string | null; remaining: string | null; retryAfter: string | null };
}

/**
 * One request, on a fresh connection, with transport failures named.
 */
export async function request(
  base: string,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<TestResponse> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        // No pooled socket, so no keep-alive race to lose.
        connection: 'close',
        ...(options.headers ?? {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (cause) {
    throw new Error(
      `TRANSPORT FAILURE on ${method} ${path} — this is a harness fault, not an `
      + `assertion. Cause: ${(cause as Error)?.message ?? String(cause)}`,
      { cause },
    );
  }

  const raw = await res.text();
  return {
    status: res.status,
    raw,
    body: raw ? JSON.parse(raw) : null,
    headers: res.headers,
    limits: {
      limit: res.headers.get('ratelimit-limit'),
      remaining: res.headers.get('ratelimit-remaining'),
      retryAfter: res.headers.get('retry-after'),
    },
  };
}
