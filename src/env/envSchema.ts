/**
 * Typed environment schema (TAB 12).
 *
 * ## What this replaces
 *
 * `config.ts` read thirty-odd variables straight off `process.env`, so every
 * exported value was `string | undefined` and a missing one surfaced as an
 * undefined deep inside a query, an SMTP call or a PayMongo request — far from
 * the cause. Nothing described which variables the app actually needs.
 *
 * ## Why it refuses only in production, and only for a short list
 *
 * The acceptance criterion is that production refuses insecure fallback
 * configuration. It is NOT that every variable is mandatory everywhere: tests
 * and local development legitimately run without SendGrid or PayMongo keys, and
 * making those fatal would break the suite and every developer machine.
 *
 * More importantly, this repo's server has not been booted since its startup was
 * rewritten. A fail-fast that names the wrong variable as required would turn
 * that first boot into a crash, and the failure would look like the startup work
 * rather than like this list. So REQUIRED is deliberately confined to variables
 * whose absence would ALREADY have broken production — it runs today, so it
 * demonstrably has these set. Adding to this list is a claim about production's
 * real environment; do not add on the strength of "it looks important".
 *
 * Everything else is DEGRADED: reported at boot, never fatal. That is the
 * "degraded without hiding them" requirement from TAB 03's dependency
 * classification, applied to configuration.
 *
 * ## Values are never printed
 *
 * TAB 12 also requires that no secret appears in logs. This module reports
 * variable NAMES and whether they are set. It never logs, returns or throws a
 * value — not truncated, not masked. A masked secret in a log is still a secret
 * in a log, and masking invites someone to widen it later.
 */

export type EnvRequirement = 'required' | 'degraded';

export interface EnvVarSpec {
  name: string;
  requirement: EnvRequirement;
  /** What breaks without it. Written for whoever reads the boot failure. */
  purpose: string;
}

/**
 * Variables whose absence would already have broken production.
 *
 * Production serves traffic against PostgreSQL today, so the connection settings
 * and the schema name are present by demonstration rather than by assumption.
 */
export const REQUIRED_ENV: readonly EnvVarSpec[] = Object.freeze([
  { name: 'DB_USER', requirement: 'required', purpose: 'PostgreSQL connection' },
  { name: 'DB_HOST', requirement: 'required', purpose: 'PostgreSQL connection' },
  { name: 'DB_DATABASE', requirement: 'required', purpose: 'PostgreSQL connection' },
  { name: 'DB_PASSWORD', requirement: 'required', purpose: 'PostgreSQL connection' },
  { name: 'DB_PORT', requirement: 'required', purpose: 'PostgreSQL connection' },
  {
    name: 'SCHEMA',
    requirement: 'required',
    // Every query interpolates this. Undefined turns them into `undefined.table`.
    purpose: 'PostgreSQL schema every query is qualified with',
  },

]);

/**
 * Present in production, absent in development and CI. Reported, never fatal.
 *
 * Each entry names the capability that silently stops working, because the
 * failure mode of a missing integration key is usually silence.
 */
