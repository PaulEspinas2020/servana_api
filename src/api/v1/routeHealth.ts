/**
 * Route health and the production smoke plan (§143, §150).
 *
 * ## The rule this file exists to enforce
 *
 * > "A 401 from global auth middleware must never be considered route proof."
 *
 * This is not a hypothetical. `GET /api/catalog` shipped unreachable — shadowed
 * by `GET /api/:id` in the legacy tree — and every check that touched it saw a
 * plausible-looking response and concluded the route was fine. The legacy tree
 * cannot answer "does this path exist?" at all: an unknown single-segment path
 * is parsed as a booking id, so it returns 401 or 400, and both look exactly
 * like a route that exists and is protected.
 *
 * So a probe result carries a PROOF STRENGTH, and only two values count:
 *
 *   - `HANDLER_REACHED`  — a 2xx/4xx that the HANDLER produced, i.e. one whose
 *     body is in the v1 envelope and whose code is a domain code.
 *   - `ROUTE_ABSENT`     — the v1 router's own 404, which is definitive because
 *     the v1 router terminates in one rather than falling through.
 *
 * Everything else — a bare 401, a 403, a proxy error, an HTML body — is
 * `INCONCLUSIVE`, and `classifyProbe` says so rather than rounding it up.
 *
 * ## Why the smoke plan lives here and never executes
 *
 * The standing rules forbid running anything against production. What this
 * module produces is a PLAN: which endpoints to call, with which least-privilege
 * account, in which order, and what result would count as proof. `scripts/
 * production-smoke.ts` can print it, and refuses to execute against a
 * non-local host without an explicit acknowledgement — the same shape
 * `run-migrations.ts` uses for the same reason.
 */

import { V1_CONTRACT, V1_PREFIX, type AuthMode, type ContractEntry } from './contract';

// ─── Proof strength (§143) ────────────────────────────────────────────────────

export type ProofStrength =
  /** The handler ran. The only positive proof a route exists and works. */
  | 'HANDLER_REACHED'
  /** The v1 router's terminal 404. Definitive proof the route is NOT mounted. */
  | 'ROUTE_ABSENT'
  /** Proves nothing about the route. A 401, a 403, a proxy page, an HTML body. */
  | 'INCONCLUSIVE';

export interface ProbeResult {
  status: number;
  /** Parsed body, when it was JSON. */
  body?: unknown;
  contentType?: string;
}

/**
 * What a probe actually proved.
 *
 * The v1 envelope is what makes this decidable from outside: a v1 response is
 * `{ data }` or `{ error: { code, requestId } }`, and nothing else in the
 * platform produces that shape. A 401 from `verifyAuth` is a legacy-shaped body
 * or an empty one, so it cannot be mistaken for a handler response.
 */
export const classifyProbe = (probe: ProbeResult): ProofStrength => {
  const body = probe.body as Record<string, any> | null | undefined;
  const isJson = !probe.contentType || probe.contentType.includes('application/json');
  if (!isJson || !body || typeof body !== 'object') return 'INCONCLUSIVE';

  const hasV1Success = Object.prototype.hasOwnProperty.call(body, 'data');
  const v1Error = body.error;
  const hasV1Error =
    v1Error && typeof v1Error === 'object' &&
    typeof v1Error.code === 'string' && typeof v1Error.requestId === 'string';

  // The router's own terminal 404 — the one case where a 404 is informative.
  if (probe.status === 404 && hasV1Error && v1Error.code === 'NOT_FOUND') {
    const message = String(v1Error.message ?? '');
    if (/No v1 endpoint for/i.test(message)) return 'ROUTE_ABSENT';
  }

  // A bare auth rejection proves nothing: the middleware answered, not the route.
  if (probe.status === 401 || probe.status === 403) {
    if (!hasV1Error) return 'INCONCLUSIVE';
    // Even in the v1 shape, an auth code came from the chain rather than the
    // handler. UNAUTHENTICATED on a protected route is exactly what an absent
    // route behind global auth would also produce.
    if (['UNAUTHENTICATED', 'FORBIDDEN', 'ROLE_NOT_PERMITTED'].includes(v1Error.code)) {
      return 'INCONCLUSIVE';
    }
  }

  if (hasV1Success) return 'HANDLER_REACHED';
  if (hasV1Error) return 'HANDLER_REACHED';
  return 'INCONCLUSIVE';
};

/** Only these two answers may be recorded as a route-health verdict. */
export const isConclusive = (strength: ProofStrength): boolean =>
  strength === 'HANDLER_REACHED' || strength === 'ROUTE_ABSENT';

// ─── Least-privilege smoke accounts (§150) ────────────────────────────────────

export interface SmokeAccount {
  key: string;
  authMode: Exclude<AuthMode, 'public'>;
  /** Environment variable holding the credential. NEVER a literal. */
  credentialEnv: string;
  /** The narrowest thing this account may do. */
  privilege: string;
  rotationDays: number;
  constraints: readonly string[];
}

