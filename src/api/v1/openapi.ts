/**
 * OpenAPI 3.1, generated from `V1_CONTRACT`.
 *
 * The document is not maintained. It is derived, then written to
 * `docs/api/openapi.v1.json` by `npm run api:docs`, and
 * `tests/v1-contract.test.ts` fails if the committed file differs from what the
 * contract produces. So the spec cannot describe a route that is not mounted,
 * and cannot omit one that is.
 *
 * ## Why the schemas are hand-written and the paths are not
 *
 * Paths, methods, auth, parameters and error codes all exist as data on the
 * contract entry, so generating them is mechanical and the generator is the
 * only thing that has to be right. Response BODY schemas do not exist as data —
 * they are the shape a domain service returns, and inferring them would mean
 * either a decorator framework this codebase does not use, or a runtime sample
 * that would document whatever happened to be in the database. They are
 * therefore written once, here, and pinned by name: `responseSchema` on the
 * contract must resolve to a schema in this file or the build fails, so a typo
 * cannot ship as an undocumented endpoint.
 */

import { V1_CONTRACT, ContractEntry, IMPLEMENTED, V1_PREFIX } from './contract';
import { V1_ERROR_STATUS, V1ErrorCode } from './errors';

const ERROR_RESPONSE_REF = { $ref: '#/components/schemas/Error' };

