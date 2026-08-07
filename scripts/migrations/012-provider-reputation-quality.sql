-- Command 25: canonical, booking-linked provider reputation and quality.
-- Additive migration. Provider/customer identifiers remain server-resolved.

CREATE TABLE IF NOT EXISTS servana.customer_reviews (
  review_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id VARCHAR(128) NOT NULL,
  customer_uid VARCHAR(128) NOT NULL,
  provider_uid VARCHAR(128) NOT NULL,
  service_id VARCHAR(128),
  overall_rating INTEGER NOT NULL CHECK (overall_rating BETWEEN 1 AND 5),
  public_comment TEXT,
  private_feedback TEXT,
  visibility VARCHAR(30) NOT NULL DEFAULT 'PUBLIC',
  moderation_status VARCHAR(30) NOT NULL DEFAULT 'NOT_REQUIRED',
  client_request_id VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS servana.review_dimension_scores (
  id BIGSERIAL PRIMARY KEY,
  review_id UUID NOT NULL REFERENCES servana.customer_reviews(review_id) ON DELETE CASCADE,
  dimension_key VARCHAR(50) NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  UNIQUE (review_id, dimension_key)
);
CREATE TABLE IF NOT EXISTS servana.review_provider_responses (
  response_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL REFERENCES servana.customer_reviews(review_id) ON DELETE CASCADE,
  provider_uid VARCHAR(128) NOT NULL,
  body TEXT NOT NULL,
  moderation_status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS servana.review_reports (
  report_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID REFERENCES servana.customer_reviews(review_id),
  response_id UUID REFERENCES servana.review_provider_responses(response_id),
  reporter_uid VARCHAR(128) NOT NULL,
  reason VARCHAR(50) NOT NULL,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS servana.provider_rating_aggregates (
  provider_uid VARCHAR(128) PRIMARY KEY,
  average_rating NUMERIC(3,2) NOT NULL DEFAULT 0,
  review_count INTEGER NOT NULL DEFAULT 0,
  rating_1_count INTEGER NOT NULL DEFAULT 0,
  rating_2_count INTEGER NOT NULL DEFAULT 0,
  rating_3_count INTEGER NOT NULL DEFAULT 0,
  rating_4_count INTEGER NOT NULL DEFAULT 0,
  rating_5_count INTEGER NOT NULL DEFAULT 0,
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE servana.customer_reviews
  ADD COLUMN IF NOT EXISTS branch_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS publication_state VARCHAR(32) NOT NULL DEFAULT 'PUBLISHED',
  ADD COLUMN IF NOT EXISTS appeal_state VARCHAR(32) NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS provider_response_state VARCHAR(32) NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS policy_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Older runtime-created tables used narrow CHECK constraints. Command 25 has
-- additional explicit lifecycle states, so widen them in the controlled migration.
ALTER TABLE servana.customer_reviews
  DROP CONSTRAINT IF EXISTS customer_reviews_moderation_status_check,
  DROP CONSTRAINT IF EXISTS customer_reviews_visibility_check;
ALTER TABLE servana.customer_reviews
  ADD CONSTRAINT customer_reviews_visibility_check
    CHECK (visibility IN ('PUBLIC','ANONYMOUS_PUBLIC','PRIVATE')),
  ADD CONSTRAINT customer_reviews_moderation_status_check
    CHECK (moderation_status IN
      ('NOT_REQUIRED','AUTOMATED_CHECKS_PASSED','PENDING','APPROVED','REJECTED',
       'HIDDEN','REMOVED','FLAGGED','REPORTED','REDACTED','RESTORED'));
CREATE UNIQUE INDEX IF NOT EXISTS ux_customer_reviews_request
  ON servana.customer_reviews (customer_uid, client_request_id)
  WHERE client_request_id IS NOT NULL AND deleted_at IS NULL;

-- The legacy unconditional constraint made a soft-withdrawn review impossible
-- to replace even though the service advertised that action.
ALTER TABLE servana.customer_reviews
  DROP CONSTRAINT IF EXISTS customer_reviews_booking_id_customer_uid_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_customer_reviews_active_booking
  ON servana.customer_reviews (booking_id, customer_uid)
  WHERE deleted_at IS NULL AND publication_state NOT IN ('WITHDRAWN','ARCHIVED');

ALTER TABLE servana.review_provider_responses
  ADD COLUMN IF NOT EXISTS client_request_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS publication_state VARCHAR(32) NOT NULL DEFAULT 'PENDING_MODERATION',
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE servana.review_provider_responses
  DROP CONSTRAINT IF EXISTS review_provider_responses_moderation_status_check;
CREATE UNIQUE INDEX IF NOT EXISTS ux_review_provider_response_active
  ON servana.review_provider_responses (review_id, provider_uid)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_review_provider_response_request
  ON servana.review_provider_responses (provider_uid, client_request_id)
  WHERE client_request_id IS NOT NULL;

ALTER TABLE servana.review_reports
  ADD COLUMN IF NOT EXISTS client_request_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS state VARCHAR(32) NOT NULL DEFAULT 'SUBMITTED',
  ADD COLUMN IF NOT EXISTS provider_reason_detail TEXT,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS ux_review_report_provider_review
  ON servana.review_reports (review_id, reporter_uid)
  WHERE review_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_review_report_request
  ON servana.review_reports (reporter_uid, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS servana.review_policy_versions (
  policy_version INTEGER PRIMARY KEY,
  rating_min INTEGER NOT NULL CHECK (rating_min = 1),
  rating_max INTEGER NOT NULL CHECK (rating_max = 5),
  review_window_days INTEGER NOT NULL CHECK (review_window_days > 0),
  edit_window_hours INTEGER NOT NULL CHECK (edit_window_hours > 0),
  response_window_days INTEGER NOT NULL CHECK (response_window_days > 0),
  appeal_window_days INTEGER NOT NULL CHECK (appeal_window_days > 0),
  minimum_dimension_sample INTEGER NOT NULL CHECK (minimum_dimension_sample > 0),
  effective_at TIMESTAMPTZ NOT NULL,
  retired_at TIMESTAMPTZ
);
INSERT INTO servana.review_policy_versions
  (policy_version, rating_min, rating_max, review_window_days, edit_window_hours,
   response_window_days, appeal_window_days, minimum_dimension_sample, effective_at)
VALUES (1, 1, 5, 14, 48, 30, 14, 5, NOW())
ON CONFLICT (policy_version) DO NOTHING;

CREATE TABLE IF NOT EXISTS servana.review_dimension_definitions (
  dimension_key VARCHAR(50) PRIMARY KEY,
  provider_label VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  is_public BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1
);
INSERT INTO servana.review_dimension_definitions
  (dimension_key, provider_label, description)
VALUES
  ('SERVICE_QUALITY', 'Service quality', 'How well the agreed service was delivered.'),
  ('PROFESSIONALISM', 'Professionalism', 'Professional and respectful service conduct.'),
  ('PUNCTUALITY', 'Timeliness', 'Arrival and service timing for the confirmed schedule.'),
  ('COMMUNICATION', 'Communication', 'Clear and appropriate booking communication.'),
  ('CLEANLINESS', 'Cleanliness', 'Care and cleanliness appropriate to the service.'),
  ('SCOPE_ADHERENCE', 'Scope adherence', 'Delivery of the confirmed service scope.')
ON CONFLICT (dimension_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS servana.service_review_dimensions (
  service_id BIGINT NOT NULL REFERENCES servana.services(id),
  dimension_key VARCHAR(50) NOT NULL REFERENCES servana.review_dimension_definitions(dimension_key),
  is_required BOOLEAN NOT NULL DEFAULT FALSE,
  display_order INTEGER NOT NULL DEFAULT 0,
  policy_version INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (service_id, dimension_key)
);

CREATE TABLE IF NOT EXISTS servana.review_moderation_cases (
  case_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL REFERENCES servana.customer_reviews(review_id),
  report_id UUID REFERENCES servana.review_reports(report_id),
  state VARCHAR(32) NOT NULL DEFAULT 'PENDING_REVIEW',
  public_effect VARCHAR(32) NOT NULL DEFAULT 'UNCHANGED',
  provider_reason_code VARCHAR(64),
  provider_reason_detail TEXT,
  internal_notes TEXT,
  assigned_admin_uid VARCHAR(128),
  decision_admin_uid VARCHAR(128),
  decision_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_review_open_moderation_case
  ON servana.review_moderation_cases (review_id)
  WHERE state IN ('PENDING_REVIEW','UNDER_REVIEW','ADDITIONAL_INFORMATION_REQUIRED','ESCALATED');

CREATE TABLE IF NOT EXISTS servana.review_appeals (
  appeal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES servana.review_moderation_cases(case_id),
  review_id UUID NOT NULL REFERENCES servana.customer_reviews(review_id),
  provider_uid VARCHAR(128) NOT NULL,
  ground VARCHAR(64) NOT NULL,
  explanation TEXT NOT NULL,
  state VARCHAR(32) NOT NULL DEFAULT 'SUBMITTED',
  provider_reason_code VARCHAR(64),
  provider_reason_detail TEXT,
  internal_notes TEXT,
  client_request_id VARCHAR(128) NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (provider_uid, client_request_id),
  UNIQUE (case_id, provider_uid)
);

CREATE TABLE IF NOT EXISTS servana.review_reputation_events (
  event_id BIGSERIAL PRIMARY KEY,
  review_id UUID NOT NULL REFERENCES servana.customer_reviews(review_id),
  provider_uid VARCHAR(128) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  actor_type VARCHAR(32) NOT NULL,
  actor_uid VARCHAR(128),
  public_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  restricted_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key VARCHAR(160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_review_reputation_event_idempotency
  ON servana.review_reputation_events (provider_uid, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE servana.provider_rating_aggregates
  ADD COLUMN IF NOT EXISTS aggregation_policy_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS aggregate_version BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS servana.provider_service_rating_aggregates (
  provider_uid VARCHAR(128) NOT NULL,
  service_id VARCHAR(128) NOT NULL,
  average_rating NUMERIC(4,3),
  review_count INTEGER NOT NULL DEFAULT 0,
  aggregation_policy_version INTEGER NOT NULL DEFAULT 1,
  aggregate_version BIGINT NOT NULL DEFAULT 1,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider_uid, service_id)
);

CREATE TABLE IF NOT EXISTS servana.provider_quality_actions (
  action_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_uid VARCHAR(128) NOT NULL,
  service_id VARCHAR(128),
  action_type VARCHAR(40) NOT NULL,
  state VARCHAR(32) NOT NULL DEFAULT 'OPEN',
  provider_reason_code VARCHAR(64) NOT NULL,
  provider_reason_detail TEXT NOT NULL,
  is_mandatory BOOLEAN NOT NULL DEFAULT FALSE,
  due_at TIMESTAMPTZ,
  effective_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  policy_version INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_provider_quality_actions_owner
  ON servana.provider_quality_actions (provider_uid, state, effective_at DESC);
