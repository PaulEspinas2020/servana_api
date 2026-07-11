/**
 * ProviderSupplyHealthService — dashboard-level supply metrics for Admin.
 *
 * Reads existing PostgreSQL tables only. No writes. No new tables.
 * Powers: provider missing-setup lists, available-by-service/date/city counts,
 * supply gap tiles on the Admin dashboard.
 */

import dbQuery from '../db/dbQuery';
import { db } from '../config';

const s = db.schema;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProviderSetupSummary {
  totalActive: number;
  missingAvailability: number;
  missingServiceArea: number;
  missingBoth: number;
  fullySetup: number;
  setupRatePct: number;
}

export interface SupplyGapEntry {
  cityId: string | null;
  serviceId: string | null;
  date: string;
  totalProviders: number;
  eligibleProviders: number;
  gapSeverity: 'ok' | 'low' | 'critical';
}

export interface MissingSetupProvider {
  uid: string;
  name: string;
  email: string;
  missingAvailability: boolean;
  missingServiceArea: boolean;
  createdAt: string;
}

// ── Setup summary ─────────────────────────────────────────────────────────────

export const getProviderSetupSummary = async (): Promise<ProviderSetupSummary> => {
  const res = await dbQuery.query(
    `SELECT
       COUNT(*) FILTER (WHERE uc.account_status = 'active' AND uc.is_archive = false)::int AS total_active,
       COUNT(*) FILTER (
         WHERE uc.account_status = 'active'
           AND uc.is_archive = false
           AND NOT EXISTS (SELECT 1 FROM ${s}.worker_availability wa WHERE wa.worker_uid = uc.uid)
       )::int AS missing_availability,
       COUNT(*) FILTER (
         WHERE uc.account_status = 'active'
           AND uc.is_archive = false
           AND NOT EXISTS (SELECT 1 FROM ${s}.worker_service_areas wsa WHERE wsa.worker_uid = uc.uid)
       )::int AS missing_service_area,
       COUNT(*) FILTER (
         WHERE uc.account_status = 'active'
           AND uc.is_archive = false
           AND NOT EXISTS (SELECT 1 FROM ${s}.worker_availability wa WHERE wa.worker_uid = uc.uid)
           AND NOT EXISTS (SELECT 1 FROM ${s}.worker_service_areas wsa WHERE wsa.worker_uid = uc.uid)
       )::int AS missing_both
     FROM ${s}.user_credentials uc
     WHERE uc.role IN (2, 4)`,
    []
  );

  const row = res.rows[0] ?? {};
  const totalActive           = Number(row.total_active         ?? 0);
  const missingAvailability   = Number(row.missing_availability ?? 0);
  const missingServiceArea    = Number(row.missing_service_area ?? 0);
  const missingBoth           = Number(row.missing_both         ?? 0);
  const fullySetup            = totalActive - (missingAvailability + missingServiceArea - missingBoth);
  const setupRatePct          = totalActive > 0 ? Math.round((fullySetup / totalActive) * 100) : 0;

  return { totalActive, missingAvailability, missingServiceArea, missingBoth, fullySetup, setupRatePct };
};

// ── Providers missing setup ───────────────────────────────────────────────────

