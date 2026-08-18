import dotenv from "dotenv";
import { validateEnv } from "./env/envSchema";
if (!process.env.NODE_ENV) dotenv.config({ path: "../.env" });

// General
export const isProduction = process.env.NODE_ENV == "production";
export const port = process.env.PORT;
export const secret = process.env.SECRET
export const tempId = process.env.TEMP_ID

/**
 * Validate the environment before anything reads it (TAB 12).
 *
 * In production this throws with EVERY problem listed at once — reporting one
 * variable per restart turns a five-variable misconfiguration into five deploys.
 * Elsewhere it warns, so tests and local development run without a full
 * production environment.
 *
 * The TEMP_ID guard that used to live here is now one rule inside that policy;
 * it still throws in production, for the same reason: it bypasses authentication
 * outright, so it is unsafe regardless of what else is configured.
 */
validateEnv(isProduction);
export const db = {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    schema: process.env.SCHEMA
};

// Firebase
export const firebaseConfig = {
    apiKey: process.env.API_KEY,
    authDomain: process.env.AUTH_DOMAIN,
    projectId: process.env.PROJECT_ID,
    storageBucket: process.env.STORAGE_BUCKET,
    messagingSenderId: process.env.SENDER_ID,
    appId: process.env.APP_ID,
    measurementId: process.env.MEASUREMENT_ID
};

// Sendgrid
export const mailerKey = process.env.MAILER_KEY
export const mailerSender = process.env.MAILER_SENDER

// MongoDB
export const mongoConfig = {
    mongoHost: process.env.MONGO_HOST, 
    mongoUser: process.env.MONGO_USER, 
    mongoPassword: process.env.MONGO_PW, 
    mongoDatabase: process.env.MONGO_DB,
    appName: process.env.MONGO_APP_NAME
}
