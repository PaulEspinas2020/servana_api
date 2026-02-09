import admin from "firebase-admin";
import { firebaseConfig } from "../config";
import { initializeApp } from 'firebase/app';
import * as fs from 'fs';

const adminServiceAccount = JSON.parse(
    fs.readFileSync('./servana-serviceAccountKey.json','utf8')
  )

const _admin = admin.initializeApp({
    credential: admin.credential.cert(adminServiceAccount),
    storageBucket: firebaseConfig.storageBucket
}, 'admin');

const _app = initializeApp(firebaseConfig);
export const firebaseAdmin = _admin;
export const firebaseApp = _app;