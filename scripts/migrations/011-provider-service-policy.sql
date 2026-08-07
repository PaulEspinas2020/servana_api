-- Command 24 / Command 23 P0 integration: canonical provider-type,
-- branch, area and qualification policy for provider catalog offerings.

BEGIN;

CREATE TABLE IF NOT EXISTS servana.provider_document_types (
  document_type_id TEXT PRIMARY KEY,
  provider_label TEXT NOT NULL,
  category TEXT NOT NULL,
  expiry_policy TEXT NOT NULL CHECK (expiry_policy IN ('none','optional','required')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO servana.provider_document_types
  (document_type_id, provider_label, category, expiry_policy)
VALUES
  ('valid_id', 'Valid Government ID', 'identity', 'optional'),
  ('nbi_clearance', 'NBI Clearance', 'compliance', 'required'),
  ('service_record', 'CV or Service Record', 'experience', 'none'),
  ('proof_of_address', 'Proof of Address', 'address', 'none'),
  ('professional_license', 'Professional License', 'qualification', 'required'),
  ('trade_certificate', 'Trade Certificate', 'qualification', 'optional'),
  ('training_certificate', 'Training Certificate', 'qualification', 'optional'),
  ('branch_authorization', 'Branch Authorization', 'organization', 'optional'),
  ('payout_verification', 'Payout Verification Document', 'finance', 'optional')
ON CONFLICT (document_type_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS servana.provider_service_area_catalog (
  area_id TEXT PRIMARY KEY,
  provider_label TEXT NOT NULL,
  province TEXT NOT NULL,
  is_supported BOOLEAN NOT NULL DEFAULT FALSE,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO servana.provider_service_area_catalog
  (area_id, provider_label, province, is_supported)
VALUES
  ('manila','City of Manila','Metro Manila',TRUE),
  ('quezon','Quezon City','Metro Manila',TRUE),
  ('makati','Makati City','Metro Manila',TRUE),
  ('taguig','Taguig City','Metro Manila',TRUE),
  ('pasig','Pasig City','Metro Manila',TRUE),
  ('mandaluyong','Mandaluyong City','Metro Manila',TRUE),
  ('marikina','Marikina City','Metro Manila',TRUE),
  ('caloocan','Caloocan City','Metro Manila',TRUE),
  ('malabon','Malabon City','Metro Manila',TRUE),
  ('navotas','Navotas City','Metro Manila',TRUE),
  ('valenzuela','Valenzuela City','Metro Manila',TRUE),
  ('las-pinas','Las Pinas City','Metro Manila',TRUE),
  ('muntinlupa','Muntinlupa City','Metro Manila',TRUE),
  ('paranaque','Paranaque City','Metro Manila',TRUE),
  ('pasay','Pasay City','Metro Manila',TRUE),
  ('pateros','Pateros','Metro Manila',TRUE),
  ('san-juan','San Juan City','Metro Manila',TRUE),
  ('bacoor','Bacoor City','Cavite',FALSE),
  ('imus','Imus City','Cavite',FALSE),
  ('antipolo','Antipolo City','Rizal',FALSE),
  ('san-jose-del-monte','San Jose del Monte','Bulacan',FALSE)
ON CONFLICT (area_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS servana.provider_catalog_offering_policies (
  offering_id INTEGER PRIMARY KEY REFERENCES servana.provider_catalog_offerings(id) ON DELETE CASCADE,
  enforcement_state TEXT NOT NULL DEFAULT 'draft'
    CHECK (enforcement_state IN ('draft','enforced')),
  allowed_provider_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  allowed_branch_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  allowed_city_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(allowed_provider_types) = 'array'),
  CHECK (jsonb_typeof(allowed_branch_ids) = 'array'),
  CHECK (jsonb_typeof(allowed_city_ids) = 'array')
);

CREATE TABLE IF NOT EXISTS servana.provider_catalog_offering_requirements (
  id BIGSERIAL PRIMARY KEY,
  offering_id INTEGER NOT NULL REFERENCES servana.provider_catalog_offerings(id) ON DELETE CASCADE,
  requirement_key TEXT NOT NULL,
  document_type_id TEXT NOT NULL REFERENCES servana.provider_document_types(document_type_id),
  provider_label TEXT NOT NULL,
  provider_description TEXT NOT NULL,
  is_required BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(offering_id, requirement_key)
);

CREATE INDEX IF NOT EXISTS provider_catalog_policy_enforcement_idx
  ON servana.provider_catalog_offering_policies(enforcement_state);
CREATE INDEX IF NOT EXISTS provider_catalog_requirement_offering_idx
  ON servana.provider_catalog_offering_requirements(offering_id, is_active, display_order);

-- Normalize only unambiguous historical aliases. Ambiguous values such as
-- "certificate" remain for manual classification.
UPDATE servana.worker_requirements
SET requirement_type = 'valid_id', updated_at = NOW()
WHERE requirement_type IN ('government_id','national_id','passport','drivers_license','philsys');

UPDATE servana.worker_requirements
SET requirement_type = 'service_record', updated_at = NOW()
WHERE requirement_type IN ('cv','resume','work_record','tor','diploma');

COMMIT;
