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

import { Request, Response, Router, RequestHandler, NextFunction } from 'express';
import verifyAuth from '../../middleware/verifyAuth';
import verifyRoles from '../../middleware/verifyRoles';
import requireProviderRole from '../../middleware/requireProviderRole';
import requireCapability from '../../middleware/requireCapability';
import requireActiveProvider from '../../middleware/requireActiveProvider';
import { ContractEntry, IMPLEMENTED, V1_CONTRACT, HttpMethod } from './contract';
import { fail } from './envelope';
import { V1ErrorCode } from './errors';
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

/**
 * Auth chain for each declared mode. The contract's `auth` field picks one.
 *
 * Exported so `tests/authz-matrix-behaviour.test.ts` can EXECUTE the real chain
 * rather than assert against a copy of it. `ROLE_ACCESS` in `authzMatrix.ts`
 * claimed to be "derived from register.ts's authChain, and asserted against it";
 * it was not. The only checks were a source-text regex and a presence check, so
 * changing `verifyRoles([1])` to `verifyRoles([1, 4])` would have left the
 * published security matrix saying `provider: deny` with nothing failing.
 */
/**
 * The v1 envelope, applied to the auth chain's failures (TAB 02 mandate 3).
 *
 * ## The measured defect
 *
 * `envelope.ts` declares every v1 failure as
 * `{ error: { code, message, requestId } }`. The auth chain below is built from
 * the LEGACY middlewares — deliberately, because they are the one definition of
 * how a Servana token is verified and a second one would eventually disagree
 * with them. But they answer in the legacy shape,
 * `{ status: 'failed', code: 'UNAUTHENTICATED' }`, with no `requestId`.
 *
 * Smoked against production on 2026-08-18: **85 of 85** non-public v1 endpoints
 * answered a tokenless request in the legacy envelope. Not some — all of them.
 * So the v1 router violated its own published contract on every authenticated
 * route, and `routeHealth.ts`'s own definition of a well-formed v1 error
 * (`code` and `requestId` both strings) was unsatisfiable for a 401.
 *
 * ## Why this matters beyond tidiness
 *
 * The provider portal classifies failures on `error.code`. With the legacy
 * shape there is no `error` object, so every 401 reads to the client as "no v1
 * error code present" — the exact ambiguous case TAB 03 must distinguish from a
 * genuinely expired session. Fixing the client without fixing this would have
 * the client looking for a field the server never sends.
 *
 * ## Why a translator rather than a v1 auth middleware
 *
 * Re-implementing verification for v1 would create a second answer to "is this
 * token good", and the two would drift. This wraps the real chain and rewrites
 * only the failure body, so the decision stays in one place and the legacy tree
 * — 520 routes and five clients — is untouched. Additive, per the standing rule.
 */
const LEGACY_TO_V1_CODE: Record<string, V1ErrorCode> = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_REVOKED: 'TOKEN_REVOKED',
  // Emitted by verifyAuth but absent from V1_ERROR_STATUS. TAB 03 names
  // INVALID_TOKEN as a code the portal acts on, so the original is preserved in
  // `details.reason` rather than discarded — adding it to the vocabulary is a
  // contract change and belongs to TAB 04, not here.
  INVALID_TOKEN: 'UNAUTHENTICATED',
  FORBIDDEN_ROLE: 'ROLE_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  // Provider account-state denials from `requireCapability`. Mapped one-to-one,
  // never collapsed onto FORBIDDEN: `denialFor` picks between them precisely
  // because a suspended provider and an unapproved one need different screens,
  // and flattening here would discard that at the last step.
  PROVIDER_NOT_APPROVED: 'PROVIDER_NOT_APPROVED',
  PROVIDER_SUSPENDED: 'PROVIDER_SUSPENDED',
  PROVIDER_REJECTED: 'PROVIDER_REJECTED',
  PROVIDER_DISABLED: 'PROVIDER_DISABLED',
  ROLE_NOT_PERMITTED: 'ROLE_REQUIRED',
};

