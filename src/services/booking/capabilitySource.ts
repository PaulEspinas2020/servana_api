/**
 * Which source said this provider is qualified — and whether the canonical one
 * could have answered alone.
 *
 * ## The migration this measures
 *
 * `catalog_provider_services` is the authoritative capability table. The legacy
 * family grants (`employee_services`, approved `worker_service_applications`)
 * remain in the predicate as a fallback, because removing them before the
 * canonical rows are complete would be a NARROWING — a provider whose row was
 * never projected would silently stop being assignable, which is the exact
 * supply collapse this tab exists to prevent.
 *
 * A fallback with no counter is a fallback forever. So every capability
 * decision is classified, and the number that matters is `legacyOnly`: grants
 * the legacy tables recognise and the canonical table does not. That number
 * reaching zero, and staying there for a full window, is what retires the
 * fallback. Until then the fallback is load-bearing and honest about it.
 *
 * ## What this module does NOT do
 *
 * It does not decide eligibility, and it does not query. It reads rows the
 * shared predicate already returned. A second opinion about who is qualified is
 * the failure mode the whole pipeline exists to remove.
 */

/** The three ways a provider can currently be qualified. */
export type CapabilityGrantName =
  | 'CANONICAL'
  | 'LEGACY_EMPLOYEE_SERVICE'
  | 'LEGACY_APPROVED_APPLICATION';

export const LEGACY_GRANT_NAMES: readonly CapabilityGrantName[] =
  ['LEGACY_EMPLOYEE_SERVICE', 'LEGACY_APPROVED_APPLICATION'];

export interface CapabilityDecision {
  /** Qualified at all — the answer that decides an assignment. */
  qualified: boolean;
  /** The canonical table recognised this grant. */
  canonical: boolean;
  /**
   * Qualified ONLY because of a legacy family grant.
   *
   * The adoption gap, one decision at a time. Every one of these is a
   * `catalog_provider_services` row that should exist and does not.
   */
  legacyOnly: boolean;
  /** Every source that matched, de-duplicated, in declaration order. */
  sources: CapabilityGrantName[];
}

const ORDER: readonly CapabilityGrantName[] =
  ['CANONICAL', 'LEGACY_EMPLOYEE_SERVICE', 'LEGACY_APPROVED_APPLICATION'];

/**
 * Classify the rows `PROVIDER_CAPABILITY_SQL` returned.
 *
 * Unknown source strings are IGNORED for the canonical/legacy split but still
 * count as qualified, because a row came back: the predicate found a grant this
 * classifier has not been taught about, and refusing to call that qualified
 * would make adding a fourth source silently narrow the pool.
 */
export const classifyCapabilityRows = (
  rows: ReadonlyArray<{ source?: unknown }>,
): CapabilityDecision => {
  const matched = new Set<string>();
  for (const row of rows) {
    if (typeof row?.source === 'string' && row.source) matched.add(row.source);
  }

  const canonical = matched.has('CANONICAL');
  const qualified = rows.length > 0;

  return {
    qualified,
    canonical,
    legacyOnly: qualified && !canonical,
    sources: ORDER.filter((name) => matched.has(name)),
  };
};

// ─── Adoption telemetry ───────────────────────────────────────────────────────

export interface CapabilityAdoptionCounters {
  /** Decisions where the provider was qualified by something. */
  qualified: number;
  /** Of those, decisions the canonical table could answer. */
  canonical: number;
  /** Of those, decisions ONLY a legacy family grant could answer. */
  legacyOnly: number;
  /** Decisions where nothing qualified the provider. */
  unqualified: number;
  /**
   * Distinct `${service}` keys that fell back, capped.
   *
   * Service ids, never provider uids: §58 applies to telemetry exactly as it
   * applies to a response, and a log naming which provider is missing a row is
   * a log that has to be protected like the data it describes. The service is
   * enough to find the gap and fix it with the reconciler.
   */
  legacyOnlyServices: string[];
  since: string;
}

const CAP = 50;

const fresh = (): CapabilityAdoptionCounters => ({
  qualified: 0,
  canonical: 0,
  legacyOnly: 0,
  unqualified: 0,
  legacyOnlyServices: [],
  since: new Date().toISOString(),
});

let counters = fresh();

/**
 * Record one capability decision.
 *
 * Never throws. This sits inside the assignment commit path, and a telemetry
 * bug there would be an outage rather than a missing log line.
 */
export const recordCapabilityDecision = (
  decision: CapabilityDecision,
  context: { canonicalServiceId?: unknown; legacyFamilyId?: unknown } = {},
): void => {
  try {
    if (!decision.qualified) { counters.unqualified += 1; return; }

    counters.qualified += 1;
    if (decision.canonical) counters.canonical += 1;
    if (decision.legacyOnly) {
      counters.legacyOnly += 1;
      const key = `service:${context.canonicalServiceId ?? 'none'}/family:${context.legacyFamilyId ?? 'none'}`;
      if (!counters.legacyOnlyServices.includes(key) && counters.legacyOnlyServices.length < CAP) {
        counters.legacyOnlyServices.push(key);
      }
    }
  } catch { /* a counter must never break an assignment */ }
};

export const capabilityAdoptionReport = (): CapabilityAdoptionCounters => ({
  ...counters,
  legacyOnlyServices: [...counters.legacyOnlyServices],
});

/** Test seam, and the operational reset after a reporting window. */
export const resetCapabilityAdoptionCounters = (): void => { counters = fresh(); };

/**
 * What has to be true before the legacy fallback is removed from the predicate.
 *
 * Written down because "the backfill ran, so it must be complete" is exactly
 * the reasoning that would take a provider's livelihood away silently. The
 * fallback costs two index lookups; removing it early costs an assignable
 * provider nobody can find.
 */
export const CANONICAL_ADOPTION_CRITERIA = {
  /** `legacyOnly` must be 0 in the runtime counters for this many days. */
  zeroFallbackDays: 30,
  /**
   * `parity` must report zero legacy-only grants across the whole population,
   * measured by `npm run capability:parity` against the real database — not
   * inferred from the runtime counters, which only see services somebody tried
   * to assign.
   */
  requireParityClean: true,
  /**
   * Every capability-change writer must project canonically. Asserted in the
   * source by `tests/capability-canonical-source.test.ts`, so a new writer
   * added without a projection fails the build rather than the migration.
   */
  requireAllWritersProject: true,
  /**
   * The reconciler must have run at least once after the last writer change,
   * so a grant created during a deploy window is not left legacy-only forever.
   */
  requireReconcilerRun: true,
} as const;