export const DEGRADED_ENV: readonly EnvVarSpec[] = Object.freeze([
  {
    name: 'SECRET',
    requirement: 'degraded',
    /**
     * Moved OFF the required list, and the reason is a correction.
     *
     * I put it there arguing the required list held only variables whose absence
     * would ALREADY have broken production. That premise failed here: production
     * has never set SECRET, and `helpers/validation.ts` silently falls back
     * to the literal "nosecret". Absence was invisible because the code hid it.
     *
     * It is safe to demote because its only consumer, `generateUserToken`,
     * has NO CALLERS and nothing verifies its JWT — authentication is
     * Firebase `verifyIdToken` throughout. Dead code, not a live key.
     *
     * If anything ever signs with it again, move it back to required AND set it
     * in production first, in that order.
     */
    purpose: 'legacy JWT signing — currently dead code, no callers verify it',
  },
  { name: 'PAYMONGO_SECRET_KEY', requirement: 'degraded', purpose: 'checkout, refunds and payouts' },
  { name: 'PAYMONGO_WEBHOOK_SECRET', requirement: 'degraded', purpose: 'webhook signature verification' },
  { name: 'MAILER_KEY', requirement: 'degraded', purpose: 'all outbound email' },
  { name: 'MAILER_SENDER', requirement: 'degraded', purpose: 'outbound email sender identity' },
  { name: 'FIREBASE_SERVICE_ACCOUNT_JSON', requirement: 'degraded', purpose: 'auth token verification' },
  { name: 'PROJECT_ID', requirement: 'degraded', purpose: 'Firebase project binding' },
  { name: 'STORAGE_BUCKET', requirement: 'degraded', purpose: 'document and image storage' },
  { name: 'MONGO_HOST', requirement: 'degraded', purpose: 'chat and notification storage' },
  { name: 'MONGO_DB', requirement: 'degraded', purpose: 'chat and notification storage' },
  { name: 'SEMAPHORE_API_KEY', requirement: 'degraded', purpose: 'SMS/OTP delivery' },
  { name: 'GOOGLE_PLACES_SERVER_API_KEY', requirement: 'degraded', purpose: 'address lookup' },
  { name: 'APP_URL', requirement: 'degraded', purpose: 'links in email and payment return URLs' },
]);

export const ENV_SCHEMA: readonly EnvVarSpec[] = Object.freeze([
  ...REQUIRED_ENV,
  ...DEGRADED_ENV,
]);

const isSet = (name: string): boolean => {
  const v = process.env[name];
  return typeof v === 'string' && v.trim().length > 0;
};

export interface EnvReport {
  missingRequired: string[];
  missingDegraded: string[];
  /** Configuration that is unsafe for production regardless of what is set. */
  insecure: string[];
}

/**
 * Inspect the environment. Pure — it neither throws nor logs, so it can be
 * tested and so the caller decides what a problem means.
 */
export const inspectEnv = (production: boolean): EnvReport => {
  const insecure: string[] = [];

  // The existing TEMP_ID guard, expressed as policy rather than as a lone `if`.
  // It bypasses authentication outright, so it is unsafe even fully configured.
  if (production && isSet('TEMP_ID')) {
    insecure.push('TEMP_ID must not be set in production — it bypasses all authentication');
  }

  return {
    missingRequired: REQUIRED_ENV.filter((s) => !isSet(s.name)).map((s) => s.name),
    missingDegraded: DEGRADED_ENV.filter((s) => !isSet(s.name)).map((s) => s.name),
    insecure,
  };
};

/** Message for a fatal report. Names only — never a value. */
export const describeFailure = (report: EnvReport): string => {
  const lines: string[] = [];
  if (report.insecure.length) {
    lines.push(...report.insecure.map((m) => `  INSECURE: ${m}`));
  }
  for (const name of report.missingRequired) {
    const spec = ENV_SCHEMA.find((s) => s.name === name);
    lines.push(`  MISSING:  ${name} — ${spec?.purpose ?? 'required'}`);
  }
  return `Environment is not usable:\n${lines.join('\n')}`;
};

/**
 * Validate at boot.
 *
 * Production: throws on the FIRST call with every problem listed at once.
 * Reporting one variable per restart turns a five-variable misconfiguration into
 * five deploys.
 *
 * Elsewhere: warns and continues, so tests and local development run without a
 * full production environment.
 */
export const validateEnv = (
  production: boolean = process.env.NODE_ENV === 'production',
  log: Pick<Console, 'warn' | 'info'> = console,
): EnvReport => {
  const report = inspectEnv(production);

  if (production && (report.missingRequired.length || report.insecure.length)) {
    throw new Error(describeFailure(report));
  }

  if (report.missingRequired.length) {
    log.warn(
      `[env] ${report.missingRequired.length} required variable(s) unset: ` +
        `${report.missingRequired.join(', ')} — fatal in production.`,
    );
  }
  if (report.missingDegraded.length) {
    // Degraded, not hidden: the capability list is what makes this actionable.
    log.info(
      `[env] degraded — unset: ${report.missingDegraded.join(', ')}. ` +
        'The features these serve will not work.',
    );
  }

  return report;
};
