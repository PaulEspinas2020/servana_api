const firebaseProviderRegister = jest.fn();
const upsertSourceAttribution = jest.fn(() => Promise.resolve());
const evaluateProvider = jest.fn(() => Promise.resolve());

jest.mock('../src/services/auth.service', () => ({}));
jest.mock('../src/services/firebaseFunctions.service', () => ({ firebaseProviderRegister }));
jest.mock('../src/services/providerOnboardingService', () => ({ upsertSourceAttribution }));
jest.mock('../src/services/providerAutoOnlineEngine', () => ({ evaluateProvider }));
jest.mock('../src/services/adminProviderService', () => ({}));
jest.mock('../src/services/notification.service', () => ({}));
jest.mock('../src/services/tokenRefreshService', () => ({}));
jest.mock('../src/errors/authErrors', () => ({}));

import { providerRegisterController } from '../src/controllers/auth.controller';

const response = () => {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return { res: { status } as any, status, json };
};

describe('POST /api/auth/provider/register', () => {
  beforeEach(() => {
    firebaseProviderRegister.mockReset();
    upsertSourceAttribution.mockClear();
    evaluateProvider.mockClear();
  });

  test('normalizes names and fixes source attribution to provider_web', async () => {
    firebaseProviderRegister.mockResolvedValue({ data: { uid: 'provider-1', role: 2 } });
    const { res, status } = response();

    await providerRegisterController({ body: {
      idToken: ' token ', firstName: '  Ana  Maria ', lastName: ' Dela   Cruz ',
      sourceClient: 'admin',
    } } as any, res);

    expect(firebaseProviderRegister).toHaveBeenCalledWith('token', 'Ana Maria', 'Dela Cruz');
    expect(upsertSourceAttribution).toHaveBeenCalledWith(
      'provider-1', 'provider_web', true, 'registration',
    );
    expect(status).toHaveBeenCalledWith(200);
  });

  test('rejects names that bypass the browser contract', async () => {
    const { res, status } = response();
    await providerRegisterController({ body: {
      idToken: 'token', firstName: 'A'.repeat(81), lastName: 'Cruz',
    } } as any, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(firebaseProviderRegister).not.toHaveBeenCalled();
  });

  test('reports rejected Firebase credentials as unauthorized', async () => {
    firebaseProviderRegister.mockRejectedValue({ code: 'auth/id-token-expired' });
    const { res, status, json } = response();
    await providerRegisterController({ body: {
      idToken: 'expired', firstName: 'Ana', lastName: 'Cruz',
    } } as any, res);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ status: 'failed', message: 'Authentication failed.' });
  });

  test('does not expose internal registration failures', async () => {
    firebaseProviderRegister.mockRejectedValue(new Error('database host secret'));
    const { res, status, json } = response();
    await providerRegisterController({ body: {
      idToken: 'token', firstName: 'Ana', lastName: 'Cruz',
    } } as any, res);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      status: 'failed', message: 'Registration failed. Please try again.',
    });
  });
});
