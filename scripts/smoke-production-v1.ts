/**
 * Is the v1 surface we shipped actually reachable? (TAB 02 mandate 5)
 *
 * ## Why this exists
 *
 * The provider portal shipped a build calling `/api/v1` paths while production
 * mounted no v1 router at all, and every gate in both repositories was green
 * throughout. 5,935 backend tests and 5,771 portal tests all passed, because
 * every one of them mocks the transport. Nothing in either pipeline asked the
 * only question that mattered: does the deployed server answer the deployed
 * client?
 *
 * This script asks it, against production, over the real network.
 *
 * ## What it asserts
 *
 * For every entry in `V1_CONTRACT`, unauthenticated:
 *
 *   - `status: 'implemented'` must be MOUNTED — the router must not answer with
 *     its own catch-all.
 *   - `status: 'planned'` must be ABSENT — a planned entry that answers is a
 *     surface shipped ahead of its contract.
 *   - `auth: 'public'` must not require a token: anything except 401/403.
 *   - every other auth mode must return 401 without one. A public endpoint that
 *     401s means the router sits behind blanket auth — which was exactly the
 *     production symptom — and is a FAILED deploy, not a passed one.
 *
 * ## Mounted vs. not-mounted, which are both 404
 *
 * `src/api/v1/register.ts` ends the router in its own 404, whose message is
 * `No v1 endpoint for <METHOD> <path>`. A mounted route answering "that id does
 * not exist" is also a 404. Only the catch-all's shape distinguishes them, so
 * that string — not the status code — is what this script keys on.
 *
 * ## Safety: this runs against PRODUCTION
 *
 * It is a reachability probe and must never be capable of becoming a real
 * submission:
 *
 *   - no credential is ever sent, so no authenticated mutation can occur;
 *   - non-GET requests carry an EMPTY body, so a public mutation such as
 *     `POST /auth/register` is rejected at validation. A 400 proves the route
 *     is mounted and reached its handler, which is all that is being asked;
 *   - `/auth/forgot-password` and `/auth/resend-verification` are the reason
 *     the empty body is non-negotiable — with a real address they would send
 *     mail to a real person.
 *
 * The authenticated half of TAB 02 — 26 provider-scoped endpoints with a real
 * token — is NOT implemented here, because doing so needs a dedicated
 * production provider account that does not exist yet (TAB 12 mandate 1). It is
 * deliberately absent rather than stubbed green.
 */

import { V1_CONTRACT } from '../src/api/v1/contract';

const BASE = process.env.SERVANA_SMOKE_BASE ?? 'https://api.servana.com.ph';
const PREFIX = '/api/v1';
const TIMEOUT_MS = 20_000;

type Verdict = 'PASS' | 'FAIL';

interface Row {
  method: string;
  path: string;
  auth: string;
  status: string;
  observed: number | string;
  mounted: boolean;
  code: string | null;
  envelope: string;
  verdict: Verdict;
  why: string;
}

/**
 * A concrete value for each path parameter. Reads only, and deliberately
 * type-plausible: a numeric id that fails validation tells us nothing about
 * whether the route is mounted, which is the question.
 */
const paramValue = (name: string): string =>
  /id$/i.test(name) && /^(category|subcategory|service|booking)/i.test(name) ? '1' : 'smoke-probe';

const concrete = (path: string): string =>
  path.replace(/:([A-Za-z0-9_]+)/g, (_m, name) => paramValue(name));

/** The v1 router's own 404, as opposed to a handler's. */
const isCatchAll = (body: any, raw: string): boolean => {
  const message = body?.error?.message ?? body?.message ?? raw;
  return typeof message === 'string' && /No v1 endpoint for/i.test(message);
};

const errorCode = (body: any): string | null =>
  body?.error?.code ?? body?.code ?? null;

