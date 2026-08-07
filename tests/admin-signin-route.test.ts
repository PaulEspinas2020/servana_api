import fs from 'fs';
import path from 'path';

const read = (...parts: string[]) => fs.readFileSync(path.join(__dirname, '..', 'src', ...parts), 'utf8');

describe('dedicated admin sign-in contract', () => {
  test('route is rate limited and uses the admin-only controller', () => {
    const routes = read('routes', 'auth.route.ts');
    expect(routes).toContain('router.post("/auth/admin-signin", signInLimiter, authController.adminSignin)');
  });

  test('controller checks the database-backed session role before returning it', () => {
    const controller = read('controllers', 'auth.controller.ts');
    expect(controller).toContain('Number(session?.role) !== 1');
    expect(controller).toContain("code: 'ADMIN_ACCESS_REQUIRED'");
  });
});
