/**
 * The v1 route-composition layer.
 *
 * One place registers every canonical route, and it registers them FROM the
 * contract. Domain logic stays in `domains/*` — this file has no business
 * knowledge and must never grow any. It is a composition root, not a
 * controller.
 *
 * ## What it guarantees, at import time, before the server listens
 *
 *   1. Every `status: 'implemented'` contract entry has a handler.
 *   2. Every handler has a contract entry.
 *   3. No `status: 'planned'` entry has a handler (a planned route that
 *      quietly works is a documented lie in the other direction).
 *   4. No two entries share a method + path.
 *   5. Auth middleware is derived from the contract's `auth` field, so an
 *      endpoint cannot be documented as authenticated and mounted as public.
 *
 * Each of those is a `throw` and not a warning. A half-wired endpoint that 404s
 * in production is strictly worse than a process that refuses to start and
 * names the id it could not wire — this is the same reasoning
 * `assertContinueUrlsAreUsable()` applies to Firebase URLs in app.ts.
 *
 * ## Route ordering
 *
 * Entries are sorted so that a literal segment always beats a parameter at the
 * same position. `/notifications/unread-count` must be registered before
 * `/notifications/:key/read` or Express binds "unread-count" as a key — the
 * exact trap the legacy notification router had to hand-order around, and the
 * one that made GET /api/catalog unreachable at the app level. Here it is a
 * property of the composition layer rather than a comment asking the next
 * person to be careful.
 */

import { Request, Response, Router, RequestHandler } from 'express';
import verifyAuth from '../../middleware/verifyAuth';
import verifyRoles from '../../middleware/verifyRoles';
import requireProviderRole from '../../middleware/requireProviderRole';
import { ContractEntry, IMPLEMENTED, V1_CONTRACT, HttpMethod } from './contract';
import { fail } from './envelope';
import { V1Handler, V1Handlers } from './types';

export type { V1Handler, V1Handlers } from './types';

/**
 * Wraps a handler so a rejected promise cannot become an unhandled rejection.
 *
 * Express 5 forwards async rejections to the error handler, but this backend
 * has no central error handler — an unhandled rejection there would hang the
 * request until the client times out. Every v1 handler already has its own
 * try/catch; this is the backstop for the case somebody forgets one.
 */
const guard = (id: string, handler: V1Handler): RequestHandler =>
  (req, res, next) => {
    try {
      const result = handler(req, res);
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        (result as Promise<unknown>).catch((error: unknown) => {
          if (res.headersSent) return next(error);
          // eslint-disable-next-line no-console
          console.error(`[v1] unhandled rejection in ${id}:`, error);
          fail(res, req, 'INTERNAL');
        });
      }
    } catch (error) {
      if (res.headersSent) return next(error);
      // eslint-disable-next-line no-console
      console.error(`[v1] unhandled throw in ${id}:`, error);
      fail(res, req, 'INTERNAL');
    }
  };

/** Auth chain for each declared mode. The contract's `auth` field picks one. */
const authChain = (entry: ContractEntry): RequestHandler[] => {
  switch (entry.auth) {
    case 'public':
      return [];
    case 'authenticated':
      return [verifyAuth];
    case 'provider':
      return [verifyAuth, requireProviderRole as RequestHandler];
    case 'admin':
      return [verifyAuth, verifyRoles([1]) as RequestHandler];
    default: {
      // Exhaustiveness: a new AuthMode must be handled here or the build fails.
      const unreachable: never = entry.auth;
      throw new Error(`v1: unhandled auth mode ${String(unreachable)}`);
    }
  }
};

/**
 * Specificity sort: fewer parameters earlier, and at equal depth a literal
 * segment before a parameter segment. Deterministic — equal keys fall back to
 * the path string so registration order never depends on array order.
 */
const specificityKey = (path: string): string =>
  path
    .split('/')
    .filter(Boolean)
    .map((segment) => (segment.startsWith(':') ? '1' : '0'))
    .join('');

const bySpecificity = (a: ContractEntry, b: ContractEntry): number => {
  const ka = specificityKey(a.path);
  const kb = specificityKey(b.path);
  if (ka !== kb) return ka < kb ? -1 : 1;
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.method < b.method ? -1 : 1;
};

export interface BuildResult {
  router: Router;
  /** Exactly what was mounted, for the route-existence test to assert against. */
  mounted: Array<{ id: string; method: HttpMethod; path: string }>;
}

/**
 * Extra middleware for specific endpoints, keyed by contract id.
 *
 * Runs AFTER the auth chain and before the handler. This is where rate limiters
 * live: they are per-endpoint policy rather than a property of the contract's
 * auth mode, and putting them on the contract would mean either a `rateLimit`
 * field the OpenAPI generator has to ignore, or a limiter instance in a data
 * file. A key that names no implemented entry is a throw, not a silent no-op —
 * a rate limiter that is configured and not mounted is worse than none, because
 * it reads as protection.
 */
export type V1Middleware = Record<string, RequestHandler[]>;

