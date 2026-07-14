/**
 * Admin Onboarding Service — production-grade provider onboarding & approval engine.
 *
 * Tables are created lazily (same pattern as notification.service.ts).
 * All tables are additive — no existing column is modified.
 * Provider Web, Provider Mobile, and Customer Mobile contracts are untouched.
 *
 * Schema created here:
 *   provider_onboarding_cases           — one active case per provider
 *   provider_requirement_definitions    — canonical requirement registry
 *   provider_requirement_decisions      — immutable decisions per worker_requirement
 *   provider_review_reason_codes        — versioned reason code registry
 *   provider_onboarding_notes           — internal + provider-facing messages
 *   provider_onboarding_timeline        — append-only audit events
 */

import dbQuery from '../db/dbQuery';
import { db } from '../config';
import * as notificationService from './notification.service';

const dbSchema = db.schema;

// ── Lazy schema init ──────────────────────────────────────────────────────────

let _schemaReady: Promise<void> | null = null;

export const ensureOnboardingSchema = (): Promise<void> => {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    // ── provider_onboarding_cases ─────────────────────────────────────────────
    await dbQuery.query(`
      CREATE TABLE IF NOT EXISTS ${dbSchema}.provider_onboarding_cases (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider_uid        TEXT NOT NULL,
        onboarding_status   TEXT NOT NULL DEFAULT 'not_started'
                            CHECK (onboarding_status IN (
                              'not_started','in_progress','submitted','queued',
                              'in_review','waiting_for_provider',
                              'waiting_for_internal_review','escalated',
                              'ready_for_final_review','approved','rejected',
                              'withdrawn','expired','suspended','reopened'
                            )),
        priority            TEXT NOT NULL DEFAULT 'normal'
                            CHECK (priority IN ('low','normal','high','urgent')),
        assigned_reviewer   TEXT,
        assigned_team       TEXT,
        waiting_party       TEXT CHECK (waiting_party IN ('provider','servana','external',NULL)),
        submitted_at        TIMESTAMPTZ,
        first_review_due_at TIMESTAMPTZ,
        decision_due_at     TIMESTAMPTZ,
        last_activity_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at        TIMESTAMPTZ,
        reopened_at         TIMESTAMPTZ,
        internal_note       TEXT,
        version             INT NOT NULL DEFAULT 1,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await dbQuery.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS poc_provider_uid_active_idx
      ON ${dbSchema}.provider_onboarding_cases (provider_uid)
      WHERE onboarding_status NOT IN ('approved','rejected','withdrawn','expired')
    `);
    await dbQuery.query(`
      CREATE INDEX IF NOT EXISTS poc_status_idx
      ON ${dbSchema}.provider_onboarding_cases (onboarding_status, last_activity_at DESC)
    `);
    await dbQuery.query(`
      CREATE INDEX IF NOT EXISTS poc_priority_idx
      ON ${dbSchema}.provider_onboarding_cases (priority, submitted_at ASC NULLS LAST)
    `);

    // ── provider_requirement_definitions ──────────────────────────────────────
    await dbQuery.query(`
      CREATE TABLE IF NOT EXISTS ${dbSchema}.provider_requirement_definitions (
        id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code                      TEXT UNIQUE NOT NULL,
        def_version               INT NOT NULL DEFAULT 1,
        title                     TEXT NOT NULL,
        provider_facing_title     TEXT NOT NULL,
        description               TEXT NOT NULL DEFAULT '',
        category                  TEXT NOT NULL DEFAULT 'other'
                                  CHECK (category IN ('identity','background','qualification',
                                    'profile','financial','service_specific','other')),
        is_required               BOOLEAN NOT NULL DEFAULT true,
        applicable_provider_types JSONB NOT NULL DEFAULT '["2","4"]',
        accepted_mime_types       JSONB NOT NULL DEFAULT '["image/jpeg","image/png","application/pdf"]',
        max_file_size_bytes       BIGINT NOT NULL DEFAULT 5242880,
        min_files                 INT NOT NULL DEFAULT 1,
        max_files                 INT NOT NULL DEFAULT 3,
        provider_instructions     TEXT NOT NULL DEFAULT '',
        reviewer_instructions     TEXT NOT NULL DEFAULT '',
        is_active                 BOOLEAN NOT NULL DEFAULT true,
        effective_from            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        effective_until           TIMESTAMPTZ,
        created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── provider_requirement_decisions ────────────────────────────────────────
    await dbQuery.query(`
      CREATE TABLE IF NOT EXISTS ${dbSchema}.provider_requirement_decisions (
        id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        worker_requirement_id       BIGINT NOT NULL,
        provider_uid                TEXT NOT NULL,
        requirement_definition_code TEXT,
        decision                    TEXT NOT NULL
                                    CHECK (decision IN (
                                      'approved','rejected','needs_resubmission','escalated'
                                    )),
        reason_code                 TEXT,
        provider_message            TEXT,
        internal_rationale          TEXT,
        reviewer_uid                TEXT NOT NULL,
        decided_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expected_req_version        INT,
        is_superseded               BOOLEAN NOT NULL DEFAULT false,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await dbQuery.query(`
      CREATE INDEX IF NOT EXISTS prd_provider_uid_idx
      ON ${dbSchema}.provider_requirement_decisions (provider_uid, decided_at DESC)
    `);
    await dbQuery.query(`
      CREATE INDEX IF NOT EXISTS prd_req_id_idx
      ON ${dbSchema}.provider_requirement_decisions (worker_requirement_id)
    `);

    // ── provider_review_reason_codes ──────────────────────────────────────────
    await dbQuery.query(`
      CREATE TABLE IF NOT EXISTS ${dbSchema}.provider_review_reason_codes (
        code                    TEXT PRIMARY KEY,
        domain                  TEXT NOT NULL,
        applicable_decisions    JSONB NOT NULL DEFAULT '[]',
        internal_label          TEXT NOT NULL,
        provider_facing_title   TEXT NOT NULL,
        provider_facing_body    TEXT NOT NULL,
        suggested_correction    TEXT NOT NULL DEFAULT '',
        requires_free_text      BOOLEAN NOT NULL DEFAULT false,
        requires_escalation     BOOLEAN NOT NULL DEFAULT false,
        provider_may_resubmit   BOOLEAN NOT NULL DEFAULT true,
        is_sensitive            BOOLEAN NOT NULL DEFAULT false,
        is_active               BOOLEAN NOT NULL DEFAULT true,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── provider_onboarding_notes ─────────────────────────────────────────────
    await dbQuery.query(`
      CREATE TABLE IF NOT EXISTS ${dbSchema}.provider_onboarding_notes (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        case_id        UUID NOT NULL,
        author_uid     TEXT NOT NULL,
        note_type      TEXT NOT NULL DEFAULT 'internal'
                       CHECK (note_type IN ('internal','provider_message','escalation')),
        body           TEXT NOT NULL,
        is_provider_visible BOOLEAN NOT NULL DEFAULT false,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await dbQuery.query(`
      CREATE INDEX IF NOT EXISTS pon_case_id_idx
      ON ${dbSchema}.provider_onboarding_notes (case_id, created_at DESC)
    `);

    // ── provider_onboarding_timeline ──────────────────────────────────────────
    await dbQuery.query(`
      CREATE TABLE IF NOT EXISTS ${dbSchema}.provider_onboarding_timeline (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        case_id          UUID,
        provider_uid     TEXT NOT NULL,
        actor_uid        TEXT,
        actor_role       INT,
        action           TEXT NOT NULL,
        domain           TEXT NOT NULL DEFAULT 'case',
        target_id        TEXT,
        prev_state       TEXT,
        next_state       TEXT,
        reason_code      TEXT,
        internal_reason  TEXT,
        provider_message TEXT,
        result_version   INT,
        source_client    TEXT NOT NULL DEFAULT 'admin',
        metadata         JSONB NOT NULL DEFAULT '{}',
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await dbQuery.query(`
      CREATE INDEX IF NOT EXISTS pot_case_id_idx
      ON ${dbSchema}.provider_onboarding_timeline (case_id, created_at DESC)
    `);
    await dbQuery.query(`
      CREATE INDEX IF NOT EXISTS pot_provider_uid_idx
      ON ${dbSchema}.provider_onboarding_timeline (provider_uid, created_at DESC)
    `);
  })().catch(err => {
    _schemaReady = null;
    throw err;
  });
  return _schemaReady;
};

// ── Seed reason codes (idempotent) ────────────────────────────────────────────

export const seedReasonCodes = async () => {
  await ensureOnboardingSchema();
  const codes = [
    // Requirement domain
    { code: 'req_unreadable', domain: 'requirement', decisions: ['rejected','needs_resubmission'], label: 'Document Unreadable', title: 'Document could not be read', body: 'The uploaded file is blurry, incomplete, or could not be opened. Please upload a clear, complete copy.', correction: 'Upload a high-quality scan or photo.', sensitive: false },
    { code: 'req_expired', domain: 'requirement', decisions: ['rejected','needs_resubmission'], label: 'Document Expired', title: 'Document has expired', body: 'The submitted document is past its expiry date.', correction: 'Submit a current, valid document.', sensitive: false },
    { code: 'req_wrong_type', domain: 'requirement', decisions: ['rejected','needs_resubmission'], label: 'Wrong Document Type', title: 'Wrong document type submitted', body: 'This file does not match the required document for this step.', correction: 'Re-read the instructions and submit the correct document.', sensitive: false },
    { code: 'req_name_mismatch', domain: 'requirement', decisions: ['rejected','needs_resubmission'], label: 'Name Mismatch', title: 'Name on document does not match profile', body: 'The name on your document does not match the name on your profile. Please update your profile or submit a document that matches.', correction: 'Ensure your legal name matches your registered profile.', sensitive: false },
    { code: 'req_pages_missing', domain: 'requirement', decisions: ['needs_resubmission'], label: 'Incomplete Document', title: 'Required pages are missing', body: 'Your document is missing required pages. Please resubmit a complete copy.', correction: 'Submit all pages of the document.', sensitive: false },
    { code: 'req_additional_info', domain: 'requirement', decisions: ['needs_resubmission'], label: 'Additional Info Needed', title: 'More information needed', body: 'We need additional information or a supporting document to complete the review.', correction: 'Follow the specific instructions in the reviewer message.', sensitive: false, requires_free: true },
    { code: 'req_escalated_review', domain: 'requirement', decisions: ['escalated'], label: 'Escalated for Review', title: 'Your document is under further review', body: 'Your submission requires additional internal review. We will update you shortly.', correction: 'No action required at this time.', sensitive: true },
    // Service application domain
    { code: 'app_missing_requirement', domain: 'service_application', decisions: ['rejected'], label: 'Missing Required Requirement', title: 'Required documents not yet approved', body: 'A required document for this service application has not been approved yet. Please ensure all required documents are submitted and approved first.', correction: 'Complete your requirements review before applying for services.', sensitive: false },
    { code: 'app_service_conflict', domain: 'service_application', decisions: ['rejected'], label: 'Service Already Active', title: 'You already have this service', body: 'You are already approved for this service.', correction: 'No action needed — you are already active.', sensitive: false },
    { code: 'app_insufficient_qualification', domain: 'service_application', decisions: ['rejected'], label: 'Insufficient Qualification', title: 'Qualifications do not meet service requirements', body: 'Your current qualifications or requirements do not meet the criteria for this service.', correction: 'Ensure all service-specific requirements are submitted and approved.', sensitive: false },
    // Final onboarding domain
    { code: 'final_blockers_remain', domain: 'final_onboarding', decisions: ['rejected'], label: 'Blocking Items Remain', title: 'Your application has incomplete items', body: 'There are still outstanding items that need to be resolved before your account can be activated. Please check your portal for specific requirements.', correction: 'Complete all required steps shown in your portal.', sensitive: false },
    { code: 'final_policy_decision', domain: 'final_onboarding', decisions: ['rejected'], label: 'Policy Decision', title: 'Application not approved at this time', body: 'After review, we are unable to approve your application at this time.', correction: 'You may reapply in the future. Contact support for details.', sensitive: true },
    { code: 'final_identity_unresolved', domain: 'final_onboarding', decisions: ['rejected','escalated'], label: 'Identity Issue', title: 'Identity verification is pending', body: 'We need to verify additional identity information before your account can be activated.', correction: 'Contact support for guidance.', sensitive: true },
    { code: 'final_document_incomplete', domain: 'final_onboarding', decisions: ['rejected'], label: 'Documents Incomplete', title: 'Required documents are missing or incomplete', body: 'One or more required documents were not submitted, are expired, or could not be verified. All required documents must be complete before your account can be activated.', correction: 'Resubmit all required documents. Contact support if you need assistance.', sensitive: false },
    { code: 'final_document_fraudulent', domain: 'final_onboarding', decisions: ['rejected'], label: 'Document Integrity Issue', title: 'Document verification failed', body: 'We were unable to verify the authenticity of one or more submitted documents. We take document integrity seriously and cannot proceed with this application.', correction: 'Contact support if you believe this is an error.', sensitive: true },
    { code: 'final_service_not_approved', domain: 'final_onboarding', decisions: ['rejected'], label: 'No Approved Services', title: 'No approved service application on record', body: 'Your account does not have any approved service applications. At least one active service is required to complete onboarding.', correction: 'Submit a service application and ensure it is approved before final review.', sensitive: false },
    { code: 'final_background_check_failed', domain: 'final_onboarding', decisions: ['rejected'], label: 'Background Check Failed', title: 'Background verification was not successful', body: 'We could not complete background verification for your application. This is required before account activation.', correction: 'Contact support for guidance on next steps.', sensitive: true },
    { code: 'final_duplicate_account', domain: 'final_onboarding', decisions: ['rejected'], label: 'Duplicate Account', title: 'Duplicate account detected', body: 'Our records indicate an existing account associated with this identity. Only one active provider account is permitted per person.', correction: 'Contact support if you believe this is an error.', sensitive: true },
    { code: 'final_geographic_restriction', domain: 'final_onboarding', decisions: ['rejected'], label: 'Geographic Restriction', title: 'Service area not currently supported', body: 'Your location is outside our current service area. We are unable to activate accounts in this area at this time.', correction: 'Check our website for service area updates. Contact support if your area becomes available.', sensitive: false },
    { code: 'final_eligibility_criteria', domain: 'final_onboarding', decisions: ['rejected'], label: 'Eligibility Not Met', title: 'Eligibility requirements not met', body: 'After reviewing your application, your profile does not meet the minimum eligibility requirements for a provider account at this time.', correction: 'Review our provider requirements and contact support if your situation changes.', sensitive: false },
  ];

  for (const c of codes) {
    await dbQuery.query(
      `INSERT INTO ${dbSchema}.provider_review_reason_codes
         (code, domain, applicable_decisions, internal_label, provider_facing_title,
          provider_facing_body, suggested_correction, requires_free_text,
          requires_escalation, is_sensitive, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
       ON CONFLICT (code) DO NOTHING`,
      [
        c.code, c.domain,
        JSON.stringify(c.decisions),
        c.label, c.title, c.body, c.correction,
        (c as any).requires_free ?? false,
        (c as any).sensitive_escalation ?? false,
        (c as any).sensitive ?? false,
      ]
    );
  }
};

// ── Seed requirement definitions (idempotent) ─────────────────────────────────

export const seedRequirementDefinitions = async () => {
  await ensureOnboardingSchema();
  const defs = [
    {
      code: 'gov_id',
      title: 'Government-Issued ID',
      providerTitle: 'Government ID',
      description: 'A valid Philippine government-issued photo ID.',
      category: 'identity',
      instructions: 'Upload a clear photo or scan of any valid government-issued ID (front and back). Accepted: PhilSys ID, Driver\'s License, Passport, UMID, SSS, PRC.',
      reviewer: 'Verify name matches profile. Check expiry where applicable. Flag if blurry or tampered.',
    },
    {
      code: 'nbi_clearance',
      title: 'NBI Clearance',
      providerTitle: 'NBI Clearance',
      description: 'Valid National Bureau of Investigation clearance.',
      category: 'background',
      instructions: 'Upload your NBI Clearance. Must be dated within 12 months.',
      reviewer: 'Check name matches profile. Verify issue date is within 12 months. Look for any derogatory findings.',
    },
    {
      code: 'profile_photo',
      title: 'Profile Photo',
      providerTitle: 'Profile Photo',
      description: 'Clear headshot photo for provider profile.',
      category: 'profile',
      required: false,
      instructions: 'Upload a clear, professional headshot. Plain background preferred.',
      reviewer: 'Check clarity and appropriateness.',
    },
    {
      code: 'bank_account',
      title: 'Bank Account or E-Wallet',
      providerTitle: 'Bank Account or E-Wallet',
      description: 'Proof of bank account or e-wallet for payouts.',
      category: 'financial',
      required: false,
      instructions: 'Upload a screenshot or photo of your bank passbook, account certificate, or e-wallet app showing account name and number.',
      reviewer: 'Verify name matches profile. Do not store raw account numbers in notes.',
    },
  ];

  for (const d of defs) {
    await dbQuery.query(
      `INSERT INTO ${dbSchema}.provider_requirement_definitions
         (code, title, provider_facing_title, description, category,
          is_required, provider_instructions, reviewer_instructions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (code) DO NOTHING`,
      [d.code, d.title, d.providerTitle, d.description, d.category,
       (d as any).required ?? true, d.instructions, d.reviewer]
    );
  }
};

// ── Case management ───────────────────────────────────────────────────────────

const ensureCase = async (providerUid: string): Promise<any> => {
  await ensureOnboardingSchema();

  // Check for existing active case
  const existing = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.provider_onboarding_cases WHERE provider_uid = $1
     ORDER BY created_at DESC LIMIT 1`,
    [providerUid]
  );
  if (existing.rowCount) return existing.rows[0];

  // Auto-create case based on provider's current account_status
  const provRes = await dbQuery.query(
    `SELECT uid, account_status, is_email_verified, created_date
     FROM ${dbSchema}.user_credentials WHERE uid = $1 LIMIT 1`,
    [providerUid]
  );
  if (!provRes.rowCount) throw Object.assign(new Error('Provider not found'), { statusCode: 404 });

  const prov = provRes.rows[0];
  const reqRes = await dbQuery.query(
    `SELECT COUNT(*) FROM ${dbSchema}.worker_requirements WHERE worker_uid = $1`,
    [providerUid]
  );
  const hasReqs = Number(reqRes.rows[0].count) > 0;

  let status = 'not_started';
  if (prov.account_status === 'active') status = 'approved';
  else if (prov.account_status === 'rejected') status = 'rejected';
  else if (prov.account_status === 'suspended') status = 'suspended';
  else if (hasReqs || prov.is_email_verified) status = 'submitted';
  else if (prov.is_email_verified) status = 'in_progress';

  const res = await dbQuery.query(
    `INSERT INTO ${dbSchema}.provider_onboarding_cases
       (provider_uid, onboarding_status, submitted_at, last_activity_at, version)
     VALUES ($1, $2, $3, NOW(), 1)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [providerUid, status, hasReqs ? new Date() : null]
  );
  return res.rows[0] ?? (await dbQuery.query(
    `SELECT * FROM ${dbSchema}.provider_onboarding_cases WHERE provider_uid = $1 ORDER BY created_at DESC LIMIT 1`,
    [providerUid]
  )).rows[0];
};

// ── Queue listing ─────────────────────────────────────────────────────────────

export interface QueueFilter {
  status?: string;
  priority?: string;
  assignedReviewer?: string;
  search?: string;
  waitingParty?: string;
  page?: number;
  limit?: number;
}

export const getQueueSummary = async () => {
  await ensureOnboardingSchema();

  const res = await dbQuery.query(
    `SELECT
       COUNT(*) FILTER (WHERE uc.role::int IN (2,4) AND (poc.onboarding_status IS NULL OR poc.onboarding_status = 'submitted')) AS new_submissions,
       COUNT(*) FILTER (WHERE poc.onboarding_status = 'in_review') AS in_review,
       COUNT(*) FILTER (WHERE poc.onboarding_status = 'waiting_for_provider') AS waiting_provider,
       COUNT(*) FILTER (WHERE poc.onboarding_status = 'waiting_for_internal_review') AS waiting_internal,
       COUNT(*) FILTER (WHERE poc.onboarding_status = 'escalated') AS escalated,
       COUNT(*) FILTER (WHERE poc.onboarding_status = 'ready_for_final_review') AS ready_final,
       COUNT(*) FILTER (WHERE poc.priority IN ('high','urgent') AND poc.onboarding_status NOT IN ('approved','rejected','withdrawn','expired')) AS high_priority,
       COUNT(*) FILTER (WHERE poc.assigned_reviewer IS NULL AND poc.onboarding_status IN ('submitted','queued','in_review')) AS unassigned
     FROM ${dbSchema}.user_credentials uc
     LEFT JOIN ${dbSchema}.provider_onboarding_cases poc ON poc.provider_uid = uc.uid
     WHERE uc.role::int IN (2,4) AND uc.is_archive = false`,
    []
  );

  const r = res.rows[0] ?? {};
  return {
    newSubmissions: Number(r.new_submissions ?? 0),
    inReview: Number(r.in_review ?? 0),
    waitingProvider: Number(r.waiting_provider ?? 0),
    waitingInternal: Number(r.waiting_internal ?? 0),
    escalated: Number(r.escalated ?? 0),
    readyForFinalReview: Number(r.ready_final ?? 0),
    highPriority: Number(r.high_priority ?? 0),
    unassigned: Number(r.unassigned ?? 0),
  };
};

export const listCases = async (filter: QueueFilter = {}) => {
  await ensureOnboardingSchema();

  const { status, priority, assignedReviewer, search, waitingParty, page = 1, limit = 30 } = filter;
  const offset = (page - 1) * limit;
  const params: any[] = [];
  const where: string[] = ['uc.role::int IN (2,4)', 'uc.is_archive = false'];

  if (status) { params.push(status); where.push(`poc.onboarding_status = $${params.length}`); }
  if (priority) { params.push(priority); where.push(`poc.priority = $${params.length}`); }
  if (assignedReviewer) { params.push(assignedReviewer); where.push(`poc.assigned_reviewer = $${params.length}`); }
  if (waitingParty) { params.push(waitingParty); where.push(`poc.waiting_party = $${params.length}`); }
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    const p = params.length;
    where.push(`(LOWER(uc.first_name||' '||uc.last_name) LIKE $${p} OR LOWER(uc.email) LIKE $${p})`);
  }

  const whereClause = `WHERE ${where.join(' AND ')}`;
  params.push(limit, offset);
  const limitP = params.length - 1;
  const offsetP = params.length;

  const [rowsRes, countRes] = await Promise.all([
    dbQuery.query(
      `SELECT
         poc.id AS case_id,
         poc.onboarding_status,
         poc.priority,
         poc.assigned_reviewer,
         poc.waiting_party,
         poc.submitted_at,
         poc.last_activity_at,
         poc.version,
         uc.uid AS provider_uid,
         uc.first_name,
         uc.last_name,
         uc.email,
         uc.phone_number,
         uc.account_status,
         uc.is_email_verified,
         up.photo_url,
         (SELECT COUNT(*) FROM ${dbSchema}.worker_requirements wr WHERE wr.worker_uid = uc.uid) AS req_count,
         (SELECT COUNT(*) FROM ${dbSchema}.worker_service_applications wsa WHERE wsa.worker_uid = uc.uid AND wsa.status = 'pending_review') AS pending_apps,
         (SELECT COUNT(*) FROM ${dbSchema}.employee_services es WHERE es.employee_uid = uc.uid) AS active_services
       FROM ${dbSchema}.user_credentials uc
       LEFT JOIN ${dbSchema}.provider_onboarding_cases poc ON poc.provider_uid = uc.uid
       LEFT JOIN ${dbSchema}.user_profile up ON up.uid = uc.uid
       ${whereClause}
       ORDER BY CASE poc.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                poc.submitted_at ASC NULLS LAST
       LIMIT $${limitP} OFFSET $${offsetP}`,
      params
    ),
    dbQuery.query(
      `SELECT COUNT(*)
       FROM ${dbSchema}.user_credentials uc
       LEFT JOIN ${dbSchema}.provider_onboarding_cases poc ON poc.provider_uid = uc.uid
       ${whereClause}`,
      params.slice(0, -2)
    ),
  ]);

  const rows = rowsRes.rows.map((r: any) => ({
    caseId: r.case_id ?? null,
    providerUid: r.provider_uid,
    fullName: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || r.email,
    email: r.email,
    phoneNumber: r.phone_number ?? null,
    photoUrl: r.photo_url ?? null,
    accountStatus: r.account_status ?? 'pending',
    isEmailVerified: r.is_email_verified,
    onboardingStatus: r.onboarding_status ?? 'not_started',
    priority: r.priority ?? 'normal',
    assignedReviewer: r.assigned_reviewer ?? null,
    waitingParty: r.waiting_party ?? null,
    submittedAt: r.submitted_at ?? null,
    lastActivityAt: r.last_activity_at ?? null,
    version: r.version ?? 0,
    reqCount:     Number(r.req_count    ?? 0),
    pendingApps:  Number(r.pending_apps ?? 0),
    activeServices: Number(r.active_services ?? 0),
  }));

  return { rows, total: Number(countRes.rows[0]?.count ?? 0), page, limit };
};

// ── Case detail ───────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const getCaseDetail = async (caseIdOrProviderUid: string) => {
  await ensureOnboardingSchema();

  // Try by case UUID first (skip if not a valid UUID — avoids 22P02 when a
  // provider UID is passed directly, which the queue does when caseId is null)
  let caseRes = { rows: [] as any[], rowCount: 0 } as any;
  if (UUID_RE.test(caseIdOrProviderUid)) {
    caseRes = await dbQuery.query(
      `SELECT * FROM ${dbSchema}.provider_onboarding_cases WHERE id = $1 LIMIT 1`,
      [caseIdOrProviderUid]
    );
  }
  if (!caseRes.rowCount) {
    caseRes = await dbQuery.query(
      `SELECT * FROM ${dbSchema}.provider_onboarding_cases WHERE provider_uid = $1 ORDER BY created_at DESC LIMIT 1`,
      [caseIdOrProviderUid]
    );
  }

  let c = caseRes.rows[0];
  if (!c) {
    // Auto-create if provider exists but has no case
    c = await ensureCase(caseIdOrProviderUid);
  }
  if (!c) throw Object.assign(new Error('Case not found'), { statusCode: 404 });

  const [provRes, reqsRes, appsRes, svcCountRes, histRes] = await Promise.all([
    dbQuery.query(
      `SELECT uc.uid, uc.first_name, uc.last_name, uc.email, uc.phone_number,
              uc.role, uc.account_status, uc.is_archive, uc.is_email_verified, uc.created_date,
              up.photo_url
       FROM ${dbSchema}.user_credentials uc
       LEFT JOIN ${dbSchema}.user_profile up ON up.uid = uc.uid
       WHERE uc.uid = $1 LIMIT 1`,
      [c.provider_uid]
    ),
    dbQuery.query(
      `SELECT wr.id, wr.worker_uid, wr.file_url, wr.file_name, wr.uploaded_at, wr.requirement_type,
              prd.code AS def_code, prd.title AS def_title, prd.category AS def_category,
              prd.provider_facing_title,
              COALESCE(latest_dec.decision,'pending_review') AS current_decision,
              latest_dec.id AS decision_id,
              latest_dec.reason_code,
              latest_dec.provider_message,
              latest_dec.decided_at,
              latest_dec.reviewer_uid AS decision_reviewer_uid
       FROM ${dbSchema}.worker_requirements wr
       LEFT JOIN ${dbSchema}.provider_requirement_definitions prd
         ON prd.code = wr.requirement_type
       LEFT JOIN LATERAL (
         SELECT id, decision, reason_code, provider_message, decided_at, reviewer_uid
         FROM ${dbSchema}.provider_requirement_decisions prd2
         WHERE prd2.worker_requirement_id = wr.id AND NOT prd2.is_superseded
         ORDER BY prd2.decided_at DESC LIMIT 1
       ) latest_dec ON true
       WHERE wr.worker_uid = $1
       ORDER BY wr.uploaded_at DESC`,
      [c.provider_uid]
    ),
    dbQuery.query(
      `SELECT wsa.id, wsa.service_id, wsa.status, wsa.submitted_at,
              '' AS category, s.name AS service_name
       FROM ${dbSchema}.worker_service_applications wsa
       LEFT JOIN ${dbSchema}.services s ON s.id = wsa.service_id
       WHERE wsa.worker_uid = $1
       ORDER BY wsa.submitted_at DESC`,
      [c.provider_uid]
    ),
    dbQuery.query(
      `SELECT COUNT(*) FROM ${dbSchema}.employee_services WHERE employee_uid = $1`,
      [c.provider_uid]
    ),
    // Full decision history for all requirements — grouped in JS after fetch
    dbQuery.query(
      `SELECT worker_requirement_id, id, decision, reason_code, provider_message,
              decided_at, reviewer_uid, is_superseded
       FROM ${dbSchema}.provider_requirement_decisions
       WHERE provider_uid = $1
       ORDER BY worker_requirement_id, decided_at DESC`,
      [c.provider_uid]
    ).catch(() => ({ rows: [] as any[] })),
  ]);

  const prov = provRes.rows[0];
  if (!prov) throw Object.assign(new Error('Provider not found'), { statusCode: 404 });

  const activeServiceCount = Number(svcCountRes.rows[0]?.count ?? 0);

  // Group decision history by requirement ID
  const histMap = new Map<number, any[]>();
  for (const h of (histRes as any).rows ?? []) {
    const list = histMap.get(h.worker_requirement_id) ?? [];
    list.push(h);
    histMap.set(h.worker_requirement_id, list);
  }

  return {
    case: {
      id: c.id,
      providerUid: c.provider_uid,
      onboardingStatus: c.onboarding_status,
      priority: c.priority,
      assignedReviewer: c.assigned_reviewer ?? null,
      assignedTeam: c.assigned_team ?? null,
      waitingParty: c.waiting_party ?? null,
      submittedAt: c.submitted_at ?? null,
      firstReviewDueAt: c.first_review_due_at ?? null,
      decisionDueAt: c.decision_due_at ?? null,
      lastActivityAt: c.last_activity_at,
      completedAt: c.completed_at ?? null,
      reopenedAt: c.reopened_at ?? null,
      internalNote: c.internal_note ?? null,
      version: c.version,
    },

    provider: {
      uid: prov.uid,
      fullName: `${prov.first_name ?? ''} ${prov.last_name ?? ''}`.trim() || prov.email,
      email: prov.email,
      phoneNumber: prov.phone_number ?? null,
      photoUrl: prov.photo_url ?? null,
      role: prov.role,
      accountStatus: prov.account_status ?? 'pending',
      isEmailVerified: prov.is_email_verified,
      isArchive: prov.is_archive,
      createdAt: prov.created_date ?? null,
    },

    requirements: reqsRes.rows.map((r: any) => {
      const fullHistory: any[] = histMap.get(Number(r.id)) ?? [];
      return {
        id: r.id,
        requirementType: r.requirement_type ?? null,
        fileName: r.file_name ?? null,
        fileUrl: r.file_url ?? null,
        uploadedAt: r.uploaded_at ?? null,
        classification: (r.requirement_type ? 'canonically_typed' : 'legacy_null_type') as 'canonically_typed' | 'legacy_null_type',
        currentDecision: r.current_decision ?? 'pending_review',
        latestDecision: r.decision_id ? {
          id: r.decision_id,
          decision: r.current_decision,
          reasonCode: r.reason_code ?? null,
          providerMessage: r.provider_message ?? null,
          reviewerUid: r.decision_reviewer_uid ?? '',
          decidedAt: r.decided_at,
          isSuperseded: false,
        } : null,
        decisionHistory: fullHistory.map((h: any) => ({
          id: h.id,
          decision: h.decision,
          reasonCode: h.reason_code ?? null,
          providerMessage: h.provider_message ?? null,
          reviewerUid: h.reviewer_uid ?? '',
          decidedAt: h.decided_at,
          isSuperseded: h.is_superseded,
        })),
      };
    }),

    services: appsRes.rows.map((r: any) => ({
      id: r.id,
      categoryName: r.category ?? '',
      serviceName: r.service_name ?? '',
      status: r.status,
    })),

    activeServices: activeServiceCount,
    pendingApplications: appsRes.rows.filter((r: any) => r.status === 'pending_review').length,
  };
};

// ── Case status transition ────────────────────────────────────────────────────

const VALID_TRANSITIONS: Record<string, string[]> = {
  not_started: ['in_progress', 'submitted'],
  in_progress: ['submitted', 'withdrawn'],
  submitted: ['queued', 'in_review', 'rejected', 'waiting_for_provider'],
  queued: ['in_review', 'waiting_for_provider'],
  in_review: ['waiting_for_provider', 'waiting_for_internal_review', 'escalated', 'ready_for_final_review', 'rejected'],
  waiting_for_provider: ['in_review', 'submitted', 'expired'],
  waiting_for_internal_review: ['in_review', 'escalated'],
  escalated: ['in_review', 'ready_for_final_review', 'rejected'],
  ready_for_final_review: ['approved', 'rejected', 'escalated'],
  rejected: ['reopened'],
  reopened: ['in_review', 'submitted'],
  suspended: ['in_review', 'rejected'],
};

const transitionCase = async (
  caseId: string,
  newStatus: string,
  expectedVersion: number,
  actorUid: string,
  reason?: string,
  providerMsg?: string,
) => {
  const caseRes = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.provider_onboarding_cases WHERE id = $1 LIMIT 1`,
    [caseId]
  );
  if (!caseRes.rowCount) throw Object.assign(new Error('Case not found'), { statusCode: 404 });
  const c = caseRes.rows[0];
  if (c.version !== expectedVersion) throw Object.assign(new Error(`Version conflict: expected ${expectedVersion}, got ${c.version}`), { statusCode: 409 });

  const allowed = VALID_TRANSITIONS[c.onboarding_status] ?? [];
  if (!allowed.includes(newStatus)) {
    throw Object.assign(new Error(`Cannot transition from '${c.onboarding_status}' to '${newStatus}'`), { statusCode: 422 });
  }

  const now = new Date();
  const updates: string[] = [];
  const vals: any[] = [newStatus, now, c.version + 1, caseId];

  if (newStatus === 'approved' || newStatus === 'rejected') {
    updates.push(`completed_at = $${vals.length + 1}`); vals.push(now);
  }
  if (newStatus === 'reopened') {
    updates.push(`reopened_at = $${vals.length + 1}`); vals.push(now);
    updates.push(`completed_at = NULL`);
  }

  const extraSet = updates.length ? ', ' + updates.join(', ') : '';
  const updated = await dbQuery.query(
    `UPDATE ${dbSchema}.provider_onboarding_cases
     SET onboarding_status = $1, last_activity_at = $2, version = $3 ${extraSet}
     WHERE id = $4 RETURNING *`,
    vals
  );

  await writeTimeline({
    caseId,
    providerUid: c.provider_uid,
    actorUid,
    actorRole: 1,
    action: `case_status_changed_to_${newStatus}`,
    domain: 'case',
    targetId: caseId,
    prevState: c.onboarding_status,
    nextState: newStatus,
    reasonCode: reason ?? null,
    internalReason: reason ?? null,
    providerMessage: providerMsg ?? null,
    resultVersion: c.version + 1,
  });

  return updated.rows[0];
};

// ── Assignment ────────────────────────────────────────────────────────────────

export const assignCase = async (caseId: string, reviewerUid: string | null, actorUid: string, reason?: string) => {
  await ensureOnboardingSchema();
  const c = await dbQuery.query(`SELECT * FROM ${dbSchema}.provider_onboarding_cases WHERE id = $1 LIMIT 1`, [caseId]);
  if (!c.rowCount) throw Object.assign(new Error('Case not found'), { statusCode: 404 });
  const prev = c.rows[0];

  await dbQuery.query(
    `UPDATE ${dbSchema}.provider_onboarding_cases
     SET assigned_reviewer = $1, last_activity_at = NOW(), version = version + 1
     WHERE id = $2`,
    [reviewerUid, caseId]
  );
  await writeTimeline({
    caseId, providerUid: prev.provider_uid, actorUid, actorRole: 1,
    action: reviewerUid ? 'case_assigned' : 'case_unassigned',
    domain: 'case', targetId: caseId,
    prevState: prev.assigned_reviewer ?? 'unassigned',
    nextState: reviewerUid ?? 'unassigned',
    internalReason: reason,
    resultVersion: prev.version + 1,
  });
  return { caseId, assignedReviewer: reviewerUid };
};

export const setPriority = async (caseId: string, priority: string, actorUid: string) => {
  await ensureOnboardingSchema();
  const valid = ['low', 'normal', 'high', 'urgent'];
  if (!valid.includes(priority)) throw Object.assign(new Error('Invalid priority'), { statusCode: 400 });
  const c = await dbQuery.query(`SELECT * FROM ${dbSchema}.provider_onboarding_cases WHERE id = $1 LIMIT 1`, [caseId]);
  if (!c.rowCount) throw Object.assign(new Error('Case not found'), { statusCode: 404 });
  const prev = c.rows[0];
  await dbQuery.query(
    `UPDATE ${dbSchema}.provider_onboarding_cases SET priority = $1, version = version + 1 WHERE id = $2`,
    [priority, caseId]
  );
  await writeTimeline({
    caseId, providerUid: prev.provider_uid, actorUid, actorRole: 1,
    action: 'case_priority_changed', domain: 'case', targetId: caseId,
    prevState: prev.priority, nextState: priority, resultVersion: prev.version + 1,
  });
  return { caseId, priority };
};

// ── Requirement decision ──────────────────────────────────────────────────────

export const decideRequirement = async (
  requirementId: number,
  decision: 'approved' | 'rejected' | 'needs_resubmission' | 'escalated',
  actorUid: string,
  opts: { reasonCode?: string; providerMessage?: string; internalRationale?: string } = {}
) => {
  await ensureOnboardingSchema();

  const reqRes = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.worker_requirements WHERE id = $1 LIMIT 1`,
    [requirementId]
  );
  if (!reqRes.rowCount) throw Object.assign(new Error('Requirement not found'), { statusCode: 404 });
  const req = reqRes.rows[0];

  // Resolve human-readable label for provider-facing notification body
  let docLabel = req.file_name ?? 'your document';
  if (req.requirement_type) {
    const defRes = await dbQuery.query(
      `SELECT provider_facing_title FROM ${dbSchema}.provider_requirement_definitions WHERE code = $1 LIMIT 1`,
      [req.requirement_type]
    ).catch(() => ({ rows: [] as any[] }));
    docLabel = (defRes as any).rows[0]?.provider_facing_title ?? req.requirement_type;
  }

  // Supersede prior non-superseded decisions for this requirement
  await dbQuery.query(
    `UPDATE ${dbSchema}.provider_requirement_decisions SET is_superseded = true
     WHERE worker_requirement_id = $1 AND NOT is_superseded`,
    [requirementId]
  );

  const decRes = await dbQuery.query(
    `INSERT INTO ${dbSchema}.provider_requirement_decisions
       (worker_requirement_id, provider_uid, requirement_definition_code, decision,
        reason_code, provider_message, internal_rationale, reviewer_uid)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [requirementId, req.worker_uid, req.requirement_type ?? null, decision,
     opts.reasonCode ?? null, opts.providerMessage ?? null,
     opts.internalRationale ?? null, actorUid]
  );

  // Write timeline
  const c = await dbQuery.query(
    `SELECT id FROM ${dbSchema}.provider_onboarding_cases WHERE provider_uid = $1 ORDER BY created_at DESC LIMIT 1`,
    [req.worker_uid]
  );
  await writeTimeline({
    caseId: c.rows[0]?.id ?? null,
    providerUid: req.worker_uid,
    actorUid, actorRole: 1,
    action: `requirement_${decision}`,
    domain: 'requirement',
    targetId: String(requirementId),
    nextState: decision,
    reasonCode: opts.reasonCode,
    providerMessage: opts.providerMessage,
    internalReason: opts.internalRationale,
    metadata: { fileName: req.file_name, requirementType: req.requirement_type },
  });

  // Send provider notification for decisions
  let providerNotified = false;
  if (decision !== 'escalated') {
    const msgMap: Record<string, { title: string; body: string; type: string; severity: string }> = {
      approved: {
        title: 'Document Approved',
        body: `Your ${docLabel} has been approved.`,
        type: 'verification',
        severity: 'success',
      },
      rejected: {
        title: 'Document Not Accepted',
        body: opts.providerMessage ?? `Your ${docLabel} was not accepted. Please check your portal for details.`,
        type: 'verification',
        severity: 'warning',
      },
      needs_resubmission: {
        title: 'Action Required: Resubmit Document',
        body: opts.providerMessage ?? `Please resubmit your ${docLabel}.`,
        type: 'requirement_review',
        severity: 'warning',
      },
    };
    const msg = msgMap[decision];
    if (msg) {
      try {
        const notification = await notificationService.createNotification(req.worker_uid, {
          notificationKey: `req-dec:${requirementId}:${decision}:v1`,
          type: msg.type,
          severity: msg.severity,
          title: msg.title,
          safeBody: msg.body,
          safeContextLabel: 'Requirements',
          route: {
            routeLabel: 'View Requirements',
            commandsRoute: ['/provider/requirements'],
            requiresAccessCheck: false,
            contextType: 'requirement',
          },
          canMarkRead: true,
          canDismiss: decision === 'approved',
        });
        providerNotified = notification !== null;
      } catch {
        // Notification failure must not fail the decision
      }
    }
  }

  return { ...decRes.rows[0], providerNotified };
};

// ── Readiness calculation ─────────────────────────────────────────────────────

export const calculateReadiness = async (providerUid: string) => {
  await ensureOnboardingSchema();

  const [provRes, reqsRes, appsRes, servRes] = await Promise.all([
    dbQuery.query(
      `SELECT uid, is_email_verified, account_status FROM ${dbSchema}.user_credentials WHERE uid = $1 LIMIT 1`,
      [providerUid]
    ),
    dbQuery.query(
      `SELECT wr.id, wr.requirement_type, wr.file_name,
              COALESCE(latest_dec.decision,'pending_review') AS current_decision
       FROM ${dbSchema}.worker_requirements wr
       LEFT JOIN LATERAL (
         SELECT decision FROM ${dbSchema}.provider_requirement_decisions
         WHERE worker_requirement_id = wr.id AND NOT is_superseded
         ORDER BY decided_at DESC LIMIT 1
       ) latest_dec ON true
       WHERE wr.worker_uid = $1`,
      [providerUid]
    ),
    dbQuery.query(
      `SELECT status FROM ${dbSchema}.worker_service_applications WHERE worker_uid = $1`,
      [providerUid]
    ),
    dbQuery.query(
      `SELECT COUNT(*) FROM ${dbSchema}.employee_services WHERE employee_uid = $1`,
      [providerUid]
    ),
  ]);

  const prov = provRes.rows[0];
  const reqs = reqsRes.rows;
  const apps = appsRes.rows;
  const activeServices = Number(servRes.rows[0]?.count ?? 0);

  const blockers: Array<{ code: string; severity: 'blocking' | 'warning'; label: string }> = [];

  if (!prov?.is_email_verified) {
    blockers.push({ code: 'missing_email_verification', severity: 'blocking', label: 'Email not verified' });
  }

  if (reqs.length === 0) {
    blockers.push({ code: 'missing_required_requirement', severity: 'blocking', label: 'No documents uploaded' });
  } else {
    const pendingReqs = reqs.filter((r: any) => r.current_decision === 'pending_review');
    const rejectedReqs = reqs.filter((r: any) => ['rejected', 'needs_resubmission'].includes(r.current_decision));
    const legacyReqs = reqs.filter((r: any) => !r.requirement_type);

    if (pendingReqs.length > 0) {
      blockers.push({ code: 'requirement_pending_review', severity: 'blocking', label: `${pendingReqs.length} document(s) pending review` });
    }
    if (rejectedReqs.length > 0) {
      blockers.push({ code: 'requirement_rejected', severity: 'blocking', label: `${rejectedReqs.length} document(s) rejected or need resubmission` });
    }
    if (legacyReqs.length > 0) {
      blockers.push({ code: 'requirement_legacy_ambiguous', severity: 'warning', label: `${legacyReqs.length} document(s) have no type classification` });
    }
  }

  const pendingApps = apps.filter((a: any) => a.status === 'pending_review');
  const rejectedApps = apps.filter((a: any) => a.status === 'rejected');

  if (pendingApps.length > 0) {
    blockers.push({ code: 'service_application_pending', severity: 'blocking', label: `${pendingApps.length} service application(s) pending review` });
  }
  if (rejectedApps.length > 0) {
    blockers.push({ code: 'service_application_rejected', severity: 'warning', label: `${rejectedApps.length} service application(s) rejected` });
  }

  if (activeServices === 0) {
    blockers.push({ code: 'no_active_service', severity: 'blocking', label: 'No approved active services' });
  }

  // Catalog association — warn on unmapped/ambiguous (additive check, non-blocking)
  try {
    const catalogRes = await dbQuery.query(
      `
      SELECT
        COUNT(DISTINCT es.service_id)   AS service_count,
        COUNT(DISTINCT m.offering_id)   AS offering_count
      FROM ${dbSchema}.employee_services es
      LEFT JOIN ${dbSchema}.provider_catalog_offering_mappings m ON m.service_id = es.service_id
      WHERE es.employee_uid = $1
      `,
      [providerUid],
    );
    const catRow = catalogRes.rows[0];
    if (catRow) {
      const svcCount = Number(catRow.service_count ?? 0);
      const offCount = Number(catRow.offering_count ?? 0);
      if (svcCount > 0 && offCount === 0) {
        blockers.push({ code: 'catalog_unmapped', severity: 'warning', label: 'Services have no catalog mapping — review required' });
      } else if (svcCount > 0 && offCount < svcCount) {
        blockers.push({ code: 'catalog_partially_mapped', severity: 'warning', label: 'Some services cannot be matched to a catalog offering' });
      }
    }
  } catch {
    // Non-fatal: catalog table may not exist yet on older environments
  }

  const blockingCount = blockers.filter(b => b.severity === 'blocking').length;
  const isReady = blockingCount === 0;

  return {
    providerUid,
    isReady,
    readinessStatus: isReady ? 'ready' : 'not_ready',
    blockingCount,
    warningCount: blockers.filter(b => b.severity === 'warning').length,
    blockers,
    checks: {
      emailVerified: prov?.is_email_verified ?? false,
      allRequirementsApproved:
        reqs.length > 0 && reqs.every((r: any) => r.current_decision === 'approved'),
      hasActiveService: activeServices > 0,
    },
    summary: {
      emailVerified: prov?.is_email_verified ?? false,
      requirementsUploaded: reqs.length,
      requirementsApproved: reqs.filter((r: any) => r.current_decision === 'approved').length,
      serviceApplications: apps.length,
      approvedApplications: apps.filter((a: any) => a.status === 'approved').length,
      activeServices,
    },
  };
};

// ── Final approval ────────────────────────────────────────────────────────────

export const finalApproveProvider = async (
  caseId: string,
  expectedVersion: number,
  adminUid: string,
  internalNote?: string
) => {
  await ensureOnboardingSchema();

  const caseRes = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.provider_onboarding_cases WHERE id = $1 LIMIT 1`,
    [caseId]
  );
  if (!caseRes.rowCount) throw Object.assign(new Error('Case not found'), { statusCode: 404 });
  const c = caseRes.rows[0];

  // Recalculate readiness immediately before committing — must be ready
  const readiness = await calculateReadiness(c.provider_uid);
  if (!readiness.isReady) {
    throw Object.assign(
      new Error(`Cannot approve: ${readiness.blockingCount} blocking item(s) remain.`),
      { statusCode: 422, blockers: readiness.blockers }
    );
  }

  await dbQuery.query('BEGIN');
  try {
    // Activate provider account
    await dbQuery.query(
      `UPDATE ${dbSchema}.user_credentials SET account_status = 'active' WHERE uid = $1`,
      [c.provider_uid]
    );
    // Transition case to approved
    await transitionCase(caseId, 'approved', expectedVersion, adminUid);
    // Persist internal admin note if provided (never shown to provider)
    if (internalNote && String(internalNote).trim()) {
      await dbQuery.query(
        `INSERT INTO ${dbSchema}.provider_onboarding_notes (case_id, author_uid, note_type, body, is_provider_visible)
         VALUES ($1, $2, 'internal', $3, false)`,
        [caseId, adminUid, String(internalNote).trim()]
      );
    }
    await dbQuery.query('COMMIT');
  } catch (err) {
    await dbQuery.query('ROLLBACK');
    throw err;
  }

  // Notify provider — failure is non-fatal (approval already committed)
  try {
    await notificationService.createNotification(c.provider_uid, {
      type: 'account_activated',
      severity: 'info',
      title: 'Account Activated',
      safeBody: 'Your Servana provider account has been activated. You can now start accepting jobs.',
    });
  } catch { /* non-fatal */ }

  return { caseId, onboardingStatus: 'approved', providerUid: c.provider_uid };
};

export const finalRejectProvider = async (
  caseId: string,
  expectedVersion: number,
  adminUid: string,
  reasonCode: string,
  providerMessage: string,
  internalRationale?: string
) => {
  await ensureOnboardingSchema();
  if (!reasonCode) throw Object.assign(new Error('reasonCode is required'), { statusCode: 400 });
  if (!providerMessage) throw Object.assign(new Error('providerMessage is required'), { statusCode: 400 });

  const caseRes = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.provider_onboarding_cases WHERE id = $1 LIMIT 1`,
    [caseId]
  );
  if (!caseRes.rowCount) throw Object.assign(new Error('Case not found'), { statusCode: 404 });
  const c = caseRes.rows[0];

  await dbQuery.query('BEGIN');
  try {
    await dbQuery.query(
      `UPDATE ${dbSchema}.user_credentials SET account_status = 'rejected' WHERE uid = $1`,
      [c.provider_uid]
    );
    await transitionCase(caseId, 'rejected', expectedVersion, adminUid, reasonCode, providerMessage);
    if (internalRationale) {
      await dbQuery.query(
        `INSERT INTO ${dbSchema}.provider_onboarding_notes (case_id, author_uid, note_type, body, is_provider_visible)
         VALUES ($1, $2, 'internal', $3, false)`,
        [caseId, adminUid, internalRationale]
      );
    }
    await dbQuery.query('COMMIT');
  } catch (err) {
    await dbQuery.query('ROLLBACK');
    throw err;
  }

  try {
    await notificationService.createNotification(c.provider_uid, {
      type: 'account_rejected',
      severity: 'warning',
      title: 'Application Update',
      safeBody: providerMessage,
    });
  } catch { /* non-fatal */ }

  return { caseId, onboardingStatus: 'rejected', providerUid: c.provider_uid };
};

// ── Notes ─────────────────────────────────────────────────────────────────────

export const addNote = async (
  caseId: string,
  authorUid: string,
  body: string,
  noteType: 'internal' | 'provider_message' | 'escalation' = 'internal'
) => {
  await ensureOnboardingSchema();
  if (!body.trim()) throw Object.assign(new Error('Note body is required'), { statusCode: 400 });

  const isProviderVisible = noteType === 'provider_message';
  const res = await dbQuery.query(
    `INSERT INTO ${dbSchema}.provider_onboarding_notes (case_id, author_uid, note_type, body, is_provider_visible)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [caseId, authorUid, noteType, body.trim(), isProviderVisible]
  );
  return res.rows[0];
};

export const getNotes = async (caseId: string, includeInternal = true) => {
  await ensureOnboardingSchema();
  const where = includeInternal ? '' : 'AND is_provider_visible = true';
  const res = await dbQuery.query(
    `SELECT n.*, uc.first_name AS author_first, uc.last_name AS author_last
     FROM ${dbSchema}.provider_onboarding_notes n
     LEFT JOIN ${dbSchema}.user_credentials uc ON uc.uid = n.author_uid
     WHERE n.case_id = $1 ${where}
     ORDER BY n.created_at DESC`,
    [caseId]
  );
  return res.rows.map((r: any) => ({
    id: r.id,
    noteType: r.note_type,
    body: r.body,
    isProviderVisible: r.is_provider_visible,
    authorUid: r.author_uid,
    authorName: r.author_first ? `${r.author_first} ${r.author_last ?? ''}`.trim() : 'Admin',
    createdAt: r.created_at,
  }));
};

// ── Timeline ──────────────────────────────────────────────────────────────────

interface TimelineEvent {
  caseId?: string | null;
  providerUid: string;
  actorUid?: string | null;
  actorRole?: number | null;
  action: string;
  domain?: string;
  targetId?: string | null;
  prevState?: string | null;
  nextState?: string | null;
  reasonCode?: string | null;
  internalReason?: string | null;
  providerMessage?: string | null;
  resultVersion?: number | null;
  metadata?: Record<string, any>;
}

const writeTimeline = async (evt: TimelineEvent) => {
  await dbQuery.query(
    `INSERT INTO ${dbSchema}.provider_onboarding_timeline
       (case_id, provider_uid, actor_uid, actor_role, action, domain, target_id,
        prev_state, next_state, reason_code, internal_reason, provider_message,
        result_version, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      evt.caseId ?? null,
      evt.providerUid,
      evt.actorUid ?? null,
      evt.actorRole ?? null,
      evt.action,
      evt.domain ?? 'case',
      evt.targetId ?? null,
      evt.prevState ?? null,
      evt.nextState ?? null,
      evt.reasonCode ?? null,
      evt.internalReason ?? null,
      evt.providerMessage ?? null,
      evt.resultVersion ?? null,
      JSON.stringify(evt.metadata ?? {}),
    ]
  );
};

export const getTimeline = async (caseId: string, limit = 50) => {
  await ensureOnboardingSchema();
  const caseRes = await dbQuery.query(
    `SELECT provider_uid FROM ${dbSchema}.provider_onboarding_cases WHERE id = $1 LIMIT 1`,
    [caseId]
  );
  const providerUid = caseRes.rows[0]?.provider_uid;
  if (!providerUid) throw Object.assign(new Error('Case not found'), { statusCode: 404 });

  const res = await dbQuery.query(
    `SELECT t.*, uc.first_name AS actor_first, uc.last_name AS actor_last
     FROM ${dbSchema}.provider_onboarding_timeline t
     LEFT JOIN ${dbSchema}.user_credentials uc ON uc.uid = t.actor_uid
     WHERE t.provider_uid = $1
     ORDER BY t.created_at DESC
     LIMIT $2`,
    [providerUid, limit]
  );
  return res.rows.map((r: any) => ({
    id: r.id,
    action: r.action,
    domain: r.domain,
    prevState: r.prev_state ?? null,
    nextState: r.next_state ?? null,
    reasonCode: r.reason_code ?? null,
    providerMessage: r.provider_message ?? null,
    actorUid: r.actor_uid ?? null,
    actorName: r.actor_first ? `${r.actor_first} ${r.actor_last ?? ''}`.trim() : 'System',
    resultVersion: r.result_version ?? null,
    metadata: r.metadata ?? {},
    createdAt: r.created_at,
  }));
};

// ── Reason codes ──────────────────────────────────────────────────────────────

export const getReasonCodes = async (domain?: string) => {
  await ensureOnboardingSchema();
  const where = domain ? `WHERE domain = $1 AND is_active = true` : `WHERE is_active = true`;
  const params = domain ? [domain] : [];
  const res = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.provider_review_reason_codes ${where} ORDER BY domain, code`,
    params
  );
  return res.rows.map((r: any) => ({
    code: r.code,
    domain: r.domain,
    applicableDecisions: r.applicable_decisions ?? [],
    internalLabel: r.internal_label,
    providerFacingTitle: r.provider_facing_title,
    providerFacingBody: r.provider_facing_body,
    suggestedCorrection: r.suggested_correction,
    requiresFreeText: r.requires_free_text,
    requiresEscalation: r.requires_escalation,
    providerMayResubmit: r.provider_may_resubmit,
    isSensitive: r.is_sensitive,
    isActive: r.is_active,
  }));
};

// ── Case status move (exposed for controller) ──────────────────────────────────

export const moveCase = async (
  caseId: string,
  newStatus: string,
  expectedVersion: number,
  actorUid: string,
  reason?: string,
  internalNote?: string,
) => {
  const result = await transitionCase(caseId, newStatus, expectedVersion, actorUid, reason);
  if (internalNote && String(internalNote).trim()) {
    await addNote(caseId, actorUid, String(internalNote).trim(), 'internal');
  }
  return result;
};
export { writeTimeline };
