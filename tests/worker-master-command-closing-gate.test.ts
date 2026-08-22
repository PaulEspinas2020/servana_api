/**
 * TAB 11 — the closing gate for the worker/provider Master Command.
 *
 * ## What this asserts
 *
 * The book's acceptance is: *"Every one of the 54 has a disposition: promoted,
 * subsumed, or retired-with-a-successor-named."* This pins all 54 legacy paths
 * by name and fails if any loses its canonical successor.
 *
 * A document saying they are closed is a claim. This is the check.
 *
 * ## Why the list is written out rather than derived
 *
 * Deriving it from the contract would be circular — the contract is the thing
 * being checked, so a path quietly dropped from it would also vanish from the
 * expectation and the gate would go green on a smaller world. The 54 are
 * transcribed from the Master Command, which is the independent statement of
 * what had to be closed.
 *
 * Transcribing them also produced a useful cross-check: enumerating the paths
 * the book names cluster by cluster yields exactly 54, which is the number the
 * book states. Had it come to 53 or 56, one of the two documents would have been
 * wrong about its own scope.
 *
 * ## What this deliberately does NOT assert
 *
 * That any client has migrated. Publication is the backend's half; adoption is
 * the client's, and the book is explicit that it must be re-measured WITH the
 * clients rather than for them. Every one of these entries records
 * `providerMobile: 'planned'` until that client's own manifest says otherwise,
 * and the reconciler — not this suite — is what turns those rows over.
 */

import { canonicalManifest } from '../src/api/v1/convergence';
import { V1_CONTRACT } from '../src/api/v1/contract';

/** Parameter names differ between the book and the contract; shape does not. */
const shape = (p: string) => p.replace(/:[A-Za-z0-9_]+/g, ':p').replace(/\/+$/, '');

const manifest = canonicalManifest();
const successors = new Map<string, string>();
for (const e of manifest) {
  for (const s of e.supersedes) {
    successors.set(shape(s.split(' ').slice(1).join(' ')), e.id);
  }
}
const successorOf = (legacyPath: string) => successors.get(shape(legacyPath));

/** The 54, transcribed from the Master Command, cluster by cluster. */
const THE_54: Record<string, string[]> = {
  'TAB 01/04 activation and compliance': [
    '/api/provider/account-state',
    '/api/provider/activation/policy-acknowledgement',
    '/api/provider/certifications',
    '/api/provider/compliance',
    '/api/provider/contact-changes',
    '/api/provider/contact-changes/confirm',
    '/api/provider/profile-center',
    '/api/provider/profile-fields',
    '/api/provider/public-profile-preview',
    '/api/provider/public-profile-revisions',
    '/api/provider/verification-timeline',
  ],
  'TAB 02 job cards': [
    '/api/worker/job-cards',
    '/api/worker/job-cards/:bookingId',
  ],
  'TAB 05 services and applications': [
    '/api/worker/services-overview',
    '/api/worker/service-applications',
    '/api/worker/service-applications/:applicationId',
    '/api/worker/service-applications/:applicationId/resubmit',
    '/api/worker/services/:serviceId/eligibility',
    '/api/worker/services/:serviceId/pause',
    '/api/worker/services/:serviceId/reactivate',
  ],
  'TAB 06 presence and safety': [
    '/api/provider/location/go-online',
    '/api/provider/location/go-offline',
    '/api/worker/location',
    '/api/provider/safety/check-in',
    '/api/provider/safety/emergency-config',
    '/api/provider/safety/incidents',
  ],
  'TAB 07 evidence, cancellation and cash': [
    '/api/provider/bookings/:bookingId/evidence',
    '/api/provider/bookings/:bookingId/evidence/:evidenceId',
    '/api/provider/bookings/:bookingId/cancellation-eligibility',
    '/api/:bookingId/mark-cash-paid',
  ],
  'TAB 08 support cases and reviews': [
    '/api/provider/support/case-categories',
    '/api/provider/support/cases',
    '/api/provider/support/cases/:caseId',
    '/api/provider/reviews',
    '/api/provider/reviews/:reviewId/response',
    '/api/provider/review-moderation/:caseId/appeals',
  ],
  'TAB 09 auth': [
    '/api/auth/signin',
    '/api/auth/signup',
    '/api/auth/firebase-login',
    '/api/auth/resendverification',
    '/api/auth/resend-email-otp',
    '/api/auth/verify-email-otp',
  ],
  'TAB 10 the remainder': [
    '/api/chat/attachments/upload',
    '/api/provider/alerts',
    '/api/provider/alerts/:alertKey',
    '/api/provider/calendar',
    '/api/provider/earnings',
    '/api/provider/performance',
    '/api/provider/fcm-token',
    '/api/provider/account/delete',
    '/api/user/updateprofile',
    '/api/worker/profile/photo',
    '/api/worker/schedule',
    '/api/provider-catalog/v1/offerings',
  ],
};

