/**
 * Auto-assignment commits through the SAME hard constraints as an admin.
 *
 * ## The gate this closes
 *
 * `AUTO_ASSIGN` carried `targetValidation: 'LEGACY_AUTO'`: the schedule
 * conflict and nothing else. Role, archive state and canonical capability were
 * skipped, so the matching engine could commit a provider `ADMIN_ASSIGN` would
 * have refused. Two producers of the same write, disagreeing.
 *
 * ## Why the tightening is safe, and why that is the interesting part
 *
 * A refusal here does NOT fail the booking. `assignNearestWorker` walks a
 * ranked candidate list, so a refused provider costs a candidate and the walk
 * moves on. Only a booking whose ENTIRE list is ineligible ends with no
 * assignment — and that assignment would have been wrong to make.
 *
 * The two properties that make that true are what this suite holds:
 *
 *   1. every refusal is SKIPPABLE and ATTRIBUTED, so the caller continues and
 *      the reason survives;
 *   2. the end of a fruitless walk names the dominant cause, in the same
 *      vocabulary the Admin candidate pool uses.
 */

import fs from 'fs';
import path from 'path';

import {
  ASSIGNMENT_REFUSAL_CODES,
  SKIPPABLE_REFUSALS,
  isSkippableRefusal,
  isRankableRefusal,
  dominantRefusal,
  noAssignmentDiagnosis,
  recordAutoAssignEvaluation,
  recordAutoAssignExhausted,
  autoAssignDiagnosticsReport,
  resetAutoAssignDiagnostics,
} from '../src/services/booking/autoAssignDiagnostics';
import { BLOCKER_PRECEDENCE } from '../src/services/booking/candidateDiagnostics';

const SRC = path.join(__dirname, '..', 'src');

