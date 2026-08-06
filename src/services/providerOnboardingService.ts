/**
 * Provider Web Onboarding Service
 *
 * Handles:
 *   - provider_onboarding_drafts table (lazy-init) — per-step wizard state
 *   - provider_source_attribution table (lazy-init) — registration channel tracking
 *   - Full onboarding aggregate (draft + requirements + service applications + services)
 *   - Final onboarding submit validation
 *   - Reconciliation diagnostics (admin)
 *
 * Mobile contracts: none of these tables/functions are called from mobile routes.
 */

import dbQuery from '../db/dbQuery';
import { db } from '../config';

const dbSchema = db.schema;

// ── Schema ────────────────────────────────────────────────────────────────────

let schemaReady = false;

export const ensureProviderWebSchema = async (): Promise<void> => {
  if (schemaReady) return;
  try {
    await dbQuery.query(`
      CREATE TABLE IF NOT EXISTS ${dbSchema}.provider_onboarding_drafts (
        uid            TEXT        PRIMARY KEY,
        current_step   TEXT        NOT NULL DEFAULT 'welcome',
        personal_info  JSONB,
        service_ids    JSONB,
        service_area   JSONB,
        availability   JSONB,
        payout         JSONB,
        guidelines     JSONB,
        submitted      BOOLEAN     NOT NULL DEFAULT FALSE,
        submitted_at   TIMESTAMPTZ,
        source_client  TEXT        NOT NULL DEFAULT 'provider_web',
        version        INTEGER     NOT NULL DEFAULT 1,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await dbQuery.query(`
      CREATE TABLE IF NOT EXISTS ${dbSchema}.provider_source_attribution (
        uid                           TEXT        PRIMARY KEY,
        registration_source           TEXT        NOT NULL DEFAULT 'unknown',
        first_seen_source             TEXT        NOT NULL DEFAULT 'unknown',
        last_seen_source              TEXT        NOT NULL DEFAULT 'unknown',
        first_provider_web_seen_at    TIMESTAMPTZ,
        last_provider_web_seen_at     TIMESTAMPTZ,
        first_provider_mobile_seen_at TIMESTAMPTZ,
        last_provider_mobile_seen_at  TIMESTAMPTZ,
        registration_context          TEXT,
        confidence                    TEXT        NOT NULL DEFAULT 'unknown',
        created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    schemaReady = true;
  } catch (err) {
    console.error('[provider-web-onboarding] schema error:', err);
    throw err;
  }
};

// ── Source Attribution ────────────────────────────────────────────────────────

export const upsertSourceAttribution = async (
  uid: string,
  sourceClient: 'provider_web' | 'provider_mobile' | 'admin' | 'unknown',
  isRegistration = false,
  registrationContext?: string,
): Promise<void> => {
  try {
    await ensureProviderWebSchema();
    const now = new Date().toISOString();
    const webCols = sourceClient === 'provider_web'
      ? `, first_provider_web_seen_at = COALESCE(provider_source_attribution.first_provider_web_seen_at, $3::timestamptz)
         , last_provider_web_seen_at = $3::timestamptz`
      : '';
    const mobileCols = sourceClient === 'provider_mobile'
      ? `, first_provider_mobile_seen_at = COALESCE(provider_source_attribution.first_provider_mobile_seen_at, $3::timestamptz)
         , last_provider_mobile_seen_at = $3::timestamptz`
      : '';

    await dbQuery.query(
      `
      INSERT INTO ${dbSchema}.provider_source_attribution
        (uid, registration_source, first_seen_source, last_seen_source,
         registration_context, confidence, created_at, updated_at
         ${sourceClient === 'provider_web' ? ', first_provider_web_seen_at, last_provider_web_seen_at' : ''}
         ${sourceClient === 'provider_mobile' ? ', first_provider_mobile_seen_at, last_provider_mobile_seen_at' : ''}
        )
      VALUES
        ($1, $2, $2, $2, $4, 'confirmed', $3::timestamptz, $3::timestamptz
         ${sourceClient === 'provider_web' ? ', $3::timestamptz, $3::timestamptz' : ''}
         ${sourceClient === 'provider_mobile' ? ', $3::timestamptz, $3::timestamptz' : ''}
        )
      ON CONFLICT (uid) DO UPDATE SET
        last_seen_source   = $2,
        registration_source = CASE WHEN provider_source_attribution.registration_source = 'unknown'
                                   THEN $2
                                   WHEN $5 = TRUE THEN $2
                                   ELSE provider_source_attribution.registration_source END,
        first_seen_source  = COALESCE(provider_source_attribution.first_seen_source, $2),
        confidence         = 'confirmed',
        updated_at         = $3::timestamptz
        ${webCols}
        ${mobileCols}
      `,
      [uid, sourceClient, now, registrationContext ?? null, isRegistration],
    );
  } catch (err) {
    // Non-fatal — never block auth on attribution write
    console.error('[provider-web-onboarding] attribution error:', err);
  }
};

// ── Onboarding Draft ─────────────────────────────────────────────────────────

export const VALID_STEPS = [
  'welcome', 'personal_info', 'services', 'requirements',
  'service_area', 'availability', 'payout', 'guidelines', 'review',
] as const;

export type OnboardingStepKey = typeof VALID_STEPS[number];

export const saveDraftStep = async (
  uid: string,
  step: string,
  payload: Record<string, unknown>,
): Promise<{ version: number }> => {
  await ensureProviderWebSchema();

  const safeStep = VALID_STEPS.find(s => s === step);
  if (!safeStep) {
    throw Object.assign(new Error(`Invalid onboarding step: ${step}`), { statusCode: 422 });
  }

  const col = safeStep === 'personal_info' ? 'personal_info'
    : safeStep === 'services' ? 'service_ids'
    : safeStep === 'service_area' ? 'service_area'
    : safeStep === 'availability' ? 'availability'
    : safeStep === 'payout' ? 'payout'
    : safeStep === 'guidelines' ? 'guidelines'
    : null;

  if (col) {
    await dbQuery.query(
      `
      INSERT INTO ${dbSchema}.provider_onboarding_drafts
        (uid, current_step, ${col}, version, updated_at)
      VALUES ($1, $2, $3, 1, NOW())
      ON CONFLICT (uid) DO UPDATE SET
        current_step = $2,
        ${col}       = $3,
        version      = provider_onboarding_drafts.version + 1,
        updated_at   = NOW()
      `,
      [uid, safeStep, JSON.stringify(payload)],
    );
  } else {
    await dbQuery.query(
      `
      INSERT INTO ${dbSchema}.provider_onboarding_drafts
        (uid, current_step, version, updated_at)
      VALUES ($1, $2, 1, NOW())
      ON CONFLICT (uid) DO UPDATE SET
        current_step = $2,
        version      = provider_onboarding_drafts.version + 1,
        updated_at   = NOW()
      `,
      [uid, safeStep],
    );
  }

  const row = await dbQuery.query(
    `SELECT version FROM ${dbSchema}.provider_onboarding_drafts WHERE uid = $1`,
    [uid],
  );
  return { version: Number(row.rows[0]?.version ?? 1) };
};

// ── Onboarding Aggregate ─────────────────────────────────────────────────────

export const getOnboardingAggregate = async (uid: string) => {
  await ensureProviderWebSchema();

  const [workerRes, reqsRes, appsRes, servicesRes, draftRes] = await Promise.all([
    dbQuery.query(
      `SELECT uid, is_email_verified, is_mobile_verified, account_status,
              first_name, last_name, phone_number
       FROM ${dbSchema}.user_credentials WHERE uid = $1`,
      [uid],
    ),
    dbQuery.query(
      `SELECT id, file_name, uploaded_at, requirement_type
       FROM ${dbSchema}.worker_requirements WHERE worker_uid = $1 ORDER BY uploaded_at ASC`,
      [uid],
    ),
    dbQuery.query(
      `SELECT id, service_id, status, submitted_at, reviewed_at, version
       FROM ${dbSchema}.worker_service_applications WHERE worker_uid = $1
       ORDER BY submitted_at DESC`,
      [uid],
    ),
    dbQuery.query(
      `SELECT es.service_id, s.name FROM ${dbSchema}.employee_services es
       LEFT JOIN ${dbSchema}.services s ON s.id = es.service_id
       WHERE es.employee_uid = $1`,
      [uid],
    ),
    dbQuery.query(
      `SELECT * FROM ${dbSchema}.provider_onboarding_drafts WHERE uid = $1`,
      [uid],
    ),
  ]);

  if (!workerRes.rowCount) {
    throw Object.assign(new Error('Provider not found'), { statusCode: 404 });
  }

  const worker = workerRes.rows[0];
  const draft = draftRes.rows[0] ?? null;
  const requirements = reqsRes.rows;
  const applications = appsRes.rows;
  const activeServices = servicesRes.rows;

  // Derive status
  const hasRequirements = requirements.length > 0;
  const hasPendingOrApprovedApp = applications.some(
    (a: any) => ['pending_review', 'approved', 'action_required'].includes(a.status),
  );
  const hasActiveService = activeServices.length > 0;
  const guidelinesAccepted = !!(draft?.guidelines as any)?.accepted;
  const isSubmitted = draft?.submitted ?? false;

  /**
   * The requirement is a verified IDENTIFIER, not specifically an email.
   *
   * This read `is_email_verified` alone, and the portal supports signing up
   * with a mobile number and no email at all. Those providers could complete
   * all nine steps and were then refused at submit by a blocker they had no way
   * to clear — there was no email to verify. 29 of 70 production providers are
   * mobile-only, and every one of them has `is_mobile_verified = true`: their
   * identity was verified, just not by the channel this check asked about.
   *
   * `is_mobile_verified` had no writer until 86a4684 gave it one and backfilled
   * it, which is why the original check could only look at email.
   */
  const hasVerifiedIdentifier = !!(worker.is_email_verified || worker.is_mobile_verified);

  const completedSteps: string[] = [];
  if (hasVerifiedIdentifier) completedSteps.push('personal_info');
  if (hasRequirements) completedSteps.push('requirements');
  if (hasPendingOrApprovedApp || hasActiveService) completedSteps.push('services');
  if (guidelinesAccepted) completedSteps.push('guidelines');

  let status = 'in_progress';
  let currentStep = draft?.current_step ?? (hasVerifiedIdentifier ? 'requirements' : 'personal_info');

  if (isSubmitted) {
    status = 'pending_review';
    currentStep = 'submitted';
  }

  // Blockers
  const blockers: Array<{ code: string; severity: 'blocking' | 'warning'; label: string }> = [];
  if (!hasVerifiedIdentifier) {
    // `code` deliberately unchanged. Nothing branches on it today — the provider
    // portal is this route's only caller and renders the label — but it is part
    // of a shipped response shape, and renaming it would be a contract change
    // for no gain (§4). The LABEL is what a person reads, so that is corrected.
    blockers.push({
      code: 'email_not_verified',
      severity: 'blocking',
      label: 'No verified email address or mobile number',
    });
  }
  if (!hasRequirements) {
    blockers.push({ code: 'no_documents', severity: 'blocking', label: 'No documents uploaded' });
  }
  if (!hasPendingOrApprovedApp && !hasActiveService) {
    blockers.push({ code: 'no_service_selected', severity: 'blocking', label: 'No service application submitted' });
  }
  if (!guidelinesAccepted) {
    blockers.push({ code: 'guidelines_not_accepted', severity: 'blocking', label: 'Provider guidelines not accepted' });
  }

  return {
    status,
    currentStep,
    completedSteps,
    submittedAt: draft?.submitted_at ?? null,
    version: draft?.version ?? 0,
    blockers,
    readinessScore: Math.round((completedSteps.length / 4) * 100),
    provider: {
      uid: worker.uid,
      firstName: worker.first_name,
      lastName: worker.last_name,
      phoneNumber: worker.phone_number,
      isEmailVerified: worker.is_email_verified,
      // Additive: lets a client explain WHICH identifier is verified.
      isMobileVerified: !!worker.is_mobile_verified,
      accountStatus: worker.account_status,
    },
    draft: draft ? {
      currentStep: draft.current_step,
      personalInfo: draft.personal_info,
      serviceIds: draft.service_ids,
      serviceArea: draft.service_area,
      availability: draft.availability,
      payout: draft.payout,
      guidelines: draft.guidelines,
    } : null,
    requirements: requirements.map((r: any) => ({
      id: r.id,
      fileName: r.file_name,
      uploadedAt: r.uploaded_at,
      requirementType: r.requirement_type ?? null,
    })),
    serviceApplications: applications.map((a: any) => ({
      id: a.id,
      serviceId: a.service_id,
      status: a.status,
      submittedAt: a.submitted_at,
      version: a.version,
    })),
    activeServices: activeServices.map((s: any) => ({
      serviceId: s.service_id,
      name: s.name ?? null,
    })),
  };
};

// ── Submit Onboarding ─────────────────────────────────────────────────────────

export const submitOnboarding = async (uid: string) => {
  await ensureProviderWebSchema();

  const aggregate = await getOnboardingAggregate(uid);

  const blocking = aggregate.blockers.filter(b => b.severity === 'blocking');
  if (blocking.length > 0) {
    throw Object.assign(
      new Error(`Cannot submit: ${blocking.map(b => b.label).join('; ')}`),
      { statusCode: 422, blockers: blocking },
    );
  }

  await dbQuery.query(
    `
    INSERT INTO ${dbSchema}.provider_onboarding_drafts
      (uid, current_step, submitted, submitted_at, version, updated_at)
    VALUES ($1, 'submitted', TRUE, NOW(), 1, NOW())
    ON CONFLICT (uid) DO UPDATE SET
      current_step = 'submitted',
      submitted    = TRUE,
      submitted_at = COALESCE(provider_onboarding_drafts.submitted_at, NOW()),
      version      = provider_onboarding_drafts.version + 1,
      updated_at   = NOW()
    `,
    [uid],
  );

  return {
    status: 'pending_review',
    currentStep: 'submitted',
    completedSteps: aggregate.completedSteps,
    submittedAt: new Date().toISOString(),
  };
};

// ── Reconciliation Report ─────────────────────────────────────────────────────

export const getReconciliationReport = async () => {
  await ensureProviderWebSchema();

  const [totalRes, attrRes, draftRes, activeNoAppRes, pendingAppsRes, activeServicesRes] = await Promise.all([
    dbQuery.query(
      `SELECT COUNT(*) AS total FROM ${dbSchema}.user_credentials WHERE role::int IN (2,4)`,
    ),
    dbQuery.query(
      `
      SELECT COUNT(*) AS with_attribution
      FROM ${dbSchema}.provider_source_attribution psa
      JOIN ${dbSchema}.user_credentials uc ON uc.uid = psa.uid
      WHERE uc.role::int IN (2,4)
      `,
    ),
    dbQuery.query(
      `
      SELECT COUNT(*) AS with_backend_draft
      FROM ${dbSchema}.provider_onboarding_drafts pod
      JOIN ${dbSchema}.user_credentials uc ON uc.uid = pod.uid
      WHERE uc.role::int IN (2,4)
      `,
    ),
    // Active services but no approved service application (legacy direct inserts)
    dbQuery.query(
      `
      SELECT uc.uid, uc.first_name, uc.last_name, COUNT(es.service_id) AS active_service_count
      FROM ${dbSchema}.employee_services es
      JOIN ${dbSchema}.user_credentials uc ON uc.uid = es.employee_uid
      WHERE uc.role::int IN (2,4)
        AND NOT EXISTS (
          SELECT 1 FROM ${dbSchema}.worker_service_applications wsa
          WHERE wsa.worker_uid = es.employee_uid AND wsa.status = 'approved'
        )
      GROUP BY uc.uid, uc.first_name, uc.last_name
      ORDER BY active_service_count DESC
      LIMIT 100
      `,
    ),
    // Providers with pending applications
    dbQuery.query(
      `
      SELECT COUNT(DISTINCT worker_uid) AS with_pending_applications
      FROM ${dbSchema}.worker_service_applications
      WHERE status = 'pending_review'
      `,
    ),
    // Providers with active services
    dbQuery.query(
      `SELECT COUNT(DISTINCT employee_uid) AS with_active_services FROM ${dbSchema}.employee_services`,
    ),
  ]);

  return {
    summary: {
      totalProviders: Number(totalRes.rows[0]?.total ?? 0),
      withSourceAttribution: Number(attrRes.rows[0]?.with_attribution ?? 0),
      withBackendOnboardingDraft: Number(draftRes.rows[0]?.with_backend_draft ?? 0),
      withPendingApplications: Number(pendingAppsRes.rows[0]?.with_pending_applications ?? 0),
      withActiveServices: Number(activeServicesRes.rows[0]?.with_active_services ?? 0),
      activeServicesNoApplicationTrail: activeNoAppRes.rows.length,
    },
    activeServicesNoApplicationTrail: activeNoAppRes.rows.map((r: any) => ({
      uid: r.uid,
      name: `${r.first_name} ${r.last_name}`.trim(),
      activeServiceCount: Number(r.active_service_count),
      status: 'needs_review',
    })),
  };
};
