/**
 * The production smoke runner (§143, §150).
 *
 * Run: npm run smoke:plan            — print the plan. Never calls anything.
 *      npm run smoke -- --base=URL   — execute, against a LOCAL host only.
 *
 * ## This will not run against production, and that is enforced
 *
 * Two independent refusals, because one is a thing somebody disables in a hurry:
 *
 *   1. the target must be localhost/127.0.0.1 unless `SMOKE_REMOTE_ACK` is set
 *      to exactly `host/port`, the same shape `run-migrations.ts` uses;
 *   2. even then it probes only GET endpoints, because the plan
 *      (`routeHealth.smokePlan`) marks every write `safe: false` and this
 *      script has no branch that executes an unsafe step.
 *
 * The standing rules for this work forbid running it against production at all.
 * What is delivered here is the TOOLING and the STRATEGY; the run is somebody
 * else's decision, made with credentials this repository has never seen.
 *
 * ## Credentials
 *
 * Read from the environment at call time, one variable per account, named in
 * `SMOKE_ACCOUNTS`. Never logged, never echoed on failure, never defaulted. A
 * missing credential skips the steps that need it and says so — it does not
 * fall back to an unauthenticated call that would then "pass" as a 401, which
 * is the exact mistake §143 exists to prevent.
 */

import http from 'http';
import https from 'https';
import {
  CREDENTIAL_RULES,
  SMOKE_ACCOUNTS,
  classifyProbe,
  isConclusive,
  smokePlan,
  smokeSummary,
  type ProofStrength,
  type SmokeStep,
} from '../src/api/v1/routeHealth';

const args = process.argv.slice(2);
const planOnly = args.includes('--plan') || !args.some((a) => a.startsWith('--base='));
const baseArg = args.find((a) => a.startsWith('--base='))?.slice('--base='.length) ?? '';

// ─── Refusals ─────────────────────────────────────────────────────────────────

const assertTargetPermitted = (base: string) => {
  const url = new URL(base);
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(url.hostname);
  if (local) return;
  const ack = `${url.hostname}${url.port ? `:${url.port}` : ''}`;
  if (process.env.SMOKE_REMOTE_ACK !== ack) {
    throw new Error(
      `Remote smoke refused. Target ${ack} is not local. Set SMOKE_REMOTE_ACK exactly to ` +
        `"${ack}" after deployment approval. This repository's standing rules forbid running ` +
        'against production.',
    );
  }
};

// ─── Probing ──────────────────────────────────────────────────────────────────

interface StepResult {
  step: SmokeStep;
  status: number | null;
  strength: ProofStrength | 'SKIPPED';
  note: string;
}

const probe = (base: string, step: SmokeStep, token: string | null): Promise<StepResult> =>
  new Promise((resolve) => {
    const url = new URL(base.replace(/\/$/, '') + step.path.replace(/:[A-Za-z]+/g, '1'));
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: step.method,
        timeout: 10_000,
        headers: {
          accept: 'application/json',
          'x-servana-client': 'smoke',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let body: unknown = null;
          try { body = text ? JSON.parse(text) : null; } catch { body = null; }
          const strength = classifyProbe({
            status: res.statusCode ?? 0,
            body,
            contentType: String(res.headers['content-type'] ?? ''),
          });
          resolve({
            step,
            status: res.statusCode ?? null,
            strength,
            // The request id, never the body: a response body on a real system
            // carries real data, and this output gets pasted into tickets.
            note: String(res.headers['x-request-id'] ?? ''),
          });
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ step, status: null, strength: 'INCONCLUSIVE', note: 'timeout' }); });
    // The error message, never the exception — it can carry the URL with a token.
    req.on('error', (e) => resolve({ step, status: null, strength: 'INCONCLUSIVE', note: e.name }));
    req.end();
  });

const tokenFor = (accountKey: string | null): string | null => {
  if (!accountKey) return null;
  const account = SMOKE_ACCOUNTS.find((a) => a.key === accountKey);
  if (!account) return null;
  return process.env[account.credentialEnv] ?? null;
};

// ─── Output ───────────────────────────────────────────────────────────────────

const printPlan = () => {
  const plan = smokePlan();
  const summary = smokeSummary();
  console.log('Servana production smoke — PLAN ONLY. Nothing was called.\n');
  console.log(`  endpoints mounted     ${summary.total}`);
  console.log(`  probed (GET only)     ${summary.probed}`);
  console.log(`  skipped (writes)      ${summary.skippedWrites}`);
  console.log(`  by auth               public=${summary.byAuth.public} authenticated=${summary.byAuth.authenticated} provider=${summary.byAuth.provider} admin=${summary.byAuth.admin}\n`);

  console.log('Accounts (values come from the environment; none is stored here):');
  for (const account of SMOKE_ACCOUNTS) {
    console.log(`  ${account.key.padEnd(16)} $${account.credentialEnv.padEnd(24)} rotate ${account.rotationDays}d — ${account.privilege}`);
  }
  console.log(`\n  ${CREDENTIAL_RULES.personalAccounts}\n`);

  console.log('Steps:');
  for (const step of plan) {
    const mark = step.safe ? '  probe' : '  SKIP ';
    console.log(`${mark} ${step.method.padEnd(6)} ${step.path.padEnd(52)} ${step.authMode.padEnd(14)} ${step.account ?? '—'}`);
  }
  console.log('\nA 401 or 403 FAILS a step. It proves the auth chain ran, never that the route exists.');
};

const run = async (base: string) => {
  assertTargetPermitted(base);
  const steps = smokePlan().filter((s) => s.safe);
  const results: StepResult[] = [];

  for (const step of steps) {
    const token = tokenFor(step.account);
    if (step.authMode !== 'public' && !token) {
      results.push({ step, status: null, strength: 'SKIPPED', note: 'no credential in the environment' });
      continue;
    }
    results.push(await probe(base, step, token));
  }

  const proved = results.filter((r) => r.strength === 'HANDLER_REACHED');
  const absent = results.filter((r) => r.strength === 'ROUTE_ABSENT');
  const inconclusive = results.filter((r) => r.strength === 'INCONCLUSIVE');
  const skipped = results.filter((r) => r.strength === 'SKIPPED');

  for (const result of results) {
    if (isConclusive(result.strength as ProofStrength) && result.strength === 'HANDLER_REACHED') continue;
    console.log(
      `  ${String(result.strength).padEnd(16)} ${result.step.method.padEnd(6)} ${result.step.path.padEnd(52)} ` +
        `status=${result.status ?? '—'} ${result.note}`,
    );
  }

  console.log(`\n  handler reached  ${proved.length}`);
  console.log(`  route absent     ${absent.length}`);
  console.log(`  INCONCLUSIVE     ${inconclusive.length}`);
  console.log(`  skipped          ${skipped.length}`);

  // An absent route or an inconclusive probe both fail: the first is a missing
  // endpoint, the second is a check that proved nothing and must not be read as
  // a pass.
  if (absent.length || inconclusive.length) {
    console.error('\nSmoke FAILED. An INCONCLUSIVE result is a failure, not a pass.');
    process.exitCode = 1;
  } else {
    console.log('\nSmoke passed.');
  }
};

if (require.main === module) {
  if (planOnly) {
    printPlan();
  } else {
    run(baseArg).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}

export { assertTargetPermitted, tokenFor };
