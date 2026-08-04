-- Migration 006: Update aesthetics-beauty catalog offering description to include Beauty Drip
--
-- seedBuiltInOfferings uses ON CONFLICT DO NOTHING — it never updates existing records.
-- This migration is the only way to apply the new description to production where
-- the offering was seeded before Beauty Drip was added to the mappings.

UPDATE servana.provider_catalog_offerings
SET short_description    = 'Facial, skin treatments, and Beauty Drip IV therapy.',
    provider_description = 'Facial care, waxing, and Beauty Drip IV therapy delivered at home.',
    updated_at           = NOW(),
    version              = version + 1
WHERE catalog_key = 'aesthetics-beauty';
