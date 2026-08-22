/**
 * TAB 10 — the remainder, and what measuring it found.
 *
 * ## The item the book ranks first was already done
 *
 * The Master Command calls the chat attachment upload "the important one",
 * because four of five conversation routes were migrated and the fifth held the
 * whole messaging surface on legacy. Measured at this HEAD,
 * `/api/chat/attachments/upload` already has a declared canonical successor, so
 * messaging could migrate in full before this TAB started.
 *
 * ## The gap it did NOT name
 *
 * The book records `/api/provider/earnings` — the LIST — as the missing
 * per-booking ledger. That path already delegates to the same canonical service
 * the v1 list uses, so it was never missing. `GET /api/provider/earnings/:id`,
 * the single-transaction DETAIL, is what had no successor, and the book does not
 * mention it. Measuring the cluster found it; reading the book would not have.
 */

import { V1_CONTRACT } from '../src/api/v1/contract';
import { canonicalManifest } from '../src/api/v1/convergence';
import { SCHEMAS } from '../src/api/v1/openapi';

const manifest = canonicalManifest();
const entry = (id: string) => V1_CONTRACT.find((e) => e.id === id)!;
const supersedes = new Map<string, string>();
for (const e of manifest) for (const s of e.supersedes) supersedes.set(s.split(' ')[1], e.id);

describe('the premise: the headline item was already canonical', () => {
  it('the chat attachment upload has a successor, so messaging can be v1-only', () => {
    // "One route holds a whole surface back" — it does not, and had not for a
    // while. A client planning from the book would have waited for this.
    expect(supersedes.get('/api/chat/attachments/upload')).toBe('conversations.attachments.create');
  });

  it('three more of the twelve were already mapped too', () => {
    expect(supersedes.get('/api/provider/earnings')).toBeDefined();
    expect(supersedes.get('/api/provider/fcm-token')).toBeDefined();
    expect(supersedes.get('/api/user/updateprofile')).toBeDefined();
  });
});

describe('the gap the book did not name: the earnings DETAIL', () => {
  it('the single-transaction read is published and supersedes the legacy path', () => {
    const e = entry('provider.earnings.transaction');
    expect(e.status).toBe('implemented');
    expect(supersedes.get('/api/provider/earnings/:id')).toBe('provider.earnings.transaction');
  });

  it('carries the capability the legacy chain carries', () => {
    // requireCapability("canViewEarnings") guards the legacy route. A provider
    // whose application is not APPROVED holds the role and must not read
    // earnings, so a successor without the rung is privilege escalation
    // arriving as a migration.
    expect(entry('provider.earnings.transaction').capability).toBe('canViewEarnings');
  });

  it('every earnings entry carries it, not just the new one', () => {
    const earnings = V1_CONTRACT.filter(
      (e) => e.path.startsWith('/provider/earnings') && e.status === 'implemented',
    );
    expect(earnings.length).toBeGreaterThanOrEqual(4);
    for (const e of earnings) expect(e.capability).toBe('canViewEarnings');
  });
});

describe('account deletion is published as what it IS', () => {
  it('is named deletion-request, because it records an intention', () => {
    const e = entry('provider.account.requestDeletion');
    // The legacy path is /account/delete, which reads as an erasure and is not
    // one. Publishing it under a name that promised more would have been the
    // least honest thing in this programme.
    expect(e.path).toBe('/provider/account/deletion-request');
    expect(e.path).not.toMatch(/\/delete$/);
    expect(supersedes.get('/api/provider/account/delete')).toBe('provider.account.requestDeletion');
  });

  it('documents that nothing is erased by the call', () => {
    expect(entry('provider.account.requestDeletion').notes).toMatch(/RECORDS AN INTENTION/);
    expect((SCHEMAS.ProviderAccountDeletionResult as any).description).toMatch(/Nothing is erased/);
  });

  it('documents the precondition: live work blocks it', () => {
    // Nobody deletes their way out of a booking a customer is waiting for.
    expect(entry('provider.account.requestDeletion').notes).toMatch(/THE PRECONDITION/);
    expect(entry('provider.account.requestDeletion').errors).toContain('CONFLICT');
  });

  it('is idempotent, because the write is an upsert keyed on the uid', () => {
    const e = entry('provider.account.requestDeletion');
    expect(e.idempotent).toBe(true);
    expect(e.replayMechanism).toBeUndefined();
  });

  it('does NOT invent a retention policy, and says why', () => {
    const notes = entry('provider.account.requestDeletion').notes!;
    // The legacy handler promises deletion "within 30 days" in a MESSAGE
    // STRING. No client can branch on it and no job in this repository executes
    // it. Asserting a schedule here without the owner's decision would be worse
    // than asserting none.
    expect(notes).toMatch(/NOT DECIDED HERE/);
    expect(notes).toMatch(/MESSAGE STRING/);
    expect(notes).toMatch(/RA 10173/);
  });
});

