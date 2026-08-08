export const PROFILE_NAME_MAX_LENGTH = 80;
export const PROVIDER_REGISTRATION_TOKEN_MAX_LENGTH = 16_384;

export type ProviderSourceClient = 'provider_web' | 'provider_mobile';

export class ProfileCreationValidationError extends Error {
  readonly statusCode = 400;
  readonly code = 'INVALID_PROFILE_CREATION_REQUEST';

  constructor(
    message: string,
    readonly field: 'idToken' | 'firstName' | 'lastName',
  ) {
    super(message);
    this.name = 'ProfileCreationValidationError';
  }
}

/**
 * Names are deliberately Unicode-friendly: Filipino names commonly contain
 * spaces, apostrophes, hyphens and accented characters. The boundary only
 * removes ambiguous whitespace and rejects control characters / unbounded
 * input; presentation layers remain responsible for escaping output.
 */
export const normalizeProfileName = (
  value: unknown,
  field: 'firstName' | 'lastName',
): string => {
  if (typeof value !== 'string') {
    throw new ProfileCreationValidationError(`${field} is required`, field);
  }

  const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (!normalized) {
    throw new ProfileCreationValidationError(`${field} is required`, field);
  }
  if (normalized.length > PROFILE_NAME_MAX_LENGTH) {
    throw new ProfileCreationValidationError(
      `${field} must be ${PROFILE_NAME_MAX_LENGTH} characters or fewer`,
      field,
    );
  }
  if(/[\u0000-\u001F\u007F]/u.test(normalized)) {
    throw new ProfileCreationValidationError(`${field} contains invalid characters`, field);
  }
  return normalized;
};

export const normalizeProviderRegistrationInput = (body: unknown) => {
  const input = body && typeof body === 'object'
    ? body as Record<string, unknown>
    : {};
  const idToken = typeof input.idToken === 'string' ? input.idToken.trim() : '';
  if (!idToken || idToken.length > PROVIDER_REGISTRATION_TOKEN_MAX_LENGTH) {
    throw new ProfileCreationValidationError('A valid idToken is required', 'idToken');
  }

  return {
    idToken,
    firstName: normalizeProfileName(input.firstName, 'firstName'),
    lastName: normalizeProfileName(input.lastName, 'lastName'),
    sourceClient: normalizeProviderSourceClient(input.sourceClient),
  };
};

/** Unknown/malformed values never reach the attribution table. */
export const normalizeProviderSourceClient = (value: unknown): ProviderSourceClient =>
  value === 'provider_mobile' ? 'provider_mobile' : 'provider_web';

/** Explicit projection prevents new internal fields from leaking by accident. */
export const projectProviderRegistrationResponse = (result: any) => {
  const data = result?.data ?? {};
  return {
    data: {
      success: data.success === true,
      uid: typeof data.uid === 'string' ? data.uid : '',
      role: Number(data.role),
      firstName: typeof data.firstName === 'string' ? data.firstName : '',
      lastName: typeof data.lastName === 'string' ? data.lastName : '',
      fullname: typeof data.fullname === 'string' ? data.fullname : '',
      email: typeof data.email === 'string' ? data.email : null,
      phoneNumber: typeof data.phoneNumber === 'string' ? data.phoneNumber : null,
      message: typeof data.message === 'string' ? data.message : 'Registration successful',
    },
  };
};
