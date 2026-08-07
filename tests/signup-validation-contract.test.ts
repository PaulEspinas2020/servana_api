import { validatePassword } from '../src/helpers/validation';

describe('mobile signup password contract', () => {
  test('six characters is rejected', () => {
    expect(validatePassword('123456')).toBe(false);
  });

  test('seven characters is accepted', () => {
    expect(validatePassword('1234567')).toBe(true);
  });
});
