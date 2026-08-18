/**
 * Why the candidate pool is the size it is — and, when it is empty, WHICH
 * stage emptied it.
 *
 * ## The failure this exists to make visible
 *
 * "No providers available" is the least diagnosable sentence an assignment
 * screen can show. It is emitted identically when
 *
 *   - no provider in the catalog holds the service at all,
 *   - fourteen do and every one of them is deactivated,
 *   - fourteen do, all are fine, and the pool was silently capped before any
 *     of them were evaluated.
 *
 * The third case is not hypothetical in this repository: candidate generation
 * evaluates the population `.slice(0, CANDIDATE_POOL_CAP)` after ordering by
 * first name, so a provider whose name sorts late is invisible with no error
 * anybody sees. That is precisely the "silent supply collapse" the TAB 05
 * brief names, and a cap is only safe if it is REPORTED.
 *
 * So the pool carries a diagnosis alongside the list. The diagnosis is derived
 * from counts the caller already has, plus one canonical capability count
 * (`CAPABLE_PROVIDER_COUNT_SQL`) which supplies the denominator — zero out of
 * zero is a catalog fact, zero out of fourteen is an incident, and nothing
 * downstream can tell those apart without it.
 *
 * ## What this module is NOT
 *
 * It does not decide eligibility. It reads the reasons the eligibility engine
 * already produced and counts them. Adding a rule here would create a second
 * opinion about who can be assigned, which is the whole failure mode TAB 05
 * is closing.
 */

/**
 * Why a pool came back with no eligible provider.
 *
 * Ordered from "nothing to work with" to "something is wrong", because the
 * first matching reason is the one reported and an earlier code makes a later
 * one unanswerable: if the booking has no canonical service, the capability
 * count is not merely zero, it is meaningless.
 */
export const ZERO_CANDIDATE_REASONS = [
  {
    code: 'BOOKING_HAS_NO_SERVICE',
    operatorMessage:
      'This booking is not tied to a canonical service, so provider capability cannot be evaluated.',
    actionable: 'Fix the booking\'s service option before assigning.',
  },
  {
    code: 'NO_PROVIDER_POPULATION',
    operatorMessage: 'No provider accounts were returned by the candidate query at all.',
    actionable: 'Supply problem or a broken population query — not a per-provider block.',
  },
  {
    code: 'NO_PROVIDER_HAS_CAPABILITY',
    operatorMessage: 'No provider holds this service. The pool is empty by catalog, not by rules.',
    actionable: 'Approve a provider for this service, or reassign the booking to a service somebody holds.',
  },
  {
    code: 'POOL_TRUNCATED_BEFORE_EVALUATION',
    operatorMessage:
      'Capable providers exist but the pool was capped before they were evaluated, so "none available" is not a supply fact.',
    actionable: 'Raise the cap or narrow the population; do not read this as zero supply.',
  },
  {
    code: 'ALL_CANDIDATES_BLOCKED',
    operatorMessage: 'Every evaluated provider was blocked. The dominant blocker names the stage.',
    actionable: 'Read dominantBlocker — one cause usually accounts for the whole pool.',
  },
] as const;

export type ZeroCandidateReasonCode = typeof ZERO_CANDIDATE_REASONS[number]['code'];

export const ZERO_CANDIDATE_REASON_CODES: readonly ZeroCandidateReasonCode[] =
  ZERO_CANDIDATE_REASONS.map((r) => r.code);

/**
 * Blocker precedence, for attributing a provider to ONE cause.
 *
 * A blocked provider usually trips several stages at once — a deactivated
 * account also has no availability configured — and counting all of them makes
 * the histogram sum to more than the population, which is unreadable. So each
 * provider is attributed to its earliest blocker in this order, chosen to run
 * from "this account cannot work at all" to "this account cannot work on THIS
 * job", so the dominant cause is the most general true one.
 *
 * Codes not listed still count; they sort after the listed ones, in the order
 * the eligibility engine emitted them. An unknown code is therefore visible
 * rather than dropped.
 */
export const BLOCKER_PRECEDENCE: readonly string[] = [
  'ACCOUNT_INACTIVE',
  'ACCOUNT_ARCHIVED',
  'PROVIDER_ACTIVATION_NOT_ACTIVE',
  'PROVIDER_COMPLIANCE_BLOCKED',
  'PROVIDER_COMPLIANCE_UNAVAILABLE',
  'NO_ACTIVE_SERVICE',
  'SERVICE_POLICY_UNAVAILABLE',
  'NO_SERVICE_AREA',
  'CITY_NOT_IN_AREA',
  'BRANCH_NOT_IN_AREA',
  'NO_AVAILABILITY_SET',
  'DAY_NOT_AVAILABLE',
  'OUTSIDE_SCHEDULE_WINDOW',
  'TIME_OFF',
  'BOOKING_CONFLICT',
];

