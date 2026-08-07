-- Command 26: canonical provider support, disputes, safety and case management.
-- Additive only. Legacy provider_support_tickets and Mongo safety records remain
-- readable during client migration but are not authoritative for new cases.

CREATE TABLE IF NOT EXISTS servana.support_case_categories (
  category_id VARCHAR(64) PRIMARY KEY,
  domain VARCHAR(32) NOT NULL,
  provider_title VARCHAR(120) NOT NULL,
  provider_description TEXT NOT NULL,
  eligible_source_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_policy VARCHAR(32) NOT NULL DEFAULT 'OPTIONAL',
  default_severity VARCHAR(16) NOT NULL DEFAULT 'STANDARD',
  routing_queue VARCHAR(64) NOT NULL,
  sla_policy_code VARCHAR(64) NOT NULL,
  reopen_window_days INTEGER NOT NULL DEFAULT 14,
  appeal_window_days INTEGER NOT NULL DEFAULT 14,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  policy_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO servana.support_case_categories
  (category_id, domain, provider_title, provider_description, eligible_source_types,
   required_fields, evidence_policy, default_severity, routing_queue, sla_policy_code)
VALUES
  ('GENERAL_APP_HELP','GENERAL','App or feature help','Help using a Servana provider feature.','["ACCOUNT"]','["narrative"]','OPTIONAL','STANDARD','PROVIDER_SUPPORT','SUPPORT_STANDARD'),
  ('TECHNICAL_FAILURE','TECHNICAL','Technical problem','A screen, upload, notification, or workflow is not working.','["ACCOUNT","BOOKING","DOCUMENT","SERVICE"]','["narrative"]','OPTIONAL','STANDARD','TECHNICAL_SUPPORT','SUPPORT_STANDARD'),
  ('BOOKING_ASSIGNMENT','BOOKING_OPERATIONS','Booking assignment issue','Help with an assigned or reassigned booking.','["BOOKING"]','["sourceEntityId","narrative"]','OPTIONAL','STANDARD','BOOKING_OPERATIONS','BOOKING_PRIORITY'),
  ('BOOKING_SCHEDULE','BOOKING_OPERATIONS','Booking schedule issue','Help with a booking schedule or reschedule problem.','["BOOKING","CALENDAR"]','["sourceEntityId","narrative"]','OPTIONAL','STANDARD','BOOKING_OPERATIONS','BOOKING_PRIORITY'),
  ('CUSTOMER_NO_SHOW','BOOKING_DISPUTE','Customer unavailable or no-show','Report a customer no-show or inability to contact the customer.','["BOOKING"]','["sourceEntityId","narrative"]','RECOMMENDED','MODERATE','BOOKING_OPERATIONS','BOOKING_PRIORITY'),
  ('LOCATION_ACCESS','BOOKING_DISPUTE','Cannot access service location','Report an access problem at the service location.','["BOOKING"]','["sourceEntityId","narrative"]','RECOMMENDED','MODERATE','LIVE_OPERATIONS','BOOKING_PRIORITY'),
  ('SCOPE_DISPUTE','BOOKING_DISPUTE','Service scope disagreement','Report requested work outside the confirmed booking scope.','["BOOKING"]','["sourceEntityId","narrative"]','RECOMMENDED','MODERATE','BOOKING_OPERATIONS','BOOKING_PRIORITY'),
  ('COMPLETION_DISPUTE','BOOKING_DISPUTE','Completion disagreement','Dispute how service completion was recorded.','["BOOKING"]','["sourceEntityId","narrative"]','RECOMMENDED','MODERATE','BOOKING_OPERATIONS','BOOKING_PRIORITY'),
  ('CANCELLATION_ATTRIBUTION','BOOKING_DISPUTE','Incorrect cancellation attribution','Dispute who or what caused a booking cancellation.','["BOOKING"]','["sourceEntityId","narrative"]','RECOMMENDED','MODERATE','BOOKING_OPERATIONS','BOOKING_PRIORITY'),
  ('MISSING_EARNING','FINANCE','Missing earning','Report an expected booking earning that is not shown.','["BOOKING","LEDGER_ENTRY"]','["sourceEntityId","narrative"]','OPTIONAL','STANDARD','FINANCE','FINANCE_REVIEW'),
  ('INCORRECT_EARNING','FINANCE','Incorrect earning or commission','Dispute an earning, commission, deduction, or adjustment.','["BOOKING","LEDGER_ENTRY"]','["sourceEntityId","narrative"]','OPTIONAL','STANDARD','FINANCE','FINANCE_REVIEW'),
  ('HELD_EARNING','FINANCE','Held earning','Ask for review of an earning hold.','["BOOKING","PAYOUT"]','["sourceEntityId","narrative"]','OPTIONAL','STANDARD','FINANCE','FINANCE_REVIEW'),
  ('WITHDRAWAL_FAILURE','FINANCE','Withdrawal failed','Report a failed or cancelled withdrawal.','["WITHDRAWAL"]','["sourceEntityId","narrative"]','OPTIONAL','STANDARD','PAYOUTS','FINANCE_REVIEW'),
  ('PAYOUT_NOT_RECEIVED','FINANCE','Payout not received','Report a released payout that has not arrived.','["PAYOUT"]','["sourceEntityId","narrative"]','OPTIONAL','STANDARD','PAYOUTS','FINANCE_REVIEW'),
  ('CASH_VARIANCE','FINANCE','Cash discrepancy','Report a cash collection or remittance discrepancy.','["BOOKING","LEDGER_ENTRY"]','["sourceEntityId","narrative"]','RECOMMENDED','MODERATE','FINANCE','FINANCE_REVIEW'),
  ('THREAT_HARASSMENT','SAFETY','Threat, harassment, or intimidation','Report threatening, abusive, discriminatory, or unwanted conduct.','["BOOKING","MESSAGE"]','["narrative"]','OPTIONAL','HIGH','SAFETY','SAFETY_URGENT'),
  ('UNSAFE_LOCATION','SAFETY','Unsafe work location','Report a location or condition that is unsafe.','["BOOKING"]','["narrative"]','OPTIONAL','HIGH','SAFETY','SAFETY_URGENT'),
  ('INJURY_PROPERTY','SAFETY','Injury or property incident','Report an injury, hazard, near miss, or property incident.','["BOOKING"]','["narrative"]','OPTIONAL','HIGH','SAFETY','SAFETY_URGENT'),
  ('FRAUD_COERCION','SAFETY','Fraud, coercion, or prohibited request','Report fraud, payment diversion, coercion, or prohibited work.','["BOOKING","MESSAGE"]','["narrative"]','OPTIONAL','HIGH','SAFETY','SAFETY_URGENT'),
  ('EMERGENCY_INCIDENT','SAFETY','Immediate safety incident','Create a minimal incident record after moving to safety.','["BOOKING","ACCOUNT"]','[]','OPTIONAL','CRITICAL','SAFETY','SAFETY_CRITICAL'),
  ('DOCUMENT_REVIEW','COMPLIANCE','Document or verification help','Get help with a document, certification, or verification decision.','["DOCUMENT","ACCOUNT"]','["narrative"]','OPTIONAL','STANDARD','COMPLIANCE','COMPLIANCE_REVIEW'),
  ('ACCOUNT_RESTRICTION','COMPLIANCE','Account restriction','Ask for review or guidance about an account restriction.','["ACCOUNT"]','["narrative"]','OPTIONAL','STANDARD','COMPLIANCE','COMPLIANCE_REVIEW'),
  ('SERVICE_READINESS','SERVICES','Service application or readiness','Get help with service qualification, application, or readiness.','["SERVICE"]','["narrative"]','OPTIONAL','STANDARD','SERVICES','SERVICE_REVIEW'),
  ('REVIEW_QUALITY','REVIEWS','Review or quality decision','Get help with a review, moderation, appeal, or quality metric.','["REVIEW"]','["sourceEntityId","narrative"]','OPTIONAL','STANDARD','REVIEWS_MODERATION','REVIEW_REVIEW')
ON CONFLICT (category_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS servana.provider_support_cases (
  case_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_reference VARCHAR(32) UNIQUE NOT NULL,
  provider_uid VARCHAR(128) NOT NULL,
  account_uid VARCHAR(128) NOT NULL,
  organization_id VARCHAR(128),
  branch_id VARCHAR(128),
  domain VARCHAR(32) NOT NULL,
  category_id VARCHAR(64) NOT NULL REFERENCES servana.support_case_categories(category_id),
  subcategory VARCHAR(64),
  title VARCHAR(160) NOT NULL,
  provider_narrative TEXT NOT NULL,
  desired_outcome TEXT,
  provider_state VARCHAR(40) NOT NULL DEFAULT 'SUBMITTED',
  internal_state VARCHAR(48) NOT NULL DEFAULT 'NEW',
  severity VARCHAR(16) NOT NULL DEFAULT 'STANDARD',
  priority VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
  safety_classification VARCHAR(32) NOT NULL DEFAULT 'NONE',
  immediate_danger BOOLEAN NOT NULL DEFAULT FALSE,
  current_queue VARCHAR(64) NOT NULL,
  assigned_role VARCHAR(64),
  assigned_admin_uid VARCHAR(128),
  provider_action_required BOOLEAN NOT NULL DEFAULT FALSE,
  servana_action_required BOOLEAN NOT NULL DEFAULT TRUE,
  sla_policy_code VARCHAR(64) NOT NULL,
  first_response_target_at TIMESTAMPTZ,
  resolution_target_at TIMESTAMPTZ,
  escalation_due_at TIMESTAMPTZ,
  last_provider_visible_update_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  escalation_state VARCHAR(32) NOT NULL DEFAULT 'NONE',
  resolution_code VARCHAR(64),
  appeal_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  appeal_deadline_at TIMESTAMPTZ,
  client_request_id VARCHAR(128) NOT NULL,
  policy_version INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  CONSTRAINT support_case_provider_request_unique UNIQUE(provider_uid, client_request_id)
);
CREATE INDEX IF NOT EXISTS idx_support_case_provider_page
  ON servana.provider_support_cases(provider_uid, updated_at DESC, case_id DESC);
CREATE INDEX IF NOT EXISTS idx_support_case_provider_action
  ON servana.provider_support_cases(provider_uid, provider_action_required, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_case_queue
  ON servana.provider_support_cases(current_queue, internal_state, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_support_case_sla
  ON servana.provider_support_cases(escalation_due_at)
  WHERE internal_state NOT IN ('RESOLVED','CLOSED');

CREATE TABLE IF NOT EXISTS servana.support_case_sources (
  source_link_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES servana.provider_support_cases(case_id) ON DELETE CASCADE,
  provider_uid VARCHAR(128) NOT NULL,
  source_type VARCHAR(32) NOT NULL,
  source_id VARCHAR(128) NOT NULL,
  safe_label VARCHAR(160) NOT NULL,
  source_version VARCHAR(64),
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(case_id, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_support_source_duplicate
  ON servana.support_case_sources(provider_uid, source_type, source_id);

CREATE TABLE IF NOT EXISTS servana.support_case_messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES servana.provider_support_cases(case_id) ON DELETE CASCADE,
  sender_type VARCHAR(24) NOT NULL,
  sender_uid VARCHAR(128),
  provider_visible_body TEXT NOT NULL,
  client_request_id VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(case_id, sender_type, client_request_id)
);
CREATE INDEX IF NOT EXISTS idx_support_messages_case
  ON servana.support_case_messages(case_id, created_at, message_id);

CREATE TABLE IF NOT EXISTS servana.support_case_internal_notes (
  note_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES servana.provider_support_cases(case_id) ON DELETE CASCADE,
  admin_uid VARCHAR(128) NOT NULL,
  note_body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS servana.support_case_events (
  event_id BIGSERIAL PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES servana.provider_support_cases(case_id) ON DELETE CASCADE,
  event_type VARCHAR(64) NOT NULL,
  actor_type VARCHAR(24) NOT NULL,
  actor_uid VARCHAR(128),
  provider_visible BOOLEAN NOT NULL DEFAULT TRUE,
  provider_label VARCHAR(160),
  public_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  restricted_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key VARCHAR(160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(case_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_support_events_case
  ON servana.support_case_events(case_id, created_at, event_id);

CREATE TABLE IF NOT EXISTS servana.support_case_attachments (
  attachment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES servana.provider_support_cases(case_id) ON DELETE CASCADE,
  provider_uid VARCHAR(128) NOT NULL,
  private_storage_path TEXT NOT NULL,
  safe_file_name VARCHAR(180) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  byte_size BIGINT NOT NULL,
  content_sha256 CHAR(64) NOT NULL,
  scan_status VARCHAR(24) NOT NULL,
  scanner_engine VARCHAR(80),
  evidence_class VARCHAR(32) NOT NULL DEFAULT 'STANDARD',
  state VARCHAR(24) NOT NULL DEFAULT 'AVAILABLE',
  client_request_id VARCHAR(128) NOT NULL,
  retention_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider_uid, client_request_id),
  UNIQUE(case_id, content_sha256)
);

CREATE TABLE IF NOT EXISTS servana.support_case_escalations (
  escalation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES servana.provider_support_cases(case_id) ON DELETE CASCADE,
  escalation_type VARCHAR(32) NOT NULL,
  source_queue VARCHAR(64) NOT NULL,
  destination_queue VARCHAR(64) NOT NULL,
  trigger_code VARCHAR(64) NOT NULL,
  state VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
  created_by_uid VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_support_active_escalation
  ON servana.support_case_escalations(case_id, escalation_type, destination_queue)
  WHERE state = 'ACTIVE';

CREATE TABLE IF NOT EXISTS servana.support_case_resolutions (
  resolution_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES servana.provider_support_cases(case_id) ON DELETE CASCADE,
  resolution_code VARCHAR(64) NOT NULL,
  provider_explanation TEXT NOT NULL,
  internal_explanation TEXT,
  source_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  approval_state VARCHAR(24) NOT NULL DEFAULT 'APPROVED',
  applied_by_uid VARCHAR(128) NOT NULL,
  applied_by_role VARCHAR(64) NOT NULL,
  appeal_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  client_request_id VARCHAR(128) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(case_id, client_request_id)
);

CREATE TABLE IF NOT EXISTS servana.support_case_appeals (
  appeal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES servana.provider_support_cases(case_id) ON DELETE CASCADE,
  provider_uid VARCHAR(128) NOT NULL,
  resolution_id UUID NOT NULL REFERENCES servana.support_case_resolutions(resolution_id),
  ground VARCHAR(64) NOT NULL,
  explanation TEXT NOT NULL,
  state VARCHAR(32) NOT NULL DEFAULT 'SUBMITTED',
  client_request_id VARCHAR(128) NOT NULL,
  provider_reason_code VARCHAR(64),
  provider_reason_detail TEXT,
  internal_notes TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(provider_uid, client_request_id),
  UNIQUE(case_id, resolution_id)
);