export const v1AuthEnvelope = (inner: RequestHandler): RequestHandler =>
  function v1AuthEnvelopeWrapper(req, res, next) {
    const originalJson = res.json.bind(res);
    let restored = false;
    const restore = () => {
      if (!restored) { res.json = originalJson; restored = true; }
    };

    res.json = ((body: any) => {
      restore();
      const status = res.statusCode;

      /**
       * Is this ALREADY a v1 envelope?
       *
       * `!body.error` was the original discriminator and it is not sufficient.
       * `verifyAuth`'s TOKEN_REVOKED branch writes a hybrid — the legacy
       * `{ status, code, message }` PLUS its own nested
       * `error: { code, recovery, retryable }` — so `!body.error` was false and
       * the single most security-relevant 401 on the platform passed through
       * untranslated, in the legacy shape, with no requestId. A revoked session
       * is the one refusal a client must never mistake for a generic failure.
       *
       * Every genuine v1 envelope is minted by `fail()`, which always stamps a
       * string `requestId`. That is the property to test for, and it cannot be
       * satisfied by accident: a legacy body carrying an `error` field does not
       * carry `error.requestId`.
       */
      const alreadyV1 =
        body && body.error && typeof body.error.requestId === 'string';

      // Translate ONLY an auth-chain rejection in the legacy shape.
      if ((status === 401 || status === 403) && body && !alreadyV1 && typeof body.code === 'string') {
        const mapped = LEGACY_TO_V1_CODE[body.code];
        if (mapped) {
          return fail(
            res, req, mapped, typeof body.message === 'string' ? body.message : undefined,
            body.code === mapped ? undefined : { reason: body.code },
          );
        }
      }
      return originalJson(body);
    }) as Response['json'];

    // If the middleware calls next(), it did not reject — put res.json back so
    // the handler's own responses are never rewritten.
    //
    // The inner middleware's return value is PROPAGATED, not discarded. These
    // are async middlewares that return a promise, and callers rely on it:
    // `tests/authz-matrix-behaviour.test.ts` drives the chain directly and
    // awaits either `next()` or that promise. Swallowing it hangs the caller —
    // which is precisely how that suite caught this wrapper's first draft.
    return inner(req, res, ((err?: unknown) => { restore(); next(err as any); }) as NextFunction);
  };

/**
 * The capability rung, appended AFTER the role rung.
 *
 * Order is not cosmetic. `requireCapability` reads the provider account state
 * for `req.user.uid`, so it needs `verifyAuth` to have run; and running it
 * before the role check would answer a non-provider with a capability denial
 * rather than a role one, which are different screens for the caller.
 */
const capabilityChain = (entry: ContractEntry): RequestHandler[] => [
  ...(entry.capability
    ? [v1AuthEnvelope(requireCapability(entry.capability) as RequestHandler)]
    : []),
  // The REAL middleware, not a capability standing in for it. `requireActiveProvider`
  // reads `account_status` alone and treats a blank one as working; every capability
  // that looks equivalent is derived from the fuller account-state machine and refuses
  // providers this middleware admits. One definition, called rather than rebuilt.
  ...(entry.activeProvider
    ? [v1AuthEnvelope(requireActiveProvider as RequestHandler)]
    : []),
];

