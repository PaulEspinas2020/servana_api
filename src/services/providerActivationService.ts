/**
 * Provider activation — dimension D6 (Command 6 §8).
 *
 * "Approval is not activation." An approved provider may still owe a payout
 * destination, availability, a policy acknowledgement and an approved service
 * before they may work. Today those are conflated: `account_status = 'active'`
 * means approved AND activated at once, and `applyAutoOnline` sets it from a
 * completeness calculation.
 *
 * ── The one property that matters ───────────────────────────────────────────
 * `READY_FOR_ACTIVATION → ACTIVE` is an EXPLICIT transition. It is never
 * derived, never a side-effect of a checklist reaching 100%, and never a
 * consequence of some other write. A computation that grants operational access
 * is precisely the defect this dimension exists to remove — recorded as T-05 in
 * PROVIDER_ACCOUNT_TRANSITION_MATRIX.md.
 *
 * The blocking requirements are re-evaluated inside the transition, immediately
 * before it commits, mirroring `calculateReadiness` in the approval path. A
 * caller cannot pass a stale "I checked already".
 *
 * ── Schema bootstrap ────────────────────────────────────────────────────────
 * `ensureActivationSchema` is called at module load AND awaited at the top of
 * every entry point. That is the pattern `providerOperationalAvailabilityService`
 * uses, and it is deliberately not the app.ts pattern: `ensureIdentityColumns`
 * was written, added to no boot path, and every Firebase sign-in failed with
 * 42703 until it was noticed. Awaiting at the entry point is self-healing and
 * does not depend on boot ordering.
 */

import dbQuery from "../db/dbQuery";
import { db } from "../config";

const s = db.schema;

export type ActivationStatus =
  | "NOT_ELIGIBLE"
  | "PENDING_REQUIREMENTS"
  | "READY_FOR_ACTIVATION"
  | "ACTIVE"
  | "TEMPORARILY_RESTRICTED";

/**
 * §28: every valid edge, and nothing else. Note what is absent —
 * `PENDING_REQUIREMENTS → ACTIVE` does not exist, so nothing can skip
 * READY_FOR_ACTIVATION and the requirement re-check that guards it.
 */
export const VALID_ACTIVATION_TRANSITIONS: Record<ActivationStatus, ActivationStatus[]> = {
  NOT_ELIGIBLE: ["PENDING_REQUIREMENTS"],
  PENDING_REQUIREMENTS: ["READY_FOR_ACTIVATION", "NOT_ELIGIBLE"],
  READY_FOR_ACTIVATION: ["ACTIVE", "PENDING_REQUIREMENTS", "NOT_ELIGIBLE"],
  ACTIVE: ["TEMPORARILY_RESTRICTED", "NOT_ELIGIBLE"],
  TEMPORARILY_RESTRICTED: ["ACTIVE", "NOT_ELIGIBLE"],
};

export type ActivationRequirement = {
  code: string;
  label: string;
  satisfied: boolean;
  blocking: boolean;
  route: string;
};

let schemaReady: Promise<void> | null = null;

export const ensureActivationSchema = (): Promise<void> => {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await dbQuery.query(
      `CREATE TABLE IF NOT EXISTS ${s}.provider_activation (
         provider_uid       VARCHAR(128) PRIMARY KEY,
         activation_status  VARCHAR(32)  NOT NULL DEFAULT 'NOT_ELIGIBLE',
         version            INTEGER      NOT NULL DEFAULT 1,
         policy_acknowledged_at TIMESTAMPTZ,
         activated_at       TIMESTAMPTZ,
         activated_by       VARCHAR(128),
         created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
         updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
       )`,
      []
    );
    await dbQuery.query(
      `CREATE TABLE IF NOT EXISTS ${s}.provider_activation_events (
         id            BIGSERIAL PRIMARY KEY,
         provider_uid  VARCHAR(128) NOT NULL,
         prev_state    VARCHAR(32),
         next_state    VARCHAR(32)  NOT NULL,
         actor_type    VARCHAR(16)  NOT NULL,
         actor_uid     VARCHAR(128),
         reason        TEXT,
         created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
       )`,
      []
    );
    await dbQuery.query(
      `CREATE INDEX IF NOT EXISTS idx_activation_events_provider
         ON ${s}.provider_activation_events (provider_uid, created_at DESC)`,
      []
    );
  })().catch((e) => {
    // Reset so a transient failure does not permanently poison the cache.
    schemaReady = null;
    throw e;
  });
  return schemaReady;
};