/** Which envelope answered — the v1 shape, or the legacy one. */
const envelopeOf = (body: any): string => {
  if (body && typeof body === 'object') {
    if (body.error && typeof body.error === 'object') return 'v1';
    if ('status' in body && 'code' in body) return 'legacy';
    if ('data' in body) return 'v1-data';
  }
  return 'other';
};

async function probe(method: string, path: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${PREFIX}${path}`, {
      method: method.toUpperCase(),
      // NEVER a real payload. See the safety note above.
      ...(method.toLowerCase() === 'get' || method.toLowerCase() === 'head'
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: '{}' }),
      signal: controller.signal,
    });
    const raw = await res.text();
    let body: any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* non-JSON is itself a finding */ }
    return { status: res.status, body, raw };
  } catch (cause) {
    return { status: `ERROR: ${(cause as Error)?.message ?? String(cause)}`, body: null, raw: '' };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const rows: Row[] = [];

  for (const entry of V1_CONTRACT as any[]) {
    const path = concrete(entry.path);
    const { status, body, raw } = await probe(entry.method, path);
    const numeric = typeof status === 'number' ? status : -1;
    const mounted = numeric === -1 ? false : !(numeric === 404 && isCatchAll(body, raw));
    const code = errorCode(body);
    const envelope = envelopeOf(body);

    let verdict: Verdict = 'PASS';
    let why = '';

    if (numeric === -1) {
      verdict = 'FAIL';
      why = String(status);
    } else if (entry.status === 'planned') {
      // A planned entry must not answer yet.
      if (mounted) { verdict = 'FAIL'; why = 'planned but MOUNTED — shipped ahead of its contract'; }
      else why = 'planned, absent — correct';
    } else if (!mounted) {
      verdict = 'FAIL';
      why = 'implemented but NOT MOUNTED — the deployed API does not serve it';
    } else if (entry.auth === 'public') {
      if (numeric === 401 || numeric === 403) {
        verdict = 'FAIL';
        why = `public endpoint answered ${numeric} — router is behind blanket auth`;
      } else why = `public, reachable (${numeric})`;
    } else {
      if (numeric !== 401) {
        verdict = 'FAIL';
        why = `${entry.auth} endpoint answered ${numeric} without a token — expected 401`;
      } else why = `${entry.auth}, correctly refused (401${code ? `, ${code}` : ''})`;
    }

    rows.push({
      method: entry.method.toUpperCase(), path: entry.path, auth: entry.auth,
      status: entry.status, observed: status, mounted, code, envelope, verdict, why,
    });
  }

  const failed = rows.filter((r) => r.verdict === 'FAIL');
  const notMounted = rows.filter((r) => r.status === 'implemented' && !r.mounted);
  const legacyEnvelope = rows.filter((r) => r.observed === 401 && r.envelope === 'legacy');

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ base: BASE, at: new Date().toISOString(), rows }, null, 2));
  } else {
    console.log(`\nv1 production smoke — ${BASE}${PREFIX} — ${new Date().toISOString()}\n`);
    for (const r of rows) {
      console.log(
        `${r.verdict === 'PASS' ? 'PASS' : 'FAIL'}  ${r.method.padEnd(6)} ${r.path.padEnd(52)} ` +
        `${String(r.auth).padEnd(14)} ${String(r.observed).padEnd(6)} ${r.why}`,
      );
    }
    console.log(`\n  ${rows.length} contract entries probed`);
    console.log(`  ${rows.length - failed.length} PASS / ${failed.length} FAIL`);
    console.log(`  ${notMounted.length} implemented entries NOT mounted in production`);
    console.log(
      `  ${legacyEnvelope.length} of the 401s answered in the LEGACY envelope ` +
      `({status,code}) rather than the v1 one ({error:{code}})`,
    );
  }

  // A deploy that cannot answer "is the surface I just shipped reachable" is
  // not finished. Non-zero so this can be the final step of a deploy.
  process.exit(failed.length === 0 ? 0 : 1);
}

void main();
