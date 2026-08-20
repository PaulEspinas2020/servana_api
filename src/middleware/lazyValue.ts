/**
 * Defer a constructor to first property access, without changing its callers.
 *
 * ## Why this exists
 *
 * Several modules held a client at module scope:
 *
 *     const defaultAuthAdmin = getAuthAdmin(firebaseAdmin);
 *
 * `getAuthAdmin` resolves the app's credential immediately, so IMPORTING any of
 * those modules required a live Firebase Admin key on disk. Six of them sit on
 * the import path to `src/app.ts`, which made the composed application
 * un-importable on a checkout without the key — and therefore made the hermetic
 * release gate (`.github/workflows/release-gate.yml`, `ubuntu-latest`, no
 * secrets) fail every run since it was created, while the self-hosted deploy
 * runner passed because `deploy.yml` copies the key in first.
 *
 * `tests/app-import-is-inert.test.ts` states the rule being restored here:
 * importing the application composes it and does nothing else.
 *
 * ## Why a Proxy rather than a thunk
 *
 * `services/accountLinking.ts` and `services/tokenRevocation.ts` already solved
 * this locally with `const auth = () => getAuthAdmin(firebaseAdmin)`. That is
 * correct but changes every call site from `auth.x()` to `auth().x()`, and one
 * of these modules has twenty-odd of them. Returning a Proxy keeps the value
 * shape, so the deferral is invisible to callers.
 *
 * The result is memoised: `resolve` runs once, on first access. That matters
 * because `admin.initializeApp` throws on a duplicate app name.
 */
export const lazyValue = <T extends object>(resolve: () => T): T => {
  let cached: T | undefined;
  const get = (): T => (cached ??= resolve());
  return new Proxy({} as T, {
    get: (_target, property, receiver) => Reflect.get(get(), property, receiver),
    has: (_target, property) => Reflect.has(get(), property),
    ownKeys: () => Reflect.ownKeys(get()),
    getOwnPropertyDescriptor: (_target, property) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(get(), property);
      // A Proxy may only report a property as existing if it is configurable on
      // the target, and the target here is always the empty object above.
      return descriptor && { ...descriptor, configurable: true };
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(get()),
  });
};
