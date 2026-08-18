/**
 * The release gate (§151) and the generated safety documents (§148).
 *
 * ## Why the gate is tested rather than written down
 *
 * A checklist nobody executes is a checklist that is complete on every release.
 * Each gate names an npm script, and this suite asserts the script EXISTS —
 * because a gate whose command was renamed is a gate that silently stopped
 * being checked, and it goes on being ticked.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));

import fs from 'fs';
import path from 'path';
import { generateAll, safetyDrift, staleFiles } from '../scripts/generate-release-safety-docs';
import { BLOCKING_GATES, RELEASE_GATES, RELEASE_PROHIBITIONS } from '../src/observability/releaseGate';
import { ALERTS, METRICS, P0_ALERTS, SAFE_ENTITY_KEYS } from '../src/observability/observabilityPolicy';
import { OWNERSHIP_RULES, matrixSummary } from '../src/api/v1/authzMatrix';
import { SMOKE_ACCOUNTS } from '../src/api/v1/routeHealth';
import { NO_REMOVAL_RULE } from '../src/api/v1/deprecation';

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (rel: string) =>
  fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const pkg = JSON.parse(read('package.json'));

// ─── The gate ─────────────────────────────────────────────────────────────────

describe('every release gate names a command that exists', () => {
  it('resolves every npm script a gate invokes', () => {
    /**
     * THE assertion of this file. A gate reading `npm run guard:contracts`
     * after somebody renamed the script to `guard:protected-contracts` would go
     * on being ticked on every release, checking nothing.
     */
    for (const gate of RELEASE_GATES) {
      const scripts = [...gate.command.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
      for (const script of scripts) {
        expect({ gate: gate.key, script, defined: Boolean(pkg.scripts[script]) })
          .toEqual({ gate: gate.key, script, defined: true });
      }
    }
  });

  it('resolves every test file a gate invokes', () => {
    for (const gate of RELEASE_GATES) {
      const suites = [...gate.command.matchAll(/(tests\/[\w.-]+\.test\.ts)/g)].map((m) => m[1]);
      for (const suite of suites) {
        expect({ gate: gate.key, suite, exists: fs.existsSync(path.join(REPO_ROOT, suite)) })
          .toEqual({ gate: gate.key, suite, exists: true });
      }
    }
  });

  it('keeps the blocking list short, on purpose', () => {
    // A gate that blocks for something a human would wave through teaches
    // people to wave things through, and then the gate that mattered gets
    // waved through too.
    expect(BLOCKING_GATES.length).toBeGreaterThan(5);
    expect(BLOCKING_GATES.length).toBeLessThan(RELEASE_GATES.length);
  });

  it('blocks on correctness, authorization and migration safety', () => {
    const blocking = BLOCKING_GATES.map((g) => g.key);
    for (const key of ['typecheck', 'authorization', 'migration-safety', 'no-secrets-in-logs', 'socket-contract']) {
      expect(blocking).toContain(key);
    }
  });

  it('does not block on documentation freshness', () => {
    // Stale docs mislead; they do not break a live client. Blocking on them
    // would put a doc regeneration between an incident fix and production.
    const advisory = RELEASE_GATES.filter((g) => g.severity === 'ADVISORY').map((g) => g.key);
    expect(advisory).toContain('docs-fresh');
  });

  it('every gate says what a failure means for a live client', () => {
    for (const gate of RELEASE_GATES) {
      expect(gate.failureMeans.length).toBeGreaterThan(30);
    }
  });

  it('the protected-contracts guard is a blocking gate', () => {
    // Providers are a live production dependency. This is the gate that stops a
    // rename reaching an installed base that cannot be corrected for weeks.
    const gate = RELEASE_GATES.find((g) => g.key === 'protected-contracts')!;
    expect(gate.severity).toBe('BLOCKING');
    expect(gate.failureMeans).toMatch(/installed base|Flutter/i);
  });

  it('states prohibitions that no script can check', () => {
    expect(RELEASE_PROHIBITIONS.length).toBeGreaterThan(3);
    for (const prohibition of RELEASE_PROHIBITIONS) {
      expect(prohibition.rule.length).toBeGreaterThan(30);
      expect(prohibition.exception.length).toBeGreaterThan(10);
    }
    const rules = RELEASE_PROHIBITIONS.map((p) => p.rule).join(' ');
    expect(rules).toMatch(/No legacy route is removed in the same release/);
    expect(rules).toMatch(/No migration is applied by hand/);
  });

  it('verify itself runs the doc checks the gates depend on', () => {
    const verify = String(pkg.scripts.verify);
    for (const script of ['api:docs:check', 'convergence:docs:check', 'safety:docs:check', 'test:ci']) {
      expect(verify).toContain(script);
    }
  });
});

