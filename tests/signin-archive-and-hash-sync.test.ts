/**
 * Two sign-in defects on the email/password route.
 *
 * ARCHIVED ACCOUNTS COULD STILL SIGN IN. Both Firebase sign-in paths refuse them
 * (firebaseAuthLogin and customerFirebaseLogin check dbUser.isArchived), and the
 * admin portal has an archive action. The email/password route ignored it — the
 * credentials lookup did not even SELECT the column, so it could not have
 * checked. Disabling an account did nothing to the one route most people use.
 *
 * A FIREBASE-SIDE PASSWORD RESET LOCKED THE ACCOUNT OUT PERMANENTLY. Sign-in
 * compared the submitted password against a local bcrypt hash BEFORE asking
 * Firebase. Firebase is the authority; the column is a cache. A customer who
 * resets through the Firebase-hosted page changes it in Firebase only, so the
 * cached hash never matches again and every future sign-in answers "Invalid
 * email or password" — for a password that is, from the customer's side,
 * correct. There is no recovery through the app: resetting again produces the
 * same divergence.
 *
 * Source-level assertions. loggedInUser reaches Firebase, the mailer and four
 * services, so exercising it here would test the mocks rather than the logic.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const auth = read('services', 'auth.service.ts');
const users = read('services', 'user.service.ts');

/**
 * The body of loginUserInDBAndFirebase, where sign-in actually happens.
 *
 * Bounded by the NEXT top-level declaration rather than a character count: a
 * fixed window silently truncates when the function grows, and an assertion
 * that stops matching because its slice moved reads exactly like a regression.
 */
const signInBody = (() => {
  const start = auth.indexOf('const loginUserInDBAndFirebase');
  const next = auth.indexOf('\nconst ', start + 1);
  return auth.slice(start, next === -1 ? auth.length : next);
})();

describe('archived accounts cannot sign in', () => {
  it('the credentials lookup selects is_archive', () => {
    // It could not be checked before because it was never fetched.
    const fn = users.slice(
      users.indexOf('const getUserCredentialsByEmail'),
      users.indexOf('const getUserCredentialsByEmail') + 900,
    );
    expect(fn).toContain('c.is_archive');
  });

  it('the lookup exposes it as a boolean', () => {
    expect(users).toMatch(/isArchived:\s*rows\[0\]\.is_archive === true/);
  });

  it('sign-in refuses an archived account', () => {
    expect(signInBody).toMatch(/isArchived/);
    expect(signInBody).toContain('has been disabled');
  });

  it('it answers 403, not 401', () => {
    // 401 reads as "wrong password" and sends the customer round the reset
    // loop. 403 is the honest answer: the credentials were fine.
    const idx = signInBody.indexOf('has been disabled');
    expect(signInBody.slice(idx, idx + 200)).toContain('403');
  });

  it('the check runs before any token is minted', () => {
    // Signing in to Firebase first would hand out a usable credential and then
    // throw, which is a token leak rather than a rejection.
    expect(signInBody.indexOf('isArchived')).toBeLessThan(
      signInBody.indexOf('signInUserAndGetTokeninFirebase'),
    );
  });
});

describe('a stale local password hash cannot lock the account out', () => {
  it('a failed local compare is no longer fatal on its own', () => {
    // The old shape threw immediately on a hash mismatch, which is what made a
    // Firebase-side reset permanent.
    expect(signInBody).not.toMatch(
      /if \(!comparePassword\([^)]*\)\) \{\s*throw Object\.assign\(new Error\('Invalid email or password\.'\)/,
    );
    expect(signInBody).toMatch(/const localHashMatches = comparePassword/);
  });

  it('Firebase is consulted before the credential is judged wrong', () => {
    expect(signInBody.indexOf('const localHashMatches')).toBeLessThan(
      signInBody.indexOf('signInUserAndGetTokeninFirebase'),
    );
    // The re-sync can only run after Firebase has accepted the password.
    expect(signInBody.indexOf('signInUserAndGetTokeninFirebase')).toBeLessThan(
      signInBody.indexOf('updateUserPasswordHash'),
    );
  });

  it('the stale hash is re-synced once Firebase accepts the password', () => {
    expect(signInBody).toMatch(/if \(!localHashMatches\)/);
    expect(signInBody).toMatch(/updateUserPasswordHash\(\s*firebaseUser\.uid,\s*hashPassword\(password\)/);
  });

  it('a failed re-sync does not fail the sign-in', () => {
    // The customer is authenticated either way; the next sign-in retries.
    const idx = signInBody.indexOf('updateUserPasswordHash');
    expect(signInBody.slice(idx, idx + 300)).toContain('.catch(');
  });

  it('the writer exists and scopes by uid', () => {
    const fn = users.slice(
      users.indexOf('const updateUserPasswordHash'),
      users.indexOf('const updateUserPasswordHash') + 500,
    );
    expect(fn).toMatch(/UPDATE \$\{dbSchema\}\.user_credentials SET password = \$1 WHERE uid = \$2/);
  });

  it('it is exported', () => {
    expect(users).toMatch(/^\s*updateUserPasswordHash,$/m);
  });
});

describe('what must not have changed', () => {
  it('a wrong password is still rejected', () => {
    // Firebase throws when it rejects the password, and that error propagates —
    // the re-sync path is only reachable AFTER a successful Firebase sign-in.
    // If this ever becomes a caught-and-ignored error, sign-in stops checking
    // passwords at all.
    const idx = signInBody.indexOf('signInUserAndGetTokeninFirebase');
    const call = signInBody.slice(idx - 120, idx + 120);
    expect(call).not.toMatch(/try\s*\{[^}]*signInUserAndGetTokeninFirebase[^}]*\}\s*catch/);
  });

  it('the response whitelist still carries the refresh token', () => {
    expect(signInBody).toMatch(/refreshToken:\s*firebaseUser\.refreshToken/);
  });
});
