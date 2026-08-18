const firebaseProviderRegister = jest.fn();
const upsertSourceAttribution = jest.fn();
const evaluateProvider = jest.fn();

jest.mock('../src/services/auth.service', () => ({}));
jest.mock('../src/services/firebaseFunctions.service', () => ({ firebaseProviderRegister }));
jest.mock('../src/services/providerOnboardingService', () => ({ upsertSourceAttribution }));
jest.mock('../src/services/providerAutoOnlineEngine', () => ({ evaluateProvider }));
jest.mock('../src/services/adminProviderService', () => ({}));
jest.mock('../src/services/notification.service', () => ({}));
jest.mock('../src/services/tokenRefreshService', () => ({}));
jest.mock('../src/errors/authErrors', () => ({}));

import { providerRegisterController } from '../src/controllers/auth.controller';
import {
  normalizeProfileName,
  normalizeProviderRegistrationInput,
} from '../src/services/profileCreationContract';

const response = () => {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return { res: { status } as any, status, json };
};

const registered = (overrides: Record<string, unknown> = {}) => ({
  data: {
    success: true,
    uid: 'provider-1',
    role: 2,
    firstName: 'María',
    lastName: 'Dela Cruz',
    fullname: 'María Dela Cruz',
    email: 'maria@example.com',
    phoneNumber: null,
    message: 'Registration successful',
    ...overrides,
  },
});

describe('provider profile creation contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    firebaseProviderRegister.mockResolvedValue(registered());
    upsertSourceAttribution.mockResolvedValue(undefined);
    evaluateProvider.mockResolvedValue(undefined);
  });

  test('normalizes real Unicode names without imposing an ASCII-only policy', () => {
    expect(normalizeProfileName('  María   O\'Connor-Santos ', 'firstName'))
      .toBe("María O'Connor-Santos");
  });

  test('rejects missing, unbounded and control-character fields before Firebase', async () => {
    for (const body of [
      { idToken: '', firstName: 'Ana', lastName: 'Santos' },
      { idToken: 'token', firstName: 'A'.repeat(81), lastName: 'Santos' },
      { idToken: 'token', firstName: 'Ana', lastName: 'San\u0000tos' },
    ]) {
      const { res, status } = response();
      await providerRegisterController({ body } as any, res);
      expect(status).toHaveBeenLastCalledWith(400);
    }
    expect(firebaseProviderRegister).not.toHaveBeenCalled();
  });

  test('creates a canonical provider profile and normalizes source attribution', async () => {
    const { res, status, json } = response();
    await providerRegisterController({
      body: {
        idToken: '  firebase-token  ',
        firstName: '  María ',
        lastName: ' Dela   Cruz ',
        sourceClient: 'attacker_supplied_source',
      },
    } as any, res);

    expect(firebaseProviderRegister).toHaveBeenCalledWith(
      'firebase-token', 'María', 'Dela Cruz',
    );
    expect(upsertSourceAttribution).toHaveBeenCalledWith(
      'provider-1', 'provider_web', true, 'registration',
    );
    expect(evaluateProvider).toHaveBeenCalledWith('provider-1', 'system', null);
    expect(status).toHaveBeenCalledWith(200);
    expect(json.mock.calls[0][0].data.role).toBe(2);
  });

  test('projects an allowlisted response and never reflects tokens or internal fields', async () => {
    firebaseProviderRegister.mockResolvedValue(registered({
      idToken: 'must-not-leak',
      refreshToken: 'must-not-leak',
      passwordHash: 'must-not-leak',
      internalDecision: 'must-not-leak',
    }));
    const { res, json } = response();
    await providerRegisterController({
      body: { idToken: 'firebase-token', firstName: 'Ana', lastName: 'Santos' },
    } as any, res);

    const serialized = JSON.stringify(json.mock.calls[0][0]);
    expect(serialized).not.toContain('must-not-leak');
    expect(Object.keys(json.mock.calls[0][0].data).sort()).toEqual([
      'email', 'firstName', 'fullname', 'lastName', 'message',
      'phoneNumber', 'role', 'success', 'uid',
    ].sort());
  });

  test('keeps attribution best-effort after the authoritative profile is created', async () => {
    upsertSourceAttribution.mockRejectedValue(new Error('db unavailable'));
    const { res, status } = response();
    await providerRegisterController({
      body: {
        idToken: 'firebase-token', firstName: 'Ana', lastName: 'Santos',
        sourceClient: 'provider_mobile',
      },
    } as any, res);

    await Promise.resolve();
    expect(status).toHaveBeenCalledWith(200);
    expect(upsertSourceAttribution).toHaveBeenCalledWith(
      'provider-1', 'provider_mobile', true, 'registration',
    );
  });

  test('normalizes source client at the pure contract boundary', () => {
    expect(normalizeProviderRegistrationInput({
      idToken: 'token', firstName: 'Ana', lastName: 'Santos',
      sourceClient: 'provider_mobile',
    }).sourceClient).toBe('provider_mobile');
  });
});

describe('legacy provider profile name helpers remain compatible', () => {
  const {
    isValidProviderProfileName,
    normalizeProviderProfileName,
    providerRegistrationNames,
  } = require('../src/contracts/providerProfileCreation');

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
