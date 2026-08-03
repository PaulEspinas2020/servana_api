/**
 * Invite an admin by email (no Firebase UID).
 *
 * The portal's form required a Firebase UID, so the person had to already exist
 * in Firebase — created by hand, out of band. You cannot get a uid without an
 * account, and nobody creates the account because the form asks for the uid.
 *
 * Static assertions over the source, consistent with the other authorization
 * tests here: the risks live in ordering and in a guard, and a test stubbing the
 * SDK would pass against a version that got either wrong.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const flat = (s: string) => s.replace(/\s+/g, ' ');
const code = (s: string) =>
  s.split('\n').map((l) => l.replace(/--.*/, '').replace(/^\s*\/\/.*/, '')).join('\n');

const svc = flat(code(read('services/adminInviteService.ts')));
const routes = flat(code(read('routes/adminPermission.routes.ts')));

describe('authorization', () => {
  test('inviting requires Super Admin, exactly like creating', () => {
    // Being able to invite an admin IS being able to create one. A weaker guard
    // on the friendlier route would make the strict one decorative.
    expect(routes).toMatch(
      /post\('\/admin\/admin-users\/invite',\s*\.\.\.adminOnly,\s*requireSuperAdmin/
    );
    expect(routes).toMatch(
      /post\('\/admin\/admin-users\/:adminUid\/resend-invite',\s*\.\.\.adminOnly,\s*requireSuperAdmin/
    );
  });
});

describe('account resolution', () => {
  test('reuses an existing Firebase account rather than failing', () => {
    expect(svc).toContain('getUserByEmail');
    expect(svc).toMatch(/auth\/user-not-found/);
  });

  test('creates the account with NO password', () => {
    // The invitee sets one through the link, so a password is never chosen by
    // the inviter, never transmitted, and never known by anyone else.
    const create = svc.slice(svc.indexOf('auth.createUser'), svc.indexOf('auth.createUser') + 260);
    expect(create).not.toMatch(/password/i);
  });

  test('normalizes the email before anything else', () => {
    expect(svc).toContain('normalizeEmail(input.email)');
  });
});

describe('the guard that matters', () => {
  test('refuses to convert a provider or customer into an admin', () => {
    // createAdminUser upserts user_credentials.role = 1. If the email belongs
    // to a provider, that single statement destroys their provider access —
    // every provider query scopes on role — with no warning and no undo.
    expect(svc).toContain('PROTECTED_ROLES');
    expect(svc).toMatch(/IDENTIFIER_CONFLICT/);
  });

  test('the check runs BEFORE the admin record is created', () => {
    expect(svc.indexOf('PROTECTED_ROLES[currentRole]'))
      .toBeLessThan(svc.indexOf('createAdminUser('));
  });

  test('the conflict message does not leak the other account', () => {
    // It names the ROLE, which the operator needs in order to act, and nothing
    // that identifies the person holding it.
    const msg = svc.slice(svc.indexOf('already belongs to a'), svc.indexOf('IDENTIFIER_CONFLICT'));
    expect(msg).not.toMatch(/uid|display_name|first_name/);
  });
});

describe('ordering and failure', () => {
  test('the email is sent AFTER the admin record exists', () => {
    // The other order gives the invitee a working link into an account with no
    // admin access and no way to tell why.
    expect(svc.indexOf('createAdminUser(')).toBeLessThan(svc.indexOf('sendInviteEmail('));
  });

  test('a failed mail hop does not fail the invitation', () => {
    // The record exists and is usable; the operator can resend. Throwing here
    // would leave an admin created but reported as failed.
    const send = svc.slice(svc.indexOf('export async function sendInviteEmail'));
    expect(send).toMatch(/catch/);
    expect(send).toMatch(/return false/);
  });

  test('the link is never logged — it is a credential', () => {
    const send = svc.slice(svc.indexOf('export async function sendInviteEmail'));
    const logLine = send.slice(send.indexOf('console.error'), send.indexOf('return false'));
    expect(logLine).not.toContain('link');
    expect(logLine).not.toContain('${email}');
  });
});
