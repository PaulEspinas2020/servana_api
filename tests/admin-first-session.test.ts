/**
 * An invited admin's FIRST sign-in must not demote them.
 *
 * The sequence: the invite creates the Firebase account, then createAdminUser
 * INSERTs user_credentials with role = 1. The invitee follows the emailed link,
 * sets a password, signs in — and that sign-in runs upsertFirebaseUser, whose
 * INSERT defaults `role` to "2" (provider).
 *
 * It is only safe because `role` is absent from the ON CONFLICT DO UPDATE SET,
 * so the existing row keeps role = 1. That is a property of ORDERING and an
 * omission, not of intent: adding `role` to that SET — which looks like an
 * obvious completeness fix — would silently downgrade every admin on their next
 * sign-in, and they would find out by losing the portal.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const strip = (s: string) =>
  s.split('\n').map((l) => l.replace(/--.*/, '').replace(/^\s*\/\/.*/, '')).join('\n');
const flat = (s: string) => strip(s).replace(/\s+/g, ' ');

const userSvc = read('services/user.service.ts');
const inviteSvc = flat(read('services/adminInviteService.ts'));
const permSvc = flat(read('services/adminPermissionService.ts'));

describe('first sign-in does not overwrite the role', () => {
  const upsertConflict = () => {
    const s = strip(userSvc);
    const i = s.indexOf('ON CONFLICT (uid)');
    expect(i).toBeGreaterThan(-1);
    return s.slice(i, s.indexOf('RETURNING', i));
  };

  test('role is NOT in the DO UPDATE SET', () => {
    // The whole safety property. If this ever fails, every existing admin is
    // demoted to provider the next time they sign in.
    expect(upsertConflict()).not.toMatch(/\brole\b\s*=/);
  });

  test('the columns that ARE updated are the harmless ones', () => {
    const c = upsertConflict();
    expect(c).toMatch(/email = COALESCE/);
    expect(c).toMatch(/phone_number = COALESCE/);
    expect(c).toMatch(/first_name = CASE/);
  });

  test('role still defaults to provider on INSERT', () => {
    // Documenting the hazard rather than asserting it is fine: a brand-new
    // account created by a provider sign-in SHOULD be a provider. The danger is
    // only if that path ever runs before the admin row exists.
    expect(flat(userSvc)).toMatch(/role = "2"/);
  });
});

describe('the invite establishes the role before any sign-in', () => {
  test('createAdminUser writes role = 1', () => {
    expect(permSvc).toMatch(/INSERT INTO \$\{s\}\.user_credentials \(uid, role\) VALUES \(\$1, 1\)/);
    expect(permSvc).toMatch(/ON CONFLICT \(uid\) DO UPDATE SET role = 1/);
  });

  test('the invite calls it BEFORE sending the email', () => {
    // So the row exists with role = 1 before the invitee can possibly sign in.
    // The reverse order would race a fast invitee against their own account.
    expect(inviteSvc.indexOf('createAdminUser(')).toBeLessThan(
      inviteSvc.indexOf('sendInviteEmail(')
    );
  });

  test('and before the account can be used at all', () => {
    // createUser comes first (it yields the uid), then the role is written.
    expect(inviteSvc.indexOf('auth.createUser')).toBeLessThan(
      inviteSvc.indexOf('createAdminUser(')
    );
  });
});

describe('the invited account cannot sign in before setting a password', () => {
  test('it is created with no password', () => {
    const create = inviteSvc.slice(
      inviteSvc.indexOf('auth.createUser'),
      inviteSvc.indexOf('auth.createUser') + 260
    );
    expect(create).not.toMatch(/password/i);
  });

  test('and is not marked email-verified', () => {
    // Verification happens by following the emailed link. Pre-marking it would
    // assert something nobody has demonstrated.
    expect(inviteSvc).toMatch(/emailVerified: false/);
  });
});
