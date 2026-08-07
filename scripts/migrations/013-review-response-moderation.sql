-- Command 25 follow-up: dedicated moderation for provider review responses.
-- Separate from review moderation so response policy never changes the
-- customer's review publication or its contribution to rating aggregates.

CREATE TABLE IF NOT EXISTS servana.review_response_moderation_cases (
  case_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id UUID NOT NULL UNIQUE REFERENCES servana.review_provider_responses(response_id),
  review_id UUID NOT NULL REFERENCES servana.customer_reviews(review_id),
  provider_uid VARCHAR(128) NOT NULL,
  state VARCHAR(32) NOT NULL DEFAULT 'PENDING_REVIEW',
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

CREATE INDEX IF NOT EXISTS idx_review_response_moderation_queue
  ON servana.review_response_moderation_cases (state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_response_moderation_provider
  ON servana.review_response_moderation_cases (provider_uid, created_at DESC);
