/**
 * The canonical provider ACTIVATION projection — the checklist a provider who
 * cannot yet work needs in order to find out why, and what to do about it.
 *
 * ## Why this is a sibling resource and not more fields on the profile
 *
 * The obvious move is to widen `GET /api/v1/provider/profile`. It is refused
 * here for a measured reason: `ProviderProfile` is the response schema of TWO
 * operations, `provider.profile.get` (seat `self`) AND
 * `provider.publicProfile.get` (seat `otherCustomer`) — the projection a
 * stranger receives when choosing a provider. Adding an activation checklist to
 * that schema would declare, in the published contract, that a compliance state
 * travels on the endpoint customers read. Even with the value withheld at that
 * seat, the shape would be one seat-computation bug away from disclosure, and
 * `providerProfileService`'s own header already refuses the same trade for
 * document previews: folding them into a profile read "would turn every profile
 * fetch into a document disclosure".
 *
 * Two further reasons, both measurable:
 *
 *   - **Purpose limitation.** Rendering a provider card and driving an
 *     onboarding checklist are different purposes over different data. Separate
 *     resources let authorization, retention and caching differ per purpose
 *     instead of being set by whichever purpose is laxest.
 *   - **§56.** This projection fans out to the readiness engine, the activation
 *     engine, the onboarding case and the compliance inputs. The public profile
 *     read is a hot path on the customer app's browse screen; loading it with
 *     activation work would be a duplicate-cost regression for five clients to
 *     serve one.
 *
 * The Master Command accepts either shape. This one is chosen, and this is why.
 *
 * ## One source per concern
 *
 * Nothing here is re-derived. Each concern is taken from the service that owns
 * it, and every one of them is computed from a SINGLE load:
 *
 *   | concern                              | owner                                      |
 *   | ------------------------------------ | ------------------------------------------ |
 *   | state, nextStep, capabilities, tasks | `providerAccountStateService` (precedence) |
 *   | compliance                           | `computeCompliance` — the same call the    |
 *   |                                      | state machine already made                 |
 *   | documentSummary                      | `summariseDocuments`, that same array      |
 *   | certificationSummary                 | `summariseCertifications`, same array      |
 *   | completion                           | `buildCompletionRequirements`, same array  |
 *
 * `getProviderAccountStateDetailed` returns the compliance inputs it loaded, so
 * the summaries beside a verdict are counts of the very rows that produced it.
 * A second `calculateCompliance` call here would have been six extra queries AND
 * a second answer able to disagree with the first between them — the failure
 * this table exists to make impossible.
 *
 * ## Fail closed, and say so
 *
 * A denied account loads nothing, so `compliance`, `documentSummary`,
 * `certificationSummary` and `completion` are **null**, never zeroed. An empty
 * summary and an unloaded one are different claims: rendering the second as the
 * first tells a provider whose account was never found that they have no
 * outstanding requirements. `access` is still present and still DENY_ALL, and
 * `nextStep` still names the reason — a refusal with no explanation is the one
 * outcome the legacy discovery endpoint was built to prevent.
 */

import {
  getProviderAccountStateDetailed,
  type Capabilities,
  type ProviderAccountState,
} from '../providerAccountStateService';
import {
  buildCompletionRequirements,
  completionStateOf,
  summariseCertifications,
  summariseDocuments,
  type CertificationSummary,
  type CompletionRequirement,
  type DocumentSummary,
} from '../providerProfileComplianceService';

/**
 * A capability key rendered as the action a client may offer.
 *
 * DERIVED from the `Capabilities` object rather than mapped by hand. A
 * hand-written map is a vocabulary that cannot grow: add
 * `canRequestPayoutMethod` to `Capabilities` and a mapped list silently keeps
 * offering the old thirteen, with nothing failing. Stripping the `can` prefix
 * and upper-snake-casing the rest is total by construction — every capability
 * that is true appears, and a new one appears the day it is added.
 *
 * `canViewDashboard` becomes `VIEW_DASHBOARD`; `canGoOnline` becomes `GO_ONLINE`.
 */
export const actionCodeFor = (capability: string): string =>
  capability
    .replace(/^can/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase();

/**
 * Exactly the capabilities that are TRUE, as action codes, sorted.
 *
 * Sorted so the array is stable across runs. An unstable order turns every
 * response diff into a false positive for the captured-response comparison this
 * contract's compatibility is proven with.
 */
export const availableActionsFor = (access: Capabilities): string[] =>
  Object.entries(access)
    .filter(([, granted]) => granted === true)
    .map(([capability]) => actionCodeFor(capability))
    .sort();

export interface ProviderActivationDto {
  uid: string;
  /** The stored activation state. Approval starts activation; it does not complete it. */
  state: ProviderAccountState['activation']['status'];
  /** Where this provider goes next, by the one precedence order every client shares. */
  nextStep: ProviderAccountState['nextStep'];
  account: ProviderAccountState['account'];
  verification: ProviderAccountState['verification'];
  documents: ProviderAccountState['documents'];
  application: ProviderAccountState['application'];
  /** Capability truth. A statement about state, never a grant — every endpoint re-checks. */
  access: Capabilities;
  /** The same truth as `access`, as the action codes a client renders buttons from. */
  availableActions: string[];
  /** The server-driven checklist, both phases, provider-actionable items only. */
  checklist: ProviderAccountState['checklist'];
  /** Null when nothing was loaded — a denial, not an all-clear. */
  compliance: unknown | null;
  documentSummary: DocumentSummary | null;
  certificationSummary: CertificationSummary | null;
  completion: {
    state: 'complete' | 'incomplete';
    requirements: CompletionRequirement[];
  } | null;
}

/**
 * The activation projection for ONE provider — always the caller's own.
 *
 * `uid` comes from the verified token at the handler and is never read from a
 * path, query or body: there is no seat in this projection at which another
 * account's compliance state is visible, because there is no way to name another
 * account. That is the whole of its authorization story, and it is a property of
 * the signature rather than of a check somebody has to remember.
 */
export const getProviderActivation = async (
  uid: string,
): Promise<ProviderActivationDto> => {
  const { state, compliance, inputs } = await getProviderAccountStateDetailed(uid);

  const completionRequirements =
    inputs && inputs.account
      ? buildCompletionRequirements(inputs.account, inputs.documents)
      : null;

  return {
    uid,
    state: state.activation.status,
    nextStep: state.nextStep,
    account: state.account,
    verification: state.verification,
    documents: state.documents,
    application: state.application,
    access: state.access,
    availableActions: availableActionsFor(state.access),
    checklist: state.checklist,
    compliance,
    documentSummary: inputs ? summariseDocuments(inputs.documents) : null,
    certificationSummary: inputs ? summariseCertifications(inputs.certifications) : null,
    completion: completionRequirements
      ? {
          state: completionStateOf(completionRequirements),
          requirements: completionRequirements,
        }
      : null,
  };
};
