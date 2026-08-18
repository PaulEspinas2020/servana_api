const registerUser = jest.fn();

jest.mock('../src/services/auth.service', () => ({ registerUser }));
jest.mock('../src/services/firebaseFunctions.service', () => ({}));
jest.mock('../src/services/providerOnboardingService', () => ({}));
jest.mock('../src/services/providerAutoOnlineEngine', () => ({}));
jest.mock('../src/services/adminProviderService', () => ({}));
jest.mock('../src/services/notification.service', () => ({}));
jest.mock('../src/services/tokenRefreshService', () => ({}));
jest.mock('../src/errors/authErrors', () => ({}));

import { signup } from '../src/controllers/auth.controller';

describe('POST /api/auth/signup response contract', () => {
  beforeEach(() => registerUser.mockReset());

  test('returns the authoritative wrapped success payload consumed by mobile', async () => {
    registerUser.mockResolvedValue({
      dbRegister: { uid: 'new-user-id' },
      message: 'OTP sent to customer@example.com',
    });
    const req = { body: { email: 'customer@example.com', platform: 'mobile' } } as any;
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));

    await signup(req, { status } as any);

    expect(registerUser).toHaveBeenCalledWith(req.body);
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({
      status: 'success',
      data: {
        success: true,
        userId: 'new-user-id',
        message: 'OTP sent to customer@example.com',
        verificationType: undefined,
        verificationDeliveryPending: false,
        onboardingPending: false,
      },
    });
  });

  test('keeps errors at the root for compatibility with existing clients', async () => {
    registerUser.mockRejectedValue('Email already exists');
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));

    await signup({ body: {} } as any, { status } as any);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      status: 'error',
      message: 'Email already exists',
    });
  });

  test('uses the formatted database id and exposes recoverable post-create state', async () => {
    registerUser.mockResolvedValue({
      dbRegister: { id: 'formatted-user-id' },
      message: 'Request a new verification email to continue.',
      verificationType: 'link',
      verificationDeliveryPending: true,
      onboardingPending: true,
    });
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));

    await signup({ body: { role: 3 } } as any, { status } as any);

    expect(json).toHaveBeenCalledWith({
      status: 'success',
      data: {
        success: true,
        userId: 'formatted-user-id',
        message: 'Request a new verification email to continue.',
        verificationType: 'link',
        verificationDeliveryPending: true,
        onboardingPending: true,
      },
    });
  });
});
