import {
  APPEAL_GROUNDS,
  CASE_DOMAINS,
  providerCaseActions,
  providerStateLabel,
  providerTimeExpectation,
  slaTargets,
} from '../src/services/supportCasePolicy';

describe('provider support case policy', () => {
  it('keeps disputes, finance, safety and reviews as distinct domains', () => {
    expect(CASE_DOMAINS).toEqual(expect.arrayContaining([
      'BOOKING_DISPUTE', 'FINANCE', 'SAFETY', 'REVIEWS',
    ]));
  });

  it('does not permit withdrawal of safety cases', () => {
    const actions = providerCaseActions({
      provider_state: 'UNDER_REVIEW', domain: 'SAFETY',
      provider_action_required: false,
    });
    expect(actions).toContain('REPLY');
    expect(actions).not.toContain('WITHDRAW');
  });

  it('uses provider-safe labels and action-required language', () => {
    expect(providerStateLabel('WAITING_FOR_PROVIDER')).toBe('Action required');
    expect(providerTimeExpectation({ provider_action_required: true }))
      .toBe('Servana is waiting for information from you.');
  });

  it('prioritizes critical cases by server-derived targets', () => {
    const now = new Date('2026-08-07T00:00:00.000Z');
    const targets = slaTargets('SAFETY_CRITICAL', 'CRITICAL', now);
    expect(targets.firstResponseTargetAt.toISOString()).toBe('2026-08-07T01:00:00.000Z');
    expect(targets.escalationDueAt.toISOString()).toBe('2026-08-07T01:00:00.000Z');
    expect(targets.resolutionTargetAt.toISOString()).toBe('2026-08-08T00:00:00.000Z');
  });

  it('publishes bounded appeal grounds rather than free-form state changes', () => {
    expect(APPEAL_GROUNDS).toContain('NEW_MATERIAL_EVIDENCE');
    expect(APPEAL_GROUNDS).toContain('POLICY_MISAPPLIED');
  });
});