/** Response DTOs. Every `responseSchema`/`requestSchema` name must be a key here. */
export const SCHEMAS: Record<string, unknown> = {
  Error: {
    type: 'object',
    required: ['error'],
    additionalProperties: false,
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message', 'requestId'],
        properties: {
          // Sorted, so the generated document is byte-stable regardless of the
          // order codes were declared in — a spec whose diff churns on an
          // unrelated edit is a spec nobody reviews.
          code: { type: 'string', enum: Object.keys(V1_ERROR_STATUS).sort() },
          message: { type: 'string', description: 'Human-readable. Never branch on this — branch on `code`.' },
          details: { description: 'Optional structured context. Shape depends on `code`.' },
          requestId: { type: 'string', description: 'Also returned as the X-Request-Id header.' },
        },
      },
    },
  },

  PageMeta: {
    type: 'object',
    required: ['limit', 'offset', 'total', 'hasMore'],
    properties: {
      limit: { type: 'integer' },
      offset: { type: 'integer' },
      total: { type: ['integer', 'null'], description: 'null when the total is not cheaply knowable.' },
      hasMore: { type: 'boolean' },
    },
  },

  CatalogSummary: {
    type: 'object',
    properties: {
      categories: { type: 'integer' },
      subcategories: { type: 'integer' },
      services: { type: 'integer' },
      lastUpdatedAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description: 'ISO 8601 with a UTC designator. Never Postgres\' native "2026-08-11 11:03:23.421016+00".',
      },
    },
  },

  CatalogService: {
    type: 'object',
    required: ['id', 'name'],
    properties: {
      id: { type: 'integer', description: 'Canonical services.id — THE bookable identity.' },
      subcategoryId: { type: 'integer' },
      name: { type: 'string' },
      slug: { type: 'string' },
      shortDescription: { type: ['string', 'null'] },
      imageUrl: { type: ['string', 'null'] },
      status: { type: 'string' },
      bookable: { type: 'boolean' },
      basePrice: { type: ['number', 'null'] },
      unit: { type: ['string', 'null'] },
      estimatedDurationMins: { type: ['integer', 'null'] },
    },
    description:
      'Never carries `level2`/`level_2`. In the legacy model those mean the SUBCATEGORY; ' +
      'response parity used to map `name` onto them, which made a Service claim its own ' +
      'name as its subcategory. /api/v1 is exempt from that middleware.',
  },

  CatalogSubcategory: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      categoryId: { type: 'integer' },
      name: { type: 'string' },
      slug: { type: 'string', description: 'Unique PER CATEGORY, not globally.' },
      services: { type: 'array', items: { $ref: '#/components/schemas/CatalogService' } },
    },
  },

  CatalogCategory: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      name: { type: 'string' },
      slug: { type: 'string', description: 'Globally unique.' },
      subcategories: { type: 'array', items: { $ref: '#/components/schemas/CatalogSubcategory' } },
    },
  },

  CatalogTree: {
    type: 'object',
    required: ['categories'],
    properties: {
      categories: { type: 'array', items: { $ref: '#/components/schemas/CatalogCategory' } },
    },
  },

  CatalogServiceList: {
    type: 'object',
    required: ['services'],
    properties: {
      services: { type: 'array', items: { $ref: '#/components/schemas/CatalogService' } },
    },
  },

  CatalogServiceDetail: {
    allOf: [
      { $ref: '#/components/schemas/CatalogService' },
      {
        type: 'object',
        properties: {
          fullDescription: { type: ['string', 'null'] },
          inclusions: { type: 'array', items: { type: 'string' } },
          exclusions: { type: 'array', items: { type: 'string' } },
          addons: { type: 'array', items: { type: 'object' } },
          available: {
            type: 'boolean',
            description:
              'Folds in subcategory and category status. Detail is NOT status-filtered, so an ' +
              'archived deep link resolves to an honest "unavailable" rather than a 404.',
          },
        },
      },
    ],
  },

  Identity: {
    type: 'object',
    required: ['uid'],
    properties: {
      id: { type: 'string', description: 'Same value as uid. Present for clients that key on `id`.' },
      uid: { type: 'string', description: 'The Firebase uid. THE primary key — there is no numeric user id.' },
      email: { type: ['string', 'null'] },
      firstName: { type: ['string', 'null'] },
      lastName: { type: ['string', 'null'] },
      role: { description: '1 admin, 2 and 4 provider, 3 customer. See servana_role_map.' },
      isEmailVerified: { type: ['boolean', 'null'] },
      phoneNumber: { type: ['string', 'null'] },
    },
  },

  Booking: { type: 'object', description: 'A booking as produced by bookingService.formatBooking.' },

  BookingList: {
    type: 'object',
    required: ['bookings'],
    properties: { bookings: { type: 'array', items: { $ref: '#/components/schemas/Booking' } } },
  },

  BookingTimeline: {
    type: 'object',
    required: ['timeline'],
    properties: { timeline: { type: 'array', items: { type: 'object' } } },
    description: 'Operational history, voiced for the customer. Not the audit record (§16).',
  },

  JobCard: { type: 'object', description: 'A job card as produced by controllers/jobCardView.formatJobCard.' },

  JobCardList: {
    type: 'object',
    required: ['jobs'],
    properties: { jobs: { type: 'array', items: { $ref: '#/components/schemas/JobCard' } } },
  },

  NotificationList: {
    type: 'object',
    required: ['notifications'],
    properties: { notifications: { type: 'array', items: { type: 'object' } } },
  },

  UnreadCount: {
    type: 'object',
    required: ['count'],
    properties: { count: { type: 'integer' } },
  },

  NotificationMutation: { type: 'object', description: 'Outcome flags from the notification service.' },

  ProviderReviewList: {
    type: 'object',
    required: ['reviews'],
    properties: { reviews: { type: 'array', items: { type: 'object' } } },
    description: 'No customer identity is projected (§58).',
  },

  ProviderRating: {
    type: 'object',
    properties: { providerUid: { type: 'string' }, average: { type: ['number', 'null'] }, count: { type: 'integer' } },
  },

  NotificationPreferences: { type: 'object', additionalProperties: true, description: 'Per-channel preference flags, keyed by uid.' },

  // ── Planned. Documented so the migration matrix can name a successor. ──────
  Session: { type: 'object', description: 'PLANNED — owned by the auth domain command.' },
  SearchResults: { type: 'object', description: 'PLANNED — no backend search exists today.' },
  HomeFeed: { type: 'object', description: 'PLANNED — composed client-side today.' },
  ConversationList: { type: 'object', description: 'PLANNED — owned by the messaging domain command.' },
  EarningsSummary: { type: 'object', description: 'PLANNED — owned by the provider-earnings domain command.' },
  AdminBookingList: { type: 'object', description: 'PLANNED — owned by the admin-bookings domain command.' },
};

const AUTH_DEFAULT_ERRORS: Record<ContractEntry['auth'], V1ErrorCode[]> = {
  public: [],
  authenticated: ['UNAUTHENTICATED', 'TOKEN_EXPIRED', 'TOKEN_REVOKED'],
  provider: ['UNAUTHENTICATED', 'TOKEN_EXPIRED', 'TOKEN_REVOKED', 'PROVIDER_ROLE_REQUIRED'],
  admin: ['UNAUTHENTICATED', 'TOKEN_EXPIRED', 'TOKEN_REVOKED', 'ROLE_REQUIRED'],
};

