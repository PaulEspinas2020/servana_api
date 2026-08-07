-- Command 24 P0: recent-auth contact changes, moderated profile media, and
-- deployment migration bookkeeping. Additive only; existing clients continue
-- to read user_credentials/user_profile exactly as before.

BEGIN;

ALTER TABLE servana.worker_requirements
  ADD COLUMN IF NOT EXISTS scanner_engine TEXT;

CREATE TABLE IF NOT EXISTS servana.provider_contact_change_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_uid TEXT NOT NULL,
  contact_kind TEXT NOT NULL CHECK (contact_kind IN ('email', 'mobile')),
  normalized_target TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  verification_secret_hash TEXT,
  state TEXT NOT NULL DEFAULT 'pending_verification'
    CHECK (state IN ('pending_verification', 'verified', 'committed', 'expired', 'cancelled')),
  client_request_id TEXT NOT NULL,
  recent_auth_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  committed_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider_uid, client_request_id)
);

CREATE INDEX IF NOT EXISTS provider_contact_change_active_idx
  ON servana.provider_contact_change_requests(provider_uid, contact_kind, created_at DESC);

CREATE TABLE IF NOT EXISTS servana.provider_profile_media_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_uid TEXT NOT NULL,
  media_kind TEXT NOT NULL DEFAULT 'profile_photo' CHECK (media_kind = 'profile_photo'),
  private_storage_path TEXT NOT NULL,
  published_storage_path TEXT,
  published_url TEXT,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  scan_status TEXT NOT NULL,
  scanner_engine TEXT,
  state TEXT NOT NULL DEFAULT 'under_review'
    CHECK (state IN ('processing', 'under_review', 'approved', 'rejected', 'replaced', 'revoked')),
  client_request_id TEXT NOT NULL,
  provider_reason_code TEXT,
  provider_reason_detail TEXT,
  internal_note TEXT,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider_uid, client_request_id)
);

CREATE INDEX IF NOT EXISTS provider_profile_media_provider_idx
  ON servana.provider_profile_media_submissions(provider_uid, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS provider_profile_media_one_approved_idx
  ON servana.provider_profile_media_submissions(provider_uid, media_kind)
  WHERE state = 'approved';

COMMIT;