export const listProvidersMissingSetup = async (
  filter: 'availability' | 'service_area' | 'both' | 'any' = 'any',
  limit = 50,
): Promise<MissingSetupProvider[]> => {
  const availCond = `NOT EXISTS (SELECT 1 FROM ${s}.worker_availability wa WHERE wa.worker_uid = uc.uid)`;
  const areaCond  = `NOT EXISTS (SELECT 1 FROM ${s}.worker_service_areas wsa WHERE wsa.worker_uid = uc.uid)`;

  let missingCond: string;
  switch (filter) {
    case 'availability':  missingCond = availCond;                        break;
    case 'service_area':  missingCond = areaCond;                         break;
    case 'both':          missingCond = `(${availCond} AND ${areaCond})`; break;
    default:              missingCond = `(${availCond} OR ${areaCond})`;  break;
  }

  const res = await dbQuery.query(
    `SELECT uc.uid, uc.first_name, uc.last_name, uc.email, uc.created_date AS created_at,
            ${availCond} AS missing_availability,
            ${areaCond}  AS missing_service_area
     FROM ${s}.user_credentials uc
     WHERE uc.role IN (2, 4)
       AND uc.account_status = 'active'
       AND uc.is_archive = false
       AND ${missingCond}
     ORDER BY uc.created_date DESC
     LIMIT $1`,
    [limit]
  );

  return res.rows.map((r: any) => ({
    uid:                 r.uid,
    name:                `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
    email:               r.email,
    missingAvailability: r.missing_availability,
    missingServiceArea:  r.missing_service_area,
    createdAt:           r.created_at,
  }));
};

// ── Available provider count by date/service/city ─────────────────────────────

export const getAvailableProviderCount = async (
  serviceId: string | null,
  date: string,
  cityId: string | null,
): Promise<number> => {
  const dow = new Date(date).getDay();

  let conditions = [
    `uc.role IN (2, 4)`,
    `uc.account_status = 'active'`,
    `uc.is_archive = false`,
    // Has availability on this day of week
    `EXISTS (
       SELECT 1 FROM ${s}.worker_availability wa
       WHERE wa.worker_uid = uc.uid
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(wa.schedule) AS sl
           WHERE (sl->>'dayOfWeek')::int = ${dow}
             AND (sl->>'isAvailable')::boolean = true
         )
     )`,
    // Not on time-off that day
    `NOT EXISTS (
       SELECT 1 FROM ${s}.worker_time_off wto
       WHERE wto.worker_uid = uc.uid
         AND COALESCE(wto.status, 'active') = 'active'
         AND wto.start_date <= $1::date
         AND wto.end_date   >= $1::date
     )`,
  ];

  const params: any[] = [date];

  if (serviceId) {
    conditions.push(`EXISTS (
       SELECT 1 FROM ${s}.employee_services es
       WHERE es.employee_uid = uc.uid
         AND es.service_id = $${params.length + 1}
     )`);
    params.push(serviceId);
  }

  if (cityId) {
    conditions.push(`EXISTS (
       SELECT 1 FROM ${s}.worker_service_areas wsa
       WHERE wsa.worker_uid = uc.uid
         AND wsa.city_ids @> $${params.length + 1}::jsonb
     )`);
    params.push(JSON.stringify([cityId]));
  }

  const res = await dbQuery.query(
    `SELECT COUNT(*)::int AS cnt
     FROM ${s}.user_credentials uc
     WHERE ${conditions.join(' AND ')}`,
    params
  );
  return Number(res.rows[0]?.cnt ?? 0);
};

// ── Supply gaps ───────────────────────────────────────────────────────────────

export const getSupplyGaps = async (
  daysAhead = 7,
): Promise<SupplyGapEntry[]> => {
  const gaps: SupplyGapEntry[] = [];
  const today = new Date();

  // Fetch unique (service_id, branch_id) combos from upcoming unassigned bookings
  // service_id lives on service_options, not bookings directly
  const combosRes = await dbQuery.query(
    `SELECT DISTINCT so.service_id, b.branch_id
     FROM ${s}.bookings b
     LEFT JOIN ${s}.service_options so ON so.id = b.service_option_id
     WHERE b.status NOT IN ('CANCELLED', 'COMPLETED')
       AND b.worker_uid IS NULL
       AND b.schedule >= NOW()
       AND b.schedule < NOW() + INTERVAL '${daysAhead} days'
     LIMIT 20`,
    []
  );

  for (let d = 0; d < daysAhead; d++) {
    const date = new Date(today);
    date.setDate(today.getDate() + d);
    const dateStr = date.toISOString().slice(0, 10);

    for (const combo of combosRes.rows) {
      const eligible = await getAvailableProviderCount(combo.service_id, dateStr, null);

      // How many unassigned bookings need coverage this day for this combo
      const demandRes = await dbQuery.query(
        `SELECT COUNT(*)::int AS cnt
         FROM ${s}.bookings b
         LEFT JOIN ${s}.service_options so ON so.id = b.service_option_id
         WHERE b.status NOT IN ('CANCELLED', 'COMPLETED')
           AND b.worker_uid IS NULL
           AND so.service_id IS NOT DISTINCT FROM $1
           AND b.branch_id IS NOT DISTINCT FROM $2
           AND b.schedule::date = $3::date`,
        [combo.service_id, combo.branch_id, dateStr]
      );
      const demand = Number(demandRes.rows[0]?.cnt ?? 0);
      if (demand === 0) continue;

      const gapSeverity: SupplyGapEntry['gapSeverity'] =
        eligible === 0 ? 'critical' : eligible < demand ? 'low' : 'ok';

      gaps.push({
        cityId:            null,
        serviceId:         combo.service_id ? String(combo.service_id) : null,
        date:              dateStr,
        totalProviders:    eligible,
        eligibleProviders: eligible,
        gapSeverity,
      });
    }
  }

  return gaps.sort((a, b) => {
    const sev = { critical: 0, low: 1, ok: 2 };
    return sev[a.gapSeverity] - sev[b.gapSeverity];
  });
};