// ─── The documents ────────────────────────────────────────────────────────────

describe('the committed safety documents are the generated ones', () => {
  it('are not stale — run "npm run safety:docs" if this fails', () => {
    expect(staleFiles()).toEqual([]);
  });

  it('generates exactly the four the command names', () => {
    expect(generateAll().map((f) => f.relPath)).toEqual([
      'docs/api/OBSERVABILITY_STANDARD.md',
      'docs/api/SECURITY_AUTHZ_MATRIX.md',
      'docs/api/API_CONTRACT_CI.md',
      'docs/api/RELEASE_GATE_CHECKLIST.md',
    ]);
  });

  it('reports no drift between the authz matrix and the router', () => {
    expect(safetyDrift()).toEqual([]);
  });

  it('all four carry the do-not-edit header', () => {
    for (const file of generateAll()) {
      expect(read(file.relPath)).toContain('GENERATED FILE');
    }
  });
});

describe('the observability standard states what the code does', () => {
  const doc = read('docs/api/OBSERVABILITY_STANDARD.md');

  it('publishes every metric with its labels and its reason', () => {
    for (const metric of METRICS) {
      expect(doc).toContain(`\`${metric.name}\``);
      expect(doc).toContain(metric.why);
    }
  });

  it('publishes every P0 alert with a first action', () => {
    for (const alert of P0_ALERTS) {
      expect(doc).toContain(alert.name);
      expect(doc).toContain(alert.firstAction);
    }
  });

  it('shows the redactor OUTPUT, produced by running it', () => {
    /**
     * Evidence rather than description. The document contains what `redact()`
     * actually returned for a realistic payload, so a redactor that started
     * leaking would rewrite its own documentation and fail the staleness check.
     */
    // Scoped to the OUTPUT block. The document deliberately shows the input
    // alongside it — that is what makes the example legible — so a
    // whole-document search would be asserting the wrong thing.
    const output = doc.slice(doc.indexOf('Output:'), doc.indexOf('### A ROLE'));
    expect(output).toContain('"bookingId": 84213');
    expect(output).toContain('"serviceId": 180');
    for (const secret of ['dana@example.com', '14 Mabini Street', '482913', 'eyJhbGciOiJIUzI1NiJ9.abc']) {
      expect(output).not.toContain(secret);
    }
  });

  it('lists the safe entity keys from the declaration', () => {
    for (const key of SAFE_ENTITY_KEYS) expect(doc).toContain(`\`${key}\``);
  });

  it('says a role is logged and a uid is not', () => {
    expect(doc).toContain('A ROLE, never a person');
    expect(doc).toContain('There is no\nuid field');
  });

  it('explains the cardinality rule with a real template', () => {
    expect(doc).toContain('/api/v1/bookings/:id/timeline');
  });
});

describe('the authorization matrix describes every mounted endpoint', () => {
  const doc = read('docs/api/SECURITY_AUTHZ_MATRIX.md');
  const summary = matrixSummary();

  it('publishes the counts from the real contract', () => {
    expect(doc).toContain(`| Mounted endpoints | ${summary.endpoints} |`);
    expect(doc).toContain(`| Object-scoped | ${summary.objectScoped} |`);
    expect(doc).toContain(`| **Unguarded** | **${summary.unguarded}** |`);
  });

  it('carries a row for every ownership rule with its predicate', () => {
    for (const rule of OWNERSHIP_RULES) {
      expect(doc).toContain(rule.predicate);
      expect(doc).toContain(rule.enforcedBy);
    }
  });

  it('states the 401-is-not-proof rule prominently', () => {
    expect(doc).toContain('A 401 from global auth middleware must never be considered route proof');
    expect(doc).toContain('INCONCLUSIVE');
    expect(doc).toContain('is not a pass');
  });

  it('names every smoke account by its environment variable, never a value', () => {
    for (const account of SMOKE_ACCOUNTS) {
      expect(doc).toContain(account.credentialEnv);
    }
    // The document must not itself become a place a secret gets pasted.
    expect(doc).not.toMatch(/Bearer [A-Za-z0-9._-]{16,}/);
    expect(doc).not.toMatch(/eyJ[A-Za-z0-9._-]{20,}/);
  });

  it('explains why a refusal is a 404', () => {
    expect(doc).toContain('enumeration oracle');
    expect(doc).toContain('booking ids are small integers');
  });
});