const ALL = Object.values(THE_54).flat();

describe('the closing gate: every one of the 54 has a disposition', () => {
  it('the transcription is 54 paths, which is the number the book states', () => {
    // A cross-check on the scope rather than on the work: if this were 53 or
    // 56, one of the two documents would be wrong about what it covers.
    expect(ALL.length).toBe(54);
    expect(new Set(ALL).size).toBe(54);
  });

  for (const [cluster, paths] of Object.entries(THE_54)) {
    describe(cluster, () => {
      for (const legacy of paths) {
        it(`${legacy} names a canonical successor`, () => {
          const id = successorOf(legacy);
          // "A route with a written 'stays legacy, here is why' is a closed
          // item; a route with no answer is not."
          expect(id).toBeDefined();
        });
      }
    });
  }

  it('every successor is IMPLEMENTED, not merely planned', () => {
    // A planned entry is documentation. Naming one as a successor would close
    // an item on paper and ship a 404.
    for (const legacy of ALL) {
      const id = successorOf(legacy)!;
      const entry = V1_CONTRACT.find((e) => e.id === id)!;
      expect(entry.status).toBe('implemented');
    }
  });

  it('every superseding mapping explains why the legacy route still exists', () => {
    for (const legacy of ALL) {
      const id = successorOf(legacy)!;
      const entry = V1_CONTRACT.find((e) => e.id === id)!;
      for (const l of entry.legacy) {
        if (l.disposition === 'RETIRE') continue;
        expect(l.note.length).toBeGreaterThan(20);
      }
    }
  });
});

describe('the published contract carries what a client must send', () => {
  it('every write states its body contract, or states that it has none', () => {
    const writes = manifest.filter((e) => e.method !== 'GET');
    expect(writes.length).toBeGreaterThanOrEqual(80);
    for (const w of writes) {
      const declared = w.requestSchema !== null;
      // null and [] are different answers, and TAB 03 published them apart.
      expect(w.requiredBody === null).toBe(!declared);
      expect(w.allowedBody === null).toBe(!declared);
      expect(w.additionalBodyAllowed === null).toBe(!declared);
    }
  });

  it('every non-idempotent operation names a replay mechanism', () => {
    for (const e of manifest) {
      if (e.idempotent) continue;
      expect(Array.isArray(e.replayMechanism)).toBe(true);
      expect(e.replayMechanism!.length).toBeGreaterThan(0);
    }
  });

  it('every entry carries the rateLimit field, so silence is never ambiguous', () => {
    // TAB 09. `null` means no policy; `{ limits: [] }` means a policy of none.
    // A missing field would mean neither.
    for (const e of manifest) {
      expect(e).toHaveProperty('rateLimit');
    }
  });

  it('the extract is versioned against the contract the process serves', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const published = require('../docs/api/CANONICAL_CALL_MANIFEST.json');
    expect(published.contractSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(published.contractDigestHeader).toBe('x-contract-sha256');
    // So a client compares its pin against a live server rather than a checkout.
  });
});

describe('adoption is the CLIENT half, and is not claimed here', () => {
  it('the 54 successors record a caller state per client rather than asserting migration', () => {
    for (const legacy of ALL) {
      const id = successorOf(legacy)!;
      const entry = V1_CONTRACT.find((e) => e.id === id)!;
      // Publication is done; adoption is measured FROM the client manifests by
      // the reconciler, never asserted here. A backend claiming a client had
      // migrated is exactly the defect `reconcile-client-manifests` was built
      // to remove.
      expect(entry.callers).toHaveProperty('providerMobile');
      expect(entry.callers).toHaveProperty('providerWeb');
    }
  });
});
