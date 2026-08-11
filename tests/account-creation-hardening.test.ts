import fs from 'fs';
import path from 'path';

const read = (file: string) => fs.readFileSync(
  path.join(__dirname, '..', 'src', file),
  'utf8',
);

const auth = read('services/auth.service.ts');
const users = read('services/user.service.ts');
const controller = read('controllers/auth.controller.ts');
const otp = read('services/otpService.ts');

describe('account creation is atomic and recoverable', () => {
  test('classic signup derives normalized identifiers and creates the provider profile atomically', () => {
    const register = users.slice(
      users.indexOf('const registerUserInDB'),
      users.indexOf('export const upsertFirebaseUser'),
    );

    expect(register).toContain('deriveNormalized(');
    expect(register).toContain('email_normalized');
    expect(register).toContain('phone_normalized');
    expect(register).toContain('WITH inserted AS');
    expect(register).toContain('INSERT INTO ${dbSchema}.user_profile (uid)');
    expect(register).toContain('SELECT uid FROM inserted WHERE role::int = 2');
    expect(register).not.toContain('await updateUserProfile');
  });

  test('Firebase registration also ensures the canonical provider profile in the same statement', () => {
    const upsert = users.slice(
      users.indexOf('export const upsertFirebaseUser'),
      users.indexOf('const updateUserPasswordHash'),
    );

    expect(upsert).toContain('WITH upserted AS');
    expect(upsert).toContain('INSERT INTO ${dbSchema}.user_profile (uid)');
    expect(upsert).toContain('SELECT uid FROM upserted WHERE role::int = 2');
  });

  test('a failed DB write compensates the Firebase identity, but delivery failures do not delete a committed account', () => {
    const register = auth.slice(
      auth.indexOf('const registerUser = async'),
      auth.indexOf('const verifyEmailOtp = async'),
    );

    expect(register).toContain('registrationCommitted = true');
    expect(register).toContain('if (userData?.uid && !registrationCommitted)');
    expect(register).toContain('deleteFirebaseUser(userData.uid)');
    expect(register).toContain('verificationDeliveryPending = true');
    expect(register.indexOf('registrationCommitted = true')).toBeLessThan(
      register.indexOf('verificationDeliveryPending = true'),
    );
  });

  test('mail promises are awaited so delivery failures enter the recovery path', () => {
    const register = auth.slice(
      auth.indexOf('const registerUser = async'),
      auth.indexOf('const verifyEmailOtp = async'),
    );
    expect(register).toContain('await send(dbRegister.email, "verify_email_otp"');
    expect(register).toContain('await send(dbRegister.email, "verify_email"');
  });
});

describe('account identity and verification contracts', () => {
  test('registration canonicalizes email and names before either identity store sees them', () => {
    const register = auth.slice(
      auth.indexOf('const registerUser = async'),
      auth.indexOf('const verifyEmailOtp = async'),
    );
    const canonical = register.indexOf('const canonicalUser');
    expect(register).toContain('normalizeEmail(email)');
    expect(register).toContain('normalizeProfileName(firstName, "firstName")');
    expect(register).toContain('normalizeProfileName(lastName, "lastName")');
    expect(canonical).toBeLessThan(register.indexOf('registerNewUserInFirebase(canonicalUser)'));
  });

  test('OTP lookup is case-stable and consumption is single-use', () => {
    // The lookup and the compare-and-swap moved to `services/otpService.ts`
    // when one-time codes gained an explicit PURPOSE — `user.service`'s three
    // OTP functions now delegate to it. This asserts the GUARANTEE wherever it
    // lives rather than the file the SQL used to sit in: the previous version
    // of this test pinned the literal string in user.service and would have
    // failed on a move that strengthened the thing it protects.
    expect(users).toContain('const canonicalEmail = normalizeEmail(email)');
    expect(users).toContain('WHERE email_normalized = $1');

    // Case-stable: every read and write normalises the address first.
    expect(otp).toContain('const canonicalEmail = normalizeEmail(email)');

    // Single-use: the UPDATE re-checks `used` and `expires_at`, so two
    // concurrent verifications of one code cannot both succeed. A read-then-
    // write would let both through.
    expect(otp).toContain('WHERE id = $1 AND used = FALSE AND expires_at > NOW()');
    expect(otp).toContain('return rows.length === 1');

    // And the legacy consumer still refuses an unclaimed code.
    expect(auth).toContain('if (!claimed) throw "Invalid or expired OTP"');
  });

  test('every OTP read is scoped to a purpose, so one code cannot satisfy two decisions', () => {
    // Registration is the only purpose in production today, which is exactly
    // why the scoping goes in now: the second purpose is where an unscoped read
    // becomes a code minted for a password reset satisfying a registration
    // screen.
    expect(otp).toContain('AND purpose = $2');
    expect(otp).toContain("REGISTRATION_VERIFICATION: 'REGISTRATION_VERIFICATION'");
    // The legacy wrappers pass the default purpose rather than reading unscoped.
    expect(users).toContain('otpService.DEFAULT_PURPOSE');
  });

  test('the success response reports the real formatted DB id and additive recovery state', () => {
    const signup = controller.slice(
      controller.indexOf('const signup = async'),
      controller.indexOf('const verifyEmailOtpController'),
    );
    expect(signup).toContain('dbRegister?.uid');
    expect(signup).toContain('dbRegister?.id');
    expect(signup).toContain('verificationDeliveryPending');
    expect(signup).toContain('onboardingPending');
  });

  test('classic provider signup runs the same attribution and eligibility hooks as provider web', () => {
    const signup = controller.slice(
      controller.indexOf('const signup = async'),
      controller.indexOf('const verifyEmailOtpController'),
    );
    expect(signup).toContain('normalizeProviderSourceClient');
    expect(signup).toContain('upsertSourceAttribution(userId, sourceClient, true');
    expect(signup).toContain("evaluateProvider(userId, 'system', null)");
    expect(signup).toContain('.catch(() => {})');
  });
});

describe('admin-created accounts use the same commit boundary', () => {
  test('a failed authoritative profile write removes the just-created Firebase identity', () => {
    const adminCreate = auth.slice(
      auth.indexOf('const addEmployees = async'),
      auth.indexOf('const updateEmployee = async'),
    );
    expect(adminCreate).toContain('deleteFirebaseUser(firebaseUser.uid).catch');
    expect(adminCreate).toContain('Promise.allSettled');
    expect(adminCreate).toContain('provisioningPending');
    expect(adminCreate).toContain('inviteDeliveryPending');
  });

  test('an all-failed admin batch is not returned as a successful HTTP request', () => {
    const addEmployees = controller.slice(
      controller.indexOf('export const addEmployeesController'),
      controller.indexOf('export const forgotPasswordController'),
    );
    expect(addEmployees).toContain('created === 0 ? 422 : 200');
    expect(addEmployees).toContain('created === 0 ? "failed"');
  });
});