export function buildV1Router(handlers: V1Handlers, middleware: V1Middleware = {}): BuildResult {
  const handlerIds = new Set(Object.keys(handlers));
  const implementedIds = new Set(IMPLEMENTED.map((e) => e.id));

  const missing = [...implementedIds].filter((id) => !handlerIds.has(id));
  if (missing.length) {
    throw new Error(
      `v1 contract: ${missing.length} implemented entr${missing.length === 1 ? 'y has' : 'ies have'} no handler — ${missing.join(', ')}`,
    );
  }

  const orphaned = [...handlerIds].filter((id) => !implementedIds.has(id));
  if (orphaned.length) {
    const planned = orphaned.filter((id) => V1_CONTRACT.some((e) => e.id === id));
    const unknown = orphaned.filter((id) => !planned.includes(id));
    if (planned.length) {
      throw new Error(
        `v1 contract: handler(s) supplied for PLANNED entr${planned.length === 1 ? 'y' : 'ies'} — ${planned.join(', ')}. Flip the entry to 'implemented' or drop the handler.`,
      );
    }
    throw new Error(`v1 contract: handler(s) with no contract entry — ${unknown.join(', ')}`);
  }

  const seen = new Set<string>();
  for (const entry of V1_CONTRACT) {
    const key = `${entry.method} ${entry.path}`;
    if (seen.has(key)) {
      throw new Error(`v1 contract: duplicate route ${key}`);
    }
    seen.add(key);
  }

  const strayMiddleware = Object.keys(middleware).filter((id) => !implementedIds.has(id));
  if (strayMiddleware.length) {
    throw new Error(
      `v1 contract: middleware declared for non-implemented entr${strayMiddleware.length === 1 ? 'y' : 'ies'} — ${strayMiddleware.join(', ')}`,
    );
  }

  const router = Router();
  const mounted: BuildResult['mounted'] = [];

  for (const entry of [...IMPLEMENTED].sort(bySpecificity)) {
    router[entry.method](
      entry.path,
      ...authChain(entry),
      ...(middleware[entry.id] ?? []),
      guard(entry.id, handlers[entry.id]),
    );
    mounted.push({ id: entry.id, method: entry.method, path: entry.path });
  }

  /**
   * A real 404 for anything else under /api/v1.
   *
   * The legacy tree cannot do this — `GET /api/:id` means an unknown
   * single-segment path is a booking lookup, so the API answers 401 or 400 for
   * paths that do not exist. Under v1 an unknown path says so, in the v1 error
   * shape, which is what makes route-existence checkable from the outside
   * instead of requiring router introspection.
   */
  router.use((req: Request, res: Response) =>
    fail(res, req, 'NOT_FOUND', `No v1 endpoint for ${req.method} ${req.baseUrl}${req.path}`),
  );

  return { router, mounted };
}

/** The composed handler map. Domain modules own the logic; this owns nothing. */
import { handlers as catalogHandlers } from './domains/catalog';
import { handlers as identityHandlers } from './domains/identity';
import { handlers as bookingHandlers } from './domains/bookings';
import { handlers as providerJobHandlers } from './domains/providerJobs';
import { handlers as notificationHandlers } from './domains/notifications';
import { handlers as reviewHandlers } from './domains/reviews';
import { handlers as settingsHandlers } from './domains/settings';
import { handlers as authHandlers } from './domains/auth';
import { handlers as bookingActionHandlers } from './domains/bookingActions';
import {
  perAccountLoginLimiter,
  perIpLoginLimiter,
  perAccountRegisterLimiter,
  perAccountOtpLimiter,
  perAccountRecoveryLimiter,
} from '../../middleware/credentialLimiter';

export const V1_HANDLERS: V1Handlers = {
  ...catalogHandlers,
  ...identityHandlers,
  ...bookingHandlers,
  ...providerJobHandlers,
  ...notificationHandlers,
  ...reviewHandlers,
  ...settingsHandlers,
  ...authHandlers,
  ...bookingActionHandlers,
};

/**
 * Rate limits, per endpoint.
 *
 * Credential endpoints carry TWO limiters. Keyed on the identifier alone, an
 * attacker spraying one password across thousands of accounts from one host
 * gets a fresh budget per account and is never slowed; keyed on IP alone, one
 * carrier NAT locks out a city. Both must pass. See `middleware/credentialLimiter`.
 */
export const V1_MIDDLEWARE: V1Middleware = {
  'auth.login': [perAccountLoginLimiter, perIpLoginLimiter],
  'auth.register': [perAccountRegisterLimiter, perIpLoginLimiter],
  'auth.refresh': [perIpLoginLimiter],
  'auth.verifyEmail': [perAccountOtpLimiter, perIpLoginLimiter],
  'auth.verifyMobile': [perIpLoginLimiter],
  'auth.forgotPassword': [perAccountRecoveryLimiter, perIpLoginLimiter],
  'auth.resetPassword': [perAccountRecoveryLimiter, perIpLoginLimiter],
  'auth.resendVerification': [perAccountRecoveryLimiter, perIpLoginLimiter],
};

const built = buildV1Router(V1_HANDLERS, V1_MIDDLEWARE);

export const v1Router = built.router;
export const V1_MOUNTED = built.mounted;
export default v1Router;