ensureActivationSchema().catch(() => {});

/**
 * Read the stored row WITHOUT creating one.
 *
 * `getActivation` upserts, which is right for a transition — it needs a row and
 * a version to lock against. It is wrong for a read: a provider merely opening
 * a page would leave a new row behind, and a read path must not write against
 * an existing provider's record. Returns null when nothing has been stored,
 * which is a real answer — "no activation has ever been recorded" — and not the
 * same as NOT_ELIGIBLE having been decided.
 */
export async function peekActivation(
  providerUid: string
): Promise<{ status: ActivationStatus; version: number; activatedAt: string | null } | null> {
  await ensureActivationSchema();
  const { rows } = await dbQuery.query(
    `SELECT activation_status, version, activated_at
       FROM ${s}.provider_activation
      WHERE provider_uid = $1
      LIMIT 1`,
    [providerUid]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    status: (r.activation_status as ActivationStatus) ?? "NOT_ELIGIBLE",
    version: Number(r.version ?? 1),
    activatedAt: r.activated_at ? new Date(r.activated_at).toISOString() : null,
  };
}

/** Read the stored row, creating the default one on first sight. */
export async function getActivation(
  providerUid: string
): Promise<{ status: ActivationStatus; version: number; activatedAt: string | null }> {
  await ensureActivationSchema();
  const { rows } = await dbQuery.query(
    `INSERT INTO ${s}.provider_activation (provider_uid)
     VALUES ($1)
     ON CONFLICT (provider_uid) DO UPDATE SET provider_uid = EXCLUDED.provider_uid
     RETURNING activation_status, version, activated_at`,
    [providerUid]
  );
  const r = rows[0];
  return {
    status: (r.activation_status as ActivationStatus) ?? "NOT_ELIGIBLE",
    version: Number(r.version ?? 1),
    activatedAt: r.activated_at ? new Date(r.activated_at).toISOString() : null,
  };
}

/**
 * Records that the provider has accepted the Servana provider agreement.
 *
 * ## The checklist row that could never be ticked
 *
 * `policy_acknowledgement` is a BLOCKING requirement and
 * `policy_acknowledged_at` had exactly two references in the whole backend: the
 * column definition, and the `count(*)` below that reads it. **Nothing wrote
 * it, anywhere, on any platform.** Measured on production 2026-08-11:
 * `provider_activation` held 0 rows and 0 acknowledgements.
 *
 * So every provider sat permanently short of 100%, the application could never
 * be submitted through this path, and the row rendered as an inert line on the
 * checklist with no destination — which is how it was reported: "provider
 * agreement not clickable". The missing tap target was the symptom; the missing
 * writer was the defect.
 *
 * Same class as `is_mobile_verified`, which held 68 of 70 providers at
 * IDENTIFIER_VERIFICATION_REQUIRED for the same reason. A requirement with no
 * writer is not a strict rule, it is a dead end.
 *
 * ## Why it is idempotent and monotonic
 *
 * Accepting twice is not a second acceptance. `COALESCE` keeps the FIRST
 * timestamp, so a provider who taps again — or a client that retries — cannot
 * quietly rewrite when they agreed. That date is the evidence of consent and it
 * only happens once (§15).
 *
 * Returns the effective timestamp either way, so a repeat call is a success
 * with the original date rather than an error the UI has to explain.
 */
export async function acknowledgeProviderPolicy(
  providerUid: string,
  meta: { version: string | null }
): Promise<{ acknowledgedAt: string; policyVersion: string | null }> {
  await ensureActivationSchema();

  // Creates the row on first sight — a provider acknowledges before anything
  // else has had reason to insert one, which is why this cannot assume it
  // exists.
  const { rows } = await dbQuery.query(
    `INSERT INTO ${s}.provider_activation (provider_uid, policy_acknowledged_at)
     VALUES ($1, now())
     ON CONFLICT (provider_uid) DO UPDATE
       SET policy_acknowledged_at =
             COALESCE(${s}.provider_activation.policy_acknowledged_at, now()),
           updated_at = now()
     RETURNING policy_acknowledged_at`,
    [providerUid]
  );

  const acknowledgedAt = new Date(rows[0].policy_acknowledged_at).toISOString();

  // Audited on the same table every other activation transition uses, so "who
  // agreed to what, and when" is answerable from one place (§15/§16).
  await dbQuery
    .query(
      `INSERT INTO ${s}.provider_activation_events
         (provider_uid, prev_state, next_state, actor_type, actor_uid, reason)
       VALUES ($1, NULL, 'POLICY_ACKNOWLEDGED', 'provider', $1, $2)`,
      [providerUid, meta.version ? `policy_version=${meta.version}` : null]
    )
    .catch((e: any) =>
      console.error("[activation] policy audit write failed:", e?.message)
    );

  return { acknowledgedAt, policyVersion: meta.version };
}

