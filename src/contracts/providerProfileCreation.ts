export const PROVIDER_PROFILE_NAME_MAX_LENGTH = 80;

export const normalizeProviderProfileName = (value: unknown): string =>
  typeof value === 'string'
    ? value.normalize('NFC').trim().replace(/\s+/gu, ' ')
    : '';

export const isValidProviderProfileName = (value: unknown): boolean => {
  const normalized = normalizeProviderProfileName(value);
  return normalized.length > 0
    && normalized.length <= PROVIDER_PROFILE_NAME_MAX_LENGTH
    && !/[\u0000-\u001F\u007F]/u.test(normalized);
};

export const providerRegistrationNames = (firstName: unknown, lastName: unknown) => ({
  firstName: normalizeProviderProfileName(firstName),
  lastName: normalizeProviderProfileName(lastName),
});
