import admin from "firebase-admin";
import { firebaseConfig } from "../config";
import { initializeApp } from 'firebase/app';
import * as fs from 'fs';

// Load Firebase service account credentials from environment variable (preferred)
// or fall back to the local key file for development environments.
// In production, set FIREBASE_SERVICE_ACCOUNT_JSON to the JSON string of the
// service account key so the file never needs to exist in the repo.
const KEY_FILE = './servana-serviceAccountKey.json';

/**
 * Nothing here runs at import time, and that is the point.
 *
 * This module used to resolve credentials and call initializeApp() at module
 * scope, so merely IMPORTING it threw when no key was present. Because
 * verifyAuth -> api/v1/register -> app imports it transitively, that made
 * `require('../src/app')` impossible without a live Admin credential, and four
 * test suites failed for that reason alone: app-import-is-inert,
 * authz-matrix-behaviour, health-probe-parity and v1-composed-app.
 *
 * That is the same defect tests/app-import-is-inert.test.ts already documents
 * for `db/mongodbQuery.ts`, which "threw outright when MONGO_URI was unset,
 * which is the state of a clean checkout". A Firebase key is not in a clean
 * checkout either — it is deliberately not committed.
 *
 * Deferring is NOT a licence to discover the problem per-request. Boot still
 * fails fast: the startup graph calls assertFirebaseAdminCredentials() before
 * the server listens, so a missing credential is a refusal to start with
 * instructions, exactly as before — not a 500 on every authenticated call.
 * Composing is free; starting is what validates.
 */
const resolveAdminCredentials = (): object => {
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

let adminAppCache: admin.app.App | null = null;

/**
 * The Admin SDK app, initialised on first use and memoised.
 *
 * Memoised rather than re-created because admin.initializeApp() throws on a
 * duplicate app name, and 'admin' is a fixed name here.
 */
export const getFirebaseAdmin = (): admin.app.App => {
    if (!adminAppCache) {
        adminAppCache = admin.initializeApp({
            credential: admin.credential.cert(resolveAdminCredentials()),
            storageBucket: firebaseConfig.storageBucket
        }, 'admin');
    }
    return adminAppCache;
};

/**
 * Boot-time credential check. Call from the startup graph, never from a request
 * path: it exists so a missing credential stops the server starting instead of
 * surfacing later as a per-request failure.
 */
export const assertFirebaseAdminCredentials = (): void => {
    resolveAdminCredentials();
};

let clientAppCache: ReturnType<typeof initializeApp> | null = null;

/** The client SDK app. Needs no credential — firebaseConfig is public. */
export const getFirebaseApp = (): ReturnType<typeof initializeApp> => {
    if (!clientAppCache) {
        clientAppCache = initializeApp(firebaseConfig);
    }
    return clientAppCache;
};
