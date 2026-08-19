/**
 * A variable the code reads but the schema never names cannot be reported unset.
 *
 * ## The incident this encodes
 *
 * On 2026-08-19, `POST /api/auth/refresh` and `POST /api/v1/auth/refresh` both
 * answered `502 REFRESH_UNAVAILABLE` on production, for any token. The cause is
 * in `tokenRefreshService`, which says so itself:
 *
 *     const apiKey = firebaseConfig.apiKey;
 *     if (!apiKey) {
 *       // Misconfiguration, not a client error.
 *
 * `API_KEY` was unset. No session could be renewed by any client — admin
 * portal, both mobile apps, provider web — and the symptom is not something
 * anybody files as a bug: users are simply signed out when their token reaches
 * its hour, because a correct client refuses to discard a session on a 502 and
 * then presents a token the server rejects.
 *
 * It went unnoticed because `API_KEY` appeared in NO list. `validateEnv` reports
 * required variables as fatal and degraded ones as features that will not work;
 * a variable in neither is invisible to both. The absence was not
 * under-reported — it was unreportable.
 *
 * This is the same shape as the catalog outage nine hours earlier, where
 * `/readyz` had named `DB_PASSWORD` for over a day and nothing watched it. There
 * the signal existed and nobody read it. Here there was no signal to read.
 *
 * ## Frozen, not enforced, and why
 *
 * 29 variables are read by `src/` and declared nowhere. Shipping this as a hard
 * failure fails 29 times on the first run, and a gate that cannot pass is
 * deleted inside a week — the same reasoning `orphan-route-ratchet` gives for
 * freezing its 405. So the 29 are frozen here and the assertion is that the
 * number does not RISE.
 *
 * Draining the list is worth doing. Adding to it must be deliberate.
 */

import fs from 'fs';
import path from 'path';
import { ENV_SCHEMA } from '../src/env/envSchema';

const SRC = path.resolve(__dirname, '..', 'src');

/**
 * Comments removed before scanning, because a comment is not a read.
 *
 * This class of bug has appeared four times in this programme: a marker parser
 * that read the docblock defining its markers, an `IF NOT EXISTS` scan that read
 * commented-out DDL, an `<any>` ratchet that counted the sentence explaining
 * itself, and a `forceRefund` check that matched the note recording its
 * removal. The docblock above this very file names `API_KEY` and
 * `process.env`-shaped text; without this it would count itself.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      const at = line.indexOf('//');
      return at === -1 ? line : line.slice(0, at);
    })
    .join('\n');

const tsFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.isFile() && full.endsWith('.ts') ? [full] : [];
  });

/** Every `process.env.NAME` actually read by application source. */
const readInSource = (): Set<string> => {
  const names = new Set<string>();
  for (const file of tsFiles(SRC)) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const match of code.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      names.add(match[1]);
    }
    // `process.env['NAME']` is the same read written differently.
    for (const match of code.matchAll(/process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g)) {
      names.add(match[1]);
    }
  }
  return names;
};

/**
 * The variables read by `src/` and named by no list, as of 2026-08-19.
 *
 * Frozen so the number cannot rise. Every entry is a variable whose absence the
 * server cannot report — some harmless (`PORT`, `NODE_ENV`), some emphatically
 * not (`MONGO_URI`, `PROVIDER_DOCUMENT_SCANNER_TOKEN`, `CUSTOMER_RESET_URL`).
 * They are listed rather than counted so that draining one is a visible edit.
 */
