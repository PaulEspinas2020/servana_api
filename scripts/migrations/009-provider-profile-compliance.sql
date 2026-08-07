-- Command 24: canonical provider profile, protected documents, certifications,
-- verification events and compliance state. Apply through the controlled
-- deployment migration runner before enabling the Command 24 API routes.

BEGIN;

ALTER TABLE servana.user_profile
  ADD COLUMN IF NOT EXISTS public_display_name TEXT,
  ADD COLUMN IF NOT EXISTS public_bio TEXT,
  ADD COLUMN IF NOT EXISTS public_skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS public_languages JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS public_experience_summary TEXT,
  ADD COLUMN IF NOT EXISTS legal_address JSONB,
  ADD COLUMN IF NOT EXISTS profile_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS public_profile_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE servana.worker_requirements
  ADD COLUMN IF NOT EXISTS storage_path TEXT,
  ADD COLUMN IF NOT EXISTS mime_type TEXT,
  ADD COLUMN IF NOT EXISTS byte_size INTEGER,
  ADD COLUMN IF NOT EXISTS content_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS client_request_id TEXT,
  ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'legacy_review_required',
  ADD COLUMN IF NOT EXISTS scan_status TEXT NOT NULL DEFAULT 'legacy_review_required',
  ADD COLUMN IF NOT EXISTS issue_date DATE,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS identifier_mask TEXT,
  ADD COLUMN IF NOT EXISTS replacement_for_id INTEGER REFERENCES servana.worker_requirements(id),
  ADD COLUMN IF NOT EXISTS replaced_by_id INTEGER REFERENCES servana.worker_requirements(id),
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS worker_requirements_provider_request_uidx
  ON servana.worker_requirements(worker_uid, client_request_id)
  WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS worker_requirements_provider_type_idx
  ON servana.worker_requirements(worker_uid, requirement_type, uploaded_at DESC);

CREATE TABLE IF NOT EXISTS servana.provider_profile_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_uid TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  submitted_fields JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending_review',
  provider_reason_code TEXT,
  provider_reason_detail TEXT,
  internal_note TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  UNIQUE(provider_uid, client_request_id)
);

CREATE INDEX IF NOT EXISTS provider_profile_revisions_provider_idx
  ON servana.provider_profile_revisions(provider_uid, submitted_at DESC);

CREATE TABLE IF NOT EXISTS servana.provider_certifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_uid TEXT NOT NULL,
  certification_type TEXT NOT NULL,
  issuing_authority TEXT NOT NULL,
  credential_mask TEXT,
  issue_date DATE,
  expires_at TIMESTAMPTZ,
  related_document_id INTEGER REFERENCES servana.worker_requirements(id),
  state TEXT NOT NULL DEFAULT 'under_review',
  renewal_of_id UUID REFERENCES servana.provider_certifications(id),
  client_request_id TEXT NOT NULL,
  provider_reason_code TEXT,
  provider_reason_detail TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider_uid, client_request_id)
);

CREATE INDEX IF NOT EXISTS provider_certifications_provider_idx
  ON servana.provider_certifications(provider_uid, created_at DESC);

CREATE TABLE IF NOT EXISTS servana.provider_verification_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_uid TEXT NOT NULL,
  domain TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT,
  event_type TEXT NOT NULL,
  provider_reason_code TEXT,
  provider_reason_detail TEXT,
  internal_metadata JSONB,
  event_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider_uid, event_key)
);

CREATE INDEX IF NOT EXISTS provider_verification_events_provider_idx
  ON servana.provider_verification_events(provider_uid, created_at DESC);

COMMIT;
