import fs from 'fs';
import path from 'path';

describe('provider Firebase login boundary', () => {
  const service = fs.readFileSync(path.join(process.cwd(), 'src/services/firebaseFunctions.service.ts'), 'utf8');
  const controller = fs.readFileSync(path.join(process.cwd(), 'src/controllers/auth.controller.ts'), 'utf8');

  it('does not create an unseen provider identity through the login endpoint', () => {
    const fn = service.slice(service.indexOf('const firebaseAuthLogin'), service.indexOf('const firebaseProviderRegister'));
    expect(fn).toContain('PROVIDER_ACCOUNT_NOT_FOUND');
    expect(fn.indexOf('PROVIDER_ACCOUNT_NOT_FOUND')).toBeLessThan(
      fn.indexOf('const dbUser = await userService.upsertFirebaseUser'),
    );
  });

  it('checks the resolved provider role before login side effects', () => {
    const fn = controller.slice(controller.indexOf('export const firebaseAuthLoginController'), controller.indexOf('export const customerFirebaseLoginController'));
    const gate = fn.indexOf('requestedRole === 2');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(fn.indexOf('upsertSourceAttribution'));
    expect(gate).toBeLessThan(fn.indexOf('touchProviderActivity'));
  });

  it('does not log token, identifier, or internal error detail at the controller boundary', () => {
    const fn = controller.slice(controller.indexOf('export const firebaseAuthLoginController'), controller.indexOf('export const customerFirebaseLoginController'));
    expect(fn).not.toContain('console.error');
  });
});
