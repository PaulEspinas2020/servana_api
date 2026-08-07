import {
  isValidProviderProfileName,
  normalizeProviderProfileName,
  providerRegistrationNames,
} from '../src/contracts/providerProfileCreation';

describe('provider profile creation contract', () => {
  test('normalizes Unicode and whitespace exactly once at the API boundary', () => {
    expect(providerRegistrationNames('  Mari\u0301a  ', ' Dela   Cruz ')).toEqual({
      firstName: 'Mar\u00eda',
      lastName: 'Dela Cruz',
    });
  });

  test('accepts punctuation used in real names', () => {
    expect(isValidProviderProfileName('Anne-Marie')).toBe(true);
    expect(isValidProviderProfileName("D'Angelo")).toBe(true);
  });

  test('rejects missing, non-string, oversized, and control-character names', () => {
    expect(isValidProviderProfileName('   ')).toBe(false);
    expect(isValidProviderProfileName(null)).toBe(false);
    expect(isValidProviderProfileName('A'.repeat(81))).toBe(false);
    expect(isValidProviderProfileName('Ana\u0000')).toBe(false);
  });

  test('does not preserve ambiguous surrounding whitespace', () => {
    expect(normalizeProviderProfileName('  Ana\tMaria  ')).toBe('Ana Maria');
  });
});
