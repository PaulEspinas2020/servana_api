/**
 * adminDashboardService.ts — Admin Operations Dashboard aggregations.
 *
 * All queries are additive read-only projections.
 * Metrics are backend-canonical and deduped by booking_id / provider uid / customer uid.
 * Optional tables (provider_onboarding_cases, provider_catalog_offerings) are queried
 * with try/catch so the dashboard degrades gracefully if they haven't been seeded yet.
 */

import dbQuery from '../db/dbQuery';
import { db } from '../config';

const s = db.schema;

// ── DTOs ─────────────────────────────────────────────────────────────────────

export interface AdminDashboardSnapshot {
  bookingsToday: number;
  unassignedJobs: number;
  inProgressJobs: number;
  completedToday: number;
  revenueToday: number;
  pendingPayments: number;
  pendingProviderApplications: number;
  documentsNeedingReview: number;
  disputes: number;
  systemHealth: 'healthy' | 'degraded' | 'incident' | 'unknown';
}

export interface AdminBookingPipeline {
  total: number;
  new: number;
  awaitingAssignment: number;
  assigned: number;
  accepted: number;
  inProgress: number;
  completed: number;
  cancelled: number;
  disputed: number;
  late: number;
  cancellationsToday: number;
}

export interface AdminProviderHealth {
  totalProviders: number;
  activeProviders: number;
  pendingApplications: number;
  missingDocuments: number;
  missingAvailability: number;
  missingServiceArea: number;
  readyForFinalReview: number;
  suspendedProviders: number;
  archivedProviders: number;
}

export interface AdminPaymentHealth {
  revenueToday: number;
  revenueWeek: number;
  revenueMonth: number;
  pendingCashPayments: number;
  gcashAwaitingApproval: number;
  paymentExceptions: number;
  averageOrderValue: number;
  currency: 'PHP';
}

export interface AdminCustomerHealth {
  totalCustomers: number;
  newCustomersToday: number;
  customersWithActiveBookings: number;
  customersWithPaymentIssues: number;
  customersWithDisputes: number;
}

export interface AdminServiceCatalogHealth {
  activeOfferings: number;
  draftOfferings: number;
  archivedOfferings: number;
  publishBlockers: number;
  mobileProtected: number;
}

export interface AdminRiskAndExceptions {
  lateJobs: number;
  unassignedPaidBookings: number;
  paymentExceptions: number;
  disputes: number;
  cancellationsToday: number;
  catalogPublishBlockers: number;
}

export interface AdminOnboardingHealth {
  queueTotal: number;
  inReview: number;
  readyForFinalReview: number;
  highPriority: number;
  waitingForProvider: number;
}

export interface AdminActionQueueItem {
  id: string;
  type: string;
  title: string;
  description: string;
  severity: 'low' | 'normal' | 'high' | 'urgent';
  count: number;
  route: string;
}

export interface AdminRecentActivityItem {
  id: string;
  type: string;
  title: string;
  description: string | null;
  actorType: string | null;
  entityType: string;
  entityId: string;
  route: string;
  createdAt: string;
}

export interface AdminDashboardOperations {
  snapshot: AdminDashboardSnapshot;
  bookingPipeline: AdminBookingPipeline;
  providerHealth: AdminProviderHealth;
  paymentHealth: AdminPaymentHealth;
  customerHealth: AdminCustomerHealth;
  serviceCatalogHealth: AdminServiceCatalogHealth;
  riskAndExceptions: AdminRiskAndExceptions;
  onboardingHealth: AdminOnboardingHealth;
  actionQueue: AdminActionQueueItem[];
  recentActivity: AdminRecentActivityItem[];
  meta: {
    generatedAt: string;
    timezone: string;
    dateRange: { from: string; to: string };
  };
}

// ── Fallbacks ────────────────────────────────────────────────────────────────

const FALLBACK_CATALOG: AdminServiceCatalogHealth = {
  activeOfferings: 0, draftOfferings: 0, archivedOfferings: 0,
  publishBlockers: 0, mobileProtected: 0,
};

