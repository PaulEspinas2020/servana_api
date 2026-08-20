import admin from "firebase-admin";
import { firebaseConfig } from "../config";
import { initializeApp, type FirebaseApp } from 'firebase/app';
import * as fs from 'fs';
import { lazyValue } from './lazyValue';

// Load Firebase service account credentials from environment variable (preferred)
// or fall back to the local key file for development environments.
// In production, set FIREBASE_SERVICE_ACCOUNT_JSON to the JSON string of the
// service account key so the file never needs to exist in the repo.
const KEY_FILE = './servana-serviceAccountKey.json';

/**
 * Initialisation is LAZY, and that is the whole point of this file's shape.
 *
 * ## What went wrong
 *
 * This module used to resolve the credential, call `admin.initializeApp` and
 * `initializeApp` at module scope. Reading a file and constructing two SDK
 * clients are import-time side effects, so importing this module — or anything
 * that transitively imports it — REQUIRED a live Admin credential to be present
 * on disk before a single line of test code ran.
 *
 * Two modules import it eagerly and both are on the path to `src/app.ts`:
 * `middleware/verifyAuth.ts` (via `api/v1/register.ts`) and
 * `services/firebaseFunctions.service.ts` (via `auth.service.ts` ->
 * `api/v1/domains/auth.ts`). So `require('../src/app')` threw
 * "Firebase Admin credentials not found." on any checkout without the key.
 *
 * That broke the HERMETIC release gate specifically. `.github/workflows/
 * release-gate.yml` runs on `ubuntu-latest` with no secrets — deliberately, it
 * is the gate that proves the tree stands on its own — so `npm run verify`
 * exited 1 there while the self-hosted deploy runner passed, because
 * deploy.yml's "Copy secrets" step writes the key first. A gate that can only
 * pass on the machine holding production credentials is not a gate.
 *
 * ## Why a Proxy rather than editing the call sites
 *
 * `tests/app-import-is-inert.test.ts` states the rule this restores: importing
 * the application composes it and does nothing else. It already documents three
 * import-time side effects removed for the same reason; this is the fourth of
 * that family.
 *
 * The repository had already reached for the lazy `await import()` workaround in
 * `helpers/firebaseStorageUploader.ts`, `services/notification.service.ts` and
 * `controllers/providerController.ts` — and ten test files carry a
 * `jest.mock('../src/middleware/firebaseApp')` line whose only job is to dodge
 * this constructor. Fixing the module instead of its callers retires the reason
 * for all of them at once and leaves every existing call site — and every
 * existing mock — working unchanged.
 *
 * ## What is NOT changed
 *
 * The credential is still mandatory and the error is still the same instructive
 * one; it now fires on first USE rather than on import. Production reaches that
 * first use during boot, because `startup.ts` declares `firebase-admin` as a
 * required dependency — so a missing credential still surfaces at start-up, and
 * `/readyz` reports 503 with the reason instead of the process dying before it
 * can be asked why. That is the same treatment every other required dependency
 * in `startup.ts` already gets.
 */
let cachedAdmin: admin.app.App | undefined;
let cachedApp: FirebaseApp | undefined;

const resolveServiceAccount = (): object => {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    }
    if (fs.existsSync(KEY_FILE)) {
        return JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    }
    // The key is no longer committed — it is a live Admin SDK credential that
    // bypasses every Security Rule and can mint auth tokens for any UID, so it
    // has no business in git. Deploys inject it (.github/workflows/deploy.yml
    // copies it from /home/github-runner/env/); local dev provisions it once.
    //
    // Fail with instructions rather than a bare ENOENT — the previous
    // behaviour was a stack trace that told a new developer nothing.
    throw new Error(
        'Firebase Admin credentials not found.\n' +
        '\n' +
        'Provide either:\n' +
        `  • ${KEY_FILE} in the repository root, or\n` +
        '  • FIREBASE_SERVICE_ACCOUNT_JSON containing the key as a JSON string\n' +
        '\n' +
        'See docs/ROTATE_SERVICE_ACCOUNT.md. Never commit the key.',
    );
};

/**
 * Memoised so that repeated access does not re-enter `admin.initializeApp`,
 * which throws on a duplicate app name.
 */
export const getFirebaseAdmin = (): admin.app.App => {
    if (!cachedAdmin) {
        cachedAdmin = admin.initializeApp({
            credential: admin.credential.cert(resolveServiceAccount()),
            storageBucket: firebaseConfig.storageBucket,
        }, 'admin');
    }
    return cachedAdmin;
};

export const getFirebaseApp = (): FirebaseApp => {
    if (!cachedApp) cachedApp = initializeApp(firebaseConfig);
    return cachedApp;
};

/**
 * `firebaseAdmin` and `firebaseApp` stay VALUE exports so that the existing call
 * sites keep reading `firebaseAdmin.auth()` unchanged. `lazyValue` defers the
 * constructor to the first property access, which is what makes the import
 * inert. See `./lazyValue.ts` for the full reasoning.
 */

/**
 * Boot-time credential check, kept from origin/main's version of this fix.
 *
 * Both sides of the merge solved the same import-time defect independently:
 * this tree deferred construction with `lazyValue`, origin/main converted the
 * exports to `getFirebaseAdmin()` functions. The Proxy shape won because it is
 * the superset — `scripts/create-admin-with-password.ts` and
 * `scripts/backfill-verified-identifiers.ts` still import `firebaseAdmin` as a
 * VALUE, and neither `tsconfig.json` nor `tsconfig.tests.json` compiles
 * `scripts/`, so dropping that export would have broken both silently.
 *
 * The assert is kept because `src/app.ts` calls it before the server listens.
 * It is now belt AND braces: this fires at compose-time, and `startup.ts`
 * separately declares `firebase-admin` a required STARTUP_DEPENDENCY. Two boot
 * checks for one credential is redundancy, not conflict — neither can regress
 * without the other still failing the boot.
 */
export const assertFirebaseAdminCredentials = (): void => {
    resolveServiceAccount();
};

export const firebaseAdmin: admin.app.App = lazyValue(getFirebaseAdmin);
export const firebaseApp: FirebaseApp = lazyValue(getFirebaseApp);