export interface DiagnosableCandidate {
  eligible: boolean;
  reasons: ReadonlyArray<{ code: string; severity: string }>;
}

/**
 * Where this pool's capability answers came from.
 *
 * `catalog_provider_services` is authoritative; the legacy family grants remain
 * as an instrumented fallback until the canonical rows are provably complete.
 * A pool that is only healthy BECAUSE of the fallback looks identical to one
 * that is healthy canonically, and the difference is the whole migration — so
 * it is reported rather than inferred.
 */
export interface CapabilitySourceInput {
  canonicalServiceId: string | number | null;
  legacyFamilyId: string | number | null;
  /** Providers with an active canonical row. `null` = not measured. */
  capableCanonical: number | null;
  /** Providers the legacy fallback is carrying alone. `null` = not measured. */
  capableLegacyOnly: number | null;
}

export interface CandidatePoolInput {
  /** Canonical `services.id` the booking resolves to, or null when it has none. */
  serviceId: string | number | null;
  capability?: CapabilitySourceInput;
  /** Providers the population query returned, BEFORE any cap. */
  population: number;
  /** The cap applied, if any. `null` means the whole population was evaluated. */
  cap: number | null;
  /**
   * Providers holding the canonical grant for this service, from
   * `CAPABLE_PROVIDER_COUNT_SQL`. `null` when it could not be measured — which
   * is reported as unmeasured, never as zero.
   */
  capable: number | null;
  candidates: readonly DiagnosableCandidate[];
}

export interface CandidatePoolDiagnostics {
  serviceId: string | null;
  /**
   * Whether capability was part of this evaluation at all.
   *
   * `false` when the booking resolves to no canonical service: the engine then
   * skips the capability stage, so every provider in the list is "eligible"
   * for a job nobody was checked against. That is a MORE dangerous pool than an
   * empty one, and it does not show up in any count — a full list of confident
   * candidates looks exactly like a healthy one.
   */
  capabilityEvaluated: boolean;
  /** Providers returned by the population query. */
  population: number;
  /** Providers actually evaluated. Lower than `population` means capped. */
  evaluated: number;
  truncated: boolean;
  cap: number | null;
  /** Providers holding the canonical service grant. `null` = not measured. */
  capable: number | null;
  eligible: number;
  blocked: number;
  /** One entry per blocked provider, attributed by `BLOCKER_PRECEDENCE`. */
  primaryBlockers: Record<string, number>;
  /** Every blocker seen, counted once per provider. Sums higher than `blocked`. */
  blockerOccurrences: Record<string, number>;
  dominantBlocker: string | null;
  zeroCandidateReason: ZeroCandidateReasonCode | null;
  zeroCandidateMessage: string | null;
  supplyCollapse: {
    suspected: boolean;
    /** Human-readable statement of the arithmetic that raised it. */
    detail: string | null;
  };
  /**
   * The capability-source split for this service.
   *
   * `canonicalCovers` false means this pool exists only because the legacy
   * fallback is still in the predicate: remove it today and these providers
   * stop being assignable. That is the number the adoption criteria watch.
   */
  capabilitySource: {
    canonicalServiceId: string | null;
    legacyFamilyId: string | null;
    capableCanonical: number | null;
    capableLegacyOnly: number | null;
    canonicalCovers: boolean | null;
  };
}

const countInto = (map: Record<string, number>, code: string): void => {
  map[code] = (map[code] ?? 0) + 1;
};

/** The blocker a provider is attributed to: earliest in precedence, else first emitted. */
export const primaryBlockerOf = (candidate: DiagnosableCandidate): string | null => {
  const blockers = candidate.reasons.filter((r) => r.severity === 'blocker').map((r) => r.code);
  if (!blockers.length) return null;

  let best = blockers[0];
  let bestRank = Number.MAX_SAFE_INTEGER;
  for (const code of blockers) {
    const rank = BLOCKER_PRECEDENCE.indexOf(code);
    if (rank !== -1 && rank < bestRank) { bestRank = rank; best = code; }
  }
  return best;
};

/**
 * Summarise a pool that has already been evaluated.
 *
 * Pure. Takes counts and reason lists, runs no queries and reaches nothing —
 * so it is testable without a database, which is why the counts are arguments
 * rather than something it fetches.
 */
