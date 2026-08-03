/**
 * Identifier normalization (Command 5 §4, §5, §7).
 *
 * These feed a UNIQUENESS constraint, which is what makes the negative cases as
 * important as the positive ones. A normalizer that always succeeds produces a
 * distinct output for every malformed spelling, so the index cannot catch
 * duplicates and two typos of one number become two provider accounts — the
 * exact failure §15 exists to prevent.
 *
 * The normalizer this replaces (`normalizePhilippinePhone`, still used for guest
 * contact numbers) ends with `return raw.startsWith('+') ? raw : '+' + cleaned`,
 * so "notaphone" normalises to "+notaphone". Every `returns null` test below is
 * a case that helper would have accepted.
 */

import {
  toE164PhMobile,
  isValidPhMobile,
  formatPhMobileForDisplay,
  maskPhMobile,
  normalizeEmail,
  detectIdentifierType,
} from '../src/helpers/phoneIdentifier';

describe('PH mobile → E.164', () => {
  test('accepts the forms a person actually types', () => {
    for (const input of [
      '0917 123 4567',
      '0917-123-4567',
      '09171234567',
      '9171234567',
      '+63 917 123 4567',
      '+639171234567',
      '63 917 123 4567',
      '(0917) 123-4567',
      '  09171234567  ',
    ]) {
      expect(toE164PhMobile(input)).toBe('+639171234567');
    }
  });

  test('every accepted spelling collapses to ONE value', () => {
    // The property the uniqueness index depends on.
    const all = new Set(
      ['0917 123 4567', '09171234567', '9171234567', '+639171234567', '639171234567']
        .map(toE164PhMobile)
    );
    expect(all.size).toBe(1);
  });

  describe('rejects rather than inventing a valid-looking number', () => {
    test.each([
      ['notaphone', 'letters'],
      ['0917123456', 'one digit short'],
      ['091712345678', 'one digit too long'],
      ['08171234567', 'landline prefix, not 9XX'],
      ['+1 415 555 0123', 'not a PH number'],
      ['0917123456a', 'trailing letter'],
      ['', 'empty'],
      ['   ', 'whitespace only'],
      ['+63', 'country code alone'],
      ['0000000000', 'not a 9XX mobile'],
    ])('%s (%s)', (input) => {
      expect(toE164PhMobile(input)).toBeNull();
      expect(isValidPhMobile(input)).toBe(false);
    });

    test('non-strings', () => {
      for (const v of [null, undefined, 42, {}, []]) {
        expect(toE164PhMobile(v)).toBeNull();
      }
    });
  });

  test('display form is what a Filipino provider reads back', () => {
    expect(formatPhMobileForDisplay('+639171234567')).toBe('0917 123 4567');
  });

  test('masked form shows enough to recognise, not enough to copy', () => {
    const masked = maskPhMobile('+639171234567');
    expect(masked).toBe('0917 •••• 567');
    expect(masked).not.toContain('1234');
  });
});

describe('email normalization', () => {
  test('casing and surrounding whitespace collapse', () => {
    for (const input of [
      'Juan@Gmail.com',
      'JUAN@GMAIL.COM',
      '  juan@gmail.com  ',
      'juan@Gmail.Com',
    ]) {
      expect(normalizeEmail(input)).toBe('juan@gmail.com');
    }
  });

  test('does NOT strip periods or +tags', () => {
    // Gmail-specific behaviour. Applying it platform-wide collapses genuinely
    // distinct addresses at every other provider (§4).
    expect(normalizeEmail('juan.cruz@outlook.com')).toBe('juan.cruz@outlook.com');
    expect(normalizeEmail('juan+servana@outlook.com')).toBe('juan+servana@outlook.com');
    expect(normalizeEmail('juan.cruz@outlook.com'))
      .not.toBe(normalizeEmail('juancruz@outlook.com'));
  });

  describe('rejects', () => {
    test.each([
      ['no-at-sign', 'missing @'],
      ['@gmail.com', 'empty local part'],
      ['juan@', 'empty domain'],
      ['juan@gmail', 'domain has no dot'],
      ['juan@.com', 'domain starts with a dot'],
      ['juan@gmail..com', 'double dot'],
      ['juan cruz@gmail.com', 'internal whitespace'],
      ['juan​@gmail.com', 'zero-width space'],
      ['juan\n@gmail.com', 'newline'],
      ['', 'empty'],
    ])('%s (%s)', (input) => {
      expect(normalizeEmail(input)).toBeNull();
    });

    test('absurd lengths', () => {
      expect(normalizeEmail('a'.repeat(65) + '@gmail.com')).toBeNull();
      expect(normalizeEmail('a'.repeat(250) + '@gmail.com')).toBeNull();
    });
  });
});

describe('identifier type detection', () => {
  test('an @ means they meant an email, even a broken one', () => {
    // Telling someone who typed `juan@gmial` that their MOBILE NUMBER is
    // invalid is worse than useless.
    expect(detectIdentifierType('juan@gmail.com')).toBe('email');
    expect(detectIdentifierType('juan@gmial')).toBe('email');
  });

  test('a valid PH mobile in any spelling is a mobile', () => {
    for (const v of ['09171234567', '+639171234567', '0917 123 4567']) {
      expect(detectIdentifierType(v)).toBe('mobile');
    }
  });

  test('anything else is unknown, not guessed', () => {
    for (const v of ['', '   ', 'juan', '12345', null, undefined]) {
      expect(detectIdentifierType(v)).toBe('unknown');
    }
  });
});
