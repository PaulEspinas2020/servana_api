/**
 * Pending-invitation state (SWEEP/STITCH on the invite flow).
 *
 * The state is DERIVED from two timestamps rather than stored as a status. A
 * status column has to be written by every path that changes the situation, and
 * the paths here are a mail send and an unrelated authenticated request — the
 * two least likely places anyone would remember to update it.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const strip = (s: string) =>
  s.split('\n').map((l) => l.replace(/--.*/, '').replace(/^\s*\/\/.*/, '')).join('\n');
const flat = (s: string) => strip(s).replace(/\s+/g, ' ');

const perm = flat(read('services/adminPermissionService.ts'));
const state = flat(read('services/adminInviteState.ts'));
const invite = flat(read('services/adminInviteService.ts'));

describe('the state is derived, not stored', () => {
  test('pending means invited and not yet arrived', () => {
    expect(perm).toMatch(
      /WHEN au\.invited_at IS NOT NULL AND au\.accepted_at IS NULL THEN 'pending'/
    );
  });

  test("an admin who was never invited is 'direct', not pending", () => {
    // Admins created by uid, and every admin predating invitations, were never
    // invited. Showing them as pending would invent a problem to chase.
    expect(perm).toMatch(/ELSE 'direct'/);
  });

  test('no invitation_status COLUMN was added', () => {
    expect(state).not.toMatch(/ADD COLUMN IF NOT EXISTS invitation_status/);
  });
});

describe('the columns exist before anything queries them', () => {
  test('schema bootstrap creates them', () => {
    // The LIST query derives invitationState from these columns. Adding them
    // lazily — only when an invitation is sent — means the first page load
    // after deploy fails on any database that has not yet sent one, which is
    // every database at the moment of deploy.
    const boot = perm.slice(perm.indexOf('ensurePermissionSchema'));
    expect(boot).toContain('ensureInviteColumns()');
  });

  test('they are additive and nullable', () => {
    expect(state).toMatch(/ADD COLUMN IF NOT EXISTS invited_at\s+TIMESTAMPTZ/);
    expect(state).toMatch(/ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ/);
  });
});

describe('when each timestamp is written', () => {
  test('invited_at is stamped only AFTER the mail actually sends', () => {
    // Stamping before would show "Pending" for someone who was never contacted,
    // which reads as "waiting on them" when it is really "waiting on us".
    const send = invite.slice(invite.indexOf('export async function sendInviteEmail'));
    expect(send.indexOf('await send(')).toBeLessThan(send.indexOf('invited_at = NOW()'));
  });

  test('accepted_at records FIRST arrival, not latest activity', () => {
    expect(state).toMatch(/accepted_at IS NULL AND invited_at IS NOT NULL/);
  });

  test('acceptance bookkeeping cannot break an admin session', () => {
    // It runs on every authenticated admin request. A throw here would turn a
    // working session into an error for a cosmetic list badge.
    const fn = state.slice(state.indexOf('markInviteAccepted'));
    expect(fn).toMatch(/catch/);
    expect(perm).toMatch(/markInviteAccepted\(adminUid\)\.catch\(/);
  });
});

describe('no import cycle', () => {
  test('the state module depends on nothing in this feature', () => {
    // adminInviteService needs invited_at; adminPermissionService needs
    // accepted_at. Putting either in either service made them import each
    // other, which works only because the calls happen at runtime — a property
    // that holds until someone moves one into an initialiser.
    // Assert on the IMPORT lines, not the file text: this module's own comment
    // names both services while explaining the cycle it avoids, and matching
    // that would be grading prose rather than dependencies. That mistake has
    // been made three times in this codebase already.
    const imports = (
      read('services/adminInviteState.ts').match(/^\s*import.*$/gm) ?? []
    ).join(' ');
    expect(imports).not.toContain('adminPermissionService');
    expect(imports).not.toContain('adminInviteService');
  });
});