/**
 * The activation checklist (§9).
 *
 * Each check is defensive: a table that does not exist yet yields
 * `satisfied: false`, never an exception and never a pass. A requirement that
 * cannot be verified has not been met — §1's default-denied applies to the
 * checklist too, not only to the capabilities.
 */
export async function getActivationRequirements(
  providerUid: string
): Promise<ActivationRequirement[]> {
  await ensureActivationSchema();

  const count = async (sql: string): Promise<number> => {
    try {
      const { rows } = await dbQuery.query(sql, [providerUid]);
      return Number(rows[0]?.n ?? 0);
    } catch {
      return 0; // unverifiable is unsatisfied
    }
  };

  const [approvedServices, availability, policy] = await Promise.all([
    count(
      `SELECT count(*)::int AS n FROM ${s}.worker_service_applications
        WHERE worker_uid = $1 AND status = 'approved'`
    ),
    count(
      `SELECT count(*)::int AS n FROM ${s}.worker_availability WHERE worker_uid = $1`
    ),
    count(
      `SELECT count(*)::int AS n FROM ${s}.provider_activation
        WHERE provider_uid = $1 AND policy_acknowledged_at IS NOT NULL`
    ),
  ]);

  return [
    {
      code: "approved_service",
      label: "At least one approved service",
      satisfied: approvedServices > 0,
      blocking: true,
      route: "services",
    },
    {
      code: "availability",
      label: "Working hours set",
      satisfied: availability > 0,
      blocking: true,
      route: "availability",
    },
    {
      code: "policy_acknowledgement",
      label: "Provider agreement accepted",
      satisfied: policy > 0,
      blocking: true,
      route: "policy",
    },
  ];
}

export class ActivationTransitionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly blockers?: ActivationRequirement[]
  ) {
    super(message);
  }
}

/**
 * Move a provider between activation states.
 *
 * @param expectedVersion optimistic concurrency — a stale caller gets 409
 *        rather than silently overwriting a newer decision (§25).
 */
