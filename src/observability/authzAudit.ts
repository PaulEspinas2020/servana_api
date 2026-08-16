/**
 * Authorization decisions, recorded (TAB 04, §"authorization decision audit").
 *
 * ## What exists and why it is not enough
 *
 * `requestLog` records that a request happened and how it ended. A 403 in that
 * line says a request was refused; it does not say WHICH rule refused it. When
 * a provider reports "I can't open my earnings", the useful question is whether
 * they failed the role check, the capability check, or an ownership check on a
 * specific object — and those are three different fixes.
 *
 * The only authorization logging in the codebase today is one `console.error`
 * inside `requireCapability`, which covers one middleware and formats by hand.
 *
 * ## Deny-by-default, like the redaction policy it sits beside
 *
 * An authorization event is emitted about a caller who has just been refused,
 * which is exactly the moment it is tempting to log "everything, to debug it".
 * So this carries a FIXED shape: nothing is passed through, every field is
 * constructed here, and there is no `detail` bag for a future caller to put a
 * request body in.
 *
 * A uid is truncated the way `requireCapability` already truncates it. Six
 * characters distinguishes accounts in a log while being useless for
 * impersonation or for correlating a person across systems.
 */

import type { Request } from 'express';
import { actorRoleOf, clientLabelOf } from './requestLog';
import type { ActorRole } from './observabilityPolicy';

/** Which check made the decision. Not free text. */
export type AuthzRule =
  /** No credential, or one that did not verify. */
  | 'authentication'
  /** The account's role is not admitted by the route's declared mode. */
  | 'role'
  /** A named admin permission was required and absent. */
  | 'permission'
  /** A provider capability gate. */
  | 'capability'
  /** The caller may use the route, but not against THIS object. */
  | 'ownership';

export type AuthzOutcome = 'allow' | 'deny';

export interface AuthzDecision {
  outcome: AuthzOutcome;
  rule: AuthzRule;
  /** Stable route identity — never a raw URL, which carries ids. */
  routeId: string;
  actorRole: ActorRole;
  /** First six characters of the uid, or `anonymous`. */
  actor: string;
  client: string;
  /** Machine-readable reason, from a closed set at the call site. */
  reason: string;
  /** The KIND of object, never its id: `booking`, `conversation`. */
  objectType?: string;
}

/** Six characters: enough to tell accounts apart, useless for impersonation. */
export const shortActor = (uid: unknown): string => {
  const value = typeof uid === 'string' ? uid.trim() : '';
  return value ? `${value.slice(0, 6)}…` : 'anonymous';
};

let recent: AuthzDecision[] = [];

/** For tests. Never read by the application. */
export const __authzDecisions = (): AuthzDecision[] => recent;
export const __resetAuthzAudit = (): void => { recent = []; };

/**
 * Emitted as ONE structured line, not a database row.
 *
 * Every authenticated request produces a decision, so a durable write per
 * decision would put the authorization path on the write path of the database
 * it is protecting. Denials are the rare case and the interesting one; a log
 * pipeline can alert on them without this module owning a table.
 */
export const recordAuthzDecision = (decision: AuthzDecision): void => {
  recent.push(decision);
  if (recent.length > 100) recent.shift();

  // Only denials are emitted. An allow line per request would drown the signal
  // and duplicate what requestLog already says.
  if (decision.outcome === 'allow') return;

  // eslint-disable-next-line no-console
  console.warn(
    `[authz] DENY rule=${decision.rule} route=${decision.routeId} ` +
      `role=${decision.actorRole} actor=${decision.actor} client=${decision.client} ` +
      `reason=${decision.reason}` +
      (decision.objectType ? ` object=${decision.objectType}` : ''),
  );
};

/**
 * Build a decision from a request without letting the request into it.
 *
 * The caller supplies the closed-set fields; everything derived from `req` goes
 * through the same helpers `requestLog` uses, so the two agree about what an
 * actor and a client are.
 */
export const decisionFor = (
  req: Request,
  fields: {
    outcome: AuthzOutcome;
    rule: AuthzRule;
    routeId: string;
    reason: string;
    objectType?: string;
  },
): AuthzDecision => ({
  outcome: fields.outcome,
  rule: fields.rule,
  routeId: fields.routeId,
  reason: fields.reason,
  ...(fields.objectType ? { objectType: fields.objectType } : {}),
  actorRole: actorRoleOf(req),
  actor: shortActor((req as { user?: { uid?: unknown } }).user?.uid),
  client: clientLabelOf(req),
});
