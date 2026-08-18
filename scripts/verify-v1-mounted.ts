/**
 * Is the `/api/v1` router actually mounted on the host we just deployed to?
 *
 * Run: npm run v1:mounted -- --base=https://api.servana.com.ph
 *      npm run v1:mounted -- --base=http://localhost:3000 --verbose
 *
 * ## Why this exists, and why it is not `production-smoke.ts`
 *
 * `production-smoke.ts` answers "do the endpoints behave correctly for a real
 * account". It needs credentials, it refuses production by design, and it is
 * the right tool for that question.
 *
 * This script answers a different and much smaller question: **is the surface
 * reachable at all**. That question needs no credentials, performs no writes,
 * and is exactly the question nobody was asking on 2026-08-18, when the
 * provider web portal was serving a build that called 29 `/api/v1` paths at a
 * production host whose deployed tree contained no `src/api` directory at all.
 *
 * Every request this script makes is a GET against a path the contract itself
 * declares `public`, plus one GET against a path that deliberately does not
 * exist. No credential is read, so there is no credential to leak, and no
 * account state to disturb. That is why it is safe to point at production and
 * why it carries none of `production-smoke.ts`'s refusals.
 *
 * ## The discriminator
 *
 * A missing router and a protected router look identical from the outside if
 * you only probe protected endpoints — both answer 401. That is precisely the
 * trap that hid the outage: `GET /api/v1/me` returning 401 reads as "correct,
 * I sent no token".
 *
 * The contract declares 20 endpoints `auth: 'public'`. Those separate the two
 * cases, because a mounted router must serve them WITHOUT a token:
 *
 *   public GET -> 200        and bogus path -> 404     MOUNTED, correct
 *   public GET -> 401        and bogus path -> 401     NOT MOUNTED (or behind a
 *                                                      blanket auth middleware
 *                                                      that runs before routing)
 *   public GET -> 401        and bogus path -> 404     MOUNTED, but the public
 *                                                      contract is a lie
 *
 * The bogus-path control is what makes the reading conclusive. Without it a 401
 * on a public endpoint is ambiguous, and an ambiguous probe reported as a
 * failure is as useless as one reported as a pass.
 *
 * A `planned` entry must answer 404: it is documented and deliberately not
 * mounted, and a planned entry that responds is a contract violation in the
 * other direction.
 *
 * Exits non-zero on any conclusive failure, so it can gate a deploy.
 */

import http from 'http';
import https from 'https';
import { V1_CONTRACT, V1_PREFIX, fullPath, type ContractEntry } from '../src/api/v1/contract';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const baseArg = args.find((a) => a.startsWith('--base='))?.slice('--base='.length) ?? '';

if (!baseArg) {
  console.error('Usage: npm run v1:mounted -- --base=<origin> [--verbose]');
  process.exit(2);
}

const BASE = baseArg.replace(/\/$/, '');
const TIMEOUT_MS = 20_000;

/**
 * A path that cannot exist under any contract entry. It is the control: its
 * response is what "this host does not route here" looks like on this host, and
 * every other reading is interpreted relative to it.
 */
const BOGUS_PATH = `${V1_PREFIX}/__mount_probe_do_not_implement__`;

interface Probe {
  path: string;
  status: number | null;
  code: string | null;
  error?: string;
}

const get = (path: string): Promise<Probe> =>
  new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(BASE + path);
    } catch {
      resolve({ path, status: null, code: null, error: 'unparseable base URL' });
      return;
    }
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        // Deliberately no Authorization header. The whole point is what an
        // anonymous caller sees.
        headers: { accept: 'application/json', 'user-agent': 'servana-v1-mount-probe' },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        // Cap the read: a mounted HTML error page can be large and we only ever
        // need the error code out of the first few hundred bytes.
        let size = 0;
        res.on('data', (c: Buffer) => {
          if (size < 4096) {
            chunks.push(c);
            size += c.length;
          }
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let code: string | null = null;
          try {
            const parsed = JSON.parse(body) as { code?: unknown };
            if (typeof parsed.code === 'string') code = parsed.code;
          } catch {
            // Not JSON. An Express HTML 404 is itself a useful signal, so this
            // is not an error — `code` simply stays null.
          }
          resolve({ path, status: res.statusCode ?? null, code });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ path, status: null, code: null, error: `timeout after ${TIMEOUT_MS}ms` });
    });
    req.on('error', (e) => resolve({ path, status: null, code: null, error: e.message }));
    req.end();
  });