describe('the contract CI document records the migration defect it fixed', () => {
  const doc = read('docs/api/API_CONTRACT_CI.md');

  it('states the transaction-stripper bug and its blast radius', () => {
    expect(doc).toContain('16 of the 36 migrations');
    expect(doc).toContain('ledger insert lands');
  });

  it('explains why the fix is in the stripper and not the files', () => {
    expect(doc).toContain('checksum');
    expect(doc).toContain('applied in\nproduction');
  });

  it('records the ownership outage that motivates the rule', () => {
    expect(doc).toContain('29 of 116 tables');
    expect(doc).toContain('bare 500');
  });

  it('states the no-removal rule and the reason there is no Sunset date', () => {
    expect(doc).toContain(NO_REMOVAL_RULE.whyNotADate);
    for (const evidence of NO_REMOVAL_RULE.evidence) expect(doc).toContain(evidence);
  });
});

describe('the checklist is runnable', () => {
  const doc = read('docs/api/RELEASE_GATE_CHECKLIST.md');

  it('carries a checkbox and a command for every gate', () => {
    for (const gate of RELEASE_GATES) {
      expect(doc).toContain(gate.title);
      expect(doc).toContain(gate.command);
    }
  });

  it('separates blocking from advisory', () => {
    expect(doc).toContain('## 1. Blocking — the deploy does not go out');
    expect(doc).toContain('## 2. Advisory');
  });

  it('says what the checklist cannot tell you', () => {
    /**
     * The honest paragraph. Every gate runs against this repository; none
     * observes production. A green checklist means the artifact is consistent,
     * not that the deploy worked.
     */
    expect(doc).toContain('## 5. What this checklist cannot tell you');
    expect(doc).toContain('not that the deploy succeeded');
  });

  it('tells the reader not to smoke against live records', () => {
    expect(doc).toContain('Do not run a production smoke against live records');
    expect(doc).toContain('treats a 401 as a FAILURE');
  });

  /**
   * The alert TAB 02's failure needed and nothing provided.
   *
   * On 2026-08-18 production answered 401 to every path, including ones that do
   * not exist, because authentication ran before routing. Nothing paged:
   * `api-error-rate` counts 5xx only, so a 401 storm is invisible to it, and
   * `auth-failure-spike` is relative to a 24h median — once the broken state
   * persists past a day it BECOMES the median and the alert falls silent while
   * production stays broken.
   *
   * So the condition is asserted to be ABSOLUTE. That is the property under
   * test, not merely the alert's existence: a relative threshold here would
   * reproduce the original silence.
   */
  it('pages on ANY public-path auth failure, absolutely rather than relatively', () => {
    const alert = ALERTS.find((a) => a.name === 'public-path-auth-failure');
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe('P0');
    expect(alert!.metric).toBe('public_path_auth_failures_total');

    // Absolute, not a baseline comparison. These are the words that would mean
    // it can go quiet while the invariant is still violated.
    expect(alert!.condition.toLowerCase()).toContain('any occurrence');
    for (const relative of ['median', 'baseline', '× the', 'compared to']) {
      expect(alert!.condition.toLowerCase()).not.toContain(relative.toLowerCase());
    }

    // The playbook must not send the responder to credentials, which is where
    // an auth-shaped alert naturally points and where the answer was not.
    expect(alert!.firstAction).toMatch(/router|routing/i);
  });

  it('declares the metric that alert fires on', () => {
    const metric = METRICS.find((m) => m.name === 'public_path_auth_failures_total');
    expect(metric).toBeDefined();
    // Anonymous by definition, so no client or uid label — and bounded labels
    // only, per the cardinality rule this file already enforces.
    expect(metric!.labels).toEqual(['route', 'namespace']);
  });
});
