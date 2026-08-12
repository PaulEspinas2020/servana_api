/**
 * The three provider surfaces return the SAME card.
 *
 * v1, Provider Web and legacy mobile share one formatter — that is the whole
 * reason the canonical state could be added in one place. This suite proves the
 * sharing is real at the response boundary rather than merely true of the
 * imports, because "they all import it" and "they all return what it produced"
 * are different claims, and only the second one is a contract.
 */

import fs from 'fs';
import path from 'path';

import { formatJobCard } from '../src/controllers/jobCardView';

const SRC = path.join(__dirname, '..', 'src');

const codeOf = (relative: string): string => fs
  .readFileSync(path.join(SRC, relative), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');

/**
 * The slice of a function's source between two anchors.
 *
 * The terminator is searched from AFTER the opening anchor. Searching from the
 * anchor's own start finds the anchor itself whenever one is a prefix of the
 * other — `export const getJobCardsByWorker` begins with `export const` — and
 * returns an empty slice that every `toContain` then fails against, which reads
 * as a missing column rather than a broken helper.
 */
const between = (code: string, from: string, to: string): string => {
  const start = code.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const end = code.indexOf(to, start + from.length);
  const slice = code.slice(start, end === -1 ? undefined : end);
  // A slice short enough to be an anchor collision is a helper fault, not a
  // finding about the code under test.
  expect(slice.length).toBeGreaterThan(from.length);
  return slice;
};

const row = (over: Record<string, unknown> = {}) => ({
  booking_id: 91,
  worker_uid: 'provider-1',
  status: 'WORKER_ASSIGNED',
  worker_status: 'EN_ROUTE',
  has_escalation: false,
  schedule: '2026-09-01T02:00:00.000Z',
  customer_id: 'cust-1',
  first_name: 'Maria',
  last_name: 'Santos',
  phone_number: '+639171234567',
  post_town: 'Makati',
  country: 'PH',
  ...over,
});

describe('the canonical fields reach every provider surface', () => {
  const CANONICAL_KEYS = ['canonicalState', 'stateLabel', 'nextAction', 'terminal'];

  it('the formatter emits them', () => {
    const card = formatJobCard(row());
    for (const key of CANONICAL_KEYS) expect(Object.keys(card)).toContain(key);
    expect(card.canonicalState).toBe('EN_ROUTE');
  });

  it('v1 returns the formatter output unmodified', () => {
    /**
     * `providerJobs.ts` maps the list and returns the single card directly. If
     * it ever picked fields instead, the canonical state would silently stop
     * reaching v1 clients while the formatter still produced it.
     */
    const code = codeOf('api/v1/domains/providerJobs.ts');
    expect(code).toContain('window.map(formatJobCard)');
    expect(code).toContain('formatJobCard(job)');
    // No field-picking between the formatter and the response.
    expect(code).not.toMatch(/formatJobCard\([^)]*\)\s*\.\s*[a-zA-Z]/);
  });

  it('Provider Web returns the formatter output unmodified', () => {
    const code = codeOf('controllers/providerController.ts');
    expect(code).toContain('jobs.map(formatJobCard)');
    expect(code).toContain('res.json(formatJobCard(job))');
  });

  it('legacy mobile returns the formatter output unmodified', () => {
    const code = codeOf('controllers/technicianController.ts');
    expect(code).toContain('jobs.map(formatJobCard)');
  });

  it('no surface strips a canonical field on the way out', () => {
    // A `delete card.canonicalState` or an explicit re-shape would defeat the
    // single-formatter design without failing anything else.
    for (const file of ['api/v1/domains/providerJobs.ts',
      'controllers/providerController.ts', 'controllers/technicianController.ts']) {
      const code = codeOf(file);
      for (const key of CANONICAL_KEYS) {
        expect(code).not.toContain(`delete ${key}`);
        expect(code).not.toContain(`.${key} = undefined`);
      }
    }
  });
});

describe('the job-card query supplies what the formatter needs', () => {
  const service = codeOf('services/technicianService.ts');

  it('selects has_escalation, or the card cannot report DISPUTED', () => {
    // Without it every card would derive `hasEscalation: false` and report a
    // non-disputed state for a booking Admin shows as DISPUTED — a divergence
    // introduced by the projection meant to remove them.
    const list = between(service, 'export const getJobCardsByWorker', 'export const');
    expect(list).toContain('has_escalation');
    expect(list).toContain('resolved_at IS NULL');
  });

  it('the single-card read shares the same query', () => {
    // getJobCardByWorker delegates, so it cannot drift from the list.
    expect(service).toContain('getJobCardsByWorker(workerId, bookingId)');
  });

  it('still selects the raw columns the legacy clients read', () => {
    const list = between(service, 'export const getJobCardsByWorker', 'export const');
    expect(list).toContain('b.status');
    expect(list).toContain('b.worker_uid');
  });
});

describe('the generated v1 documentation describes the new shape', () => {
  const spec = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'api', 'openapi.v1.json'), 'utf8',
  );

  it('the JobCard schema names the canonical fields', () => {
    // Generated from src/api/v1/openapi.ts, not hand-maintained — a second
    // hand-written provider contract would be a second source of truth.
    expect(spec).toContain('canonicalState');
    expect(spec).toContain('DEPRECATED');
  });

  it('the provider-jobs endpoints are still published', () => {
    expect(spec).toContain('/api/v1/provider/jobs');
    expect(spec).toContain('/api/v1/provider/jobs/{bookingId}');
  });
});
