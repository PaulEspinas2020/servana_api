/**
 * Customer sign-up was broken for everyone, and the same line was a mass
 * assignment.
 *
 * `registerNewUserInFirebase` did:
 *
 *     createUser({ ...user, displayName })
 *
 * where `user` is the raw request body (auth.controller.ts passes req.body
 * straight through). Two P0s from one spread:
 *
 * 1. ServanaClient always sends `phoneNumber`, defaulting it to '' for a field
 *    its own UI labels "(optional)" (http_backend.dart:130). firebase-admin
 *    checks `typeof phoneNumber !== 'undefined'` rather than truthiness, and its
 *    validator requires a leading '+' — so '' is rejected, and so is
 *    '09171234567', the way every Filipino writes their own number. Every
 *    email/password registration failed unless the customer typed '+63…', and
 *    the controller collapsed the error to "Registration failed. Please try
 *    again." with no field named.
 *
 * 2. Every other key the caller sent reached the SDK, including `emailVerified`
 *    — so a registration could mark its own address verified and walk past the
 *    OTP gate that sign-in enforces.
 *
 * The lesson is the general one: never spread a request body into a privileged
 * API. Build the payload explicitly.
 */

jest.mock('../src/middleware/firebaseApp', () => ({ firebaseAdmin: {} }));

const createUser = jest.fn();
jest.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ createUser }),
}));
jest.mock('firebase/auth', () => ({
  getAuth: jest.fn(),
  signInWithEmailAndPassword: jest.fn(),
  applyActionCode: jest.fn(),
  createUserWithEmailAndPassword: jest.fn(),
  signOut: jest.fn(),
  sendEmailVerification: jest.fn(),
  confirmPasswordReset: jest.fn(),
  verifyPasswordResetCode: jest.fn(),
}));
jest.mock('../src/services/user.service', () => ({}));
jest.mock('../src/config', () => ({ db: { schema: 'servana' }, firebaseConfig: {} }));

import { registerNewUserInFirebase, toE164PH } from '../src/services/firebaseFunctions.service';

const BASE = {
  email: 'customer@example.com',
  password: 'Asdf@1234',
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  role: 3,
  platform: 'mobile',
};

beforeEach(() => {
  createUser.mockReset();
  createUser.mockResolvedValue({ uid: 'new-uid' });
});

const payload = () => createUser.mock.calls[0][0];

describe('the registration that used to fail', () => {
  it('an empty phoneNumber does not reach Firebase at all', async () => {
    // The exact body ServanaClient sends when the optional field is untouched.
    await registerNewUserInFirebase({ ...BASE, phoneNumber: '' });
    expect(createUser).toHaveBeenCalled();
    expect(payload()).not.toHaveProperty('phoneNumber');
  });

  it('a local Philippine number is normalised rather than rejected', async () => {
    await registerNewUserInFirebase({ ...BASE, phoneNumber: '09171234567' });
    expect(payload().phoneNumber).toBe('+639171234567');
  });

  it('an already-E.164 number is passed through', async () => {
    await registerNewUserInFirebase({ ...BASE, phoneNumber: '+639171234567' });
    expect(payload().phoneNumber).toBe('+639171234567');
  });

  it('an unparseable number is omitted, not forwarded to be rejected', async () => {
    // Dropping it is deliberate: the field is optional, and failing the whole
    // registration over a malformed optional field is what caused the outage.
    await registerNewUserInFirebase({ ...BASE, phoneNumber: 'not a number' });
    expect(payload()).not.toHaveProperty('phoneNumber');
  });

  it('a missing phoneNumber key is fine', async () => {
    await registerNewUserInFirebase({ ...BASE });
    expect(payload()).not.toHaveProperty('phoneNumber');
  });
});

describe('the payload is a whitelist, not a spread', () => {
  it('emailVerified from the request never reaches Firebase', async () => {
    // The mass assignment: self-verifying skips the OTP gate that sign-in
    // enforces (auth.service.ts reads the FIREBASE flag at sign-in).
    await registerNewUserInFirebase({ ...BASE, emailVerified: true });
    expect(payload()).not.toHaveProperty('emailVerified');
  });

  it('uid from the request never reaches Firebase', async () => {
    // Choosing your own uid means choosing whose rows you collide with.
    await registerNewUserInFirebase({ ...BASE, uid: 'someone-elses-uid' });
    expect(payload()).not.toHaveProperty('uid');
  });

  it('disabled from the request never reaches Firebase', async () => {
    await registerNewUserInFirebase({ ...BASE, disabled: false });
    expect(payload()).not.toHaveProperty('disabled');
  });

  it('photoURL and any other stray key are dropped', async () => {
    await registerNewUserInFirebase({
      ...BASE,
      photoURL: 'https://evil.example/x.png',
      anythingElse: 'nope',
    });
    expect(payload()).not.toHaveProperty('photoURL');
    expect(payload()).not.toHaveProperty('anythingElse');
  });

  it('sends exactly the intended keys and nothing more', async () => {
    await registerNewUserInFirebase({ ...BASE, phoneNumber: '09171234567' });
    expect(Object.keys(payload()).sort()).toEqual(
      ['displayName', 'email', 'password', 'phoneNumber'].sort(),
    );
  });

  it('still sets displayName from the name fields', async () => {
    await registerNewUserInFirebase({ ...BASE });
    expect(payload().displayName).toBe('Juan Dela Cruz');
    expect(payload().email).toBe('customer@example.com');
  });
});

describe('E.164 normalisation', () => {
  it.each([
    ['09171234567', '+639171234567'],
    ['639171234567', '+639171234567'],
    ['+639171234567', '+639171234567'],
    ['0917 123 4567', '+639171234567'],
    ['0917-123-4567', '+639171234567'],
    ['+14155552671', '+14155552671'],
  ])('%s -> %s', (input, expected) => {
    expect(toE164PH(input)).toBe(expected);
  });

  it.each(['', '   ', 'abc', '12345', '0917123456', null, undefined, 42, {}])(
    'rejects %p rather than guessing',
    (input) => {
      expect(toE164PH(input as any)).toBeNull();
    },
  );

  it('does not silently truncate a too-long number into a valid one', () => {
    expect(toE164PH('091712345671234567')).toBeNull();
  });
});