const FALLBACK_ONBOARDING: AdminOnboardingHealth = {
  queueTotal: 0, inReview: 0, readyForFinalReview: 0, highPriority: 0, waitingForProvider: 0,
};

// ── Main aggregation ─────────────────────────────────────────────────────────

export const getOperationsDashboard = async (): Promise<AdminDashboardOperations> => {
  const now = new Date();

  // ── Core query: bookings + payments + providers + customers ────────────────
  const mainSql = `
    WITH
      -- Date reference in Asia/Manila
      dr AS (
        SELECT
          DATE_TRUNC('day',  NOW() AT TIME ZONE 'Asia/Manila') AS day_start,
          DATE_TRUNC('week', NOW() AT TIME ZONE 'Asia/Manila') AS week_start,
          DATE_TRUNC('month',NOW() AT TIME ZONE 'Asia/Manila') AS month_start
      ),

      -- Latest assignment per booking (dedupe booking_workers by recency)
      lw AS (
        SELECT DISTINCT ON (bw.booking_id)
          bw.booking_id,
          bw.status    AS worker_status,
          bw.assigned_at
        FROM ${s}.booking_workers bw
        ORDER BY bw.booking_id, bw.assigned_at DESC NULLS LAST
      ),

      -- Latest payment per booking
      lp AS (
        SELECT DISTINCT ON (p.booking_id)
          p.booking_id,
          p.status    AS pay_status,
          p.method    AS pay_method,
          p.proof_url,
          COALESCE(p.amount, 0)::numeric AS pay_amount,
          p.paid_at
        FROM ${s}.payments p
        ORDER BY p.booking_id, p.id DESC
      ),

      -- Open (unresolved) escalations
      esc AS (
        SELECT DISTINCT booking_id
        FROM ${s}.booking_escalations
        WHERE resolved_at IS NULL
      ),

      -- Operations status projection (not stored — derived at read time)
      bops AS (
        SELECT
          b.id          AS booking_id,
          b.created_at,
          CASE WHEN b.schedule IS NOT NULL AND b.schedule::text <> ''
               THEN b.schedule::text::timestamptz
               ELSE NULL END AS schedule,
          b.user_id,
          b.status      AS raw_status,
          b.worker_uid,
          lp.pay_status,
          lp.pay_method,
          lp.proof_url,
          lp.pay_amount,
          COALESCE(lp.paid_at, b.created_at) AS pay_paid_at,
          (esc.booking_id IS NOT NULL)::boolean AS has_escalation,
          CASE
            WHEN esc.booking_id IS NOT NULL                        THEN 'disputed'
            WHEN b.status = 'COMPLETED'
              OR lw.worker_status = 'COMPLETED'                    THEN 'completed'
            WHEN lw.worker_status = 'IN_PROGRESS'                  THEN 'in_progress'
            WHEN lw.worker_status = 'ACCEPTED'                     THEN 'accepted'
            WHEN lw.worker_status = 'ASSIGNED'                     THEN 'assigned'
            WHEN b.status IN ('CONFIRMED','PAID')
              AND (b.worker_uid IS NULL OR b.worker_uid = '')      THEN 'awaiting_assignment'
            WHEN b.status IN ('CANCELLED','CANCELED')              THEN 'cancelled'
            ELSE 'new'
          END AS ops_status
        FROM ${s}.bookings b
        LEFT JOIN lw  ON lw.booking_id  = b.id
        LEFT JOIN lp  ON lp.booking_id  = b.id
        LEFT JOIN esc ON esc.booking_id = b.id
      ),

      -- Booking aggregations
      ba AS (
        SELECT
          COUNT(DISTINCT booking_id)                                                               AS total_bookings,
          COUNT(DISTINCT booking_id) FILTER (WHERE
            (created_at AT TIME ZONE 'Asia/Manila')::date = (SELECT day_start::date FROM dr))     AS bookings_today,
          COUNT(DISTINCT booking_id) FILTER (WHERE ops_status = 'awaiting_assignment')            AS unassigned_jobs,
          COUNT(DISTINCT booking_id) FILTER (WHERE ops_status IN ('in_progress','accepted'))      AS in_progress_jobs,
          COUNT(DISTINCT booking_id) FILTER (WHERE ops_status = 'completed'
            AND (created_at AT TIME ZONE 'Asia/Manila')::date = (SELECT day_start::date FROM dr)) AS completed_today,
          COUNT(DISTINCT booking_id) FILTER (WHERE ops_status = 'disputed')                       AS disputes,
          COUNT(DISTINCT booking_id) FILTER (WHERE ops_status = 'cancelled'
            AND (created_at AT TIME ZONE 'Asia/Manila')::date = (SELECT day_start::date FROM dr)) AS cancellations_today,
          COUNT(DISTINCT booking_id) FILTER (WHERE pay_status = 'PENDING'
            AND pay_method = 'GCASH' AND proof_url IS NOT NULL)                                   AS gcash_awaiting,
          COUNT(DISTINCT booking_id) FILTER (WHERE pay_method = 'CASH'
            AND pay_status = 'PENDING')                                                            AS pending_cash,
          COUNT(DISTINCT booking_id) FILTER (WHERE pay_status = 'PENDING')                        AS total_pending_payments,
          COUNT(DISTINCT booking_id) FILTER (WHERE pay_status IN ('FAILED','REFUND_PENDING'))     AS payment_exceptions,
          COUNT(DISTINCT booking_id) FILTER (WHERE schedule < NOW()
            AND ops_status NOT IN ('completed','cancelled','disputed'))                            AS late_jobs,
          COUNT(DISTINCT booking_id) FILTER (WHERE ops_status = 'new')                            AS pipeline_new,
          COUNT(DISTINCT booking_id) FILTER (WHERE ops_status = 'awaiting_assignment')            AS pipeline_awaiting,
          COUNT(DISTINCT booking_id) FILTER (WHERE ops_status = 'assigned')                       AS pipeline_assigned,
          COUNT(DISTINCT booking_id) FILTER (WHERE ops_status = 'accepted')                       AS pipeline_accepted,
          COUNT(DISTINCT booking_id) FILTER (WHERE ops_status = 'in_progress')                    AS pipeline_in_progress,
          COUNT(DISTINCT booking_id) FILTER (WHERE ops_status = 'completed')                      AS pipeline_completed,
          COUNT(DISTINCT booking_id) FILTER (WHERE ops_status = 'cancelled')                      AS pipeline_cancelled,
          COUNT(DISTINCT booking_id) FILTER (WHERE ops_status = 'disputed')                       AS pipeline_disputed,
          -- Unassigned PAID bookings specifically (most urgent action item)
          COUNT(DISTINCT booking_id) FILTER (WHERE ops_status = 'awaiting_assignment'
            AND raw_status = 'PAID')                                                               AS unassigned_paid,
          -- Revenue
          COALESCE(SUM(pay_amount) FILTER (WHERE pay_status = 'PAID'
            AND pay_paid_at >= (SELECT day_start FROM dr)), 0)::numeric                           AS revenue_today,
          COALESCE(SUM(pay_amount) FILTER (WHERE pay_status = 'PAID'
            AND pay_paid_at >= (SELECT week_start FROM dr)), 0)::numeric                          AS revenue_week,
          COALESCE(SUM(pay_amount) FILTER (WHERE pay_status = 'PAID'
            AND pay_paid_at >= (SELECT month_start FROM dr)), 0)::numeric                         AS revenue_month,
          CASE
            WHEN COUNT(booking_id) FILTER (WHERE pay_status = 'PAID') > 0
            THEN (COALESCE(SUM(pay_amount) FILTER (WHERE pay_status = 'PAID'), 0)
                  / COUNT(booking_id) FILTER (WHERE pay_status = 'PAID'))::numeric
            ELSE 0::numeric
          END AS avg_order_value,
          -- Customer-booking cross
          COUNT(DISTINCT user_id) FILTER (WHERE
            ops_status NOT IN ('completed','cancelled','disputed'))                                AS customers_with_active_bookings,
          COUNT(DISTINCT user_id) FILTER (WHERE pay_status IN ('FAILED','REFUND_PENDING'))        AS customers_with_payment_issues,
          COUNT(DISTINCT user_id) FILTER (WHERE has_escalation = true)                            AS customers_with_disputes
        FROM bops
      )

    SELECT ba.*
    FROM ba
  `;

  const mainResult = await dbQuery.query(mainSql, []);
  const r = mainResult.rows[0] ?? {};

  const n = (v: unknown): number => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };

  // ── Provider + customer counts (user_credentials — degrade gracefully) ───────
  let totalProviders = 0, activeProviders = 0, suspendedProviders = 0,
      archivedProviders = 0, totalCustomers = 0, newCustomersToday = 0,
      documentsNeedingReview = 0;
  try {
    const paRes = await dbQuery.query(
      `SELECT
         COUNT(*) FILTER (WHERE role::int IN (2,4) AND is_archive = false)                       AS total_providers,
         COUNT(*) FILTER (WHERE role::int IN (2,4) AND is_archive = false AND account_status = 'active')    AS active_providers,
         COUNT(*) FILTER (WHERE role::int IN (2,4) AND is_archive = false AND account_status = 'suspended') AS suspended_providers,
         COUNT(*) FILTER (WHERE role::int IN (2,4) AND is_archive = true)                        AS archived_providers,
         COUNT(*) FILTER (WHERE role::int = 3)                                                   AS total_customers,
         COUNT(*) FILTER (WHERE role::int = 3
           AND created_date >= DATE_TRUNC('day', NOW() AT TIME ZONE 'Asia/Manila'))              AS new_customers_today,
         COUNT(*) FILTER (WHERE role::int IN (2,4) AND is_archive = false AND account_status = 'pending')   AS docs_review
       FROM ${s}.user_credentials`,
      []
    );
    const pa = paRes.rows[0] ?? {};
    totalProviders         = n(pa.total_providers);
    activeProviders        = n(pa.active_providers);
    suspendedProviders     = n(pa.suspended_providers);
    archivedProviders      = n(pa.archived_providers);
    totalCustomers         = n(pa.total_customers);
    newCustomersToday      = n(pa.new_customers_today);
    documentsNeedingReview = n(pa.docs_review);
  } catch { /* user_credentials role column type mismatch — degrade to 0 */ }

  // ── Provider health details (optional tables — degrade gracefully) ──────────
  let missingDocs = 0, missingAvail = 0, missingArea = 0;
  try {
    const phRes = await dbQuery.query(
      `SELECT
         COUNT(*) FILTER (WHERE role::int IN (2,4) AND is_archive = false
           AND NOT EXISTS (SELECT 1 FROM ${s}.worker_requirements wr
                           WHERE wr.worker_uid = uc.uid))  AS missing_docs,
         COUNT(*) FILTER (WHERE role::int IN (2,4) AND is_archive = false
           AND NOT EXISTS (SELECT 1 FROM ${s}.worker_availability wa
                           WHERE wa.worker_uid = uc.uid))  AS missing_avail,
         COUNT(*) FILTER (WHERE role::int IN (2,4) AND is_archive = false
           AND NOT EXISTS (SELECT 1 FROM ${s}.worker_service_areas wsa
                           WHERE wsa.worker_uid = uc.uid)) AS missing_area
       FROM ${s}.user_credentials uc`,
      []
    );
    const ph = phRes.rows[0] ?? {};
    missingDocs  = n(ph.missing_docs);
    missingAvail = n(ph.missing_avail);
    missingArea  = n(ph.missing_area);

    // Accurate docs-pending-review count: providers with at least one requirement
    // that has no final (approved/rejected) non-superseded decision yet.
    // Nested try/catch because provider_requirement_decisions is also lazily created.
    try {
      const drRes = await dbQuery.query(
        `SELECT COUNT(DISTINCT wr.worker_uid) AS docs_pending
         FROM ${s}.worker_requirements wr
         JOIN ${s}.user_credentials uc ON uc.uid = wr.worker_uid
         WHERE uc.role::int IN (2,4) AND uc.is_archive = false
           AND NOT EXISTS (
             SELECT 1 FROM ${s}.provider_requirement_decisions prd
             WHERE prd.worker_requirement_id = wr.id
               AND NOT prd.is_superseded
               AND prd.decision IN ('approved','rejected')
           )`,
        []
      );
      documentsNeedingReview = n(drRes.rows[0]?.docs_pending);
    } catch { /* provider_requirement_decisions not yet created — keep pending-account fallback */ }
  } catch { /* worker_requirements/availability/service_areas may not exist yet */ }

  // ── Pending service applications (optional table) ───────────────────────────
  let pendingApplications = 0;
  try {
    const appsRes = await dbQuery.query(
      `SELECT COUNT(DISTINCT worker_uid) AS cnt
       FROM ${s}.worker_service_applications
       WHERE status = 'pending_review'`,
      []
    );
    pendingApplications = n(appsRes.rows[0]?.cnt);
  } catch { /* worker_service_applications may not exist yet */ }

  // ── Catalog health (optional table) ────────────────────────────────────────
  let catalogHealth: AdminServiceCatalogHealth = FALLBACK_CATALOG;
  try {
    const catRes = await dbQuery.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'active')   AS active_offerings,
         COUNT(*) FILTER (WHERE status = 'draft')    AS draft_offerings,
         COUNT(*) FILTER (WHERE status = 'archived') AS archived_offerings,
         COUNT(*) FILTER (WHERE is_builtin = true)   AS mobile_protected
       FROM ${s}.provider_catalog_offerings`,
      []
    );
    const c = catRes.rows[0] ?? {};
    const draft = n(c.draft_offerings);
    catalogHealth = {
      activeOfferings: n(c.active_offerings),
      draftOfferings: draft,
      archivedOfferings: n(c.archived_offerings),
      publishBlockers: draft,
      mobileProtected: n(c.mobile_protected),
    };
  } catch { /* table not yet seeded */ }

  // ── Onboarding health (optional table) ─────────────────────────────────────
  let onboardingHealth: AdminOnboardingHealth = FALLBACK_ONBOARDING;
  try {
    const obRes = await dbQuery.query(
      `SELECT
         COUNT(*) FILTER (WHERE onboarding_status IN
           ('submitted','queued','in_review','waiting_for_internal_review','ready_for_final_review')) AS queue_total,
         COUNT(*) FILTER (WHERE onboarding_status = 'in_review')              AS in_review,
         COUNT(*) FILTER (WHERE onboarding_status = 'ready_for_final_review') AS ready_for_final_review,
         COUNT(*) FILTER (WHERE priority IN ('high','urgent')
           AND onboarding_status NOT IN ('approved','rejected','withdrawn','expired'))    AS high_priority,
         COUNT(*) FILTER (WHERE waiting_party = 'provider')                   AS waiting_for_provider
       FROM ${s}.provider_onboarding_cases`,
      []
    );
    const ob = obRes.rows[0] ?? {};
    onboardingHealth = {
      queueTotal: n(ob.queue_total),
      inReview: n(ob.in_review),
      readyForFinalReview: n(ob.ready_for_final_review),
      highPriority: n(ob.high_priority),
      waitingForProvider: n(ob.waiting_for_provider),
    };
  } catch { /* table not yet initialized */ }

  // ── Recent activity (booking timeline) ────────────────────────────────────
  let recentActivity: AdminRecentActivityItem[] = [];
  try {
    const actRes = await dbQuery.query(
      `SELECT
         id::text        AS id,
         event_type      AS type,
         title,
         description,
         actor_type,
         booking_id::text AS entity_id,
         created_at
       FROM ${s}.booking_timeline_events
       ORDER BY created_at DESC
       LIMIT 20`,
      []
    );
    recentActivity = actRes.rows.map((row: any) => ({
      id: row.id,
      type: row.type ?? 'event',
      title: row.title ?? 'Booking event',
      description: row.description ?? null,
      actorType: row.actor_type ?? null,
      entityType: 'booking',
      entityId: row.entity_id,
      route: `/portal/job-orders/${row.entity_id}`,
      createdAt: row.created_at?.toISOString?.() ?? String(row.created_at),
    }));
  } catch { /* timeline table may not exist */ }

  // Fallback: if booking_timeline_events doesn't exist yet, surface recent bookings
  if (recentActivity.length === 0) {
    try {
      const bkRes = await dbQuery.query(
        `SELECT b.id::text AS id, b.status AS raw_status, b.created_at
         FROM ${s}.bookings b
         ORDER BY b.created_at DESC
         LIMIT 20`,
        []
      );
      const statusTypeMap: Record<string, string> = {
        CONFIRMED: 'booking_created', PAID: 'payment_submitted',
        COMPLETED: 'job_completed',   CANCELLED: 'booking_cancelled',
        CANCELED: 'booking_cancelled', DISPUTED: 'dispute_opened',
      };
      recentActivity = bkRes.rows.map((row: any) => {
        const st = String(row.raw_status ?? '').toUpperCase();
        const type = statusTypeMap[st] ?? 'booking_created';
        const label = st.charAt(0) + st.slice(1).toLowerCase();
        return {
          id: row.id,
          type,
          title: `Booking ${label}`,
          description: null,
          actorType: null,
          entityType: 'booking',
          entityId: row.id,
          route: `/portal/job-orders/${row.id}`,
          createdAt: row.created_at?.toISOString?.() ?? String(row.created_at),
        };
      });
    } catch { /* bookings table unavailable */ }
  }

  // ── Assemble sections ─────────────────────────────────────────────────────

  const snapshot: AdminDashboardSnapshot = {
    bookingsToday: n(r.bookings_today),
    unassignedJobs: n(r.unassigned_jobs),
    inProgressJobs: n(r.in_progress_jobs),
    completedToday: n(r.completed_today),
    revenueToday: n(r.revenue_today),
    pendingPayments: n(r.total_pending_payments),
    pendingProviderApplications: pendingApplications,
    documentsNeedingReview,
    disputes: n(r.disputes),
    systemHealth: 'healthy',
  };

  const bookingPipeline: AdminBookingPipeline = {
    total: n(r.total_bookings),
    new: n(r.pipeline_new),
    awaitingAssignment: n(r.pipeline_awaiting),
    assigned: n(r.pipeline_assigned),
    accepted: n(r.pipeline_accepted),
    inProgress: n(r.pipeline_in_progress),
    completed: n(r.pipeline_completed),
    cancelled: n(r.pipeline_cancelled),
    disputed: n(r.pipeline_disputed),
    late: n(r.late_jobs),
    cancellationsToday: n(r.cancellations_today),
  };

  const providerHealth: AdminProviderHealth = {
    totalProviders,
    activeProviders,
    pendingApplications,
    missingDocuments: missingDocs,
    missingAvailability: missingAvail,
    missingServiceArea: missingArea,
    readyForFinalReview: onboardingHealth.readyForFinalReview,
    suspendedProviders,
    archivedProviders,
  };

  const paymentHealth: AdminPaymentHealth = {
    revenueToday: n(r.revenue_today),
    revenueWeek: n(r.revenue_week),
    revenueMonth: n(r.revenue_month),
    pendingCashPayments: n(r.pending_cash),
    gcashAwaitingApproval: n(r.gcash_awaiting),
    paymentExceptions: n(r.payment_exceptions),
    averageOrderValue: n(r.avg_order_value),
    currency: 'PHP',
  };

  const customerHealth: AdminCustomerHealth = {
    totalCustomers,
    newCustomersToday,
    customersWithActiveBookings: n(r.customers_with_active_bookings),
    customersWithPaymentIssues: n(r.customers_with_payment_issues),
    customersWithDisputes: n(r.customers_with_disputes),
  };

  const riskAndExceptions: AdminRiskAndExceptions = {
    lateJobs: n(r.late_jobs),
    unassignedPaidBookings: n(r.unassigned_paid),
    paymentExceptions: n(r.payment_exceptions),
    disputes: n(r.disputes),
    cancellationsToday: n(r.cancellations_today),
    catalogPublishBlockers: catalogHealth.publishBlockers,
  };

  // ── Action queue (derived from aggregated counts) ─────────────────────────
  const actionQueue: AdminActionQueueItem[] = [];

  if (n(r.unassigned_paid) > 0) {
    actionQueue.push({
      id: 'unassigned_paid',
      type: 'unassigned_booking',
      title: 'Unassigned Paid Bookings',
      description: `${n(r.unassigned_paid)} paid booking(s) need a provider assigned`,
      severity: 'urgent',
      count: n(r.unassigned_paid),
      route: '/portal/job-orders?operationsStatus=awaiting_assignment',
    });
  }
  if (n(r.gcash_awaiting) > 0) {
    actionQueue.push({
      id: 'gcash_review',
      type: 'payment_review',
      title: 'GCash Proofs Awaiting Approval',
      description: `${n(r.gcash_awaiting)} GCash payment(s) need verification`,
      severity: 'high',
      count: n(r.gcash_awaiting),
      route: '/portal/job-orders?paymentStatus=gcash_review',
    });
  }
  if (n(r.late_jobs) > 0) {
    actionQueue.push({
      id: 'late_jobs',
      type: 'late_job',
      title: 'Late / Overdue Jobs',
      description: `${n(r.late_jobs)} job(s) are past their scheduled time`,
      severity: 'high',
      count: n(r.late_jobs),
      route: '/portal/job-orders?operationsStatus=in_progress',
    });
  }
  if (n(r.disputes) > 0) {
    actionQueue.push({
      id: 'disputes',
      type: 'dispute',
      title: 'Open Disputes / Escalations',
      description: `${n(r.disputes)} booking(s) have unresolved escalations`,
      severity: 'high',
      count: n(r.disputes),
      route: '/portal/job-orders?operationsStatus=disputed',
    });
  }
  if (pendingApplications > 0) {
    actionQueue.push({
      id: 'provider_applications',
      type: 'provider_application',
      title: 'Provider Applications Pending',
      description: `${pendingApplications} provider(s) have service applications awaiting review`,
      severity: 'normal',
      count: pendingApplications,
      route: '/portal/provider-onboarding',
    });
  }
  if (documentsNeedingReview > 0) {
    actionQueue.push({
      id: 'document_review',
      type: 'document_review',
      title: 'Providers Pending Review',
      description: `${documentsNeedingReview} provider(s) submitted for review`,
      severity: 'normal',
      count: documentsNeedingReview,
      route: '/portal/provider-onboarding?filter=documents',
    });
  }
  if (onboardingHealth.readyForFinalReview > 0) {
    actionQueue.push({
      id: 'final_review',
      type: 'onboarding_case',
      title: 'Ready for Final Review',
      description: `${onboardingHealth.readyForFinalReview} onboarding case(s) ready for final approval`,
      severity: 'normal',
      count: onboardingHealth.readyForFinalReview,
      route: '/portal/provider-onboarding',
    });
  }
  if (n(r.payment_exceptions) > 0) {
    actionQueue.push({
      id: 'payment_exceptions',
      type: 'payment_exception',
      title: 'Payment Exceptions',
      description: `${n(r.payment_exceptions)} payment(s) failed or need refund review`,
      severity: 'normal',
      count: n(r.payment_exceptions),
      route: '/portal/job-orders?paymentStatus=payment_exception',
    });
  }
  if (catalogHealth.publishBlockers > 0) {
    actionQueue.push({
      id: 'catalog_blockers',
      type: 'catalog_blocker',
      title: 'Unpublished Service Offerings',
      description: `${catalogHealth.publishBlockers} catalog offering(s) still in draft`,
      severity: 'low',
      count: catalogHealth.publishBlockers,
      route: '/portal/services?status=draft',
    });
  }

  // Sort by severity
  const severityOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
  actionQueue.sort((a, b) =>
    (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4)
  );

  const generatedAt = now.toISOString();

  return {
    snapshot,
    bookingPipeline,
    providerHealth,
    paymentHealth,
    customerHealth,
    serviceCatalogHealth: catalogHealth,
    riskAndExceptions,
    onboardingHealth,
    actionQueue,
    recentActivity,
    meta: {
      generatedAt,
      timezone: 'Asia/Manila',
      dateRange: {
        from: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
        to: generatedAt,
      },
    },
  };
};