describe('the offerings path answers the question the mandate asked', () => {
  it('is inside the canonical surface, with one version segment', () => {
    const e = entry('provider.catalog.offerings');
    // The legacy path carries a `v1` of its OWN under a different prefix —
    // /api/provider-catalog/v1/... — a version belonging to that subsystem and
    // not to this contract. Two things called v1 in one URL space is a question
    // somebody has to stop and answer every time they read it.
    expect(e.path).toBe('/provider/catalog/offerings');
    expect(e.path).not.toMatch(/v1/);
    expect(supersedes.get('/api/provider-catalog/v1/offerings')).toBe('provider.catalog.offerings');
  });
});

describe('the photo channel now exists for the profile PATCH to point at', () => {
  it('upload and delete are both published', () => {
    // The book names /api/worker/profile/photo as ONE path; it carries POST and
    // DELETE. Counting paths has undercounted every cluster in this programme.
    expect(entry('provider.profilePhoto.upload').method).toBe('post');
    expect(entry('provider.profilePhoto.delete').method).toBe('delete');
    expect(entry('provider.profilePhoto.upload').path)
      .toBe(entry('provider.profilePhoto.delete').path);
  });

  it('is the channel TAB 01 named when it refused `photo` on the profile patch', () => {
    // REVIEW_FIELD_CHANNELS.photo points at the legacy path; this is its
    // canonical successor, so the refusal now points at something published.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { REVIEW_FIELD_CHANNELS } = require('../src/services/providerProfileComplianceService');
    expect(REVIEW_FIELD_CHANNELS.photo).toMatch(/profile-photo-submissions|profile\/photo/);
    expect(entry('provider.profilePhoto.upload').notes).toMatch(/TAB 01/);
  });

  it('the upload requires a replay key, so a retry submits one photo', () => {
    expect(entry('provider.profilePhoto.upload').replayMechanism).toEqual(['client-request-id']);
  });
});

describe('every remainder entry is triaged rather than left implicit', () => {
  const REMAINDER = [
    'provider.alerts.list', 'provider.alerts.dismiss', 'provider.calendar.get',
    'provider.performance.get', 'provider.profilePhoto.upload', 'provider.profilePhoto.delete',
    'provider.schedule.get', 'provider.catalog.offerings',
    'provider.account.requestDeletion', 'provider.earnings.transaction',
  ];

  it('all ten are implemented and provider-scoped', () => {
    for (const id of REMAINDER) {
      const e = entry(id);
      expect(e.status).toBe('implemented');
      expect(e.auth).toBe('provider');
    }
  });

  it('each names the legacy path it supersedes, so nothing is orphaned', () => {
    for (const id of REMAINDER) {
      expect(entry(id).legacy.length).toBeGreaterThan(0);
      for (const l of entry(id).legacy) expect(l.note.length).toBeGreaterThan(20);
    }
  });

  it('every non-idempotent one declares a replay mechanism', () => {
    for (const id of REMAINDER) {
      const e = entry(id);
      if (e.idempotent) continue;
      expect(Array.isArray(e.replayMechanism)).toBe(true);
      expect(e.replayMechanism!.length).toBeGreaterThan(0);
    }
  });

  it('none accepts a provider uid as a parameter', () => {
    for (const id of REMAINDER) {
      expect(entry(id).path).not.toMatch(/:providerUid|:workerId|:uid/);
    }
  });
});