/** Public GETs, which are the only entries that separate "absent" from "protected". */
const publicGets: ContractEntry[] = V1_CONTRACT.filter(
  (e) => e.status === 'implemented' && e.auth === 'public' && e.method === 'get',
);

/** Planned entries must NOT be mounted. Probe the GETs among them. */
const plannedGets: ContractEntry[] = V1_CONTRACT.filter(
  (e) => e.status === 'planned' && e.method === 'get',
);

/** `:param` -> `1`. These are public reads; a wrong id yields 404, which is fine. */
const concrete = (entry: ContractEntry): string => fullPath(entry).replace(/:[A-Za-z]+/g, '1');

const main = async (): Promise<void> => {
  console.log(`v1 mount check against ${BASE}`);
  console.log(`contract: ${V1_CONTRACT.length} entries, ${publicGets.length} public GETs, ` +
    `${plannedGets.length} planned GETs\n`);

  const control = await get(BOGUS_PATH);
  if (control.error) {
    console.error(`UNREACHABLE: control probe failed - ${control.error}`);
    console.error('The host did not answer at all. This is not a mount verdict; fix reachability first.');
    process.exit(2);
  }
  console.log(`control  ${String(control.status).padEnd(4)} ${control.code ?? '-'}  ${BOGUS_PATH}`);
  console.log('  (this is what "not routed here" looks like on this host)\n');

  const failures: string[] = [];
  let publicOk = 0;
  let publicUnauthed = 0;

  for (const entry of publicGets) {
    const path = concrete(entry);
    const probe = await get(path);

    if (probe.error) {
      failures.push(`${entry.id}: ${probe.error}`);
      console.log(`FAIL     ---  ${path}  (${probe.error})`);
      continue;
    }

    // 200 or 404 both prove the router is mounted: 404 here means "routed, and
    // id 1 does not exist", which is a correct answer from a live handler.
    const mounted = probe.status !== 401 && probe.status !== 403;
    if (mounted) {
      publicOk += 1;
      if (verbose) console.log(`ok       ${String(probe.status).padEnd(4)} ${path}`);
    } else {
      publicUnauthed += 1;
      failures.push(
        `${entry.id} (${path}) is declared auth:'public' but answered ${probe.status}` +
          (probe.code ? ` ${probe.code}` : ''),
      );
      console.log(`FAIL     ${String(probe.status).padEnd(4)} ${probe.code ?? '-'}  ${path}  <- declared public`);
    }
  }

  for (const entry of plannedGets) {
    const path = concrete(entry);
    const probe = await get(path);
    if (probe.error) continue;
    if (probe.status === 404) {
      if (verbose) console.log(`ok       404  ${path}  (planned, correctly unmounted)`);
    } else {
      failures.push(`${entry.id} (${path}) is status:'planned' but answered ${probe.status}`);
      console.log(`FAIL     ${String(probe.status).padEnd(4)} ${path}  <- planned entries must not be mounted`);
    }
  }

  // ─── Verdict ────────────────────────────────────────────────────────────────
  console.log('');
  const sameAsControl =
    publicGets.length > 0 &&
    publicUnauthed === publicGets.length &&
    control.status === 401;

  if (sameAsControl) {
    console.error('VERDICT: NOT MOUNTED');
    console.error(
      `Every one of the ${publicGets.length} public GETs answered exactly as the bogus control path did ` +
        `(${control.status} ${control.code ?? '-'}). The v1 router is not mounted on this host, or it sits ` +
        'behind a middleware that authenticates before routing. Either way, no client can reach /api/v1 here.',
    );
    console.error('Check the DEPLOYED commit, not the repository: `gh run list` describes production, `git log` does not.');
    process.exit(1);
  }

  if (failures.length > 0) {
    console.error(`VERDICT: MOUNTED, WITH ${failures.length} CONTRACT VIOLATION(S)`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log(
    `VERDICT: MOUNTED — ${publicOk}/${publicGets.length} public GETs served anonymously, ` +
      `${plannedGets.length} planned entries correctly absent, control path ${control.status}.`,
  );
};

main().catch((e: unknown) => {
  console.error('v1 mount check failed to run:', e instanceof Error ? e.message : String(e));
  process.exit(2);
});
