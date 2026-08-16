/**
 * The reviews contract is DERIVED, and this is what keeps it that way.
 *
 * `docs/reviews/REVIEWS_V1_CONTRACT.md` is produced by EXECUTING `reviewPolicy`.
 * That is only worth anything if a declaration edit which is not followed by a
 * regenerate FAILS — otherwise it is a hand-written document with a
 * machine-generated header, which is worse than an honestly hand-written one
 * because it reads as authoritative.
 *
 * The dangerous tables here are ELIGIBILITY and VISIBILITY. A contract that says
 * a review needs only a completed booking, while the code also requires an
 * assignment and a window, is what a client team builds the wrong error screens
 * from — and a visibility table that drifts one row is a leak nobody notices from
 * reading either side.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));

import fs from 'fs';
import path from 'path';
import { staleFiles, generateAll } from '../scripts/generate-review-docs';
import {
  CANONICAL_DIMENSIONS,
  CANONICAL_SERVICE_RESOLUTION,
  CONTENT_LIMITS,
  DIMENSION_KEYS,
  ELIGIBILITY_REFUSALS,
  ELIGIBILITY_REFUSAL_CODES,
  FIELD_VISIBILITY,
  MIN_DIMENSION_SAMPLE,
  MODERATION_AUDIT,
  MODERATION_STATES,
  MODERATION_STATE_NAMES,
  NEVER_PROJECTED,
  REVIEW_EVENTS,
  REVIEW_SEATS,
  REVIEW_WINDOW_DAYS,
  SUPPORT_CASE_LIMITS,
  SUPPORT_CATEGORY_NAMES,
  evaluateEligibility,
  mayReadField,
} from '../src/services/reviews/reviewPolicy';
import { V1_CONTRACT, V1_PREFIX } from '../src/api/v1/contract';

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (relPath: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8').replace(/\r\n/g, '\n');

describe('the committed document is the generated one', () => {
  it('is not stale — run "npm run review:docs" if this fails', () => {
    expect(staleFiles()).toEqual([]);
  });

  it('generates exactly the file it claims to', () => {
    expect(generateAll().map((f) => f.relPath)).toEqual([
      'docs/reviews/REVIEWS_V1_CONTRACT.md',
    ]);
  });

  it('carries the do-not-edit header, so a hand edit is at least visible', () => {
    expect(read('docs/reviews/REVIEWS_V1_CONTRACT.md')).toContain('GENERATED FILE');
  });
});

describe('the contract states what the code decides', () => {
  const doc = read('docs/reviews/REVIEWS_V1_CONTRACT.md');

  it('renders the eligibility table from the REAL decision function', () => {
    // Each row is run output. Changing a refusal's status rewrites this table.
    const verdict = evaluateEligibility({
      isOwner: true,
      isActiveCustomer: true,
      hasCompletedProvider: true,
      bookingCompleted: false,
      completedAt: '2026-08-01T00:00:00.000Z',
      hasExistingReview: false,
      now: '2026-08-02T00:00:00.000Z',
    });
    expect(doc).toContain(`\`${verdict.refusal}\` | ${verdict.status} |`);
  });

  it('publishes every refusal code with its status and its kind', () => {
    for (const code of ELIGIBILITY_REFUSAL_CODES) {
      const spec = ELIGIBILITY_REFUSALS[code];
      const row = doc
        .split('\n')
        .find((line) => line.startsWith(`| \`${code}\` | ${spec.status} |`));
      expect(row).toBeDefined();
      expect(row).toContain(spec.terminal ? 'terminal' : 'retryable');
      expect(row).toContain(spec.reason);
    }
  });

  it('records that ownership is answered FIRST, with no window', () => {
    // The privacy property. A document that omits it invites a client team to
    // "improve" the error by distinguishing the cases.
    expect(doc).toContain('ownership is checked first');
    expect(doc).toContain('enumeration oracle');
  });

  it('states the review window in days from the declaration', () => {
    expect(doc).toContain(`closes **${REVIEW_WINDOW_DAYS} days** later`);
  });

  it('names the canonical service resolution and the forbidden one', () => {
    expect(doc).toContain(CANONICAL_SERVICE_RESOLUTION.helper);
    expect(doc).toContain(CANONICAL_SERVICE_RESOLUTION.resolvesTo);
    expect(doc).toContain(CANONICAL_SERVICE_RESOLUTION.forbidden);
  });

  it('records the Catalog V2 correction this tab made', () => {
    expect(doc).toContain('service_families');
    expect(doc).toContain('no schema change and no backfill');
  });

  it('states that the create payload has no provider field at all', () => {
    expect(doc).toContain('There is no `providerId` field on the create payload');
  });

  it('lists every dimension with its meaning and the content limits', () => {
    for (const key of DIMENSION_KEYS) {
      expect(doc).toContain(`| \`${key}\` | ${CANONICAL_DIMENSIONS[key]} |`);
    }
    expect(doc).toContain(`| \`publicComment\` | ${CONTENT_LIMITS.publicComment} |`);
    expect(doc).toContain(`| \`privateFeedback\` | ${CONTENT_LIMITS.privateFeedback} |`);
  });

  it('renders the visibility matrix by RUNNING mayReadField', () => {
    // Scoped to section 4: `privateFeedback` is also a row in the content-limits
    // table, and a whole-document row lookup finds that one first.
    const matrix = doc.slice(
      doc.indexOf('## 4. Who may read what'),
      doc.indexOf('## 5. Moderation'),
    );
    expect(matrix.length).toBeGreaterThan(0);

    for (const field of Object.keys(FIELD_VISIBILITY)) {
      const row = matrix.split('\n').find((line) => line.startsWith(`| \`${field}\` |`));
      expect(row).toBeDefined();
      const cells = row!.split('|').slice(2, 2 + REVIEW_SEATS.length).map((c) => c.trim());
      REVIEW_SEATS.forEach((seat, i) => {
        expect(cells[i]).toBe(mayReadField(field, seat) ? 'read' : '—');
      });
    }
  });

  it('names every field projected to nobody', () => {
    for (const field of NEVER_PROJECTED) {
      expect(doc).toContain(`\`${field}\``);
    }
    expect(doc).toContain('### Projected to nobody, including admin');
  });

  it('publishes every moderation state with its visibility and rating effect', () => {
    for (const state of MODERATION_STATE_NAMES) {
      const spec = MODERATION_STATES[state];
      const row = doc.split('\n').find((line) => line.startsWith(`| \`${state}\` |`));
      expect(row).toBeDefined();
      expect(row).toContain(spec.publiclyVisible ? 'visible' : 'hidden');
      expect(row).toContain(spec.countsToward ? 'counts' : 'excluded');
    }
  });

  it('states the hidden-and-counted invariant, which is the rating gate', () => {
    expect(doc).toContain('no state is hidden');
    expect(doc).toContain('and counted');
  });

  it('names the append-only moderation audit and what it records', () => {
    expect(doc).toContain(MODERATION_AUDIT.table);
    for (const record of MODERATION_AUDIT.records) {
      expect(doc).toContain(record);
    }
  });

  it('states that no endpoint accepts a rating', () => {
    expect(doc).toContain('No client computes an average, and no endpoint accepts one');
    expect(doc).toContain(`${MIN_DIMENSION_SAMPLE} samples`);
  });

  it('lists every support category and where it is routed', () => {
    for (const name of SUPPORT_CATEGORY_NAMES) {
      expect(doc).toContain(`| \`${name}\` |`);
    }
    expect(doc).toContain('`BILLING` is stored here and RESOLVED elsewhere');
    expect(doc).toContain(`| Open cases per booking | ${SUPPORT_CASE_LIMITS.maxOpenPerBooking} |`);
  });

  it('names the events published, and the one deliberately withheld', () => {
    for (const event of REVIEW_EVENTS) expect(doc).toContain(`\`${event}\``);
    expect(doc).toContain('`ReviewUpdated`');
    expect(doc).toContain('Deliberately not published');
  });

  it('lists every canonical review endpoint at its real path', () => {
    for (const entry of V1_CONTRACT.filter((e) => e.domain === 'reviews')) {
      expect(doc).toContain(`${entry.method.toUpperCase()} ${V1_PREFIX}${entry.path}`);
    }
  });

  it('states plainly where the shipped paths differ from the ones the command named', () => {
    // The command named /providers/:providerId/reviews. The shipped routes group
    // by domain. A contract that quietly used the command's wording would leave a
    // client team calling a route that does not exist.
    expect(doc).toContain('/providers/:providerId/reviews');
    expect(doc).toContain('SHIPPED in TAB 01');
  });

  it('names all five client surfaces and explains every role split', () => {
    for (const surface of [
      'Customer Mobile', 'Customer Web', 'Provider Mobile', 'Provider Web', 'Admin Web',
    ]) {
      expect(doc).toContain(surface);
    }
    expect(doc).toContain('### Why each capability is or is not role-split');
  });
});