const UNDECLARED_BASELINE: readonly string[] = [
  'ADMIN_PORTAL_URL',
  'ADMIN_RATE_LIMIT_LOG_ONLY',
  'ALLOW_BASELINE_DOCUMENT_SCAN',
  'APP_ID',
  'AUTH_DOMAIN',
  'CAPABILITY_ENFORCEMENT',
  'CUSTOMER_RESET_URL',
  'CUSTOMER_VERIFY_URL',
  'LOG_SAMPLE_RATE',
  'MEASUREMENT_ID',
  'MONGO_APP_NAME',
  'MONGO_PW',
  'MONGO_URI',
  'MONGO_USER',
  'NODE_ENV',
  'PAYMONGO_EXPECT_LIVE_MODE',
  'PAYMONGO_RETURN_URL',
  'PAYMONGO_SK_DEV',
  'PAYMONGO_WEBHOOK_TOLERANCE_SECONDS',
  'PORT',
  'PROVIDER_DOCUMENT_SCANNER_TIMEOUT_MS',
  'PROVIDER_DOCUMENT_SCANNER_TOKEN',
  'PROVIDER_DOCUMENT_SCANNER_URL',
  'PROVIDER_RESET_URL',
  'PROVIDER_VERIFY_URL',
  'REFUND_ALLOW_SELF_APPROVAL',
  'SEMAPHORE_SENDER_NAME',
  'SENDER_ID',
  'TEMP_ID',
];

describe('every environment variable the code reads can be reported unset', () => {
  const declared = new Set(ENV_SCHEMA.map((spec) => spec.name));
  const used = readInSource();
  const undeclared = [...used].filter((name) => !declared.has(name)).sort();

  it('finds the reads, rather than passing by finding nothing', () => {
    // A broken extractor returns an empty set and makes this whole file
    // vacuous. The number is a floor, not a target.
    expect(used.size).toBeGreaterThan(40);
    expect(used.has('DB_PASSWORD')).toBe(true);
  });

  it('does not count a variable merely mentioned in a comment', () => {
    // This file's own docblock names API_KEY and quotes source. Counting a
    // comment as a read is the fourth appearance of that class in this
    // programme, so it is asserted rather than assumed.
    const sample = stripComments(`
      // process.env.NOT_A_REAL_READ
      /* process.env.ALSO_NOT_ONE */
      const real = process.env.GENUINE_READ;
    `);
    expect(sample).toContain('GENUINE_READ');
    expect(sample).not.toContain('NOT_A_REAL_READ');
    expect(sample).not.toContain('ALSO_NOT_ONE');
  });

  it('adds no new undeclared variable', () => {
    /**
     * The property that makes the list drain rather than churn. A new
     * `process.env.X` with no schema entry is a variable whose absence nothing
     * can report — which is exactly how API_KEY broke token refresh for every
     * client, silently, for an unknown length of time.
     */
    const added = undeclared.filter((name) => !UNDECLARED_BASELINE.includes(name));
    expect(added).toEqual([]);
  });

  it('reports a drained variable rather than letting the list rot', () => {
    // Declaring one must lower the baseline, so the frozen list keeps
    // describing reality instead of becoming a historical artefact.
    const drained = UNDECLARED_BASELINE.filter((name) => !undeclared.includes(name));
    expect(drained).toEqual([]);
  });

  it('declares API_KEY, whose absence stopped every client renewing a session', () => {
    /**
     * The instance, pinned separately from the rule. Token refresh 502s for
     * every client without it, and nothing said so because it was in no list.
     * `degraded` rather than `required`: the server can genuinely serve without
     * it, and making it fatal would turn a broken-refresh incident into a
     * won't-boot incident. What was missing was visibility, not severity.
     */
    const spec = ENV_SCHEMA.find((s) => s.name === 'API_KEY');
    expect(spec).toBeDefined();
    expect(spec?.requirement).toBe('degraded');
    expect(spec?.purpose).toMatch(/refresh/i);
  });

  it('names every variable the refresh path depends on', () => {
    // Read from the service rather than restated, so a rename cannot leave this
    // test agreeing with a variable nobody uses.
    const service = stripComments(
      fs.readFileSync(path.join(SRC, 'services', 'tokenRefreshService.ts'), 'utf8'),
    );
    expect(service).toContain('firebaseConfig.apiKey');
    expect(declared.has('API_KEY')).toBe(true);
  });
});
