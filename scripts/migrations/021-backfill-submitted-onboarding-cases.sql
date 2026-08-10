-- Backfill onboarding cases for providers who already submitted.
-- Apply before deploying the matching release.
--
-- WHY THIS EXISTS
--
-- `submitOnboarding` wrote `provider_onboarding_drafts.submitted = true` and
-- nothing else, while `providerAccountStateService` derives the application
-- status SOLELY from `provider_onboarding_cases`, defaulting to NOT_STARTED
-- when no row exists. Cases were only ever created by admin code. A provider
-- could therefore complete and submit everything and be reported
-- APPLICATION_NOT_SUBMITTED forever — told to submit an application they had
-- already submitted, blocked from Go Online, and routed back into onboarding by
-- the auth guard.
--
-- The code fix stops it happening again. This repairs the providers it already
-- happened to; without it they stay stuck, because nothing re-runs submit on
-- their behalf.
--
-- Measured on production before writing this: `provider_onboarding_drafts` held
-- exactly ONE row with `submitted = true` (submitted 2026-08-07, 14
-- requirements uploaded, profile COMPLETE, account active) and it had no case.
-- So this backfills one provider today, not the seventy the provider count
-- might suggest — most providers never reached this submit path at all.
--
-- SAFE TO RE-RUN. `NOT EXISTS` skips anyone who already has a case, so it
-- cannot duplicate, and it cannot disturb a case a reviewer has since moved on.
-- It deliberately does NOT touch providers whose draft is unsubmitted: they
-- have not applied, and inventing an application for them would put work in the
-- review queue that nobody asked for.

INSERT INTO servana.provider_onboarding_cases
  (provider_uid, onboarding_status, submitted_at, last_activity_at, waiting_party, version)
SELECT d.uid,
       'submitted',
       COALESCE(d.submitted_at, NOW()),
       NOW(),
       'servana',
       1
  FROM servana.provider_onboarding_drafts d
 WHERE d.submitted IS TRUE
   AND NOT EXISTS (
     SELECT 1 FROM servana.provider_onboarding_cases c
      WHERE c.provider_uid = d.uid
   );
