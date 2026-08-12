/**
 * How many auto-assignments would the FULL eligibility rule have refused?
 *
 * `AUTO_ASSIGN` validates its target with `LEGACY_AUTO` — the schedule conflict
 * and nothing else. `ADMIN_ASSIGN` uses `FULL`: canonical provider role,
 * not-archived, service capability, and the same schedule conflict.
 *
 * Closing that gap upward is a TAB 05 behaviour correction, and it changes
 * which bookings get auto-assigned AT ALL. Making it without knowing the
 * candidate delta would be discovering the blast radius in production, so this
 * measures it first.
 *
 * ## It is READ-ONLY, and that is enforced three ways
 *
 *   1. the PostgreSQL session is opened `default_transaction_read_only`, so the
 *      server itself refuses a write;
 *   2. every statement is checked against a mutation denylist before it is
 *      sent, so a write is refused before it reaches the wire;
 *   3. the connection is opened inside a transaction declared `READ ONLY`.
 *
 * Any one of those would probably do. Three, because "probably" is not the
 * standard for a script pointed at production.
 *
 * ## It will not guess at credentials
 *
 * Dedicated `PG_MEASURE_*` variables with NO fallback to the application's
 * `DB_*`, plus an explicit `ALLOW_PRODUCTION_MEASUREMENT=true`. A fallback is
 * how a script written for staging ends up reading production without anybody
 * deciding that it should.
 *
 * ## It emits no PII
 *
 * Provider identifiers are hashed and truncated; no names, no emails, no
 * customer data, no booking addresses. The output answers "how many, and which
 * check refused them", which is what the decision needs — a list of real uids
 * is not.
 *
 * ## Running it
 *
 *   PG_MEASURE_HOST=... PG_MEASURE_PORT=5432 PG_MEASURE_DATABASE=... \
 *   PG_MEASURE_USER=... PG_MEASURE_PASSWORD=... PG_MEASURE_SCHEMA=servana \
 *   ALLOW_PRODUCTION_MEASUREMENT=true \
 *   npx ts-node scripts/measure-legacy-auto-delta.ts
 *
 * Expected output: a JSON report, `totals` plus `byFailure` plus a hashed
 * `providers` breakdown. See `EXAMPLE_REPORT` at the foot of this file for the
 * exact shape an operator should expect.
 */

import crypto from 'crypto';
import { Pool } from 'pg';

import { PROVIDER_ROLES } from '../src/constants/providerRoles';

// ─── Safety ───────────────────────────────────────────────────────────────────

/** Statements that must never leave this script. */
const MUTATION_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE',
  'GRANT', 'REVOKE', 'COPY', 'MERGE', 'REFRESH', 'VACUUM', 'CALL', 'DO',
];

/**
 * Is this statement a read?
 *
 * Allow-list first — it must START as a SELECT or a WITH — then a denylist for
 * anything smuggled into a later clause, such as a data-modifying CTE. An
 * allow-list alone would pass `WITH x AS (DELETE ...) SELECT ...`, which is
 * valid PostgreSQL and very much a write.
 */
