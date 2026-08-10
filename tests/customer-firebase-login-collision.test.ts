import fs from 'fs';
import path from 'path';

const readSrc = (...parts: string[]) =>
  fs.readFileSync(path.join(__dirname, '..', 'src', ...parts), 'utf8');

/**
 * Structural assertions must run over CODE, not prose.
 *
 * The first version of this suite asserted on raw source and failed against
 * its own subject's comments: the guard's doc block names both
 * `upsertFirebaseUser` and `mergePhoneIntoExistingAccount` while explaining
 * itself, so an ordering check found the comment mention first and an absence
 * check matched an explanation of why the thing is absent. A source-text
 * assertion cannot tell an identifier from a sentence about it.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * The defect: `/auth/customer-firebase-login` — the route the LIVE mobile app
 * uses — created a second account for a customer who already had one, because
 * `upsertFirebaseUser` is `ON CONFLICT (uid)` and Firebase issues a uid per
 * identifier.
 */
describe('customer firebase login — duplicate account guard', () => {
  const service = readSrc('services', 'firebaseFunctions.service.ts');
  const controller = readSrc('controllers', 'auth.controller.ts');

  const customerFn = service.slice(
    service.indexOf('const customerFirebaseLogin = async'),
    service.indexOf('const checkUserIfExistInFirebase'),
  );

  test('the extraction actually captured the function (positive control)', () => {
    // A zero from a broken slice is indistinguishable from a real zero, and
    // this suite is a series of assertions about what is inside that slice.
    expect(customerFn.length).toBeGreaterThan(400);
    expect(customerFn).toContain('upsertFirebaseUser');
  });

  test('a first-sight uid is checked for a collision before any row is written', () => {
    const code = stripComments(customerFn);
    expect(code).toContain('findLinkCollision(');

    const guardAt = code.indexOf('findLinkCollision(');
    const upsertAt = code.indexOf('upsertFirebaseUser(');
    // Order is the whole point: checking after the upsert would be checking
    // after the duplicate already exists.
    expect(guardAt).toBeGreaterThan(-1);
    expect(upsertAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(upsertAt);
  });

  test('the guard is scoped to first-sight uids, so returning customers are untouched', () => {
    expect(customerFn).toContain('SELECT 1 FROM ${dbSchema}.user_credentials WHERE uid = $1');
    expect(customerFn).toContain('existingRows.length === 0');
  });

  test('it refuses rather than merging, and says why in the code', () => {
    // Merging deletes the incoming uid and returns a CUSTOM token the shipped
    // app cannot exchange. If someone later adds the merge here, this fails.
    // Asserted on the CALL form over stripped code — the doc block deliberately
    // names the helper while explaining why it is not used.
    expect(stripComments(customerFn)).not.toContain('mergePhoneIntoExistingAccount(');
    expect(stripComments(customerFn)).toContain('CustomerLinkCollisionError(');
  });

  test('both collision kinds carry an actionable customer-facing message', () => {
    expect(customerFn).toContain('already linked to a Servana account');
    expect(customerFn).toMatch(/collision\.via === "mobile"/);
  });
});

/**
 * The response shape is not a style choice — it is the only one the installed
 * +37 build can present. See the comment in the controller.
 */
describe('the collision response matches what the shipped client can render', () => {
  const controller = readSrc('controllers', 'auth.controller.ts');

  const handler = controller.slice(
    controller.indexOf('export const customerFirebaseLoginController'),
    controller.indexOf('export const providerRegisterController'),
  );

  test('the extraction captured the handler (positive control)', () => {
    expect(handler).toContain('customerFirebaseLogin');
    expect(handler).toContain('Authentication failed.');
  });

  test('a collision answers 200, not 401', () => {
    // 401 fires onUnauthorized in the client and shows "session expired" to
    // somebody who has no session yet; any non-2xx throws before the body is
    // read, so the message would never reach the customer.
    expect(handler).toMatch(/linkCollision[\s\S]{0,120}status\(200\)/);
  });

  test('it carries a TOP-LEVEL message and no token', () => {
    // The client reads `body.data.token ?? body.token` for emptiness and then
    // `body.message` — not `data.message`.
    const branch = handler.slice(handler.indexOf('linkCollision'));
    const payload = branch.slice(0, branch.indexOf('\n', branch.indexOf('json(')) + 200);
    expect(payload).toContain('message: error.message');
    expect(payload).not.toContain('token');
  });

  test('every other failure keeps its original status — the change is additive', () => {
    expect(handler).toContain('isDisabled ? 403 : 401');
    expect(handler).toContain('This account has been disabled. Please contact support.');
  });
});

/**
 * The route the WEB uses must keep the richer behaviour. If somebody
 * "harmonises" the two routes by copying the customer one over it, the merge
 * and its relink response disappear and this fails.
 */
describe('the provider/web route keeps its merge path', () => {
  const service = readSrc('services', 'firebaseFunctions.service.ts');

  test('firebaseAuthLogin still merges and can answer relinked', () => {
    const web = service.slice(
      service.indexOf('const firebaseAuthLogin = async'),
      service.indexOf('const firebaseProviderRegister'),
    );
    expect(web.length).toBeGreaterThan(400);
    expect(web).toContain('mergePhoneIntoExistingAccount');
    expect(web).toContain('relinked: true');
    expect(web).toContain('AccountLinkRequiredError');
  });
});
