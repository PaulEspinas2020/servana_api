/**
 * Load `.env` BEFORE anything reads `process.env`.
 *
 * ## The bug this exists to prevent
 *
 * On 2026-08-19 production answered 500 on every database-backed route with
 * `SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string` — the
 * `pg` driver being handed `undefined`. `.env` was present, correct, and in the
 * process's own working directory the whole time.
 *
 * Two things combined:
 *
 *  1. `app.ts` calls `dotenv.config()` in its module body, *after* its imports.
 *     In CommonJS every imported module's top-level code runs first, so any
 *     module that reads `process.env` at import scope sees an unpopulated
 *     environment.
 *  2. `config.ts` — which 53 modules import, and which captures the database
 *     credentials into a module-level `const` — guarded its own load with
 *     `if (!process.env.NODE_ENV)`. In production `NODE_ENV` is always set, so
 *     that call never ran. Its path was `"../.env"`, resolved against the
 *     process CWD rather than the source tree, so it pointed somewhere else
 *     again on the one occasion it could have fired.
 *
 * The net effect: **in production, `.env` had never supplied the database
 * credentials at all.** The API only ever worked because PM2's process
 * environment happened to carry them, which is why a restart that lost them
 * took the whole platform down and why sourcing the env file into the shell
 * before `pm2 restart` was the only thing that fixed it.
 *
 * ## Why importing this is safe everywhere
 *
 * `dotenv.config()` does not overwrite a variable that is already set. So where
 * the process environment is populated — which is how production runs today —
 * this changes nothing at all. It can only add values that were missing. There
 * is no configuration in which importing this makes the environment worse.
 *
 * ## How to use it
 *
 * Import it for its side effect, as the FIRST import of any entry point and of
 * `config.ts`:
 *
 *     import "./env/loadEnv";
 *
 * Import order is the whole point, so it must stay first. Anything above it is
 * a module that may read `process.env` before this has run.
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

/**
 * Candidate locations, in the order they are tried.
 *
 * The CWD is correct for the deployed layout (PM2 runs with `cwd` set to the
 * application directory), but it is not guaranteed — a script run from
 * elsewhere, or a future change to the unit that starts the process, would
 * silently move it. Resolving against this file's own location as well means
 * the lookup does not depend on who started the process or from where.
 */
const candidates = [
  path.resolve(process.cwd(), ".env"),
  // dist/env/loadEnv.js -> the package root two levels up.
  path.resolve(__dirname, "..", "..", ".env"),
];

let loadedFrom: string | null = null;

for (const candidate of candidates) {
  if (!fs.existsSync(candidate)) continue;
  const result = dotenv.config({ path: candidate });
  if (result.error) continue;
  loadedFrom = candidate;
  break;
}

/**
 * Where the environment file was read from, or null if none was found.
 *
 * Null is not an error. A container or a systemd unit may supply everything
 * through the real process environment, which is a perfectly good way to run
 * and the case this module deliberately does not disturb. `validateEnv` in
 * `config.ts` is what decides whether the resulting environment is adequate;
 * this only makes sure the file has had its chance to contribute first.
 */
export const envFileLoadedFrom = loadedFrom;