export function isReadOnlyStatement(sql: string): boolean {
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (!/^\s*(SELECT|WITH)\b/i.test(stripped)) return false;
  const upper = stripped.toUpperCase();
  return !MUTATION_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\b`).test(upper));
}

export interface MeasureConfig {
  host: string; port: number; database: string;
  user: string; password: string; schema: string;
}

export type MeasureResolution =
  | { usable: true; config: MeasureConfig }
  | { usable: false; reason: string };

export function resolveMeasureConfig(env: NodeJS.ProcessEnv = process.env): MeasureResolution {
  if (String(env.ALLOW_PRODUCTION_MEASUREMENT ?? '').toLowerCase() !== 'true') {
    return {
      usable: false,
      reason: 'ALLOW_PRODUCTION_MEASUREMENT is not "true". Reading production is '
        + 'deliberate, not incidental, even when the reading is harmless.',
    };
  }
  const need = ['PG_MEASURE_HOST', 'PG_MEASURE_DATABASE', 'PG_MEASURE_USER', 'PG_MEASURE_PASSWORD'];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) {
    return {
      usable: false,
      reason: `Missing ${missing.join(', ')}. These are DELIBERATELY separate from `
        + 'the application\'s DB_* variables, with no fallback: a fallback is how a '
        + 'script written for staging ends up reading production.',
    };
  }
  return {
    usable: true,
    config: {
      host: env.PG_MEASURE_HOST!,
      port: Number(env.PG_MEASURE_PORT ?? 5432),
      database: env.PG_MEASURE_DATABASE!,
      user: env.PG_MEASURE_USER!,
      password: env.PG_MEASURE_PASSWORD!,
      schema: env.PG_MEASURE_SCHEMA || 'servana',
    },
  };
}

/** Stable, non-reversible, and short enough to read in a report. */
export const hashProvider = (uid: string): string =>
  `p_${crypto.createHash('sha256').update(String(uid)).digest('hex').slice(0, 12)}`;

// ─── Classification ───────────────────────────────────────────────────────────

/** One assignment row, reduced to the facts the FULL rule tests. */
export interface CandidateRow {
  providerUid: string;
  role: number | null;
  isArchived: boolean;
  hasCapability: boolean;
}

export type FailureReason = 'ROLE_NOT_PROVIDER' | 'ARCHIVED' | 'NO_CAPABILITY';

/**
 * Which FULL checks would refuse this assignment.
 *
 * Pure, total and order-independent: it returns EVERY reason rather than the
 * first, because "would it be refused" and "how many different ways is this
 * provider ineligible" are different questions and the second is the more
 * useful one for deciding whether the correction is safe.
 *
 * The schedule conflict is deliberately absent: `LEGACY_AUTO` already enforces
 * it, so it cannot contribute to the delta.
 */
export function classifyCandidate(row: CandidateRow): FailureReason[] {
  const reasons: FailureReason[] = [];
  const providerRoles = new Set([...PROVIDER_ROLES].map(Number));
  if (row.role === null || !providerRoles.has(Number(row.role))) reasons.push('ROLE_NOT_PROVIDER');
  if (row.isArchived) reasons.push('ARCHIVED');
  if (!row.hasCapability) reasons.push('NO_CAPABILITY');
  return reasons;
}

export interface DeltaReport {
  measuredAt: string;
  totals: {
    autoAssignments: number;
    wouldBeRefused: number;
    refusedPercent: number;
  };
  byFailure: Record<FailureReason, number>;
  /** Hashed provider ids and how many of their auto-assignments would be refused. */
  providers: Array<{ provider: string; refused: number; reasons: FailureReason[] }>;
}

/** Builds the report from classified rows. Pure, so it is testable without a database. */
export function buildReport(rows: CandidateRow[], measuredAt: string): DeltaReport {
  const byFailure: Record<FailureReason, number> = {
    ROLE_NOT_PROVIDER: 0, ARCHIVED: 0, NO_CAPABILITY: 0,
  };
  const perProvider = new Map<string, { refused: number; reasons: Set<FailureReason> }>();
  let refused = 0;

  for (const row of rows) {
    const reasons = classifyCandidate(row);
    if (!reasons.length) continue;
    refused += 1;
    for (const r of reasons) byFailure[r] += 1;
    const key = hashProvider(row.providerUid);
    const entry = perProvider.get(key) ?? { refused: 0, reasons: new Set<FailureReason>() };
    entry.refused += 1;
    for (const r of reasons) entry.reasons.add(r);
    perProvider.set(key, entry);
  }

  return {
    measuredAt,
    totals: {
      autoAssignments: rows.length,
      wouldBeRefused: refused,
      refusedPercent: rows.length ? Number(((refused / rows.length) * 100).toFixed(2)) : 0,
    },
    byFailure,
    providers: [...perProvider.entries()]
      // Deterministic: most affected first, then by hash so equal counts do not
      // reorder between runs.
      .sort((a, b) => b[1].refused - a[1].refused || a[0].localeCompare(b[0]))
      .map(([provider, v]) => ({
        provider,
        refused: v.refused,
        reasons: [...v.reasons].sort(),
      })),
  };
}

// ─── The query ────────────────────────────────────────────────────────────────

/**
 * Every AUTO_ASSIGN in the canonical evidence table, with the three facts the
 * FULL rule would test.
 *
 * Reads `booking_transitions` rather than `booking_workers` because it is the
 * only place that records HOW an assignment happened. A `booking_workers` row
 * does not say whether an admin or the dispatcher created it.
 */
export const DELTA_QUERY = (schema: string): string => `
  SELECT
    bt.provider_uid                              AS provider_uid,
    uc.role::int                                 AS role,
    COALESCE(uc.is_archive, false)               AS is_archived,
    EXISTS (
      SELECT 1 FROM ${schema}.employee_services es
       WHERE es.employee_uid = bt.provider_uid AND es.service_id = so.service_id
      UNION ALL
      SELECT 1 FROM ${schema}.worker_service_applications wsa
       WHERE wsa.worker_uid = bt.provider_uid AND wsa.service_id = so.service_id
         AND wsa.status = 'approved'
    )                                            AS has_capability
  FROM ${schema}.booking_transitions bt
  JOIN ${schema}.bookings b        ON b.id = bt.booking_id
  LEFT JOIN ${schema}.service_options so ON so.id = b.service_option_id
  LEFT JOIN ${schema}.user_credentials uc ON uc.uid = bt.provider_uid
  WHERE bt.action = 'AUTO_ASSIGN'
    AND bt.provider_uid IS NOT NULL`;

// ─── Entry point ──────────────────────────────────────────────────────────────

/** The shape an authorized operator should expect. Documentation, not output. */
export const EXAMPLE_REPORT = {
  measuredAt: '2026-08-12T09:00:00.000Z',
  totals: { autoAssignments: 42, wouldBeRefused: 5, refusedPercent: 11.9 },
  byFailure: { ROLE_NOT_PROVIDER: 0, ARCHIVED: 1, NO_CAPABILITY: 4 },
  providers: [
    { provider: 'p_9f2a1c4b7e01', refused: 3, reasons: ['NO_CAPABILITY'] },
    { provider: 'p_1b8d3e5a2f90', refused: 2, reasons: ['ARCHIVED', 'NO_CAPABILITY'] },
  ],
};

async function main(): Promise<void> {
  const resolved = resolveMeasureConfig();
  if (!resolved.usable) {
    console.error(`[legacy-auto-delta] REFUSED: ${resolved.reason}`);
    process.exitCode = 1;
    return;
  }
  const { config } = resolved;

  const pool = new Pool({
    host: config.host, port: config.port, database: config.database,
    user: config.user, password: config.password, max: 1,
    // The server refuses writes for this session, whatever the script asks for.
    options: '-c default_transaction_read_only=on',
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');

    const sql = DELTA_QUERY(config.schema);
    if (!isReadOnlyStatement(sql)) {
      throw new Error('Refusing to send a statement that is not provably read-only');
    }
    const res = await client.query(sql);

    const rows: CandidateRow[] = res.rows.map((r: any) => ({
      providerUid: String(r.provider_uid),
      role: r.role === null || r.role === undefined ? null : Number(r.role),
      isArchived: r.is_archived === true,
      hasCapability: r.has_capability === true,
    }));

    // Stamped after the query rather than inside the report builder, so the
    // builder stays pure and testable.
    console.log(JSON.stringify(buildReport(rows, new Date().toISOString()), null, 2));
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    // No credentials, no host, no driver internals — this may run in a shared
    // terminal.
    console.error('[legacy-auto-delta] failed:', err?.message ?? 'unknown error');
    process.exitCode = 1;
  });
}
