import dbQuery from '../db/dbQuery';
import { db } from '../config';

const s = db.schema;
export const RATING_AGGREGATION_POLICY_VERSION = 1;
export const MIN_DIMENSION_SAMPLE = 5;

export type QueryRunner = (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>;

/** Decimal-safe display rule shared by every surface: one decimal, half-up. */
export const displayRating = (value: unknown, count: number): number | null => {
  if (count <= 0 || value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round((numeric + Number.EPSILON) * 10) / 10 : null;
};

export const isAggregateContributor = (publicationState: string, moderationState: string): boolean =>
  ['PUBLISHED', 'EDITED', 'REDACTED'].includes(publicationState)
  && ['NOT_REQUIRED', 'AUTOMATED_CHECKS_PASSED', 'APPROVED', 'RESTORED', 'REPORTED'].includes(moderationState);

export async function recalculateProviderRating(
  providerUid: string,
  runner: QueryRunner = (sql, params = []) => dbQuery.query(sql, params),
): Promise<void> {
  await runner(
    `INSERT INTO ${s}.provider_rating_aggregates
       (provider_uid, average_rating, review_count,
        rating_1_count, rating_2_count, rating_3_count, rating_4_count, rating_5_count,
        aggregation_policy_version, aggregate_version, last_updated_at, calculated_at)
     SELECT $1,
            COALESCE(ROUND(AVG(overall_rating)::numeric, 2), 0),
            COUNT(*)::int,
            COUNT(*) FILTER (WHERE overall_rating = 1)::int,
            COUNT(*) FILTER (WHERE overall_rating = 2)::int,
            COUNT(*) FILTER (WHERE overall_rating = 3)::int,
            COUNT(*) FILTER (WHERE overall_rating = 4)::int,
            COUNT(*) FILTER (WHERE overall_rating = 5)::int,
            $2, 1, NOW(), NOW()
       FROM ${s}.customer_reviews
      WHERE provider_uid = $1
        AND deleted_at IS NULL
        AND publication_state IN ('PUBLISHED','EDITED','REDACTED')
        AND moderation_status IN ('NOT_REQUIRED','AUTOMATED_CHECKS_PASSED','APPROVED','RESTORED','REPORTED')
     ON CONFLICT (provider_uid) DO UPDATE SET
       average_rating = EXCLUDED.average_rating,
       review_count = EXCLUDED.review_count,
       rating_1_count = EXCLUDED.rating_1_count,
       rating_2_count = EXCLUDED.rating_2_count,
       rating_3_count = EXCLUDED.rating_3_count,
       rating_4_count = EXCLUDED.rating_4_count,
       rating_5_count = EXCLUDED.rating_5_count,
       aggregation_policy_version = EXCLUDED.aggregation_policy_version,
       aggregate_version = ${s}.provider_rating_aggregates.aggregate_version + 1,
       last_updated_at = NOW(), calculated_at = NOW()`,
    [providerUid, RATING_AGGREGATION_POLICY_VERSION],
  );

  await runner(`DELETE FROM ${s}.provider_service_rating_aggregates WHERE provider_uid = $1`, [providerUid]);
  await runner(
    `INSERT INTO ${s}.provider_service_rating_aggregates
       (provider_uid, service_id, average_rating, review_count,
        aggregation_policy_version, aggregate_version, calculated_at)
     SELECT provider_uid, service_id, ROUND(AVG(overall_rating)::numeric, 3), COUNT(*)::int,
            $2, 1, NOW()
       FROM ${s}.customer_reviews
      WHERE provider_uid = $1 AND service_id IS NOT NULL AND deleted_at IS NULL
        AND publication_state IN ('PUBLISHED','EDITED','REDACTED')
        AND moderation_status IN ('NOT_REQUIRED','AUTOMATED_CHECKS_PASSED','APPROVED','RESTORED','REPORTED')
      GROUP BY provider_uid, service_id`,
    [providerUid, RATING_AGGREGATION_POLICY_VERSION],
  );
}

export async function getPublicRatingSummary(
  providerUid: string,
  runner: QueryRunner = (sql, params = []) => dbQuery.query(sql, params),
) {
  const result = await runner(
    `SELECT average_rating, review_count, rating_1_count, rating_2_count,
            rating_3_count, rating_4_count, rating_5_count,
            aggregation_policy_version, aggregate_version,
            COALESCE(calculated_at, last_updated_at) AS calculated_at
       FROM ${s}.provider_rating_aggregates WHERE provider_uid = $1`,
    [providerUid],
  );
  const row = result.rows[0];
  const count = Number(row?.review_count ?? 0);
  return {
    averageRating: displayRating(row?.average_rating, count),
    reviewCount: count,
    distribution: {
      1: Number(row?.rating_1_count ?? 0),
      2: Number(row?.rating_2_count ?? 0),
      3: Number(row?.rating_3_count ?? 0),
      4: Number(row?.rating_4_count ?? 0),
      5: Number(row?.rating_5_count ?? 0),
    },
    scale: { minimum: 1, maximum: 5 },
    lowVolume: count < MIN_DIMENSION_SAMPLE,
    minimumDimensionSample: MIN_DIMENSION_SAMPLE,
    aggregationPolicyVersion: Number(row?.aggregation_policy_version ?? RATING_AGGREGATION_POLICY_VERSION),
    aggregateVersion: Number(row?.aggregate_version ?? 0),
    calculatedAt: row?.calculated_at ?? null,
    explanation: count === 0
      ? 'No verified customer reviews yet.'
      : 'The public rating is the rounded average of eligible published reviews from completed bookings.',
  };
}

export async function reconcileProviderRating(providerUid: string, runner: QueryRunner = (sql, params = []) => dbQuery.query(sql, params)) {
  const before = await getPublicRatingSummary(providerUid, runner);
  await recalculateProviderRating(providerUid, runner);
  const after = await getPublicRatingSummary(providerUid, runner);
  return {
    repaired: before.averageRating !== after.averageRating
      || before.reviewCount !== after.reviewCount
      || JSON.stringify(before.distribution) !== JSON.stringify(after.distribution),
    before,
    after,
  };
}
