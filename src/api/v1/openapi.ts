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

  CatalogRef: {
    type: 'string',
    pattern: '^(category|subcategory|service|addon):[0-9]+$',
    description:
      'Qualified canonical reference, e.g. `service:180`. Four different things in this platform ' +
      'are called a "service id" — services.id, service_families.id, service_options.id and a ' +
      'subcategory id — and three are integers in overlapping ranges. A ref cannot be read as the ' +
      'wrong one. Prefer it as a cache key and for cross-entity result sets; `id` remains ' +
      'authoritative for path parameters.',
  },

  CatalogService: {
    type: 'object',
    required: ['ref', 'id', 'name'],
    properties: {
      ref: { $ref: '#/components/schemas/CatalogRef' },
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
      ref: { $ref: '#/components/schemas/CatalogRef' },
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
      ref: { $ref: '#/components/schemas/CatalogRef' },
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

  CategorySummary: {
    type: 'object',
    required: ['ref', 'id', 'name'],
    properties: {
      ref: { $ref: '#/components/schemas/CatalogRef' },
      id: { type: 'integer', description: 'Canonical catalog_categories.id.' },
      name: { type: 'string' },
      slug: { type: 'string', description: 'Globally unique.' },
      description: { type: ['string', 'null'] },
      imageUrl: { type: ['string', 'null'] },
      displayOrder: { type: 'integer' },
      subcategoryCount: { type: 'integer' },
      serviceCount: { type: 'integer' },
    },
    description: 'No nested children. Use /catalog/categories/{id}/subcategories for the next level.',
  },

  CategorySummaryList: {
    type: 'object',
    required: ['categories'],
    properties: { categories: { type: 'array', items: { $ref: '#/components/schemas/CategorySummary' } } },
  },

  CategoryDetail: {
    allOf: [
      { $ref: '#/components/schemas/CategorySummary' },
      {
        type: 'object',
        properties: {
          available: {
            type: 'boolean',
            description: 'Detail is NOT status-filtered, so a deep link to a deactivated Category resolves honestly.',
          },
        },
      },
    ],
  },

  SubcategorySummary: {
    type: 'object',
    required: ['ref', 'id', 'name'],
    properties: {
      ref: { $ref: '#/components/schemas/CatalogRef' },
      id: { type: 'integer', description: 'Canonical catalog_subcategories.id.' },
      categoryId: { type: 'integer' },
      categoryName: { type: 'string' },
      name: { type: 'string' },
      slug: { type: 'string', description: 'Unique PER CATEGORY, not globally.' },
      description: { type: ['string', 'null'] },
      imageUrl: { type: ['string', 'null'] },
      displayOrder: { type: 'integer' },
      serviceCount: { type: 'integer' },
    },
  },

  SubcategorySummaryList: {
    type: 'object',
    required: ['subcategories'],
    properties: { subcategories: { type: 'array', items: { $ref: '#/components/schemas/SubcategorySummary' } } },
  },

  SubcategoryDetail: {
    allOf: [
      { $ref: '#/components/schemas/SubcategorySummary' },
      {
        type: 'object',
        properties: {
          available: { type: 'boolean', description: 'Folds in the parent Category status.' },
        },
      },
    ],
  },

  SearchHit: {
    type: 'object',
    required: ['ref', 'type', 'id', 'name', 'score'],
    properties: {
      ref: { $ref: '#/components/schemas/CatalogRef' },
      type: { type: 'string', enum: ['category', 'subcategory', 'service'] },
      id: { type: 'integer', description: 'Canonical id WITHIN its type. Read `ref` to key across types.' },
      name: { type: 'string' },
      slug: { type: 'string' },
      context: { type: ['string', 'null'], description: 'Parent path, e.g. "Personal Care > Facial".' },
      imageUrl: { type: ['string', 'null'] },
      bookable: { type: ['boolean', 'null'], description: 'Services only. A Category cannot be booked.' },
      status: { type: 'string' },
      displayOrder: { type: 'integer' },
      basePrice: { type: ['number', 'null'] },
      categoryId: { type: ['integer', 'null'] },
      subcategoryId: { type: ['integer', 'null'] },
      score: { type: 'integer', description: '4 exact, 3 name-prefix, 2 word-prefix, 1 contains.' },
      matchedTerm: { type: 'string', description: 'The query, or the alias that widened it. Makes a surprising hit explainable.' },
    },
  },

  SearchResults: {
    type: 'object',
    required: ['query', 'hits', 'total'],
    properties: {
      query: { type: 'string' },
      expandedTerms: {
        type: 'array',
        items: { type: 'string' },
        description: 'Every term the query was widened to via the alias table.',
      },
      total: { type: 'integer', description: 'Total matches before the limit.' },
      hits: { type: 'array', items: { $ref: '#/components/schemas/SearchHit' } },
      counts: {
        type: 'object',
        properties: {
          category: { type: 'integer' },
          subcategory: { type: 'integer' },
          service: { type: 'integer' },
        },
      },
    },
    description:
      'Aliases widen what a term MATCHES, never what exists. "aircon" and "air conditioning" ' +
      'return the same Services with the same ids.',
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

  // ── Auth and identity ─────────────────────────────────────────────────────

  Session: {
    type: 'object',
    required: ['token', 'uid', 'identifierType'],
    properties: {
      token: { type: 'string', description: 'Firebase ID token. Lives ONE HOUR — refresh before it expires.' },
      refreshToken: {
        type: ['string', 'null'],
        description:
          'Long-lived. Belongs in secure device storage, never a log or a query string. ' +
          'Exchange it at POST /api/v1/auth/refresh.',
      },
      uid: { type: 'string', description: 'The Firebase uid. THE primary key — there is no numeric user id.' },
      email: { type: ['string', 'null'] },
      role: { type: ['integer', 'null'], description: '1 admin, 2 and 4 provider, 3 customer.' },
      firstName: { type: ['string', 'null'] },
      lastName: { type: ['string', 'null'] },
      isEmailVerified: { type: 'boolean' },
      identifierType: {
        type: 'string',
        enum: ['email', 'mobile', 'token'],
        description: 'Which identifier the caller actually presented.',
      },
    },
  },

  LoginRequest: {
    type: 'object',
    additionalProperties: false,
    properties: {
      identifier: {
        type: 'string',
        description:
          'Email address OR Philippine mobile number, in any form a person types ' +
          '(0917…, +63917…, 9171234567). Required with `password`.',
      },
      password: { type: 'string' },
      idToken: { type: 'string', description: 'Firebase ID token. Alternative to identifier+password.' },
      audience: {
        type: 'string',
        enum: ['admin', 'provider', 'customer', 'any'],
        description:
          'Which surface is asking. Asserted AFTER authentication, so the admin login box is not ' +
          'an oracle for "is this address an admin". Defaults to `any`.',
      },
      role: { type: 'string', enum: ['2', '3'], description: 'Token path only: role a NEW account is created with.' },
      fcmToken: { type: 'string', description: 'Optional. Registered non-blocking; failure never fails the sign-in.' },
    },
    description: 'Exactly one credential: `identifier`+`password`, or `idToken`.',
  },

  RegisterRequest: {
    type: 'object',
    properties: {
      email: { type: 'string' },
      password: { type: 'string' },
      firstName: { type: 'string' },
      lastName: { type: 'string' },
      role: { description: '2 provider or 3 customer. Admin accounts cannot be created here.' },
      idToken: { type: 'string', description: 'Firebase-first registration. Alternative to email+password.' },
      platform: { type: 'string', description: 'Governs whether verification is a code or a link.' },
      sourceClient: { type: 'string' },
    },
  },

  RegisterResult: {
    type: 'object',
    properties: {
      uid: { type: ['string', 'null'] },
      verificationType: { type: 'string', enum: ['otp', 'link', 'none'] },
      verificationDeliveryPending: {
        type: 'boolean',
        description:
          'The account exists but the code or link did not go out. Not a failure — retry delivery ' +
          'via resend-verification rather than re-registering, which would collide with the identity.',
      },
      onboardingPending: { type: 'boolean' },
    },
  },

  RefreshRequest: {
    type: 'object',
    required: ['refreshToken'],
    additionalProperties: false,
    properties: { refreshToken: { type: 'string' } },
  },

  ForgotPasswordRequest: {
    type: 'object',
    required: ['identifier'],
    properties: {
      identifier: { type: 'string', description: 'Email address. Mobile recovery is not configured — see the contract.' },
      platform: { type: 'string', description: 'Allowlisted name, never a URL. Chooses where the link lands.' },
    },
  },

  ResetPasswordRequest: {
    type: 'object',
    required: ['oobCode', 'newPassword'],
    additionalProperties: false,
    properties: {
      oobCode: { type: 'string', description: 'Single-use code from the reset email.' },
      newPassword: { type: 'string' },
    },
  },

  VerifyEmailRequest: {
    type: 'object',
    required: ['identifier', 'code'],
    additionalProperties: false,
    properties: {
      identifier: { type: 'string', description: 'The email address being verified.' },
      code: { type: 'string', description: 'Six digits.' },
    },
  },

  ResendVerificationRequest: {
    type: 'object',
    required: ['identifier'],
    properties: {
      identifier: { type: 'string' },
      channel: { type: 'string', enum: ['otp', 'link'], description: 'Defaults to `otp`.' },
      platform: { type: 'string', description: 'Link channel only. Allowlisted name, never a URL.' },
    },
  },

  VerifyMobileRequest: {
    type: 'object',
    required: ['idToken'],
    additionalProperties: false,
    properties: {
      idToken: {
        type: 'string',
        description:
          'A Firebase ID token whose sign-in provider is `phone`, or which has a phone credential ' +
          'linked. Firebase only issues one after its own SMS OTP.',
      },
    },
  },

  VerificationResult: {
    type: 'object',
    properties: {
      verified: { type: 'boolean' },
      identifierType: { type: 'string', enum: ['email', 'mobile'] },
    },
  },

  LogoutResult: {
    type: 'object',
    properties: {
      sessionsRevoked: { type: 'boolean' },
      pushCleared: { type: 'boolean' },
    },
    description: 'Ends ALL sessions — Firebase has no per-session revocation.',
  },

  NeutralAck: {
    type: 'object',
    properties: { message: { type: 'string' } },
    description:
      'Deliberately identical whether or not the account exists. The difference between "that ' +
      'address is not registered" and "sent" is a free membership check.',
  },

  // ── Planned. Documented so the migration matrix can name a successor. ──────
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
