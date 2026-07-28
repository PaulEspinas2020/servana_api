import admin from "firebase-admin";
import { firebaseConfig } from "../config";
import { initializeApp } from 'firebase/app';
import * as fs from 'fs';

// Load Firebase service account credentials from environment variable (preferred)
// or fall back to the local key file for development environments.
// In production, set FIREBASE_SERVICE_ACCOUNT_JSON to the JSON string of the
// service account key so the file never needs to exist in the repo.
let adminServiceAccount: object;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    adminServiceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} else {
    adminServiceAccount = JSON.parse(
        fs.readFileSync('./servana-serviceAccountKey.json', 'utf8')
    );
}

const _admin = admin.initializeApp({
    credential: admin.credential.cert(adminServiceAccount),
    storageBucket: firebaseConfig.storageBucket
}, 'admin');

const _app = initializeApp(firebaseConfig);
export const firebaseAdmin = _admin;
export const firebaseApp = _app;