export const summariseCandidatePool = (input: CandidatePoolInput): CandidatePoolDiagnostics => {
  const evaluated = input.candidates.length;
  const eligibleList = input.candidates.filter((c) => c.eligible);
  const blockedList = input.candidates.filter((c) => !c.eligible);

  const primaryBlockers: Record<string, number> = {};
  const blockerOccurrences: Record<string, number> = {};

  for (const candidate of blockedList) {
    const primary = primaryBlockerOf(candidate);
    // A candidate marked ineligible with no blocker reason is itself a defect:
    // it means something denied without saying why. Name it rather than lose it.
    countInto(primaryBlockers, primary ?? 'UNATTRIBUTED_BLOCK');
    for (const code of new Set(
      candidate.reasons.filter((r) => r.severity === 'blocker').map((r) => r.code),
    )) {
      countInto(blockerOccurrences, code);
    }
  }

  // Deterministic: highest count, ties broken by precedence, then alphabetically.
  // Ties are common in small pools and a summary that reorders between two
  // identical runs is a summary nobody trusts.
  const dominantBlocker = Object.entries(primaryBlockers).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    const ra = BLOCKER_PRECEDENCE.indexOf(a[0]);
    const rb = BLOCKER_PRECEDENCE.indexOf(b[0]);
    if (ra !== rb) return (ra === -1 ? Number.MAX_SAFE_INTEGER : ra) - (rb === -1 ? Number.MAX_SAFE_INTEGER : rb);
    return a[0].localeCompare(b[0]);
  })[0]?.[0] ?? null;

  const truncated = input.cap !== null && input.population > input.cap;
  const serviceId = input.serviceId === null || input.serviceId === undefined
    ? null
    : String(input.serviceId);

  let zeroCandidateReason: ZeroCandidateReasonCode | null = null;
  if (eligibleList.length === 0) {
    if (serviceId === null)                zeroCandidateReason = 'BOOKING_HAS_NO_SERVICE';
    else if (input.population === 0)       zeroCandidateReason = 'NO_PROVIDER_POPULATION';
    else if (input.capable === 0)          zeroCandidateReason = 'NO_PROVIDER_HAS_CAPABILITY';
    else if (truncated)                    zeroCandidateReason = 'POOL_TRUNCATED_BEFORE_EVALUATION';
    else                                   zeroCandidateReason = 'ALL_CANDIDATES_BLOCKED';
  }

  // Collapse is a claim about SUPPLY, so it needs the capability denominator.
  // With `capable === null` the count was not measured and no claim is made:
  // an unmeasured denominator must not be reported as a healthy one either.
  // Truncation is NOT reported here even though it also distorts the count.
  // `truncated`, `cap` and `population` already state it exactly, and folding a
  // measurement caveat into a supply claim would make the flag mean two things.
  const suspected = eligibleList.length === 0
    && input.capable !== null
    && input.capable > 0;

  const collapseDetail = suspected
    ? `${input.capable} provider(s) hold this service and 0 are assignable`
      + (dominantBlocker ? `; dominant blocker ${dominantBlocker}` : '')
    : null;

  const capability = input.capability;
  const capabilitySource = {
    canonicalServiceId: capability?.canonicalServiceId == null
      ? null : String(capability.canonicalServiceId),
    legacyFamilyId: capability?.legacyFamilyId == null
      ? null : String(capability.legacyFamilyId),
    capableCanonical: capability?.capableCanonical ?? null,
    capableLegacyOnly: capability?.capableLegacyOnly ?? null,
    // Unmeasured stays unmeasured. Reporting `true` from a failed count would
    // certify an adoption that was never checked.
    canonicalCovers: capability?.capableLegacyOnly == null
      ? null
      : capability.capableLegacyOnly === 0,
  };

  return {
    serviceId,
    capabilityEvaluated: serviceId !== null,
    capabilitySource,
    population: input.population,
    evaluated,
    truncated,
    cap: input.cap,
    capable: input.capable,
    eligible: eligibleList.length,
    blocked: blockedList.length,
    primaryBlockers,
    blockerOccurrences,
    dominantBlocker,
    zeroCandidateReason,
    zeroCandidateMessage: zeroCandidateReason
      ? ZERO_CANDIDATE_REASONS.find((r) => r.code === zeroCandidateReason)!.operatorMessage
      : null,
    supplyCollapse: { suspected, detail: collapseDetail },
  };
};

/**
 * The compact form for an audit `after` payload.
 *
 * The full diagnostics belong in the API response, where an operator reads
 * them. The audit trail wants the few numbers that let somebody reconstruct,
 * months later, whether the pool was healthy when the assignment was made —
 * without storing a per-provider list against every candidate view.
 */
export const auditSummaryOf = (d: CandidatePoolDiagnostics): Record<string, unknown> => ({
  serviceId: d.serviceId,
  capabilityEvaluated: d.capabilityEvaluated,
  population: d.population,
  evaluated: d.evaluated,
  truncated: d.truncated,
  capable: d.capable,
  eligibleCount: d.eligible,
  blockedCount: d.blocked,
  dominantBlocker: d.dominantBlocker,
  zeroCandidateReason: d.zeroCandidateReason,
  supplyCollapseSuspected: d.supplyCollapse.suspected,
  // Recorded on every candidate view so the adoption gap has a time series,
  // not just a snapshot somebody has to remember to run.
  canonicalCovers: d.capabilitySource.canonicalCovers,
  capableLegacyOnly: d.capabilitySource.capableLegacyOnly,
});
