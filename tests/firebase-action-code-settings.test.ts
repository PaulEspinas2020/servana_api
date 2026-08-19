/**
 * What actually reaches Firebase.
 *
 * `platform-continue-urls.test.ts` proves the *resolution* rule. This proves
 * the *wiring*: that a resolved URL is handed to the Admin SDK as
 * `ActionCodeSettings`, and — the part that matters for mobile parity — that
 * when nothing resolves, the SDK is called with `undefined` and NOT with an
 * empty object or a settings object carrying an empty `url`.
 *
 * That distinction is invisible in the resolution tests and is exactly where
 * this kind of change breaks an existing client: `generateEmailVerificationLink(
 * email, {})` is not the same call as `generateEmailVerificationLink(email)`,
 * and the second is what every current caller has always made.
 */

const generateEmailVerificationLink = jest.fn();
const generatePasswordResetLink = jest.fn();

jest.mock('../src/middleware/firebaseApp', () => ({ getFirebaseAdmin: () => ({}) }));
jest.mock('firebase-admin/auth', () => ({
    getAuth: () => ({ generateEmailVerificationLink, generatePasswordResetLink }),
}));
jest.mock('firebase/auth', () => ({
    getAuth: () => ({}),
    signInWithEmailAndPassword: jest.fn(),
    applyActionCode: jest.fn(),
    createUserWithEmailAndPassword: jest.fn(),
    signOut: jest.fn(),
    sendEmailVerification: jest.fn(),
    confirmPasswordReset: jest.fn(),
    verifyPasswordResetCode: jest.fn(),
}));
jest.mock('../src/db/dbQuery', () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock('../src/config', () => ({
    db: { schema: 'servana' },
    firebaseConfig: { storageBucket: 'test' },
}));
jest.mock('../src/services/user.service', () => ({}));
jest.mock('../src/services/accountLinkGuard', () => ({
    findLinkCollision: jest.fn(),
    AccountLinkRequiredError: class extends Error {},
}));
jest.mock('../src/services/accountLinking', () => ({ mergePhoneIntoExistingAccount: jest.fn() }));
jest.mock('../src/services/identityVerificationSync', () => ({
    provenFrom: jest.fn(),
    recordProvenIdentifiers: jest.fn(),
}));
jest.mock('../src/services/tokenRevocation', () => ({ noteRevoked: jest.fn() }));

import {
    sendEmailVerificationFirebase,
    generatePasswordResetLink as generateResetLink,
} from '../src/services/firebaseFunctions.service';

beforeEach(() => {
    generateEmailVerificationLink.mockReset().mockResolvedValue('https://firebase.test/link');
    generatePasswordResetLink.mockReset().mockResolvedValue('https://firebase.test/reset');
});

describe('email verification links', () => {
    test('with no continueUrl the SDK is called exactly as it always was', () => {
        // Two arguments where there used to be one is still a behaviour change
        // if the second is `{}`. It must be `undefined`.
        return sendEmailVerificationFirebase('someone@example.com').then(() => {
            expect(generateEmailVerificationLink).toHaveBeenCalledWith(
                'someone@example.com',
                undefined,
            );
        });
    });

    test('an empty-string continueUrl is treated as absent, not as a setting', async () => {
        // `{ url: '' }` would be rejected by Firebase and take down a signup
        // that works today.
        await sendEmailVerificationFirebase('someone@example.com', '');
        expect(generateEmailVerificationLink).toHaveBeenCalledWith('someone@example.com', undefined);
    });

    test('a resolved continueUrl is passed as ActionCodeSettings', async () => {
        await sendEmailVerificationFirebase('someone@example.com', 'https://servana.com.ph/verify-email');
        expect(generateEmailVerificationLink).toHaveBeenCalledWith('someone@example.com', {
            url: 'https://servana.com.ph/verify-email',
        });
    });
});

describe('password reset links', () => {
    test('with no continueUrl the SDK is called exactly as it always was', async () => {
        await generateResetLink('someone@example.com');
        expect(generatePasswordResetLink).toHaveBeenCalledWith('someone@example.com', undefined);
    });

    test('a resolved continueUrl is passed as ActionCodeSettings', async () => {
        await generateResetLink('someone@example.com', 'https://servana.com.ph/reset-password');
        expect(generatePasswordResetLink).toHaveBeenCalledWith('someone@example.com', {
            url: 'https://servana.com.ph/reset-password',
        });
    });
});
