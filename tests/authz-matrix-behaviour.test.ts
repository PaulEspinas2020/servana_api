/**
 * The authorization matrix, checked against what the router actually does.
 *
 * ## The gap this closes
 *
 * `src/api/v1/authzMatrix.ts` documents `ROLE_ACCESS` as:
 *
 *   > Derived from `register.ts`'s `authChain`, and asserted against it — a mode
 *   > whose chain changes without this table changing is a matrix that documents
 *   > an access rule the router no longer applies.
 *
 * It was not asserted against it. The only two checks were a source-text regex
 * (`/case 'provider':[\s\S]{0,120}requireProviderRole/`) and a presence check
 * (`expect(ROLE_ACCESS[mode]).toBeDefined()`). Neither compares the table's
 * allow/deny decisions to the chain's behaviour, so changing `verifyRoles([1])`
 * to `verifyRoles([1, 4])` would leave `SECURITY_AUTHZ_MATRIX.md` publishing
 * `provider: deny` on admin routes while the router allowed a provider through,
 * and nothing would have failed.
 *
 * Role 4 makes that concrete rather than hypothetical: `PROVIDER_ROLES` is
 * `{2, 4}`, so a `[1, 4]` allow-list is a plausible edit, not a contrived one.
 *
 * ## What is executed, and what is not
 *
 * The real `authChain` is imported and run. `verifyAuth` is stubbed to the one
 * property the matrix encodes about it — a request without an identity is
 * rejected — because the genuine implementation verifies a Firebase token and
 * this suite is about ROLES, not token validation. The role middlewares are NOT
 * stubbed: `requireProviderRole` and `verifyRoles` run for real against a
 * mocked `user_credentials` lookup, which is where every allow/deny decision in
 * `ROLE_ACCESS` beyond anonymity is actually made.
 */

import type { RequestHandler } from 'express';

/** role column values, per src/constants/providerRoles.ts and the role map. */
const ROLE_ROW: Record<string, string | null> = {
  anonymous: null,
  customer: '3',
  provider: '2',
  admin: '1',
};

let currentRole: string | null = null;

/**
 * Infrastructure only. `register.ts` transitively imports the Mongo client,
 * which parses `MONGO_URI` at module load, and `config`, which reads the
 * environment. Neither is under test here.
 *
 * Note what is deliberately NOT mocked: `requireProviderRole` and `verifyRoles`.
 * `tests/v1-router.test.ts` stubs both — correctly, since it is testing routing
 * — which is precisely why it could never have caught the drift this suite
 * exists to catch.
 */
jest.mock('../src/config', () => ({
  isProduction: false,
  port: '0',
  secret: 'test-secret',
  tempId: undefined,
  db: { schema: 'servana', host: 'localhost', database: 'test', user: 'test', port: '5432' },
  firebaseConfig: {
    apiKey: 'test', authDomain: 'test', projectId: 'test',
    storageBucket: 'test.appspot.com', messagingSenderId: 'test', appId: 'test',
    measurementId: 'test',
  },
  mailerKey: 'test',
  mailerSender: 'test@example.invalid',
  mongoConfig: { uri: 'mongodb://localhost:27017', db: 'test', appName: 'test' },
}));
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: {} }));

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: {
    query: jest.fn(async () => ({
      rows: currentRole === null ? [] : [{ role: currentRole }],
    })),
  },
}));

jest.mock('../src/middleware/verifyAuth', () => ({
  __esModule: true,
  default: (req: any, res: any, next: any) => {
    if (!req.user) {
      res.status(401).json({ code: 'UNAUTHENTICATED' });
      return;
    }
    next();
  },
}));

// Imported AFTER the mocks so the chain closes over them.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { authChain } = require('../src/api/v1/register');
import { ROLE_ACCESS, ROLES, type Role } from '../src/api/v1/authzMatrix';
import { V1_CONTRACT, type AuthMode } from '../src/api/v1/contract';

/** Run a chain to completion and report whether the request survived it. */
const runChain = async (mode: AuthMode, role: Role): Promise<'allow' | 'deny'> => {
  currentRole = ROLE_ROW[role];
  const chain: RequestHandler[] = authChain({ auth: mode } as never);

  const req: any = role === 'anonymous' ? {} : { user: { uid: `uid-${role}` } };
  let denied = false;
  const res: any = {
    statusCode: 0,
    headersSent: false,
    status(code: number) { this.statusCode = code; denied = code >= 400; return this; },
    json() { this.headersSent = true; return this; },
    send() { this.headersSent = true; return this; },
  };

  for (const handler of chain) {
    let advanced = false;
    await new Promise<void>((resolve) => {
      const next = () => { advanced = true; resolve(); };
      const result = (handler as any)(req, res, next);
      if (result && typeof result.then === 'function') result.then(() => resolve(), () => resolve());
      else if (!advanced) resolve();
    });
    if (denied || !advanced) return 'deny';
  }
  return denied ? 'deny' : 'allow';
};

describe('ROLE_ACCESS matches what the auth chain actually does', () => {
  const modes = [...new Set(V1_CONTRACT.map((e) => e.auth))].sort();

  it('covers every mode the contract uses', () => {
    expect(modes.length).toBeGreaterThan(1);
    for (const mode of modes) expect(ROLE_ACCESS[mode]).toBeDefined();
  });

  for (const mode of ['public', 'authenticated', 'provider', 'admin'] as AuthMode[]) {
    for (const role of ROLES) {
      it(`${mode} × ${role} — the table says ${ROLE_ACCESS[mode][role as Role]}`, async () => {
        const observed = await runChain(mode, role as Role);
        expect(observed).toBe(ROLE_ACCESS[mode][role as Role]);
      });
    }
  }
});

describe('the check would notice if the chain were widened', () => {
  it('admin mode denies role 4, which PROVIDER_ROLES contains', async () => {
    /**
     * The negative fixture. A detector that only ever reports agreement could
     * be broken, so this drives a role the admin allow-list must NOT contain
     * and asserts the chain refuses it. If `verifyRoles([1])` ever became
     * `verifyRoles([1, 4])`, this fails here and the matrix row above fails too.
     */
    currentRole = '4';
    const chain: RequestHandler[] = authChain({ auth: 'admin' } as never);
    const req: any = { user: { uid: 'uid-role4' } };
    let denied = false;
    const res: any = {
      status(code: number) { denied = code >= 400; return this; },
      json() { return this; },
    };
    for (const handler of chain) {
      await new Promise<void>((resolve) => {
        const result = (handler as any)(req, res, () => resolve());
        if (result && typeof result.then === 'function') result.then(() => resolve(), () => resolve());
      });
      if (denied) break;
    }
    expect(denied).toBe(true);
  });
});