const codeOf = (relative: string): string => fs
  .readFileSync(path.join(SRC, relative), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const executor = codeOf('services/booking/transitionExecutor.ts');
const technician = codeOf('services/technicianService.ts');

// ─── 1. One validation, for every producer ────────────────────────────────────

describe('AUTO_ASSIGN validates exactly as ADMIN_ASSIGN does', () => {
  it('declares the canonical profile', () => {
    const autoAssign = executor.slice(
      executor.indexOf('AUTO_ASSIGN: {'),
      executor.indexOf('ADMIN_REASSIGN: {'),
    );
    expect(autoAssign).toContain("targetValidation: 'FULL'");
  });

  it('has no branch that skips the strict validation', () => {
    // The weaker profile was a branch, not a flag. A branch is what let one
    // producer diverge, so the branch itself has to be gone.
    expect(executor).not.toContain("profile === 'LEGACY_AUTO'");
    expect(executor).not.toContain("targetValidation: 'LEGACY_AUTO'");
    expect(executor).not.toContain('recordLegacyAutoShadow');
  });

  it('refuses an unrecognised profile rather than defaulting to permissive', () => {
    /**
     * The failure direction matters. A profile the executor does not
     * understand must not fall through to "validate nothing" — which is
     * exactly what the old branch structure would have done if a third value
     * had ever appeared.
     */
    expect(executor).toContain("if (profile !== 'FULL')");
    expect(executor).toContain('Unknown target validation profile');
  });

  it('validates under the locks, inside the transaction', () => {
    /**
     * Asserted on the CALL GRAPH, not on file position: `applyState` is
     * *defined* above the line that *invokes* it, so comparing offsets would
     * compare the wrong thing and fail a correct implementation.
     *
     * The advisory lock is taken before `applyState` is invoked, and the
     * validation lives inside `applyState` — so it runs with both locks held.
     * Otherwise two concurrent auto-assignments of the same provider both
     * validate clean and both commit.
     */
    const advisory = executor.indexOf('pg_advisory_xact_lock');
    const applyCall = executor.indexOf('await applyState(client, loaded, toState, input)');
    expect(advisory).toBeGreaterThan(-1);
    expect(advisory).toBeLessThan(applyCall);

    const applyStateBody = executor.slice(executor.indexOf('async function applyState'));
    expect(applyStateBody)
      .toContain('await assertAssignableProvider(client, loaded.id, nextProvider)');
    // And the lock it depends on is requested for this action.
    expect(executor).toContain("advisoryLock: 'PROVIDER_ASSIGNMENT'");
  });

  it('checks capability, role, archive state AND the conflict', () => {
    const validator = executor.slice(
      executor.indexOf('async function assertAssignableProvider'),
    );
    expect(validator).toContain('providerRoleSqlPredicate');
    expect(validator).toContain('is_archive');
    expect(validator).toContain('PROVIDER_CAPABILITY_SQL');
    expect(validator).toContain('assertNoScheduleConflict');
  });
});

// ─── 2. Attribution ───────────────────────────────────────────────────────────

describe('every refusal names the stage that refused', () => {
  it('uses codes the candidate diagnostics can already rank', () => {
    /**
     * "Why did nobody get this job" and "why is this provider greyed out in
     * the candidate list" are the same question. An operator should not have to
     * learn two vocabularies to ask it.
     */
    for (const code of ASSIGNMENT_REFUSAL_CODES) {
      expect(isRankableRefusal(code)).toBe(true);
      expect(BLOCKER_PRECEDENCE).toContain(code);
    }
  });

  it('the executor stamps a reason code on each refusal', () => {
    expect(executor).toContain("reasonCode: 'ACCOUNT_INACTIVE'");
    expect(executor).toContain("reasonCode: 'ACCOUNT_ARCHIVED'");
    expect(executor).toContain("reasonCode: 'NO_ACTIVE_SERVICE'");
    expect(executor).toContain("reasonCode: 'BOOKING_CONFLICT'");
  });

  it('every refusal the executor can raise is skippable', () => {
    /**
     * The property the whole tightening rests on. If a refusal were NOT
     * skippable, auto-assignment would fail the booking outright where it used
     * to succeed — and that would be the supply collapse this tab prevents.
     */
    for (const code of ASSIGNMENT_REFUSAL_CODES) {
      expect(isSkippableRefusal(code)).toBe(true);
    }
    expect([...SKIPPABLE_REFUSALS].sort()).toEqual([...ASSIGNMENT_REFUSAL_CODES].sort());
  });

  it('rejects a non-code rather than treating it as skippable', () => {
    // Failing open here would walk past a refusal nobody classified.
    for (const junk of [undefined, null, '', 'SOMETHING_ELSE', 42, {}]) {
      expect(isSkippableRefusal(junk)).toBe(false);
    }
  });
});

// ─── 3. The caller survives a refusal ─────────────────────────────────────────

describe('a refused provider costs a candidate, not the booking', () => {
  it('the write boundary returns rather than throwing on a skippable refusal', () => {
    const persist = technician.slice(
      technician.indexOf('const persistWorkerAssignment'),
      technician.indexOf('export const assignNearestWorker'),
    );
    expect(persist).toContain('isSkippableRefusal(reasonCode)');
    expect(persist).toContain('kind: reasonCode === \'BOOKING_CONFLICT\' ? "busy" : "ineligible"');
  });

  it('distinguishes a full diary from a provider who should not be offered', () => {
    /**
     * Both mean "try the next one", and they answer different operational
     * questions. Collapsing them would make a capability gap read as a
     * scheduling problem — and send an operator to the wrong screen.
     */
    expect(technician).toContain('"created" | "existing" | "busy" | "ineligible"');
  });

  it('the walk continues on both, collecting the reason', () => {
    const walk = technician.slice(
      technician.indexOf('export const assignNearestWorker'),
    );
    expect(walk).toContain('result.kind === "busy" || result.kind === "ineligible"');
    expect(walk).toContain('refusals.push(result.reasonCode)');
    expect(walk).toContain('continue;');
  });

  it('an exhausted walk reports the diagnosis, not an empty result', () => {
    const walk = technician.slice(technician.indexOf('export const assignNearestWorker'));
    expect(walk).toContain('recordAutoAssignExhausted()');
    expect(walk).toContain('noAssignmentDiagnosis(refusals)');
  });
});

// ─── 4. The diagnosis itself ──────────────────────────────────────────────────

describe('the no-assignment diagnosis', () => {
  it('keeps the legacy reason string callers already switch on', () => {
    // Additive: the attribution travels beside the field, not instead of it.
    expect(noAssignmentDiagnosis([]).reason).toBe('NO_WORKER_AVAILABLE_AFTER_RECHECK');
  });

  it('names the dominant cause and counts every refusal', () => {
    const diagnosis = noAssignmentDiagnosis([
      'BOOKING_CONFLICT', 'NO_ACTIVE_SERVICE', 'BOOKING_CONFLICT',
    ]);
    expect(diagnosis.refusedBy).toBe('BOOKING_CONFLICT');
    expect(diagnosis.refusals).toEqual({ BOOKING_CONFLICT: 2, NO_ACTIVE_SERVICE: 1 });
  });

  it('reports nothing rather than guessing when there were no refusals', () => {
    // An empty candidate list is not the same as a list that refused everybody,
    // and claiming a cause for it would be an invention.
    expect(noAssignmentDiagnosis([]).refusedBy).toBeNull();
    expect(dominantRefusal([])).toBeNull();
  });

  it('breaks a tie by precedence, then alphabetically — deterministically', () => {
    /**
     * Ranked the way the Admin candidate pool ranks, so the same pool produces
     * the same headline either way. A reason that changes between two identical
     * runs is a reason nobody trusts.
     */
    expect(dominantRefusal(['BOOKING_CONFLICT', 'ACCOUNT_ARCHIVED'])).toBe('ACCOUNT_ARCHIVED');
    expect(dominantRefusal(['ACCOUNT_ARCHIVED', 'BOOKING_CONFLICT'])).toBe('ACCOUNT_ARCHIVED');
    // Count still outranks precedence: two conflicts beat one archived account.
    expect(dominantRefusal(['BOOKING_CONFLICT', 'BOOKING_CONFLICT', 'ACCOUNT_ARCHIVED']))
      .toBe('BOOKING_CONFLICT');
  });

  it('keeps an unranked code rather than dropping it', () => {
    expect(dominantRefusal(['SOMETHING_NEW'])).toBe('SOMETHING_NEW');
  });
});

// ─── 5. The counters ──────────────────────────────────────────────────────────

describe('the outcome counters', () => {
  beforeEach(resetAutoAssignDiagnostics);

  it('separates committed from refused, attributed by reason', () => {
    recordAutoAssignEvaluation({ committed: true });
    recordAutoAssignEvaluation({ committed: false, reasonCode: 'ACCOUNT_ARCHIVED' });
    recordAutoAssignEvaluation({ committed: false, reasonCode: 'ACCOUNT_ARCHIVED' });
    recordAutoAssignExhausted();

    expect(autoAssignDiagnosticsReport()).toMatchObject({
      evaluated: 3, committed: 1, refused: 2, exhausted: 1,
      byReason: { ACCOUNT_ARCHIVED: 2 },
    });
  });

  it('names an unattributed refusal rather than losing it', () => {
    // A refusal nobody classified is exactly the one worth seeing.
    recordAutoAssignEvaluation({ committed: false });
    expect(autoAssignDiagnosticsReport().byReason).toEqual({ UNATTRIBUTED_REFUSAL: 1 });
  });

  it('the reason counts sum to the refusal count', () => {
    recordAutoAssignEvaluation({ committed: false, reasonCode: 'BOOKING_CONFLICT' });
    recordAutoAssignEvaluation({ committed: false, reasonCode: 'NO_ACTIVE_SERVICE' });
    const report = autoAssignDiagnosticsReport();
    const summed = Object.values(report.byReason).reduce((a, b) => a + b, 0);
    expect(summed).toBe(report.refused);
  });

  it('never throws, whatever it is handed', () => {
    // It runs inside the assignment transaction.
    expect(() => recordAutoAssignEvaluation(undefined as never)).not.toThrow();
    expect(() => recordAutoAssignExhausted()).not.toThrow();
  });

  it('returns a copy, so a caller cannot edit the counters', () => {
    recordAutoAssignEvaluation({ committed: false, reasonCode: 'BOOKING_CONFLICT' });
    const report = autoAssignDiagnosticsReport();
    report.byReason.BOOKING_CONFLICT = 999;
    expect(autoAssignDiagnosticsReport().byReason.BOOKING_CONFLICT).toBe(1);
  });
});
