/**
 * Does the code agree with the declaration?
 *
 * `reviewPolicy` is only worth writing if the services actually follow it. A
 * declaration nobody consults is documentation with a `.ts` extension, and it
 * drifts in exactly the way a markdown file would — except it also LOOKS
 * authoritative to the next person, and to the generated contract.
 *
 * So each test here pairs one declaration with the place that enforces it.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));

import fs from 'fs';
import path from 'path';
import {
  DIMENSION_KEYS,
  MIN_DIMENSION_SAMPLE,
  MODERATION_STATE_NAMES,
  SUPPORT_CASE_LIMITS,
  SUPPORT_CATEGORY_NAMES,
  countsTowardRating,
  routeForCategory,
} from '../src/services/reviews/reviewPolicy';
import {
  MIN_DIMENSION_SAMPLE as AGGREGATE_SAMPLE,
  isAggregateContributor,
} from '../src/services/ratingAggregationService';
import { V1_CONTRACT, V1_PREFIX } from '../src/api/v1/contract';
import { V1_ERROR_STATUS } from '../src/api/v1/errors';

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

// ─── The declaration has no database ──────────────────────────────────────────

describe('the policy is a declaration, not a service', () => {
  const policy = read('src/services/reviews/reviewPolicy.ts');

  it('imports nothing with a database handle', () => {
    // The moment it does, the generated contract stops being executable without
    // a database and the docs check becomes an integration test.
    expect(policy).not.toMatch(/from '.*dbQuery'/);
    expect(policy).not.toMatch(/from '.*config'/);
    expect(policy).not.toMatch(/^import .* from 'pg'/m);
  });

  it('declares no event catalog of its own', () => {
    // TAB 09 owns the registry. A second one for reviews is the duplication that
    // tab exists to prevent.
    expect(policy).toMatch(/NOT redeclared here/);
    expect(policy).not.toMatch(/payload:\s*\{/);
  });
});

// ─── Dimensions ───────────────────────────────────────────────────────────────

describe('the dimension vocabulary is one vocabulary', () => {
  it('the service accepts exactly the declared keys', () => {
    const source = read('src/services/customerReviewService.ts');
    const block = source.slice(
      source.indexOf('const VALID_DIMENSIONS'),
      source.indexOf('// ─── Lazy table init'),
    );
    for (const key of DIMENSION_KEYS) {
      expect(block).toContain(`'${key}'`);
    }
    // ...and nothing else. A key the service accepts but the contract does not
    // publish is a dimension a client can write and no client can render.
    const accepted = block.match(/'[A-Z_]+'/g) ?? [];
    expect(new Set(accepted.map((k) => k.replace(/'/g, '')))).toEqual(new Set(DIMENSION_KEYS));
  });
});

// ─── Moderation ↔ aggregate ───────────────────────────────────────────────────

describe('the aggregate counts what the policy says counts', () => {
  it('agrees state by state with isAggregateContributor', () => {
    // Two files deciding the same thing separately is how a hidden review keeps
    // moving the average. This asserts they cannot disagree silently.
    for (const state of MODERATION_STATE_NAMES) {
      expect(isAggregateContributor('PUBLISHED', state)).toBe(countsTowardRating(state));
    }
  });

  it('excludes an unpublished review whatever its moderation state', () => {
    // A soft-deleted or draft review is not a public statement, so it is not a
    // rating input even when moderation approved it.
    for (const state of MODERATION_STATE_NAMES) {
      expect(isAggregateContributor('DELETED', state)).toBe(false);
    }
  });

  it('uses one sample floor, not two', () => {
    expect(AGGREGATE_SAMPLE).toBe(MIN_DIMENSION_SAMPLE);
  });
});

// ─── Support routing ──────────────────────────────────────────────────────────

describe('support routing is declared once and consulted', () => {
  it('the service asks routeForCategory rather than branching on a name', () => {
    const source = read('src/services/reviews/postServiceSupportService.ts');
    expect(source).toMatch(/routeForCategory\(category\)/);
    // A hard-coded `category === 'BILLING'` here would be a second place to
    // update when a category is added.
    expect(source).not.toMatch(/=== 'BILLING'/);
  });

  it('every declared category routes somewhere', () => {
    for (const name of SUPPORT_CATEGORY_NAMES) {
      expect(['support', 'finance']).toContain(routeForCategory(name));
    }
  });

  it('an unknown category routes nowhere, so the caller must be refused', () => {
    expect(routeForCategory('WHATEVER')).toBeNull();
  });

  it('the migration and the lazy DDL declare the same table', () => {
    const migration = read('scripts/migrations/035-post-service-support.sql');
    const service = read('src/services/reviews/postServiceSupportService.ts');
    for (const column of [
      'booking_id', 'customer_uid', 'provider_uid', 'category',
      'severity', 'routed_to', 'state', 'summary', 'detail', 'client_request_id',
    ]) {
      expect(migration).toContain(column);
      expect(service).toContain(column);
    }
    // The partial unique index is the idempotency guarantee; a migration that
    // omitted it would leave a deployed database without one.
    expect(migration).toMatch(/uq_booking_support_cases_request/);
    expect(service).toMatch(/uq_booking_support_cases_request/);
    expect(migration).toMatch(/WHERE client_request_id IS NOT NULL/);
  });

  it('the ceiling is read from the declaration, not typed into the SQL', () => {
    const service = read('src/services/reviews/postServiceSupportService.ts');
    expect(service).toMatch(/SUPPORT_CASE_LIMITS\.maxOpenPerBooking/);
    expect(SUPPORT_CASE_LIMITS.maxOpenPerBooking).toBeGreaterThan(0);
  });
});

// ─── Contract wiring ──────────────────────────────────────────────────────────

describe('the canonical entries are wired', () => {
  const entries = V1_CONTRACT.filter((e) => e.domain === 'reviews');

  it('registers six review endpoints', () => {
    expect(entries).toHaveLength(6);
  });

  it('every one names a handler that exists', () => {
    const handlers = read('src/api/v1/domains/reviews.ts');
    for (const entry of entries) {
      expect(handlers).toContain(`'${entry.id}'`);
    }
  });

  it('kept the two routes TAB 01 shipped, untouched', () => {
    // Providers are a live production dependency. Renaming or dropping these
    // would break a surface that already calls them.
    const ids = entries.map((e) => e.id);
    expect(ids).toContain('reviews.provider.list');
    expect(ids).toContain('reviews.provider.rating');
    expect(entries.find((e) => e.id === 'reviews.provider.list')!.path)
      .toBe('/reviews/providers/:providerUid');
  });

  it('the booking-scoped writes require authentication', () => {
    for (const id of [
      'bookings.review.create', 'bookings.review.get',
      'bookings.supportCases.create', 'bookings.supportCases.list',
    ]) {
      expect(entries.find((e) => e.id === id)!.auth).not.toBe('public');
    }
  });

  it('the provider reads stay public, because a rating is a public fact', () => {
    for (const id of ['reviews.provider.list', 'reviews.provider.rating']) {
      expect(entries.find((e) => e.id === id)!.auth).toBe('public');
    }
  });

  it('every refusal code the handlers translate to is a real v1 code', () => {
    const handlers = read('src/api/v1/domains/reviews.ts');
    const map = handlers.slice(
      handlers.indexOf('const CODE: Record<string, V1ErrorCode>'),
      handlers.indexOf('const asApiError'),
    );
    const targets = [...map.matchAll(/:\s*'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(5);
    for (const code of targets) {
      expect(V1_ERROR_STATUS).toHaveProperty(code);
    }
  });

  it('the new error codes carry the statuses the domain raises', () => {
    expect(V1_ERROR_STATUS.REVIEW_FORBIDDEN).toBe(403);
    expect(V1_ERROR_STATUS.REVIEW_NOT_ELIGIBLE).toBe(422);
    expect(V1_ERROR_STATUS.REVIEW_ALREADY_EXISTS).toBe(409);
    expect(V1_ERROR_STATUS.REVIEW_NOT_FOUND).toBe(404);
    expect(V1_ERROR_STATUS.SUPPORT_BOOKING_NOT_ELIGIBLE).toBe(422);
    expect(V1_ERROR_STATUS.SUPPORT_CASE_LIMIT_REACHED).toBe(409);
  });

  it('every legacy alias names a route this repository actually mounts', () => {
    // A phantom path in the migration matrix puts a route nobody serves on the
    // telemetry watch list, and it reads as "already migrated" forever.
    const routeFiles = fs
      .readdirSync(path.join(REPO_ROOT, 'src/routes'))
      .map((f) => read(path.join('src/routes', f)))
      .join('\n');
    const appFile = read('src/app.ts');

    for (const entry of entries) {
      for (const legacy of entry.legacy) {
        const tail = legacy.path.split('/').filter(Boolean).slice(-1)[0].replace(/^:/, '');
        expect(`${routeFiles}\n${appFile}`).toContain(tail);
      }
    }
  });

  it('the handlers do not re-decide authorization the service already decided', () => {
    // A transport layer that can reach a different conclusion from its domain
    // service is a second implementation of the rule, and the two drift.
    const handlers = read('src/api/v1/domains/reviews.ts');
    const body = handlers.slice(handlers.indexOf('export const handlers'));
    // No SQL, no database handle, no ownership column read by name. The only
    // thing the handler resolves itself is the caller's uid from the token and
    // the booking id from the path — both inputs to the service, not decisions.
    expect(body).not.toMatch(/\bSELECT\b|\bINSERT\b|\bUPDATE\b/);
    expect(body).not.toMatch(/user_id|customer_uid|worker_uid/);
    expect(handlers).not.toMatch(/from '.*dbQuery'/);
  });

  it('every canonical path sits under the v1 prefix', () => {
    for (const entry of entries) {
      expect(entry.path.startsWith('/')).toBe(true);
      expect(`${V1_PREFIX}${entry.path}`).toMatch(/^\/api\/v1\//);
    }
  });
});