/** Every failure an endpoint can produce: its own, plus the ones its auth mode implies. */
export const allErrorsFor = (entry: ContractEntry): V1ErrorCode[] => {
  const set = new Set<V1ErrorCode>([...AUTH_DEFAULT_ERRORS[entry.auth], ...entry.errors, 'INTERNAL']);
  return [...set].sort();
};

/** `/catalog/services/:serviceId` → `/catalog/services/{serviceId}` */
const toOpenApiPath = (path: string): string =>
  path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const entry of V1_CONTRACT) {
    const key = `${V1_PREFIX}${toOpenApiPath(entry.path)}`;
    paths[key] = paths[key] ?? {};

    const responses: Record<string, unknown> = {
      '200': {
        description: 'Success.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['data'],
              properties: {
                data: { $ref: `#/components/schemas/${entry.responseSchema}` },
                meta: {
                  type: 'object',
                  properties: { page: { $ref: '#/components/schemas/PageMeta' } },
                  additionalProperties: true,
                },
              },
            },
          },
        },
      },
    };

    // One response entry per HTTP status the endpoint's error codes can produce,
    // each naming the codes that map to it. Two codes sharing a status is
    // normal — a client branches on the code, not the status.
    const byStatus = new Map<number, V1ErrorCode[]>();
    for (const code of allErrorsFor(entry)) {
      const httpStatus = V1_ERROR_STATUS[code];
      byStatus.set(httpStatus, [...(byStatus.get(httpStatus) ?? []), code]);
    }
    for (const [httpStatus, codes] of [...byStatus.entries()].sort((a, b) => a[0] - b[0])) {
      responses[String(httpStatus)] = {
        description: codes.join(' | '),
        content: { 'application/json': { schema: ERROR_RESPONSE_REF } },
      };
    }

    const parameters = [
      ...(entry.params ?? []).map((p) => ({
        name: p.name,
        in: 'path',
        required: true,
        schema: { type: p.type },
        description: p.description,
      })),
      ...(entry.query ?? []).map((q) => ({
        name: q.name,
        in: 'query',
        required: q.required,
        schema: { type: q.type },
        description: q.description,
      })),
    ];

    paths[key][entry.method] = {
      operationId: entry.id,
      summary: entry.summary,
      tags: [entry.domain],
      ...(entry.status === 'planned' ? { deprecated: false, 'x-status': 'planned' } : {}),
      'x-implemented': entry.status === 'implemented',
      'x-idempotent': entry.idempotent,
      'x-domain-service': entry.domainService,
      'x-legacy': entry.legacy.map((l) => ({
        method: l.method.toUpperCase(),
        path: l.path,
        disposition: l.disposition,
      })),
      'x-callers': entry.callers,
      'x-observability-owner': entry.observability,
      ...(entry.auth === 'public' ? { security: [] } : { security: [{ firebaseIdToken: [] }] }),
      ...(parameters.length ? { parameters } : {}),
      ...(entry.requestSchema
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: { $ref: `#/components/schemas/${entry.requestSchema}` } },
              },
            },
          }
        : {}),
      responses,
      ...(entry.notes ? { description: entry.notes } : {}),
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Servana API — canonical v1',
      version: '1.0.0',
      description:
        'The canonical Servana contract. Generated from src/api/v1/contract.ts — do not edit by hand; ' +
        '`npm run api:docs` rewrites it and the contract test fails if it drifts.\n\n' +
        'Operations marked `x-implemented: false` are DOCUMENTED BUT NOT MOUNTED. They exist so the ' +
        'legacy migration matrix can name a canonical successor before it is built, and they will 404.\n\n' +
        'Routes under /api/v1 are exempt from the cross-platform field-parity middleware that rewrites ' +
        'every other response, so the shapes below are exactly what the wire carries.',
    },
    servers: [
      { url: 'https://servana.com.ph', description: 'Production' },
      { url: 'http://localhost:8000', description: 'Local' },
    ],
    paths,
    components: {
      securitySchemes: {
        firebaseIdToken: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'Firebase ID token',
          description:
            'Verified signature AND revocation state — a token issued before a session revocation is ' +
            'rejected with TOKEN_REVOKED, not accepted until expiry.',
        },
      },
      schemas: SCHEMAS,
    },
    tags: [...new Set(V1_CONTRACT.map((e) => e.domain))].sort().map((name) => ({ name })),
    'x-generated-from': 'src/api/v1/contract.ts',
    'x-implemented-count': IMPLEMENTED.length,
    'x-total-count': V1_CONTRACT.length,
  };
}
