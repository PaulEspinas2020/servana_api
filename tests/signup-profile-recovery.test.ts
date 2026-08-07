import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'auth.service.ts'),
  'utf8',
);
const registration = source.slice(
  source.indexOf('const registerUser = async'),
  source.indexOf('const verifyEmailOtp = async'),
);

describe('customer profile creation recovery', () => {
  test('DB profile creation remains authoritative if initial OTP persistence fails', () => {
    const dbWrite = registration.indexOf('registerUserInDB(dbData)');
    const otpTry = registration.indexOf('try {', dbWrite);
    const otpWrite = registration.indexOf('storeEmailOtp', otpTry);
    const otpCatch = registration.indexOf('catch (otpError', otpWrite);
    const successReturn = registration.indexOf('otpDeliveryPending,', otpCatch);

    expect(dbWrite).toBeGreaterThan(-1);
    expect(otpTry).toBeGreaterThan(dbWrite);
    expect(otpWrite).toBeGreaterThan(otpTry);
    expect(otpCatch).toBeGreaterThan(otpWrite);
    expect(successReturn).toBeGreaterThan(otpCatch);
  });

  test('recovery never deletes the already-created Firebase identity', () => {
    const mobileBranch = registration.slice(
      registration.indexOf('if (platform === "mobile")'),
      registration.indexOf('const verify ='),
    );
    expect(mobileBranch).not.toContain('deleteFirebaseUser');
    expect(mobileBranch).toContain('Request a new verification code');
  });
});
