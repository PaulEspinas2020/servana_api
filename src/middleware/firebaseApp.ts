import admin from "firebase-admin";
import { firebaseConfig } from "../config";
import { initializeApp } from 'firebase/app';
import * as fs from 'fs';

// Load Firebase service account credentials from environment variable (preferred)
// or fall back to the local key file for development environments.
// In production, set FIREBASE_SERVICE_ACCOUNT_JSON to the JSON string of the
// service account key so the file never needs to exist in the repo.
const KEY_FILE = './servana-serviceAccountKey.json';

let adminServiceAccount: object;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    adminServiceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} else if (fs.existsSync(KEY_FILE)) {
    adminServiceAccount = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
} else {
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
}

const _admin = admin.initializeApp({
    credential: admin.credential.cert(adminServiceAccount),
    storageBucket: firebaseConfig.storageBucket
}, 'admin');

const _app = initializeApp(firebaseConfig);
export const firebaseAdmin = _admin;
export const firebaseApp = _app;