export async function transitionActivation(opts: {
  providerUid: string;
  to: ActivationStatus;
  expectedVersion: number;
  actorType: "admin" | "system" | "provider";
  actorUid?: string | null;
  reason?: string;
}): Promise<{ status: ActivationStatus; version: number }> {
  await ensureActivationSchema();
  const { providerUid, to, expectedVersion, actorType, actorUid = null, reason } = opts;

  const current = await getActivation(providerUid);

  if (current.version !== expectedVersion) {
    throw new ActivationTransitionError(
      `Version conflict: expected ${expectedVersion}, got ${current.version}`,
      409
    );
  }

  const allowed = VALID_ACTIVATION_TRANSITIONS[current.status] ?? [];
  if (!allowed.includes(to)) {
    throw new ActivationTransitionError(
      `Cannot transition activation from '${current.status}' to '${to}'`,
      422
    );
  }

  /**
   * The guard. Re-evaluated HERE, immediately before the write — not trusted
   * from whatever the caller believed a moment ago. This is the difference
   * between an explicit transition and a computed one.
   *
   * A provider may never trigger it regardless: §32, "providers cannot change
   * their own approval state".
   */
  if (to === "ACTIVE") {
    if (actorType === "provider") {
      throw new ActivationTransitionError(
        "A provider cannot activate their own account",
        403
      );
    }
    const reqs = await getActivationRequirements(providerUid);
    const unmet = reqs.filter((r) => r.blocking && !r.satisfied);
    if (unmet.length) {
      throw new ActivationTransitionError(
        `Cannot activate: ${unmet.length} requirement(s) outstanding.`,
        422,
        unmet
      );
    }
  }

  const activatedBits =
    to === "ACTIVE" ? ", activated_at = now(), activated_by = $4" : "";

  const params: any[] = [providerUid, to, expectedVersion];
  if (to === "ACTIVE") params.push(actorUid);

  const { rows } = await dbQuery.query(
    `UPDATE ${s}.provider_activation
        SET activation_status = $2,
            version = version + 1,
            updated_at = now()
            ${activatedBits}
      WHERE provider_uid = $1 AND version = $3
      RETURNING activation_status, version`,
    params
  );

  // Lost the race between the read and the write.
  if (!rows.length) {
    throw new ActivationTransitionError("Version conflict", 409);
  }

  /**
   * Operational access is granted HERE and nowhere else.
   *
   * `account_status = 'active'` used to be written by two unrelated services —
   * the admin approve path and `applyAutoOnline`, the latter deriving it from a
   * completeness calculation. Two writers meant no single authority, and the
   * derived one promoted providers nobody had reviewed.
   *
   * Centralising it on this transition is what makes the guard above mean
   * something: the only way into `active` is through a check that just ran.
   */
  if (to === "ACTIVE") {
    await dbQuery.query(
      `UPDATE ${s}.user_credentials
          SET account_status = 'active'
        WHERE uid = $1
          AND account_status IS DISTINCT FROM 'active'`,
      [providerUid]
    );
  }

  await dbQuery.query(
    `INSERT INTO ${s}.provider_activation_events
       (provider_uid, prev_state, next_state, actor_type, actor_uid, reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [providerUid, current.status, to, actorType, actorUid, reason ?? null]
  );

  return {
    status: rows[0].activation_status as ActivationStatus,
    version: Number(rows[0].version),
  };
}

/**
 * What the activation state IS, computed without recording anything.
 *
 * Same decision as `refreshActivationEligibility`, minus the persistence — so a
 * read path can report an accurate status without leaving a row, a version bump
 * or an audit event behind on an existing provider's record. A GET that writes
 * is a defect, and here it was a compounding one: the portal calls this on
 * navigation, so every provider who merely signed in would have had activation
 * state manufactured for them by the act of looking at it.
 *
 * Advancing activation stays where it belongs — the admin approval path and the
 * admin override — which is also what this service's own rule requires: the
 * move into operational access is asked for, never a side effect of a read.
 */
export async function previewActivationEligibility(
  providerUid: string,
  applicationApproved: boolean
): Promise<ActivationStatus> {
  const stored = await peekActivation(providerUid);
  const current: ActivationStatus = stored?.status ?? "NOT_ELIGIBLE";

  if (current === "ACTIVE" || current === "TEMPORARILY_RESTRICTED") {
    return current;
  }

  const target: ActivationStatus = !applicationApproved
    ? "NOT_ELIGIBLE"
    : (await getActivationRequirements(providerUid)).every((r) => !r.blocking || r.satisfied)
      ? "READY_FOR_ACTIVATION"
      : "PENDING_REQUIREMENTS";

  if (target === current) return current;

  /**
   * Report only what a transition could actually reach. Naming a state the
   * machine would refuse to move to would have the read disagree with the
   * write — the client would show a provider as ready and the transition would
   * then decline it.
   *
   * A provider with no stored row has nothing to transition FROM, so the
   * computed target stands on its own.
   */
  if (!stored) return target;
  return (VALID_ACTIVATION_TRANSITIONS[current] ?? []).includes(target) ? target : current;
}

/**
 * Recompute the non-granting states, and RECORD the result.
 *
 * Deliberately cannot reach ACTIVE. Moving into operational access is the one
 * transition that must be asked for, so this may promote a provider as far as
 * READY_FOR_ACTIVATION and no further.
 *
 * Writes. Callers must be actor-driven paths (approval, admin override) — a
 * read path wanting the same answer uses `previewActivationEligibility`.
 */
export async function refreshActivationEligibility(
  providerUid: string,
  applicationApproved: boolean
): Promise<ActivationStatus> {
  await ensureActivationSchema();
  const current = await getActivation(providerUid);

  if (current.status === "ACTIVE" || current.status === "TEMPORARILY_RESTRICTED") {
    return current.status;
  }

  const target: ActivationStatus = !applicationApproved
    ? "NOT_ELIGIBLE"
    : (await getActivationRequirements(providerUid)).every((r) => !r.blocking || r.satisfied)
      ? "READY_FOR_ACTIVATION"
      : "PENDING_REQUIREMENTS";

  if (target === current.status) return current.status;
  if (!(VALID_ACTIVATION_TRANSITIONS[current.status] ?? []).includes(target)) {
    return current.status;
  }

  const next = await transitionActivation({
    providerUid,
    to: target,
    expectedVersion: current.version,
    actorType: "system",
    reason: "eligibility_recomputed",
  }).catch(() => null);

  return next?.status ?? current.status;
}
