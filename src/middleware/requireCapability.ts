import { Request, Response, NextFunction } from "express";
import { sendAuthError } from "../errors/authErrors";
import {
  getProviderAccountState,
  type Capabilities,
} from "../services/providerAccountStateService";

/**
 * Enforces, on the server, a capability the account-state endpoint reports.
 *
 * Command 6, masterlist S-02 / PROVIDER_ACCOUNT_ACCESS_MATRIX A-02.
 *
 * The state endpoint publishes sixteen capabilities. Three of them are actually
 * checked anywhere (canAcceptJobs and canGoOnline via requireActiveProvider,
 * plus payout registration). The other thirteen are "authenticated" in
 * practice: earnings, messaging and availability survive a suspension by
 * accident rather than by decision. Section 5 rule 5 of the access matrix says
 * it plainly — hiding a button is not authorization.
 *
 * This is the missing half. It reads the SAME service the endpoint reads, so
 * the answer a client is given and the answer the server enforces cannot
 * diverge; re-deriving the rule here is the mistake Command 6 exists to avoid.
 *
 * ── Why it ships in observe mode, and what has to happen before it enforces ──
 *
 * Enforcing today would deny every provider on the platform.
 *
 * `canViewEarnings` is granted when the application is APPROVED, when the
 * provider is fully active, or while suspended. Production, read 2026-08-04:
 * `provider_activation` is EMPTY, so `fullyActive` is false for everyone;
 * `provider_onboarding_cases` holds ONE row and it is `not_started`, so no
 * application is APPROVED. Every one of the 70 provider accounts sits at
 * `account_status = 'pending'`, including the six who have between them
 * completed 26 real bookings.
 *
 * So a straight enforce would 403 the money screens for the entire provider
 * population — the same shape as the outage `requireActiveProvider` caused,
 * with the same cause: a guard switched on before the data it reads had ever
 * been walked through the flow that populates it.
 *
 * Observe mode answers the question that decides the flip. It runs the real
 * check, logs what it WOULD have refused, and calls next(). When the readiness
 * work (masterlist S-06) has moved providers through activation, the logs will
 * go quiet, and quiet logs are the evidence to set CAPABILITY_ENFORCEMENT=enforce.
 * Not before.
 */

/**
 * ── A dependency worth naming ───────────────────────────────────────────────
 * This calls `getProviderAccountState` on requests that are otherwise pure
 * reads, so that function MUST stay side-effect free. It has not always been:
 * it resolved activation through `refreshActivationEligibility`, which upserts
 * a `provider_activation` row, bumps a version and can append an audit event.
 * That was fixed in `bd6ba25` with `previewActivationEligibility`, and if it is
 * ever reverted, every earnings request becomes a write that manufactures
 * activation history for a provider nobody reviewed. See the guard test.
 */

export type CapabilityMode = "enforce" | "observe";

/**
 * Default mode for the whole process. `observe` unless deliberately switched,
 * because the failure mode of the wrong default is "every provider locked out
 * of their own money" and the failure mode of this one is a log line.
 */
export const defaultCapabilityMode = (): CapabilityMode =>
  process.env.CAPABILITY_ENFORCEMENT === "enforce" ? "enforce" : "observe";

/**
 * Very short-lived memo of the computed state, keyed by uid.
 *
 * The state call is several queries. The worker's earnings screen fires FIVE
 * summary requests in parallel (all-time, this week, last week, this month,
 * last month), and the portal loads earnings, ledger and payouts together — so
 * without this, adding the check multiplies the cost of one screen by eight.
 *
 * Two seconds, and reads only. A suspension therefore takes up to two seconds
 * to bite on a read, which is an acceptable trade for a gate on *viewing*; it
 * is deliberately not offered for mutations, where the guard must see the
 * current answer every time.
 */
const MEMO_TTL_MS = 2_000;

type Entry = { at: number; caps: Capabilities; nextStep: string };