/**
 * The accounts a production smoke run would use, and their limits.
 *
 * §150 asks for least privilege, rotation and no personal credentials. The
 * reason for the last one is concrete: an automation running as a named
 * engineer's account produces an audit trail that says that engineer did it,
 * survives their departure, and cannot be revoked without locking a person out.
 *
 * Every credential is read from the environment at run time. There is no field
 * here that can hold a secret, which is what makes "no secrets in tests" a
 * property of the type rather than of somebody's care.
 */
export const SMOKE_ACCOUNTS: readonly SmokeAccount[] = Object.freeze([
  {
    key: 'smoke-customer',
    authMode: 'authenticated',
    credentialEnv: 'SMOKE_CUSTOMER_TOKEN',
    privilege: 'Read-only customer. Owns one seeded booking in a terminal state.',
    rotationDays: 30,
    constraints: Object.freeze([
      'Never a real customer account.',
      'Its booking is terminal, so no smoke call can move a live job.',
      'Cannot reach any /admin route; the contract gates those on role 1.',
    ]),
  },
  {
    key: 'smoke-provider',
    authMode: 'provider',
    credentialEnv: 'SMOKE_PROVIDER_TOKEN',
    privilege: 'Read-only provider. Assigned to nothing.',
    rotationDays: 30,
    constraints: Object.freeze([
      'PROVIDER RECORDS ARE LIVE. This account is a dedicated seed, never an existing provider.',
      'Assigned to no booking, so no transition endpoint can be exercised against real work.',
      'Read probes only — a write would enter the same state machine live jobs use.',
    ]),
  },
  {
    key: 'smoke-admin',
    authMode: 'admin',
    credentialEnv: 'SMOKE_ADMIN_TOKEN',
    privilege: 'Admin with READ permissions only. No assignment, no finance mutation.',
    rotationDays: 14,
    constraints: Object.freeze([
      'Holds no permission that assigns work, moves money or edits a provider.',
      'Rotated fastest because it is the account with the widest read.',
      'Its permission set is asserted before the run, not assumed.',
    ]),
  },
]);

export const CREDENTIAL_RULES = {
  storage: 'Environment variables on the smoke runner only. Never in the repository, never in CI logs.',
  rotation: 'Rotated on the cadence above, and immediately after any run whose logs were shared.',
  personalAccounts:
    'Forbidden. An automation running as a named engineer produces an audit trail attributing ' +
    'machine actions to a person, survives their departure, and cannot be revoked without ' +
    'locking a human out.',
  leastPrivilege:
    'Each account holds the narrowest role that can prove the endpoints it probes, and no ' +
    'account can perform a state transition on live work.',
  onFailure: 'A smoke failure reports the endpoint and the request id. It never echoes the token.',
} as const;

// ─── The plan ─────────────────────────────────────────────────────────────────

export interface SmokeStep {
  contractId: string;
  method: string;
  path: string;
  authMode: AuthMode;
  account: string | null;
  /** How to fill path parameters without touching a live record. */
  parameterSource: string;
  expectation: string;
  /** Read-only endpoints only. A write step is never generated. */
  safe: boolean;
}

const SAFE_METHODS = new Set(['get']);

const accountFor = (mode: AuthMode): string | null =>
  mode === 'public' ? null : SMOKE_ACCOUNTS.find((a) => a.authMode === mode)?.key ?? null;

/**
 * The smoke plan: every mounted endpoint a read-only probe can prove.
 *
 * Writes are excluded by construction rather than by care. A POST to
 * `/bookings/:id/cancel` on production enters the same state machine a real
 * customer's booking uses, and no amount of test-account isolation makes that
 * a smoke test.
 */
export const smokePlan = (): SmokeStep[] =>
  V1_CONTRACT.filter((e) => e.status === 'implemented').map((entry: ContractEntry) => {
    const safe = SAFE_METHODS.has(entry.method);
    return {
      contractId: entry.id,
      method: entry.method.toUpperCase(),
      path: `${V1_PREFIX}${entry.path}`,
      authMode: entry.auth,
      account: accountFor(entry.auth),
      parameterSource: entry.path.includes(':')
        ? 'A seeded fixture record owned by the smoke account. Never a live id.'
        : 'none',
      expectation: safe
        ? 'HANDLER_REACHED. A 401 or 403 is INCONCLUSIVE and fails the step.'
        : 'NOT PROBED — a write would enter the live domain.',
      safe,
    };
  });

export const smokeSummary = () => {
  const plan = smokePlan();
  return {
    total: plan.length,
    probed: plan.filter((s) => s.safe).length,
    skippedWrites: plan.filter((s) => !s.safe).length,
    byAuth: {
      public: plan.filter((s) => s.safe && s.authMode === 'public').length,
      authenticated: plan.filter((s) => s.safe && s.authMode === 'authenticated').length,
      provider: plan.filter((s) => s.safe && s.authMode === 'provider').length,
      admin: plan.filter((s) => s.safe && s.authMode === 'admin').length,
    },
  };
};
