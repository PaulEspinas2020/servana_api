-- Ledger checksum repair.
-- The stored values were sha256 of CRLF bytes (written from a Windows working
-- copy); the deploy host checks out LF. These are normalised, so they hold on
-- any platform. One transaction: all 38 or none.
BEGIN;
UPDATE servana.schema_migrations SET checksum_sha256 = '272d57a520c717593f7050f0fd0f4e98e5741137d7b845f01de1864350b6f9b3' WHERE migration_name = '001-massage-services.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = 'f78e7dbea528d5fc2c2de75ea7264950ce348a7eb959498f0c1bb3661665a2ba' WHERE migration_name = '002-massage-specific-services.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = '549041cd4c682588caa9a536444de17a6a5f4daab957dce65bf5752434ad207e' WHERE migration_name = '003-nail-services.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = 'dfa5d730f1b4aff935cd5adc78e9ebc17848e4f6adee5d86658065f4c905a17c' WHERE migration_name = '004-hair-barber-services.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = '197ce4ff7ecb13c76b993114f4e1bb929563280536e5bb2cb7cd1b72a751684b' WHERE migration_name = '005-beauty-services.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = 'f7cf577467310dc984a9ec88ca2c3f0d6aacdb888becda5983e9119dcbb05221' WHERE migration_name = '006-beauty-catalog-description.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = '78556208d4b72d867497d30d84ff46e99e3bae1eeb190b6e5a7c74f9fd2bb342' WHERE migration_name = '007-aircon-cleaning-services.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = '92446bdd5d0ced4db4d1962afa5f754222ca9504d081f62dc36214088365c770' WHERE migration_name = '008-aircon-installation-repair-services.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = '57babc89578a3cdca8ed58dc0376b5f8f4236573d97a02491f1594014b38e9fc' WHERE migration_name = '009-provider-profile-compliance.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = '1f255550476a8257f909295357bc0dff92ac3170745664e19a38db1843aedd4e' WHERE migration_name = '010-provider-contact-media-security.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = '7fc1a7518e363d01a2e21ea380a8d26098f372d0920337e2dd205c5d456bf848' WHERE migration_name = '011-provider-service-policy.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = 'b1d5a0cf10e8730dccc3c8cf04fd48b485811f4276d37bea7273ca2769c78cf6' WHERE migration_name = '012-provider-reputation-quality.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = 'b46475324b1e9ef3c2c3383d2142ddffdce862d6f10f99225b0e2a0d45c85fc7' WHERE migration_name = '013-review-response-moderation.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = '61ecc6fddeb8a193d2ed1687cad6a1d362cc52f8e1ce2a8d79918cb2e58ed528' WHERE migration_name = '014-provider-support-case-management.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = 'bde2c97554b4497b130a19948efe855cd5d5a2a61637ea58ecc2476e10a8e4c5' WHERE migration_name = '015-notification-owner-idempotency.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = 'f7fe9c78f07ab54d840a121289fb96eed87765ee7cef4e21d2cea326dcac5dcb' WHERE migration_name = '016-booking-worker-lifecycle-timestamps.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = '00f52dd19f34663d59cde0b7eb0805e52a0ce4cb6b5622fd99dccfe2f2a7435d' WHERE migration_name = '017-paymongo-transaction-integrity.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = '2fdc40a9176f9b2137f12cb0b69531ce8d115f3a255bdd74a6f3d72228275bee' WHERE migration_name = '018-payment-return-origin.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = 'd2d0e3f60e766ef96edb22ac70f1bef29368c61fba7044aa6c83ece9ba199dea' WHERE migration_name = '019-deploy-credential-canary.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = '197ca27aa24e5ec96a36aab079acc9f93cf1324e2ef600dbc006a22ba9edb0fb' WHERE migration_name = '020-catalog-v2-expand.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = 'ccafbd6f0d31b57591a807532b6699cf5f4ef27fbb6765d7adfcc2eb5bb0f22a' WHERE migration_name = '020-payment-superseded-sessions.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = 'b8b646b2d7cdb15ce47021e2c7e0c5ffd0ce87d1061643eff6e0793b299b2e63' WHERE migration_name = '021-backfill-submitted-onboarding-cases.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = '486803c43ef6c9fd7b377571f6c65705b961811656bd8a17a36f2ab54875cd2f' WHERE migration_name = '021-catalog-v2-backfill.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = 'fb67be677617332def14057a374f408fc7a2aebfdad35f1a8fdbfee448e52ade' WHERE migration_name = '023-catalog-v2-service-families-view.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = '4111dc51d7f6d6703ab70124f8176dcd3445552f18067309ff1bf11f9e18dd49' WHERE migration_name = '024-catalog-v2-canonical-rename.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = 'c3343c7ae0db82e45f5f1e44f364d759aaf26f7407c4a273e1b11b41b240c6ae' WHERE migration_name = '025-catalog-v2-services-sequence.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = 'f60e7b5d61e9c432d9895099ecbc24432682187596c999d75f96653b245095dd' WHERE migration_name = '026-otp-purpose.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = '101ce8df67851b5e76f526e1a32f9c2960aa94fc7e0ee09f35643558c40b0ac2' WHERE migration_name = '027-booking-lifecycle-timestamps.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = '629e187a19576882f1b2bca0d753b678e8b57c2f1507046fcde6193b30ce6a2e' WHERE migration_name = '028-booking-synthetic-marker.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = 'e7a5d2c6eb6503cf24f939c6ba8d8fa280b5093ebbd31696a52979ba1c6cdcc2' WHERE migration_name = '029-capability-canonical-source.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = 'ba4d6b481a56d3dd578e51fe1b1a3c3fa24eea2b98c472d57de64c218adfdd2a' WHERE migration_name = '030-booking-experiences.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = 'f0a5bc6b3a0b4367c537100d68b2a8ae0a2a8d8c11e6c5156a1b0881e1bbd9ba' WHERE migration_name = '031-finance-ledger.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = 'f451bfd8c6b76d34044a96888dc7148a8907c7f56e7919b68e59f51a1648118f' WHERE migration_name = '032-messaging-read-receipts.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = 'f2c8f5855fabced743db3bd52beb4428f12f664a6f7dd08bc9a43d8cc4aeb31b' WHERE migration_name = '033-domain-event-outbox.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = '3e297dd3897cd62b7d648c9fd089f7c6e2983463ea77df707dd352982f0e42ff' WHERE migration_name = '034-account-settings.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = '2812d714543ebbcb70bc0b7a51bbc157cb833703615397031dbcd6dc7f1e41e4' WHERE migration_name = '035-post-service-support.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = '35aecc34fb1d7c430164edc8a00d71fe30a7983f6dbcba378773ccbb4d5f1602' WHERE migration_name = '036-booking-transition-evidence-onboarding.sql';
UPDATE servana.schema_migrations SET checksum_sha256 = 'd60fe597e9e83195167c5da2bf287cf8235d3bc01c1ca820d0370abcdb4b42c9' WHERE migration_name = '037-notification-key-drop-global-uniques.sql';
COMMIT;