/**
 * The PROMISE is cached, not the result.
 *
 * Caching the result only helps the second request if the first has already
 * finished — and the five earnings requests are issued together, so all five
 * would miss and all five would compute. Holding the in-flight promise makes
 * the other four wait on the first instead, which is the case that actually
 * costs anything.
 */
const memo = new Map<string, { at: number; value: Promise<Entry> }>();

function readState(uid: string): Promise<Entry> {
  const now = Date.now();
  const hit = memo.get(uid);
  if (hit && now - hit.at < MEMO_TTL_MS) return hit.value;

  const value = getProviderAccountState(uid).then((state) => ({
    at: now,
    caps: state.access,
    nextStep: state.nextStep.code as string,
  }));

  // A rejected lookup must not be cached: the next request would inherit a
  // failure that has nothing to do with it, for as long as the entry lives.
  value.catch(() => memo.delete(uid));

  memo.set(uid, { at: now, value });

  // Unbounded growth is a leak on a long-lived process. The map is swept
  // rather than capped so a burst does not evict an entry that is still warm.
  if (memo.size > 500) {
    for (const [k, v] of memo) {
      if (now - v.at >= MEMO_TTL_MS) memo.delete(k);
    }
  }
  return value;
}

/** Test seam — the memo is process-global and would otherwise leak between tests. */
export const __clearCapabilityMemo = () => memo.clear();

/**
 * The denial to send, chosen from the state rather than from the capability.
 *
 * A suspended provider and an unapproved one both fail `canViewEarnings`, and
 * they need different screens: one is temporary and has a status to watch, the
 * other is a step to complete. Answering both with the same code is how a
 * client ends up showing "your session expired" to someone whose account is on
 * hold.
 */
function denialFor(nextStep: string) {
  switch (nextStep) {
    case "ACCOUNT_SUSPENDED":
      return "PROVIDER_SUSPENDED" as const;
    case "APPLICATION_REJECTED":
      return "PROVIDER_REJECTED" as const;
    case "ACCOUNT_DISABLED":
    case "ACCOUNT_CLOSED":
      return "PROVIDER_DISABLED" as const;
    case "ROLE_NOT_PERMITTED":
      return "ROLE_NOT_PERMITTED" as const;
    default:
      return "PROVIDER_NOT_APPROVED" as const;
  }
}

const requireCapability =
  (capability: keyof Capabilities, opts: { mode?: CapabilityMode } = {}) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const mode = opts.mode ?? defaultCapabilityMode();
    const uid = (req as any).user?.uid as string | undefined;

    if (!uid) {
      sendAuthError(res, "UNAUTHENTICATED");
      return;
    }

    let allowed = false;
    let nextStep = "UNKNOWN";
    try {
      const state = await readState(uid);
      allowed = state.caps[capability] === true;
      nextStep = state.nextStep;
    } catch (err) {
      if (mode === "observe") {
        // A route we are only WATCHING must never be broken by the watching.
        console.warn(
          `[capability-observe] ${capability} lookup failed for ${uid.slice(0, 6)}…`,
          err
        );
        next();
        return;
      }
      // Enforcing: a lookup that fails must not widen access, but it routes to
      // RETRY rather than to a status screen the person cannot change.
      sendAuthError(res, "ACCOUNT_STATUS_UNAVAILABLE");
      return;
    }

    if (allowed) {
      next();
      return;
    }

    if (mode === "observe") {
      // One line per would-be refusal. The uid is truncated: enough to count
      // distinct accounts, not enough to be a user record in a log file.
      console.warn(
        `[capability-observe] WOULD DENY ${capability} ` +
          `uid=${uid.slice(0, 6)}… nextStep=${nextStep} ` +
          `route=${req.method} ${req.baseUrl}${req.path}`
      );
      next();
      return;
    }

    sendAuthError(res, denialFor(nextStep));
  };

export default requireCapability;