export const authChain = (entry: ContractEntry): RequestHandler[] => {
  const capability = capabilityChain(entry);
  switch (entry.auth) {
    case 'public':
      return [...capability];
    case 'authenticated':
      return [v1AuthEnvelope(verifyAuth), ...capability];
    case 'provider':
      return [v1AuthEnvelope(verifyAuth), v1AuthEnvelope(requireProviderRole as RequestHandler), ...capability];
    case 'admin':
      return [v1AuthEnvelope(verifyAuth), v1AuthEnvelope(verifyRoles([1]) as RequestHandler), ...capability];
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
import { handlers as bookingExperienceHandlers } from './domains/bookingExperiences';
import { handlers as financeHandlers } from './domains/finance';
import { handlers as conversationHandlers } from './domains/conversations';
import { handlers as accountHandlers } from './domains/account';
import { handlers as homeHandlers } from './domains/home';
import { handlers as healthHandlers } from './domains/health';
import { handlers as clientConfigHandlers } from './domains/clientConfig';
import { handlers as telemetryHandlers } from './domains/telemetry';
import { handlers as adminBookingHandlers } from './domains/adminBookings';
import { handlers as adminFinanceHandlers } from './domains/adminFinance';
import {
  perAccountLoginLimiter,
  perIpLoginLimiter,
  perAccountRegisterLimiter,
  perAccountOtpLimiter,
  perAccountRecoveryLimiter,
} from '../../middleware/credentialLimiter';
import { BucketName, V1_RATE_LIMITS } from './rateLimitPolicy';
import { requirePermission } from '../../middleware/requirePermission';

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
  ...bookingExperienceHandlers,
  ...financeHandlers,
  ...conversationHandlers,
  ...accountHandlers,
  ...homeHandlers,
  ...healthHandlers,
  ...clientConfigHandlers,
  ...telemetryHandlers,
  ...adminBookingHandlers,
  ...adminFinanceHandlers,
};

/**
 * The one `express-rate-limit` instance per declared bucket.
 *
 * Instances, not factories: `express-rate-limit` counts per INSTANCE, so two
 * endpoints sharing a bucket name deliberately share a counter — and building a
 * fresh limiter per endpoint would silently give each one its own budget. This
 * is the mistake `signInLimiter` makes in the other direction, where two routes
 * that should NOT share a budget do.
 */
const BUCKET_MIDDLEWARE: Record<BucketName, RequestHandler> = {
  perAccountLogin: perAccountLoginLimiter,
  perAccountRegister: perAccountRegisterLimiter,
  perAccountOtp: perAccountOtpLimiter,
  perAccountRecovery: perAccountRecoveryLimiter,
  perIp: perIpLoginLimiter,
};

/**
 * Rate limits, per endpoint — derived from `rateLimitPolicy`, not restated here.
 *
 * Which endpoint gets which bucket, and the reason any endpoint has no
 * per-account bucket, are declared in one place that the documentation and the
 * tests read too. Endpoints whose policy is an empty list are omitted rather
 * than mounted with an empty chain, so this map still contains exactly the
 * endpoints that carry a limiter.
 */
/**
 * Fine-grained admin permissions, DERIVED from the contract (TAB 06).
 *
 * `auth: 'admin'` proves role 1 and nothing more. Every legacy admin route
 * additionally gates on a named permission, and a v1 successor that dropped it
 * would be a QUIETER route to the same data — privilege escalation arriving as
 * a migration.
 *
 * ## Why this moved out of a map in this file and onto `ContractEntry`
 *
 * It used to be a literal map here, and its docblock gave a fair reason: *a
 * permission key sitting unused in a data file reads as protection that is not
 * mounted.* That objection is real, and the answer is to make "unused"
 * impossible rather than to keep the data away from the contract.
 *
 * So the two checks below are the price of moving it, and they are what make
 * the field trustworthy:
 *
 *   1. every `auth: 'admin'` entry MUST declare a permission — a missing one is
 *      a throw at import, not a route that quietly checks role alone;
 *   2. every declared permission MUST end up mounted — so a key cannot sit in
 *      the contract describing protection nobody applied.
 *
 * That is the same discipline this file already applies to handlers, where a
 * key naming no implemented entry is a throw rather than a silent no-op. With
 * both in place the contract is the better home: it is the surface the docs,
 * the OpenAPI document and the parity tests all read, and a permission declared
 * beside the route it guards can be compared against the legacy route without
 * anybody parsing an Express middleware chain.
 */
const V1_PERMISSIONS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  const undeclared: string[] = [];

  for (const entry of V1_CONTRACT) {
    if (entry.auth !== 'admin') continue;
    if (entry.status !== 'implemented') continue;
    if (!entry.permission) {
      undeclared.push(entry.id);
      continue;
    }
    out[entry.id] = entry.permission;
  }

  if (undeclared.length) {
    throw new Error(
      `v1 contract: ${undeclared.length} admin endpoint(s) declare no permission — ` +
        `${undeclared.join(', ')}. auth: 'admin' proves role 1 and nothing more, so an ` +
        `admin endpoint without a named permission is a weaker guard than the legacy ` +
        `route it supersedes.`,
    );
  }

  return out;
})();

export const V1_MIDDLEWARE: V1Middleware = (() => {
  const byId = new Map<string, RequestHandler[]>();

  for (const [id, policy] of Object.entries(V1_RATE_LIMITS)) {
    if (!policy.buckets.length) continue;
    byId.set(id, policy.buckets.map((bucket) => BUCKET_MIDDLEWARE[bucket]));
  }

  for (const [id, permission] of Object.entries(V1_PERMISSIONS)) {
    byId.set(id, [...(byId.get(id) ?? []), requirePermission(permission) as RequestHandler]);
  }

  /**
   * The second half of the guarantee: a declared permission that never got
   * mounted is a contract that describes protection nobody applied.
   */
  const unmounted = Object.keys(V1_PERMISSIONS).filter((id) => !byId.has(id));
  if (unmounted.length) {
    throw new Error(
      `v1 contract: permission declared but not mounted for ${unmounted.join(', ')}`,
    );
  }

  return Object.fromEntries(byId);
})();

const built = buildV1Router(V1_HANDLERS, V1_MIDDLEWARE);

export const v1Router = built.router;
export const V1_MOUNTED = built.mounted;
export default v1Router;
