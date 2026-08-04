import { readFileSync } from 'fs';
import { join } from 'path';

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

import dbQuery from '../src/db/dbQuery';
import {
  provenFrom,
  recordProvenIdentifiers,
} from '../src/services/identityVerificationSync';

const query = (dbQuery as any).query as jest.Mock;

/**
 * The column nobody wrote.
 *
 * Masterlist S-06. `is_mobile_verified` was added with DEFAULT false, read by
 * the account-state endpoint, the identifier resolver and the link guard, and
 * written by nothing at all. Because `IDENTIFIER_VERIFICATION_REQUIRED` sits
 * second in the state precedence, a provider signing in by OTP — proving the
 * number to Firebase every time — was held at a verification step they had just
 * completed, permanently.
 *
 * Production, 2026-08-04: 68 of 70 providers had no verified identifier of any
 * kind. 29 have no email at all, so OTP is their only way in.
 */
describe('provenFrom', () => {
  const user = (over: any = {}) => ({
    emailVerified: false,
    providerData: [],
    ...over,
  });

  it('reads a phone sign-in as proof of the number', () => {
    const p = provenFrom({ firebase: { sign_in_provider: 'phone' } }, user());
    expect(p.mobileVerified).toBe(true);
  });

  it('keeps a linked phone credential proven on a later email sign-in', () => {
    // Proven once is proven. The provider signed in by password this time, but
    // the phone credential on the account was established by an OTP.
    const p = provenFrom(
      { firebase: { sign_in_provider: 'password' } },
      user({ providerData: [{ providerId: 'password' }, { providerId: 'phone' }] })
    );
    expect(p.mobileVerified).toBe(true);
  });

  it('does not invent a phone verification from an email sign-in', () => {
    const p = provenFrom(
      { firebase: { sign_in_provider: 'password' } },
      user({ providerData: [{ providerId: 'password' }] })
    );
    expect(p.mobileVerified).toBe(false);
  });

  it('takes the email verdict from Firebase, not from the address existing', () => {
    expect(provenFrom({}, user({ emailVerified: true })).emailVerified).toBe(true);
    expect(provenFrom({}, user({ emailVerified: false })).emailVerified).toBe(false);
    // A truthy non-boolean is not a verification.
    expect(provenFrom({}, user({ emailVerified: 'yes' })).emailVerified).toBe(false);
  });

  it('survives a malformed user record without claiming anything', () => {
    expect(provenFrom(undefined, undefined)).toEqual({
      emailVerified: false,
      mobileVerified: false,
    });
    expect(provenFrom({}, { providerData: 'not-an-array' })).toEqual({
      emailVerified: false,
      mobileVerified: false,
    });
  });
});

describe('recordProvenIdentifiers', () => {
  beforeEach(() => query.mockReset());

  it('writes nothing when nothing was proven', async () => {
    const changed = await recordProvenIdentifiers('uid-1', {
      emailVerified: false,
      mobileVerified: false,
    });
    expect(changed).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('only ever sets flags upward', async () => {
    // A provider verified through the older email-OTP flow carries
    // is_email_verified = true in a Firebase record that knows nothing about
    // it. Clearing that on a phone sign-in would revoke a verification that
    // genuinely happened.
    query.mockResolvedValue({ rowCount: 1 });
    await recordProvenIdentifiers('uid-1', {
      emailVerified: false,
      mobileVerified: true,
    });
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toMatch(/is_email_verified\s*=\s*COALESCE\(is_email_verified, false\)\s*OR/);
    expect(sql).toMatch(/is_mobile_verified\s*=\s*COALESCE\(is_mobile_verified, false\)\s*OR/);
    // No path may assign a bare false.
    expect(sql).not.toMatch(/is_(email|mobile)_verified\s*=\s*false/);
  });

  it('is a no-op for an account already marked', async () => {
    query.mockResolvedValue({ rowCount: 0 });
    const changed = await recordProvenIdentifiers('uid-1', {
      emailVerified: true,
      mobileVerified: true,
    });
    expect(changed).toBe(false);
  });

  it('reports a real change', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    expect(
      await recordProvenIdentifiers('uid-1', {
        emailVerified: false,
        mobileVerified: true,
      })
    ).toBe(true);
  });

  it('scopes the write to one uid', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    await recordProvenIdentifiers('uid-1', {
      emailVerified: true,
      mobileVerified: false,
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('WHERE uid = $1');
    expect(params[0]).toBe('uid-1');
  });
});

describe('every sign-in path records what it proved', () => {
  const service = readFileSync(
    join(__dirname, '..', 'src', 'services', 'firebaseFunctions.service.ts'),
    'utf8'
  );

  it('is wired into all three, not just the one that was reported', () => {
    // Fixing the instance and not the class is how the same defect comes back
    // through a sibling path. Phone sign-in, provider registration and customer
    // social login all establish a verified identifier.
    const calls = service.match(/recordProvenIdentifiers\(/g) ?? [];
    expect(calls.length).toBe(3);
  });

  it('never lets a failed record break a sign-in', () => {
    // The worst case must be that the flag lands next time, not that somebody
    // cannot get in.
    const blocks = service.split('recordProvenIdentifiers(');
    expect(blocks.length).toBe(4);
    for (const before of blocks.slice(0, -1).map((b) => b.slice(-400))) {
      expect(before).toContain('try {');
    }
  });

  it('awaits it, so the very next account-state call sees the truth', () => {
    // The client asks for /provider/account-state immediately after sign-in.
    // Fire-and-forget would show a verification screen to someone who verified
    // two seconds earlier, and clear it only on their next sign-in.
    expect(service).toMatch(/await\s+recordProvenIdentifiers\(/);
    expect(service).not.toMatch(/recordProvenIdentifiers\([^)]*\)\.catch\(/);
  });
});

describe('the two engines agree on what "verified" means', () => {
  const readiness = readFileSync(
    join(__dirname, '..', 'src', 'services', 'adminOnboardingService.ts'),
    'utf8'
  );
  const state = readFileSync(
    join(__dirname, '..', 'src', 'services', 'providerAccountStateService.ts'),
    'utf8'
  );

  it('readiness accepts a verified mobile, not only an email', () => {
    // It asked for is_email_verified alone, which is unsatisfiable for the 29
    // production providers who have no email address at all. They could satisfy
    // every other requirement and still carry a blocking
    // missing_email_verification for ever.
    expect(readiness).toContain('is_mobile_verified');
    expect(readiness).toMatch(/!emailVerified\s*&&\s*!mobileVerified/);
  });

  it('and the account-state endpoint says the same thing', () => {
    expect(state).toMatch(
      /minimumRequirementMet\s*=\s*email === "VERIFIED" \|\| mobile === "VERIFIED"/
    );
  });

  it('does not tell someone with no email that their email is unverified', () => {
    // The label follows the account, not the rule. That sentence is how a
    // support ticket starts.
    expect(readiness).toContain("'Mobile number not verified'");
  });
});
