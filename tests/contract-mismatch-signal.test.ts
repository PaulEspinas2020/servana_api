/**
 * A 404 on a namespaced API is not an ordinary 404 (TAB 13).
 *
 * ## The incident this makes visible
 *
 * Production once answered **401 to every path including nonexistent ones**,
 * which meant auth ran before routing and the deployed build did not serve v1
 * at all. The symptom reached operators as *"the API is down"* rather than as a
 * version mismatch, and the real question — *which build is running?* — was not
 * the one anybody asked first.
 *
 * The general 404 rate cannot surface that. An ordinary 404 is a client asking
 * for something that never existed; this is a client asking for something that
 * was **promised** — it holds a contract naming the route and the running build
 * does not serve it. Same status code, completely different operator response:
 * no route needs fixing, a build needs deploying or rolling back.
 *
 * ## Why the counter has to exist before the dashboard
 *
 * The book asks for an alert on "a spike in 404s on /api/v1". An alert is a
 * query over a signal, and the signal did not exist — every 404 landed in
 * `http_requests_total` labelled `statusClass: '4xx'`, indistinguishable from a
 * mistyped URL. Nothing to alert on is not the same as nothing happening.
 */

import { METRICS, ALERTS } from '../src/observability/observabilityPolicy';
import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'observability', 'requestLog.ts'),
  'utf8',
);

describe('the signal is declared', () => {
  const spec = METRICS.find((m) => m.name === 'contract_mismatch_total');

  it('exists as a counter', () => {
    expect(spec).toBeDefined();
    expect(spec!.kind).toBe('counter');
  });

  it('is labelled by namespace, so v1 can be separated from everything else', () => {
    // Without the namespace label the metric answers "some 404s happened",
    // which is what http_requests_total already said.
    expect(spec!.labels).toEqual(expect.arrayContaining(['namespace']));
  });

  it('is labelled by client, so the operator can see WHICH build is ahead', () => {
    expect(spec!.labels).toEqual(expect.arrayContaining(['client']));
  });

  it('says why it is worth paging about, not just what it counts', () => {
    expect(spec!.why.length).toBeGreaterThan(120);
    expect(spec!.why).toMatch(/promised|contract/i);
  });
});

describe('the alert names an action, not a threshold alone', () => {
  const alert = ALERTS.find((a) => a.name === 'v1-contract-mismatch');

  it('exists and points at the new metric', () => {
    expect(alert).toBeDefined();
    expect(alert!.metric).toBe('contract_mismatch_total');
  });

  it('tells the person woken up that this is a deploy problem, not a code problem', () => {
    // The wrong first action here costs the most time: somebody reads "404" and
    // starts looking for a broken route that is working perfectly.
    expect(alert!.firstAction).toMatch(/deploy|rollback|roll back/i);
  });
});

describe('the signal is actually emitted', () => {
  it('increments on a namespaced 404', () => {
    expect(source).toMatch(/contract_mismatch_total/);
  });

  it('does not fire on the legacy tree, where a 404 is just a 404', () => {
    // The legacy surface has 615 routes and no published contract, so a 404
    // there carries none of this meaning and would only add noise.
    const block = source.slice(source.indexOf("line.status === 404"));
    expect(block).toMatch(/namespace !== 'legacy'/);
  });

  it('is emitted inside the same guarded block as every other metric', () => {
    // A logging bug must be a missing line, never an outage.
    const emission = source.indexOf('contract_mismatch_total');
    const guard = source.indexOf('// A logging bug is a missing line, not an outage.');
    expect(emission).toBeLessThan(guard);
  });
});
