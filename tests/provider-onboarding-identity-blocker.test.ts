/**
 * Onboarding submit: what counts as a verified identifier.
 *
 * The blocker used to read `is_email_verified` alone. The provider portal
 * supports signing up with a mobile number and no email, so those providers
 * completed all nine steps and were refused at submit by a condition they could
 * never satisfy — there was no email to verify. In production that was 29 of 70
 * providers, every one of them carrying `is_mobile_verified = true`.
 *
 * These cases pin the rule that replaced it: a verified EMAIL or a verified
 * MOBILE clears the blocker; neither one leaves it in place.
 *
 * The blocker logic is a pure derivation over the aggregate's inputs, so it is
 * reproduced here rather than reached through the database. If the production
 * rule changes, this file must be updated deliberately — which is the point.
 */

type Worker = { is_email_verified?: boolean; is_mobile_verified?: boolean };

interface Blocker { code: string; severity: 'blocking' | 'warning'; label: string; }

/** Mirrors providerOnboardingService.getOnboardingAggregate's blocker derivation. */
function deriveBlockers(input: {
  worker: Worker;
  hasRequirements: boolean;
  hasPendingOrApprovedApp: boolean;
  hasActiveService: boolean;
  guidelinesAccepted: boolean;
}): Blocker[] {
  const { worker } = input;
  const hasVerifiedIdentifier = !!(worker.is_email_verified || worker.is_mobile_verified);

  const blockers: Blocker[] = [];
  if (!hasVerifiedIdentifier) {
    blockers.push({
      code: 'email_not_verified',
      severity: 'blocking',
      label: 'No verified email address or mobile number',
    });
  }
  if (!input.hasRequirements) {
    blockers.push({ code: 'no_documents', severity: 'blocking', label: 'No documents uploaded' });
  }
  if (!input.hasPendingOrApprovedApp && !input.hasActiveService) {
    blockers.push({ code: 'no_service_selected', severity: 'blocking', label: 'No service application submitted' });
  }
  if (!input.guidelinesAccepted) {
    blockers.push({ code: 'guidelines_not_accepted', severity: 'blocking', label: 'Provider guidelines not accepted' });
  }
  return blockers;
}

/** Everything except identity satisfied — isolates the blocker under test. */
function otherwiseComplete(worker: Worker) {
  return {
    worker,
    hasRequirements: true,
    hasPendingOrApprovedApp: true,
    hasActiveService: false,
    guidelinesAccepted: true,
  };
}

const identityCodes = (bs: Blocker[]) => bs.filter(b => b.code === 'email_not_verified');

describe('onboarding submit — verified identifier', () => {

  // The production case: uid JcpT821P0GejhcRLT3USPeVkacp2, no email, mobile
  // verified, all nine steps done, refused at submit.
  it('lets a mobile-only provider through when the mobile is verified', () => {
    const blockers = deriveBlockers(otherwiseComplete({
      is_email_verified: false,
      is_mobile_verified: true,
    }));
    expect(identityCodes(blockers)).toEqual([]);
    expect(blockers).toEqual([]);
  });

  it('lets an email-only provider through, as before', () => {
    const blockers = deriveBlockers(otherwiseComplete({
      is_email_verified: true,
      is_mobile_verified: false,
    }));
    expect(blockers).toEqual([]);
  });

  it('lets a provider with both through', () => {
    expect(deriveBlockers(otherwiseComplete({
      is_email_verified: true, is_mobile_verified: true,
    }))).toEqual([]);
  });

  it('still blocks when NEITHER identifier is verified', () => {
    const blockers = deriveBlockers(otherwiseComplete({
      is_email_verified: false, is_mobile_verified: false,
    }));
    expect(identityCodes(blockers).length).toBe(1);
  });

  it('treats absent flags as unverified — absence is not proof', () => {
    expect(identityCodes(deriveBlockers(otherwiseComplete({}))).length).toBe(1);
  });

  describe('the label a person actually reads', () => {
    it('names both channels, not just email', () => {
      const [b] = identityCodes(deriveBlockers(otherwiseComplete({})));
      expect(b.label).toContain('email');
      expect(b.label).toContain('mobile');
    });

    // Renaming the code would be a response-contract change for no gain (§4).
    it('keeps the shipped code stable', () => {
      const [b] = identityCodes(deriveBlockers(otherwiseComplete({})));
      expect(b.code).toBe('email_not_verified');
      expect(b.severity).toBe('blocking');
    });
  });

  describe('the other three blockers are untouched', () => {
    const verified = { is_email_verified: false, is_mobile_verified: true };

    it('still blocks with no documents', () => {
      const b = deriveBlockers({ ...otherwiseComplete(verified), hasRequirements: false });
      expect(b.map(x => x.code)).toEqual(['no_documents']);
    });

    it('still blocks with no service application and no active service', () => {
      const b = deriveBlockers({
        ...otherwiseComplete(verified), hasPendingOrApprovedApp: false, hasActiveService: false,
      });
      expect(b.map(x => x.code)).toEqual(['no_service_selected']);
    });

    it('accepts an active service in place of an application', () => {
      const b = deriveBlockers({
        ...otherwiseComplete(verified), hasPendingOrApprovedApp: false, hasActiveService: true,
      });
      expect(b).toEqual([]);
    });

    it('still blocks when guidelines are not accepted', () => {
      const b = deriveBlockers({ ...otherwiseComplete(verified), guidelinesAccepted: false });
      expect(b.map(x => x.code)).toEqual(['guidelines_not_accepted']);
    });

    it('reports every outstanding blocker, not just the first', () => {
      const b = deriveBlockers({
        worker: {},
        hasRequirements: false,
        hasPendingOrApprovedApp: false,
        hasActiveService: false,
        guidelinesAccepted: false,
      });
      expect(b.length).toBe(4);
    });
  });
});
