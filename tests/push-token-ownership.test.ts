/**
 * One push token, one owner (Command 4 §21).
 *
 * A push token identifies a DEVICE, not a person, and providers share devices.
 * The failure this prevents: Provider A signs out on a shared handset, B signs
 * in, and A's row still carries the same token — so the next booking push meant
 * for A arrives on the phone B is holding, carrying A's customer's name and
 * address on a lock screen.
 *
 * Static assertions over the SQL, like the other authorization tests here: the
 * defect would live in a WHERE clause, and a test stubbing the query result
 * would pass against the broken version.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const flat = (s: string) => s.replace(/\s+/g, ' ');
const code = (s: string) =>
  s.split('\n').map((l) => l.replace(/--.*/, '').replace(/^\s*\/\/.*/, '')).join('\n');

const ctrl = flat(code(read('controllers/providerController.ts')));
const routes = flat(code(read('routes/provider.routes.ts')));

const block = (name: string) => {
  const i = ctrl.indexOf(`export const ${name}`);
  expect(i).toBeGreaterThan(-1);
  return ctrl.slice(i, i + 1600);
};

describe('binding a token', () => {
  const save = () => block('saveProviderFcmToken');

  test('takes the owner from the token, never the request', () => {
    expect(save()).toContain('req.user?.uid');
    expect(save()).not.toMatch(/req\.body[^;]*\buid\b/);
  });

  test('releases the device from whoever held it before', () => {
    // The shared-handset case. Without this the previous provider stays
    // addressable at a phone someone else is now carrying.
    expect(save()).toMatch(/SET fcm_token = NULL WHERE fcm_token = \$1 AND uid <> \$2/);
  });

  test('releases BEFORE it claims, so no window has two owners', () => {
    const s = save();
    expect(s.indexOf('uid <> $2')).toBeLessThan(s.indexOf('SET fcm_token = $1 WHERE uid = $2'));
  });

  test('rejects an empty or stub token', () => {
    // The worker app currently sends `fcmToken: ''` at login. Storing that
    // would blank a real registration.
    expect(save()).toMatch(/length < 10/);
  });
});

describe('releasing a token on sign-out', () => {
  const del = () => block('deleteProviderFcmToken');

  test('the endpoint exists and is authenticated', () => {
    expect(routes).toMatch(/delete\("\/provider\/fcm-token", verifyAuth/);
  });

  test('is scoped to the caller', () => {
    expect(del()).toContain('req.user?.uid');
    expect(del()).toMatch(/WHERE uid = \$1/);
  });

  test('one device signing out does not unsubscribe the provider elsewhere', () => {
    // Scoped to the token presented, so a provider signed in on two phones
    // keeps the other one.
    expect(del()).toMatch(/WHERE uid = \$1 AND fcm_token = \$2/);
  });

  test('a missing token still releases rather than refusing', () => {
    // A sign-out that leaves a live push registration behind is worse than a
    // slightly over-broad release.
    expect(del()).toMatch(/SET fcm_token = NULL WHERE uid = \$1/);
  });
});
