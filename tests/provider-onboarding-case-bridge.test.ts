/**
 * Submitting onboarding must record something the state machine can see.
 *
 * MSP-BUG-048 / 049 / 051 were one defect. `submitOnboarding` wrote
 * `provider_onboarding_drafts.submitted = true` and nothing else, while
 * `providerAccountStateService` derives the application status SOLELY from
 * `provider_onboarding_cases`, defaulting to NOT_STARTED when no row exists —
 * and cases were only ever created by admin code.
 *
 * So a provider who had submitted was reported APPLICATION_NOT_SUBMITTED
 * forever. That single value produced all three reported symptoms:
 *
 *   048  BLOCK_REASONS.APPLICATION_NOT_SUBMITTED renders
 *        "Submit your provider application first." on Go Online.
 *   049  provider-auth.guard permits /provider/onboarding for any state that is
 *        not UNDER_REVIEW or ACTIVATION_PENDING, so they are put back into setup.
 *   051  the same guard sends Continue there too.
 *
 * Measured on production before fixing: a provider with submitted = true since
 * 2026-08-07, 14 requirements uploaded, profile COMPLETE and account active,
 * for whom the live service returned application.status = NOT_STARTED.
 *
 * Source assertions, because the defect is a missing write and a table nobody
 * read — a test that stubbed the query result would have passed against the
 * broken version.
 */
import fs from 'fs';
import path from 'path';

const readCode = (rel: string): string =>
  fs
    .readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*/, '').replace(/^\s*\/\/.*/, '').replace(/^\s*\*.*/, ''))
    .join('\n');

const providerSvc = readCode('services/providerOnboardingService.ts');
const adminSvc = readCode('services/adminOnboardingService.ts');
const stateSvc = readCode('services/providerAccountStateService.ts');

describe('submitting creates the case the state machine reads', () => {
  it('submitOnboarding records the case', () => {
    expect(providerSvc).toMatch(/await markCaseSubmitted\(uid\)/);
  });

  it('does so BEFORE claiming pending_review to the client', () => {
    // Returning 'pending_review' while nothing is pending review is what made
    // this invisible: the client was told it worked.
    const call = providerSvc.indexOf('markCaseSubmitted(uid)');
    const claim = providerSvc.indexOf("status: 'pending_review'");
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(claim);
  });

  it('does not swallow a failure', () => {
    // Catching here would put the provider straight back into the broken state
    // while reporting success. Every write in the path is idempotent, so
    // failing loudly and retrying converges.
    const region = providerSvc.slice(
      providerSvc.indexOf('markCaseSubmitted(uid)') - 200,
      providerSvc.indexOf('markCaseSubmitted(uid)') + 120,
    );
    expect(region).not.toMatch(/catch|\.catch\(/);
  });

  it('reuses the admin service rather than writing its own INSERT', () => {
    // One owner for the table, or the two writers drift (§10).
    expect(providerSvc).not.toMatch(/INSERT INTO \$\{dbSchema\}\.provider_onboarding_cases/);
    expect(adminSvc).toMatch(/export const markCaseSubmitted/);
  });
});

describe('markCaseSubmitted is monotonic and idempotent', () => {
  const fn = adminSvc.slice(
    adminSvc.indexOf('export const markCaseSubmitted'),
    adminSvc.indexOf('export const markCaseSubmitted') + 1200,
  );

  it('advances only from the pre-submission statuses', () => {
    // A case already queued, in review or decided must never be dragged back to
    // 'submitted' by a re-submit — that silently resets a reviewer's progress.
    expect(fn).toMatch(/onboarding_status IN \('not_started', 'in_progress'\)/);
  });

  it('never rewrites an existing submitted_at', () => {
    expect(fn).toMatch(/submitted_at\s*=\s*COALESCE\(submitted_at, NOW\(\)\)/);
  });

  it('goes through the idempotent ensureCase rather than a bare INSERT', () => {
    expect(fn).toMatch(/ensureCase\(providerUid\)/);
  });

  it('hands the case to Servana, not the provider', () => {
    // waiting_party drives the review queue. Leaving it on 'provider' would
    // file a submitted application as still waiting on them.
    expect(fn).toMatch(/waiting_party\s*=\s*'servana'/);
  });

  it('bumps the version, so concurrent admin edits still conflict', () => {
    expect(fn).toMatch(/version\s*=\s*version \+ 1/);
  });
});

describe('the reader this was invisible to', () => {
  it('still derives the application from the case table', () => {
    // Documents the coupling the bug depended on. If this ever reads somewhere
    // else, the write above has to follow it.
    expect(stateSvc).toMatch(/APPLICATION_FROM_CASE\[String\(caseRow\.onboarding_status\)\]/);
  });

  it('still treats a missing case as NOT_STARTED', () => {
    // Correct in isolation — the defect was that nothing ever created the row.
    expect(stateSvc).toMatch(/: "NOT_STARTED";/);
  });
});

describe('the backfill migration', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'migrations', '021-backfill-submitted-onboarding-cases.sql'),
    'utf8',
  );

  it('only backfills providers who actually submitted', () => {
    // Inventing applications for people who have not applied would put work in
    // the review queue that nobody asked for.
    expect(sql).toMatch(/d\.submitted IS TRUE/);
  });

  it('cannot duplicate an existing case', () => {
    expect(sql).toMatch(/NOT EXISTS/);
  });

  it('preserves the original submission time', () => {
    expect(sql).toMatch(/COALESCE\(d\.submitted_at, NOW\(\)\)/);
  });

  it('files the backfilled cases as waiting on Servana', () => {
    expect(sql).toMatch(/'servana'/);
  });
});
