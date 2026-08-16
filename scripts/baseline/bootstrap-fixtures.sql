-- ─── Bootstrap fixtures (§160) ──────────────────────────────────────────────
--
-- The minimum a fresh database needs before the backend will boot and answer a
-- representative request. Applied AFTER the baseline and every migration, and
-- only ever to a disposable database.
--
-- ## What "minimal enough not to create fake production truth" means here
--
-- Every row below is unmistakably synthetic and says so in its own data. There
-- is no plausible-looking customer, no provider with a name, no booking with an
-- address. The failure this avoids is the one where a seed file grows a
-- realistic dataset, somebody restores it into a shared environment to
-- reproduce a bug, and six months later a support agent is reading a fixture as
-- if it were a customer.
--
-- ## The reserved id band
--
-- Synthetic catalog rows use ids from 900000 up.
--
-- That is not arbitrary. `servana.catalog_services_id_seq` starts at 100000 so
-- newly created services cannot collide with the ids carried over from the
-- legacy `service_options` table, which are below it (§156). Fixtures sit above
-- BOTH ranges, so a fixture row can never be mistaken for a carried-over
-- service or collide with one the sequence will mint. If a fixture id ever
-- appears in a production query, it is immediately identifiable as seed data.
--
-- ## Ownership
--
-- No ownership statements here. These are rows, not objects; the tables they
-- land in are owned by the approved runtime role already, by the baseline and
-- the migrations.

BEGIN;

-- ── Catalog V2, one branch of the hierarchy ─────────────────────────────────
--
-- Category → Subcategory → Service, so a catalog read, a search and a
-- capability lookup all have something canonical to resolve. The service is
-- deliberately NOT bookable: a bookable fixture service in a shared environment
-- is a service somebody can create a booking against.

INSERT INTO servana.catalog_categories (id, name, slug, display_order, status)
VALUES (900001, 'FIXTURE Category (synthetic)', 'fixture-category', 9000, 'inactive')
ON CONFLICT (id) DO NOTHING;

INSERT INTO servana.catalog_subcategories (id, category_id, name, slug, display_order, status)
VALUES (900101, 900001, 'FIXTURE Subcategory (synthetic)', 'fixture-subcategory', 9000, 'inactive')
ON CONFLICT (id) DO NOTHING;

INSERT INTO servana.services
  (id, subcategory_id, name, slug, short_description, base_price, unit,
   estimated_duration_mins, display_order, bookable, status)
VALUES
  (900201, 900101, 'FIXTURE Service (synthetic)', 'fixture-service',
   'Seed row. Not a real service. Not bookable.', 0, 'per job', 30, 9000, false, 'inactive')
ON CONFLICT (id) DO NOTHING;

-- ── The sequence is deliberately NOT advanced ───────────────────────────────
--
-- A `setval` to `MAX(id)` here would be the obvious thing and it would be
-- wrong: the fixtures sit at 900000+, so it would push the sequence into the
-- fixture band and the next natively-created service would be minted at 900202
-- — indistinguishable from seed data, in exactly the environment where telling
-- them apart matters.
--
-- Leaving the sequence at its migration-set floor of 100000 is correct. New
-- services are minted from 100001 upward, carried-over legacy ids sit below
-- 100000, and the fixture band is far above both. Three ranges, no overlap, and
-- the sequence never has to know the fixtures exist.
--
-- The explicit ids above also leave the SERIAL sequences behind
-- `catalog_categories` and `catalog_subcategories` untouched at their low
-- values, for the same reason and with the same result.

COMMIT;

-- ── Deliberately NOT seeded ─────────────────────────────────────────────────
--
--   * no user_credentials, user_profile or provider row — authentication is
--     Firebase-backed, so a seeded identity would be an account with no
--     credential behind it and every auth test would need it mocked anyway;
--   * no bookings, payments or disbursements — a seeded booking is a row in a
--     state machine, and the domain suites build their own through the real
--     transition executor rather than inheriting one;
--   * no reviews, conversations or notifications — all of them hang off a
--     booking that does not exist here.
--
-- Anything a test needs beyond the catalog is created by that test, through the
-- domain service that owns it. That is what keeps a fixture file from becoming
-- a second, unversioned source of business truth.
--
-- ── Verification ────────────────────────────────────────────────────────────
--
--   SELECT id, name, bookable, status FROM servana.services WHERE id >= 900000;
--   SELECT last_value FROM servana.catalog_services_id_seq;
