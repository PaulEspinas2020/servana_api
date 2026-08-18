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

  BookingActionRequest: {
    type: 'object',
    additionalProperties: false,
    properties: {
      expectedState: {
        type: 'string',
        description:
          'Optimistic concurrency. Send the state you last read and get a clean ' +
          'BOOKING_STATE_CONFLICT instead of silently acting on a stale view.',
      },
      reason: { type: 'string', description: 'Required by cancellation and reassignment guards.' },
      workerCode: {
        type: 'string',
        description: 'Six digits the CUSTOMER reads out. Required to start a job. Redacted before the timeline.',
      },
    },
    description: 'Send Idempotency-Key as a HEADER; a retry replays the original result.',
  },

  BookingTransitionResult: {
    type: 'object',
    required: ['bookingId', 'action', 'fromState', 'toState'],
    properties: {
      bookingId: { type: 'integer' },
      action: { type: 'string' },
      fromState: { type: 'string' },
      toState: { type: 'string' },
      idempotentReplay: { type: 'boolean', description: 'True when an identical request had already been applied.' },
      correlationId: { type: 'string' },
      timelineEventId: { type: ['integer', 'null'] },
      state: { type: 'object', description: 'The caller-appropriate projection of the new state.' },
    },
  },

  BookingTransitionList: {
    type: 'object',
    required: ['bookingId', 'events'],
    properties: {
      bookingId: { type: 'integer' },
      currentState: { type: 'string' },
      events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            action: { type: 'string' },
            fromState: { type: 'string' },
            toState: { type: 'string' },
            actorRole: { type: 'string' },
            providerUid: { type: ['string', 'null'] },
            reason: { type: ['string', 'null'] },
            correlationId: { type: ['string', 'null'] },
            occurredAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    description:
      'Append-only. A reassigned provider keeps their progression — the current state ' +
      'resetting must not erase what happened.',
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

  // ── Booking experiences (TAB 06) ─────────────────────────────────────────
  //
  // Explicit DTOs per capability, never a generic field-rewriting shape. The
  // command forbids global field-rewriting middleware on canonical routes, and
  // a DTO written out here is what makes that enforceable rather than a habit.

  BookingTracking: {
    type: 'object',
    required: ['bookingId', 'state', 'steps', 'assignedProvider', 'visibility'],
    properties: {
      bookingId: { type: 'integer' },
      state: { type: 'string', description: 'The canonical state, from the shared derivation.' },
      steps: {
        type: 'array',
        description: 'booking_tracking rows, oldest first.',
        items: {
          type: 'object',
          properties: {
            status: { type: ['string', 'null'] },
            note: { type: ['string', 'null'] },
            at: { type: ['string', 'null'], format: 'date-time' },
          },
        },
      },
      assignedProvider: {
        type: 'object',
        properties: {
          assigned: { type: 'boolean' },
          location: {
            type: ['object', 'null'],
            description:
              'Present ONLY when visibility is VISIBLE. Null in every other case, ' +
              'with visibility.reason naming which rule withheld it.',
          },
        },
      },
      visibility: {
        type: 'object',
        required: ['visibility', 'reason'],
        properties: {
          visibility: { type: 'string', enum: ['VISIBLE', 'WITHHELD'] },
          reason: {
            type: ['string', 'null'],
            enum: [
              'NO_ASSIGNMENT', 'STATE_NOT_TRACKABLE', 'WINDOW_EXPIRED',
              'NO_POSITION_REPORTED', null,
            ],
          },
          trackableStates: { type: 'array', items: { type: 'string' } },
          windowClosesAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      policy: {
        type: 'object',
        properties: {
          trackableStates: { type: 'array', items: { type: 'string' } },
          maxHoursSinceMovement: { type: 'integer' },
        },
      },
    },
    description:
      'Booking-scoped provider location sharing. A withheld position answers 200 with a ' +
      'reason, not 403 — the caller is entitled to the booking, just not to a live ' +
      'position for it yet.',
  },

  BookingOtpRequest: {
    type: 'object',
    additionalProperties: false,
    properties: {
      purpose: {
        type: 'string',
        enum: ['BOOKING_CONFIRMATION', 'SERVICE_START'],
        description: 'Defaults to BOOKING_CONFIRMATION. A code is scoped to a booking AND a purpose.',
      },
    },
  },

  BookingOtpIssued: {
    type: 'object',
    required: ['bookingId', 'purpose', 'delivery', 'expiresAt'],
    properties: {
      bookingId: { type: 'integer' },
      purpose: { type: 'string' },
      delivery: { type: 'string', enum: ['email', 'booking_detail'], description: 'How the recipient gets it.' },
      recipient: { type: 'string', description: 'Always the customer, for both purposes.' },
      expiresAt: { type: 'string', format: 'date-time' },
      resendAvailableAt: { type: 'string', format: 'date-time' },
      issuesRemaining: { type: 'integer' },
      attemptsRemaining: { type: 'integer' },
    },
    description: 'The code itself is NEVER in this response, in any field, for any actor.',
  },

  BookingOtpVerifyRequest: {
    type: 'object',
    additionalProperties: false,
    properties: {
      code: { type: 'string', description: 'Six digits. `otp` and `workerCode` are accepted as aliases for shipped clients.' },
      otp: { type: 'string', description: 'Deprecated alias for `code`.' },
      workerCode: { type: 'string', description: 'Deprecated alias for `code`.' },
      purpose: { type: 'string', enum: ['BOOKING_CONFIRMATION', 'SERVICE_START'] },
      expectedState: { type: 'string', description: 'Optimistic concurrency, as on every other booking action.' },
    },
    description: 'Send Idempotency-Key as a HEADER; a retry replays the original result.',
  },

  BookingOtpStatus: {
    type: 'object',
    required: ['bookingId', 'purpose', 'policy'],
    properties: {
      bookingId: { type: 'integer' },
      purpose: { type: 'string' },
      issuedAt: { type: ['string', 'null'], format: 'date-time' },
      expiresAt: { type: ['string', 'null'], format: 'date-time' },
      expired: { type: 'boolean' },
      present: { type: 'boolean', description: 'Whether a code is currently on the booking. Never the code.' },
      attemptsRemaining: { type: 'integer' },
      issuesRemaining: { type: 'integer' },
      resendAvailableInSeconds: { type: 'integer' },
      policy: {
        type: 'object',
        properties: {
          expiryMinutes: { type: 'integer' },
          resendCooldownSeconds: { type: 'integer' },
          maxVerifyAttempts: { type: 'integer' },
          maxIssues: { type: 'integer' },
          recipient: { type: 'string' },
          delivery: { type: 'string' },
          canRequest: { type: 'boolean' },
          canVerify: { type: 'boolean' },
        },
      },
    },
    description: 'Lets a client render "resend in 42s" and "2 attempts left" from the backend rather than its own copy of the policy.',
  },

  BookingRescheduleRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['scheduledAt'],
    properties: {
      scheduledAt: { type: 'string', format: 'date-time', description: 'The proposed new start.' },
      reasonCode: { type: 'string', description: 'One of the standardized reschedule reasons.' },
      reason: { type: 'string', description: 'Free text, for the audit record.' },
      expectedSchedule: {
        type: 'string',
        format: 'date-time',
        description:
          'The schedule the caller last read. When it no longer matches, the move is ' +
          'refused with BOOKING_SCHEDULE_CHANGED instead of overwriting somebody else\'s.',
      },
    },
  },

  BookingRescheduleResult: {
    type: 'object',
    required: ['bookingId', 'status', 'scheduledAt'],
    properties: {
      bookingId: { type: 'integer' },
      requestId: { type: ['integer', 'null'], description: 'The proposal row. Written for accepted AND refused attempts.' },
      status: { type: 'string', enum: ['ACCEPTED', 'REFUSED', 'PENDING_PROVIDER'] },
      previousSchedule: { type: ['string', 'null'], format: 'date-time' },
      scheduledAt: { type: 'string', format: 'date-time' },
      reasonCode: { type: ['string', 'null'] },
      appliedImmediately: { type: 'boolean', description: 'True while the provider is not a party to rescheduling.' },
      reasons: { type: 'array', items: { type: 'string' } },
      verdict: { type: 'object', description: 'The policy verdict, including the notice window that applied to this actor.' },
    },
  },

  BookingRescheduleHistory: {
    type: 'object',
    required: ['bookingId', 'requests'],
    properties: {
      bookingId: { type: 'integer' },
      requests: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            previousSchedule: { type: ['string', 'null'], format: 'date-time' },
            proposedSchedule: { type: 'string', format: 'date-time' },
            reasonCode: { type: ['string', 'null'] },
            status: { type: 'string' },
            refusalCode: { type: ['string', 'null'] },
            requestedRole: { type: 'string', description: 'The seat that proposed it. The uid is NOT projected.' },
            decidedAt: { type: ['string', 'null'], format: 'date-time' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  },

  BookingAdditionalWorkRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 25,
        items: {
          type: 'object',
          properties: {
            quantity: { type: 'integer', minimum: 1, maximum: 100 },
            unitPrice: { type: 'number', description: '`amount` is accepted as an alias — the provider portal has always sent it.' },
            amount: { type: 'number', description: 'Deprecated alias for `unitPrice`.' },
            serviceOptionId: { type: ['integer', 'null'] },
          },
        },
      },
    },
  },

  BookingAdditionalWorkResult: {
    type: 'object',
    required: ['bookingId', 'request'],
    properties: {
      bookingId: { type: 'integer' },
      request: {
        type: 'object',
        description:
          'The child request as stored: id, status (PENDING_ADMIN_APPROVAL → ' +
          'WAITING_FOR_PAYMENT → WAITING_WORKER_APPROVAL → ACCEPTED → IN_PROGRESS) and ' +
          'total_amount. A change order is a priced child record, never a mutation of the ' +
          'original service.',
      },
    },
  },

  BookingAdditionalWorkList: {
    type: 'object',
    required: ['bookingId', 'requests'],
    properties: {
      bookingId: { type: 'integer' },
      requests: { type: 'array', items: { type: 'object' } },
    },
  },

  BookingDisputeRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['category', 'reason'],
    properties: {
      category: { type: 'string', description: 'One of the standardized dispute categories.' },
      reason: { type: 'string', description: 'What went wrong. Written to the admin record and NOT projected back to the other party.' },
      severity: { type: 'string', enum: ['low', 'normal', 'high'] },
      evidence: { description: 'References the reporter attached. Ids, never file contents.' },
    },
  },

  BookingDisputeResult: {
    type: 'object',
    required: ['dispute'],
    properties: {
      dispute: { $ref: '#/components/schemas/BookingDispute' },
      categories: { type: 'array', items: { type: 'string' } },
    },
  },

  BookingDispute: {
    type: 'object',
    required: ['id', 'bookingId', 'state'],
    properties: {
      id: { type: 'integer' },
      bookingId: { type: 'integer' },
      category: { type: ['string', 'null'] },
      severity: { type: 'string' },
      state: { type: 'string', enum: ['OPEN', 'RESOLVED'] },
      openedByRole: { type: ['string', 'null'] },
      openedByYou: { type: 'boolean', description: 'The only caller-dependent field in the projection.' },
      openedAt: { type: ['string', 'null'], format: 'date-time' },
      resolvedAt: { type: ['string', 'null'], format: 'date-time' },
      stateSnapshot: {
        type: ['object', 'null'],
        description:
          'The service and financial state AT OPENING — canonical state, raw statuses, ' +
          'schedule, payment status and method. No amounts, no references, no payer.',
      },
    },
    description:
      '`reason`, `assigned_team` and `actor_uid` are never projected to any caller: free ' +
      'text one party typed about another, internal routing, and a person.',
  },

  BookingDisputeList: {
    type: 'object',
    required: ['bookingId', 'disputes'],
    properties: {
      bookingId: { type: 'integer' },
      disputes: { type: 'array', items: { $ref: '#/components/schemas/BookingDispute' } },
      categories: { type: 'array', items: { type: 'string' } },
    },
  },

  JobCard: {
    type: 'object',
    description:
      'A job card as produced by controllers/jobCardView.formatJobCard. Carries '
      + 'the CANONICAL booking state alongside the legacy raw columns: '
      + '`canonicalState` (one of the eleven machine states), `stateLabel`, '
      + '`nextAction` and `terminal`. `status` and `workerStatus` are the raw '
      + 'legacy columns, preserved for shipped clients and DEPRECATED — read '
      + '`canonicalState` instead. `availableActions` is generated from the '
      + 'canonical transition whitelist, so an action never appears for a state '
      + 'the executor would refuse.',
  },

  JobCardList: {
    type: 'object',
    required: ['jobs'],
    properties: { jobs: { type: 'array', items: { $ref: '#/components/schemas/JobCard' } } },
  },

  // ── Notifications (TAB 09) ────────────────────────────────────────────────
  //
  // ONE notification shape over three physical stores. Which store a caller
  // reads is resolved from their account, never from a parameter, so the three
  // tables are three private inboxes rather than one shared surface.

  Notification: {
    type: 'object',
    required: ['notificationKey', 'type', 'title', 'body', 'isRead'],
    properties: {
      notificationKey: {
        type: 'string',
        description:
          'Opaque and OWNER-SCOPED. The same key can exist for two accounts and each only ever ' +
          'resolves their own row, because every statement is predicated on the uid from the token.',
      },
      type: { type: 'string' },
      severity: { type: 'string' },
      title: { type: 'string' },
      body: {
        type: 'string',
        description:
          'Already redacted at write time. Never a customer name, address, phone or note - a ' +
          'push payload is readable on a lock screen before the app decides anything.',
      },
      contextLabel: { type: ['string', 'null'], description: 'Usually the SVN- booking code.' },
      createdAt: { type: ['string', 'null'], format: 'date-time' },
      readAt: { type: ['string', 'null'], format: 'date-time' },
      isRead: { type: 'boolean' },
      expiresAt: { type: ['string', 'null'], format: 'date-time' },
      target: {
        type: ['string', 'null'],
        enum: [
          'BOOKING_DETAIL', 'JOB_DETAIL', 'CONVERSATION', 'EARNINGS',
          'APPLICATION', 'REVIEW', 'NOTIFICATIONS', null,
        ],
        description:
          'The canonical deep-link target, keyed on canonical ids. Null for a notification ' +
          'written before the contract existed - shown un-tappable rather than navigating ' +
          'somewhere invented.',
      },
      route: {
        type: ['object', 'null'],
        additionalProperties: true,
        description:
          'The stored route in the vocabulary the shipped clients already parse. Authorization ' +
          'is re-checked by the endpoint the screen calls: a notification is a POINTER, never a grant.',
      },
      canOpenDetail: { type: 'boolean' },
      canMarkRead: { type: 'boolean' },
    },
  },

  NotificationList: {
    type: 'object',
    required: ['notifications'],
    properties: { notifications: { type: 'array', items: { $ref: '#/components/schemas/Notification' } } },
    description: '`meta.unreadCount` carries the badge, counted from the same store the list read.',
  },

  UnreadCount: {
    type: 'object',
    required: ['count'],
    properties: { count: { type: 'integer' } },
  },

  NotificationMutation: {
    type: 'object',
    properties: {
      found: { type: 'boolean' },
      allowed: { type: 'boolean' },
      changed: { type: 'boolean' },
      marked: { type: 'boolean' },
      supported: {
        type: 'boolean',
        description:
          'False when the notification store this caller reads has no such capability at ' +
          'all - distinct from `allowed`, which is a per-row policy the sender set.',
      },
      unreadCount: {
        type: 'integer',
        description:
          'The count AFTER the mutation. Returned so a client never has to guess its badge, or ' +
          'decrement a number it inferred.',
      },
    },
  },

  ChatAttachmentUpload: {
    type: 'object',
    required: ['file', 'name'],
    description:
      'A data URI and a filename. The conversation is named by the PATH, not by the body - ' +
      'on the legacy route it was an optional body field and omitting it skipped the access ' +
      'check entirely.',
    properties: {
      file: { type: 'string', description: 'data: URI. Validated by signature, not by its declared type.' },
      name: { type: 'string', description: 'Sanitised before storage; never used as the storage key.' },
    },
  },

  MessageReportRequest: {
    type: 'object',
    required: ['category'],
    properties: {
      category: {
        type: 'string',
        description: 'Lower snake_case, 2-40 chars. A free-form category would be an unqueryable moderation queue.',
      },
      description: { type: 'string', description: 'Optional. 1000 characters maximum.' },
    },
  },

  ChatAttachment: {
    type: 'object',
    description:
      'A stored chat attachment. `attachmentId` and `previewUrl` are what a subsequent ' +
      'send references; the file is validated by signature, not by its declared type.',
    properties: {
      attachmentId: { type: 'string' },
      previewUrl: { type: 'string' },
      fileName: { type: 'string', description: 'Sanitised. Never the raw filename as supplied.' },
      mimeType: { type: 'string' },
      sizeBytes: { type: 'integer' },
    },
  },

  MessageReport: {
    type: 'object',
    description: 'The receipt for a message reported to moderation.',
    properties: { reportId: { type: 'string' } },
  },

  NotificationPreferencePatch: {
    type: 'object',
    additionalProperties: false,
    description:
      'A PARTIAL update. Unnamed categories keep their value - a full replace would silently ' +
      'reset categories a client has never heard of every time the backend adds one. An ' +
      'unknown category name is refused rather than ignored.',
    properties: {
      jobAssigned: { type: 'boolean' },
      jobReminder: { type: 'boolean' },
      paymentReceived: { type: 'boolean' },
      newMessage: { type: 'boolean' },
      promotions: { type: 'boolean' },
      requirementReview: { type: 'boolean' },
      support: { type: 'boolean' },
      accountSecurity: { type: 'boolean' },
      system: { type: 'boolean' },
    },
  },

  DeviceRegistration: {
    type: 'object',
    required: ['token'],
    additionalProperties: false,
    description: 'There is no account field. The account is the authenticated caller.',
    properties: {
      token: { type: 'string', minLength: 10, maxLength: 4096 },
      platform: { type: 'string', enum: ['ios', 'android', 'web', 'unknown'] },
      app: { type: 'string', maxLength: 32 },
    },
  },

  DeviceRegistrationResult: {
    type: 'object',
    required: ['registered', 'deviceCount'],
    properties: {
      registered: { type: 'boolean' },
      deviceCount: {
        type: 'integer',
        description: 'Devices now enrolled for this account, across every token store.',
      },
    },
  },

  DeviceRelease: {
    type: 'object',
    additionalProperties: false,
    properties: {
      token: {
        type: 'string',
        description:
          'Omit to release EVERY device - what a sign-out-everywhere wants. Passing one ' +
          'releases that handset only, so signing out of a phone does not un-enroll the tablet.',
      },
    },
  },

  DeviceReleaseResult: {
    type: 'object',
    required: ['released'],
    properties: { released: { type: 'boolean' }, deviceCount: { type: 'integer' } },
  },

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

  NotificationPreferences: {
    type: 'object',
    additionalProperties: false,
    description:
      'Every declared category, always present, filled from the account row or the category ' +
      'default. The table is keyed on a uid and has no role column - the provider-role gate on ' +
      'the legacy routes was an accident of where the feature was built, not a property of it.',
    properties: {
      jobAssigned: { type: 'boolean' },
      jobReminder: { type: 'boolean' },
      paymentReceived: { type: 'boolean' },
      newMessage: { type: 'boolean' },
      promotions: { type: 'boolean', description: 'Off by default and never preference-overridable.' },
      requirementReview: { type: 'boolean' },
      support: { type: 'boolean', description: 'Transactional: may override a disabled preference.' },
      accountSecurity: { type: 'boolean', description: 'Transactional: may override a disabled preference.' },
      system: { type: 'boolean' },
    },
  },

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

  // ── Finance ────────────────────────────────────────────────────────────────
  //
  // Explicit DTOs per actor, never a generic shape with fields removed
  // afterwards. A subtractive projection discloses every field somebody forgets
  // to strip; an additive one discloses only what it names — which is why the
  // provider variant of BookingPayment has no processor reference to omit.

  PaymentIntentRequest: {
    type: 'object',
    additionalProperties: false,
    properties: {
      returnOrigin: {
        type: 'string',
        description:
          'Optional hint, matched against a SERVER-SIDE allowlist. Never used as a URL — a ' +
          'caller-supplied return target would let a payer be returned to another application.',
      },
    },
  },

  PaymentIntent: {
    type: 'object',
    required: ['bookingId', 'checkoutUrl', 'reused'],
    properties: {
      bookingId: { type: 'integer' },
      checkoutUrl: { type: 'string', format: 'uri', description: 'Always a checkout.paymongo.com URL.' },
      reused: {
        type: 'boolean',
        description:
          'true when an existing live session was returned instead of a new one. A replay ' +
          'produces the same URL rather than a second payable session.',
      },
    },
  },

  BookingPayment: {
    type: 'object',
    required: ['bookingId', 'currency', 'state', 'captured', 'breakdown'],
    description:
      'Field-scoped by the caller\'s seat on the booking. The CALCULATION is identical for all ' +
      'three seats; only the disclosed fields differ.',
    properties: {
      bookingId: { type: 'integer' },
      currency: { type: 'string', enum: ['PHP'] },
      state: {
        type: 'string',
        enum: ['PENDING', 'PAID', 'FAILED', 'REJECTED', 'REFUNDING', 'REFUNDED'],
        description: 'Settlement truth. SEPARATE from the booking lifecycle state and linked to it.',
      },
      captured: { type: 'boolean' },
      method: { type: ['string', 'null'] },
      paidAt: { type: ['string', 'null'], format: 'date-time' },
      paymentId: { type: ['integer', 'null'], description: 'ADMIN only.' },
      breakdown: {
        type: 'object',
        description: 'Backend-computed. Clients display it and never recompute it.',
        properties: {
          gross: { type: 'number', description: 'Base price plus PAID additional work.' },
          grossMinor: { type: 'integer' },
          basePrice: { type: 'number' },
          additionalWork: { type: 'number', description: 'Charged through its own checkout.' },
        },
      },
      earning: {
        type: 'object',
        description: 'PROVIDER only. Zero with a withheldReason for an INTERNAL_FIXER.',
        properties: {
          economicModel: { type: 'string', enum: ['EXTERNAL_PROVIDER', 'INTERNAL_FIXER'] },
          payable: { type: 'number' },
          payableMinor: { type: 'integer' },
          isEstimate: { type: 'boolean', description: 'true until a disbursement row exists.' },
          withheldReason: { type: ['string', 'null'] },
        },
      },
      refund: {
        type: 'object',
        description: 'CUSTOMER and ADMIN. Never disclosed to the provider.',
        properties: {
          refundedAmount: { type: 'number' },
          refundedAt: { type: ['string', 'null'], format: 'date-time' },
          refundable: { type: 'number', description: 'Captured minus already refunded. Never below zero.' },
          refundableMinor: { type: 'integer' },
        },
      },
      provider: { type: 'object', description: 'ADMIN only.' },
      servana: { type: 'object', description: 'ADMIN only — the retained revenue and commission rate.' },
      payout: {
        type: 'object',
        description: 'PROVIDER and ADMIN. `blockedBy` names the ONE rule refusing release.',
        properties: {
          status: { type: 'string', enum: ['pending', 'processing', 'paid', 'failed', 'unknown'] },
          releasedAt: { type: ['string', 'null'], format: 'date-time' },
          eligibleAt: { type: ['string', 'null'], format: 'date-time' },
          blockedBy: { type: ['string', 'null'] },
          blockedReason: { type: ['string', 'null'] },
          windowHours: { type: 'integer', description: 'The payout window. 72.' },
        },
      },
    },
  },

  RefundRequest: {
    type: 'object',
    required: ['trigger'],
    additionalProperties: false,
    properties: {
      trigger: {
        type: 'string',
        enum: [
          'CUSTOMER_CANCELLED', 'PROVIDER_CANCELLED', 'ADMIN_CANCELLED', 'DISPUTE_UPHELD',
          'SERVICE_NOT_DELIVERED', 'DUPLICATE_PAYMENT', 'ADMIN_DISCRETION',
        ],
        description: 'Which triggers a customer may cite is narrower than an admin\'s.',
      },
      amount: { type: 'number', description: 'Omit for the whole remaining refundable balance.' },
      reason: { type: ['string', 'null'] },
    },
  },

  RefundResult: {
    type: 'object',
    required: ['bookingId', 'outcome', 'trigger', 'amount', 'currency'],
    properties: {
      bookingId: { type: 'integer' },
      outcome: {
        type: 'string',
        enum: ['requested', 'issued', 'pending_processor'],
        description:
          'A customer REQUESTS (a review row, no processor call); an admin ISSUES. ' +
          '`pending_processor` means the refund was accepted and its settlement is not yet confirmed.',
      },
      trigger: { type: 'string' },
      amount: { type: 'number' },
      amountMinor: { type: 'integer' },
      currency: { type: 'string', enum: ['PHP'] },
      reference: {
        type: ['string', 'null'],
        description: 'A Servana handle support can discuss. Never the processor\'s refund id.',
      },
      refundReviewId: { type: ['integer', 'null'] },
      reversesProviderEarning: { type: 'boolean' },
    },
  },

  ProviderEarningsSummary: {
    type: 'object',
    required: ['economicModel', 'totalEarned', 'totalPaid', 'totalPending', 'currency'],
    properties: {
      economicModel: { type: 'string', enum: ['EXTERNAL_PROVIDER', 'INTERNAL_FIXER'] },
      withheldReason: {
        type: ['string', 'null'],
        description: 'Present for INTERNAL_FIXER. Null for anyone who earns a job share.',
      },
      totalEarned: { type: 'number' },
      totalPaid: { type: 'number' },
      totalPending: { type: 'number' },
      totalFailed: {
        type: 'number',
        description:
          'Split out of pending: a failed payout needs intervention rather than patience, and ' +
          'folding it into pending tells the provider it is on its way.',
      },
      totalRefunded: { type: 'number' },
      pendingRecordedAmount: { type: 'number', description: 'Backed by a disbursement row.' },
      pendingEstimatedAmount: { type: 'number', description: 'Derived; no disbursement row yet.' },
      pendingIsEstimate: { type: 'boolean' },
      estimatedJobsCount: { type: 'integer' },
      jobsCount: { type: 'integer' },
      periodLabel: { type: 'string' },
      currency: { type: 'string', enum: ['PHP'] },
      payoutWindowHours: { type: 'integer', description: '72.' },
    },
  },

  ProviderEarningsTransactions: {
    type: 'array',
    items: {
      type: 'object',
      required: ['bookingId', 'bookingAmount', 'providerShareAmount', 'payoutStatus'],
      properties: {
        id: { type: 'string' },
        bookingId: { type: 'string' },
        bookingCode: { type: 'string' },
        serviceName: { type: 'string' },
        completedAt: { type: ['string', 'null'], format: 'date-time' },
        scheduledAt: { type: ['string', 'null'], format: 'date-time' },
        bookingAmount: { type: 'number', description: 'Includes PAID additional work.' },
        bookingAmountMinor: { type: 'integer' },
        providerShareAmount: { type: 'number' },
        providerShareAmountMinor: { type: 'integer' },
        providerSharePercent: { type: 'integer', description: '0 for an INTERNAL_FIXER.' },
        isEstimate: { type: 'boolean' },
        economicModel: { type: 'string', enum: ['EXTERNAL_PROVIDER', 'INTERNAL_FIXER'] },
        withheldReason: { type: ['string', 'null'] },
        clientPaymentStatus: { type: 'string' },
        bookingStatus: { type: 'string' },
        payoutStatus: { type: 'string', enum: ['pending', 'processing', 'paid', 'failed', 'unknown'] },
        providerPayoutStatus: {
          type: 'string',
          description: 'The legacy dialect, kept so a migrating client can branch on either.',
        },
        payoutStatusCanonical: { type: 'string' },
        payoutBlockedBy: { type: ['string', 'null'] },
        payoutBlockedReason: { type: ['string', 'null'] },
        disbursedAt: { type: ['string', 'null'], format: 'date-time' },
        expectedArrivalAt: {
          type: ['string', 'null'],
          format: 'date-time',
          description: 'Backend-computed from the same constant the release scheduler uses.',
        },
        paymentMethod: { type: ['string', 'null'] },
        currency: { type: 'string', enum: ['PHP'] },
      },
    },
  },

  ProviderPayouts: {
    type: 'array',
    items: {
      type: 'object',
      required: ['id', 'amount', 'status', 'currency'],
      properties: {
        id: { type: 'string' },
        bookingId: { type: 'string' },
        bookingCode: { type: 'string' },
        amount: { type: 'number' },
        amountMinor: { type: 'integer' },
        currency: { type: 'string', enum: ['PHP'] },
        status: { type: 'string', enum: ['pending', 'paid', 'failed'] },
        payoutStatusCanonical: { type: 'string' },
        initiatedAt: { type: ['string', 'null'], format: 'date-time' },
        expectedArrivalAt: { type: ['string', 'null'], format: 'date-time' },
        completedAt: { type: ['string', 'null'], format: 'date-time' },
        reference: {
          type: 'string',
          description: 'A Servana handle. The processor id is internal reconciliation data.',
        },
        payoutWindowHours: { type: 'integer' },
      },
    },
  },

  FinanceReconciliation: {
    type: 'object',
    required: ['generatedAt', 'checks', 'totals', 'breaks', 'balanced'],
    properties: {
      generatedAt: { type: 'string', format: 'date-time' },
      checks: {
        type: 'array',
        description:
          'Every check the engine can run, whether or not it fired — derived from the catalog, ' +
          'so the admin UI never hardcodes a description.',
        items: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
            detects: { type: 'string' },
            remediation: { type: 'string' },
            requiredBySpec: { type: 'boolean' },
            openCount: { type: 'integer' },
          },
        },
      },
      totals: {
        type: 'object',
        properties: {
          openBreaks: { type: 'integer' },
          criticalBreaks: { type: 'integer' },
          capturedAmount: { type: 'number' },
          refundedAmount: { type: 'number' },
          accruedProviderEarnings: { type: 'number' },
          releasedPayouts: { type: 'number' },
          internalFixerRevenue: { type: 'number', description: 'Retained in full; never split.' },
          outstandingProviderLiability: {
            type: 'number',
            description: 'Accrued minus released — what Servana still owes providers.',
          },
        },
      },
      breaks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            code: { type: 'string' },
            severity: { type: 'string' },
            detects: { type: ['string', 'null'] },
            remediation: { type: ['string', 'null'] },
            bookingId: { type: ['integer', 'null'] },
            paymentId: { type: ['integer', 'null'] },
            disbursementId: { type: ['integer', 'null'] },
            amount: { type: ['number', 'null'] },
            description: { type: 'string' },
            status: { type: 'string' },
            runDate: { type: ['string', 'null'] },
            createdAt: { type: ['string', 'null'], format: 'date-time' },
          },
        },
      },
      balanced: { type: 'boolean', description: 'True when nothing is open. The release gate reads this.' },
    },
  },

  // ── Messaging ──────────────────────────────────────────────────────────────
  //
  // One message shape for every surface. The realtime payload is a SUPERSET of
  // `Message` — it also carries the legacy keys the four shipped clients read —
  // so a client may replace a REST row with a socket payload by id without
  // reconciling content. That property is asserted in
  // `tests/messaging-realtime-schema.test.ts`, not merely described here.

  ConversationCreateRequest: {
    type: 'object',
    required: ['bookingId'],
    additionalProperties: false,
    properties: {
      bookingId: {
        type: 'integer',
        description:
          'The booking to open the conversation for. Participants are resolved from the ' +
          'booking; there is no participant list to supply, and no way to add someone.',
      },
    },
  },

  Attachment: {
    type: 'object',
    required: ['id', 'url'],
    properties: {
      id: { type: 'integer' },
      url: {
        type: 'string',
        description:
          'An owned storage key, or a Firebase download URL in the configured bucket under ' +
          'chat-attachments/. Both are proven at WRITE time to belong to the uploader.',
      },
      fileName: { type: ['string', 'null'] },
      mimeType: { type: ['string', 'null'], enum: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', null] },
      sizeBytes: { type: ['integer', 'null'], description: 'At most 10 MiB.' },
      width: { type: ['integer', 'null'] },
      height: { type: ['integer', 'null'] },
    },
  },

  Message: {
    type: 'object',
    required: ['id', 'conversationId', 'type', 'senderSeat', 'sentAt'],
    properties: {
      id: { type: 'integer' },
      conversationId: { type: 'integer' },
      bookingId: { type: ['integer', 'null'] },
      type: { type: 'string', enum: ['text', 'image', 'file', 'system'] },
      body: { type: ['string', 'null'], description: 'Null on a soft-deleted message.' },
      senderSeat: {
        type: 'string',
        enum: ['customer', 'provider', 'support', 'system'],
        description:
          "The seat the message was sent FROM, captured at send time — so a transcript keeps " +
          "its history if somebody's role changes later.",
      },
      senderUid: { type: ['string', 'null'], description: 'Null for a system message.' },
      isMine: { type: 'boolean', description: 'Relative to the authenticated caller.' },
      isSystem: { type: 'boolean' },
      clientMsgId: { type: ['string', 'null'] },
      sentAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description:
          'When the SERVER accepted the message. There is no delivered-at: no per-device ' +
          'acknowledgement channel exists, and publishing one would be a claim about the ' +
          "recipient's device that nothing in the system can support.",
      },
      editedAt: { type: ['string', 'null'], format: 'date-time' },
      deletedAt: { type: ['string', 'null'], format: 'date-time' },
      isDeleted: { type: 'boolean' },
      readByCount: {
        type: 'integer',
        description:
          'Active participants other than the sender whose read pointer is at or past this ' +
          'message. Uids are never published — a receipt does not need them.',
      },
      readByAll: { type: 'boolean' },
      attachments: { type: 'array', items: { $ref: '#/components/schemas/Attachment' } },
      metadata: { type: 'object', additionalProperties: true },
    },
  },

  MessagePage: {
    type: 'object',
    required: ['conversationId', 'messages', 'hasMore', 'limit'],
    properties: {
      conversationId: { type: 'integer' },
      messages: {
        type: 'array',
        items: { $ref: '#/components/schemas/Message' },
        description: 'Newest first.',
      },
      nextCursor: {
        type: ['integer', 'null'],
        description: 'Pass as `cursor` for the next, older page. Null at the end.',
      },
      hasMore: { type: 'boolean' },
      limit: { type: 'integer', description: 'The limit actually applied, after clamping.' },
    },
  },

  SendMessageRequest: {
    type: 'object',
    required: ['clientMsgId'],
    additionalProperties: false,
    description:
      'There is deliberately no sender field. The sender is the authenticated caller and ' +
      'cannot be named by the request.',
    properties: {
      type: { type: 'string', enum: ['text', 'image', 'file'], description: "Defaults to 'text'. `system` is backend-authored only." },
      body: { type: ['string', 'null'], description: 'At most 4000 characters.' },
      clientMsgId: {
        type: 'string',
        minLength: 16,
        maxLength: 128,
        pattern: '^[A-Za-z0-9._:-]+$',
        description:
          'REQUIRED. A retry after a timeout has no other way to say "this is the message I ' +
          'already sent"; the database enforces uniqueness per conversation and sender.',
      },
      attachments: {
        type: 'array',
        maxItems: 5,
        items: {
          type: 'object',
          required: ['url'],
          properties: {
            url: { type: 'string' },
            fileName: { type: 'string' },
            mimeType: { type: 'string' },
            sizeBytes: { type: 'integer' },
            width: { type: 'integer' },
            height: { type: 'integer' },
          },
        },
      },
    },
  },

  Participant: {
    type: 'object',
    required: ['uid', 'seat'],
    description:
      'Contact columns are never published. The join behind this row reaches user_credentials ' +
      'and user_profile; only a display name and an avatar come out.',
    properties: {
      uid: { type: 'string' },
      seat: { type: 'string', enum: ['customer', 'provider', 'support'] },
      displayName: { type: ['string', 'null'] },
      photoUrl: { type: ['string', 'null'] },
      joinedAt: { type: ['string', 'null'], format: 'date-time' },
      leftAt: { type: ['string', 'null'], format: 'date-time', description: 'Disclosed to support only.' },
      isActive: { type: 'boolean' },
      lastReadMessageId: { type: ['integer', 'null'] },
      lastReadAt: { type: ['string', 'null'], format: 'date-time' },
    },
  },

  Conversation: {
    type: 'object',
    required: ['id', 'kind', 'bookingId', 'status', 'viewerSeat', 'canSend', 'unreadCount'],
    properties: {
      id: { type: 'integer' },
      kind: { type: 'string', enum: ['BOOKING'] },
      bookingId: { type: 'integer' },
      bookingCode: { type: 'string', description: 'SVN-000075. What support and both apps say out loud.' },
      status: {
        type: 'string',
        enum: ['ACTIVE', 'SUPPORT_ESCALATED', 'READ_ONLY', 'CLOSED', 'ARCHIVED'],
      },
      isClosed: {
        type: 'boolean',
        description:
          'The pre-status compatibility boolean, republished. It means "the parties cannot ' +
          'write here" and is kept correct for clients that know nothing about `status`.',
      },
      viewerSeat: { type: 'string', enum: ['customer', 'provider', 'support'] },
      canSend: {
        type: 'boolean',
        description:
          'On the LIST this is advisory — derived from the conversation state and the ' +
          "participant projection to avoid an authorization round trip per row. The write " +
          'path re-derives it from booking_workers, so a stale true costs a 409, never access.',
      },
      cannotSendReason: { type: ['string', 'null'] },
      unreadCount: { type: 'integer' },
      isParticipant: {
        type: 'boolean',
        description:
          'False for an admin authorized by role. Unread is undefined for them and is ' +
          'reported as zero rather than invented.',
      },
      createdAt: { type: ['string', 'null'], format: 'date-time' },
      updatedAt: { type: ['string', 'null'], format: 'date-time' },
      lastMessageAt: { type: ['string', 'null'], format: 'date-time' },
      participants: { type: 'array', items: { $ref: '#/components/schemas/Participant' } },
      lastMessage: {
        oneOf: [{ $ref: '#/components/schemas/Message' }, { type: 'null' }],
        description: "Built through the caller's own read floor, so a preview cannot show a message they may not open.",
      },
    },
  },

  ConversationList: {
    type: 'array',
    items: { $ref: '#/components/schemas/Conversation' },
    description: '`meta.unreadTotal` carries the badge total, summed from these same rows.',
  },

  MarkReadRequest: {
    type: 'object',
    required: ['lastReadMessageId'],
    additionalProperties: false,
    properties: {
      lastReadMessageId: {
        type: 'integer',
        description:
          'Must name a message in THIS conversation that is visible to the caller. The pointer ' +
          'is monotonic, so a late request cannot move it backwards.',
      },
    },
  },

  ConversationReadState: {
    type: 'object',
    required: ['conversationId', 'lastReadMessageId', 'unreadCount'],
    properties: {
      conversationId: { type: 'integer' },
      lastReadMessageId: { type: 'integer' },
      unreadCount: { type: 'integer', description: 'After the pointer moved. Authoritative.' },
      isParticipant: { type: 'boolean' },
    },
  },

  // ── Account domain (TAB 10) ───────────────────────────────────────────────
  //
  // Every projection NAMES its fields. Nothing is built by copying a row and
  // deleting what should not travel: `user_credentials` carries the push token
  // and auth metadata, and a subtractive projection discloses every column
  // somebody later adds.

  Account: {
    type: 'object',
    required: ['uid', 'role', 'profiles'],
    description:
      'Identity, contact and a verification SUMMARY. Role data is deliberately absent - ' +
      '`profiles` is a POINTER to which extension exists, not its contents.',
    properties: {
      uid: { type: 'string', description: 'The canonical account identity. It never changes.' },
      email: { type: ['string', 'null'], description: 'A verified identifier. Not writable here.' },
      phoneNumber: { type: ['string', 'null'], description: 'A verified identifier. Not writable here.' },
      firstName: { type: ['string', 'null'] },
      lastName: { type: ['string', 'null'] },
      displayName: {
        type: ['string', 'null'],
        description: 'DERIVED from the name parts, never stored - a third copy of a name is a third thing to disagree.',
      },
      photoUrl: { type: ['string', 'null'] },
      role: { type: ['integer', 'string', 'null'], description: 'Set by Servana. A self-writable role is a privilege-escalation endpoint.' },
      accountStatus: { type: ['string', 'null'] },
      isEmailVerified: { type: 'boolean' },
      isPhoneVerified: {
        type: 'boolean',
        description: 'Absent column means unverified. Never treat "we do not know" as verified.',
      },
      profiles: {
        type: 'array',
        description: 'Which role extension exists and WHERE to fetch it. Never its contents.',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['customer', 'provider'] },
            endpoint: { type: 'string' },
          },
        },
      },
    },
  },

  AccountPatch: {
    type: 'object',
    additionalProperties: false,
    description:
      'Only these fields. An unwritable field is REFUSED by name rather than dropped - silently ' +
      'ignoring `email` leaves the caller believing they changed a verified identifier.',
    properties: {
      firstName: { type: ['string', 'null'], maxLength: 255 },
      lastName: { type: ['string', 'null'], maxLength: 255 },
      displayName: { type: ['string', 'null'], maxLength: 255 },
      photoUrl: { type: ['string', 'null'], maxLength: 255 },
    },
  },

  AccountSettings: {
    type: 'object',
    required: ['locale', 'privacy', 'security', 'notifications'],
    description: 'Every declared setting is always present, from the account row or the catalog default.',
    properties: {
      locale: {
        type: 'object',
        properties: {
          locale: { type: 'string', description: 'BCP-47. Defaults to en-PH.' },
          timeZone: {
            type: 'string',
            description:
              'IANA. Servana operates in Asia/Manila and a booking at 08:00 local is 00:00 UTC, ' +
              'so getting this wrong moves a job across a day boundary.',
          },
        },
      },
      privacy: {
        type: 'object',
        properties: {
          profileDiscoverable: { type: 'boolean' },
          shareUsageAnalytics: {
            type: 'boolean',
            description: 'OFF by default. Privacy by default means the permissive value is the chosen one.',
          },
        },
      },
      security: {
        type: 'object',
        properties: {
          twoFactorEnabled: { type: 'boolean', description: 'READ-ONLY here. Enabling it is a credential ceremony.' },
        },
      },
      notifications: {
        type: 'object',
        description: 'A POINTER to the TAB 09 preference model, plus the current values for convenience.',
        properties: {
          endpoint: { type: 'string' },
          categories: { type: 'object', additionalProperties: { type: 'boolean' } },
        },
      },
    },
  },

  AccountSettingsPatch: {
    type: 'object',
    description:
      'A PARTIAL update; unnamed settings keep their value. Accepts the flat shape OR the ' +
      'grouped shape the GET returns, so a client can round-trip what it read. An unknown key ' +
      'is REFUSED rather than ignored.',
    properties: {
      locale: { type: 'string' },
      timeZone: { type: 'string' },
      profileDiscoverable: { type: 'boolean' },
      shareUsageAnalytics: { type: 'boolean' },
    },
  },

  AccountSecurity: {
    type: 'object',
    required: ['emailVerified', 'phoneVerified', 'twoFactorEnabled', 'actions'],
    description:
      'POSTURE, read-only. Every security ACTION has its own endpoint with its own proof of ' +
      'possession; `actions` names where each lives so a client need not hardcode it.',
    properties: {
      emailVerified: { type: 'boolean' },
      phoneVerified: { type: 'boolean' },
      twoFactorEnabled: { type: 'boolean' },
      passwordUpdatedAt: { type: ['string', 'null'], format: 'date-time' },
      activeDeviceCount: { type: 'integer' },
      actions: { type: 'object', additionalProperties: { type: 'string' } },
    },
  },

  ProfileCompletion: {
    type: 'object',
    required: ['role', 'percent', 'isComplete', 'canProceed', 'missing', 'blockedBy'],
    description:
      'BACKEND-derived. A client cannot compute this: document review state, service ' +
      'qualification and availability all live behind endpoints a welcome card does not call, ' +
      'and two of the three are what matching actually selects on.',
    properties: {
      uid: { type: 'string' },
      role: { type: 'string', enum: ['customer', 'provider'] },
      percent: {
        type: 'integer',
        description: 'Counts EVERY requirement including the cosmetic ones - what a progress bar means to a person.',
      },
      isComplete: { type: 'boolean' },
      canProceed: {
        type: 'boolean',
        description:
          'Counts only the BLOCKING requirements - what the product gates on. Conflating this ' +
          'with `percent` is how a client shows "80% complete" beside a button that does not work.',
      },
      satisfied: { type: 'array', items: { type: 'string' } },
      missing: { type: 'array', items: { type: 'string' } },
      blockedBy: { type: 'array', items: { type: 'string' } },
      next: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Canonical ENDPOINTS, not screen names - a screen name breaks when a client renames a route.',
      },
    },
  },

  CustomerProfile: {
    type: 'object',
    required: ['uid'],
    description: 'The customer EXTENSION only. The identity half is /me; duplicating it is how two endpoints disagree about a name.',
    properties: {
      uid: { type: 'string' },
      birthDate: { type: ['string', 'null'] },
      gender: { type: ['string', 'null'] },
      photoUrl: { type: ['string', 'null'] },
      defaultAddressId: { type: ['string', 'null'], description: 'Set through the address book, never here.' },
      addressCount: { type: 'integer' },
    },
  },

  CustomerProfilePatch: {
    type: 'object',
    additionalProperties: false,
    properties: {
      birthDate: { type: ['string', 'null'] },
      gender: { type: ['string', 'null'] },
      photoUrl: { type: ['string', 'null'] },
    },
  },

  Address: {
    type: 'object',
    required: ['addressId', 'isDefault'],
    description:
      'NAMED fields only. The row carries created_by/updated_by audit columns and the owner uid; ' +
      'naming the output publishes only what is named.',
    properties: {
      addressId: { type: 'string', description: 'user_address.address_id. Stable, and what every shipped client stores.' },
      label: { type: ['string', 'null'] },
      addressOne: { type: ['string', 'null'] },
      addressTwo: { type: ['string', 'null'] },
      postTown: { type: ['string', 'null'] },
      zipCode: { type: ['string', 'null'] },
      country: { type: ['string', 'null'] },
      locationId: { type: ['string', 'null'], description: 'Geocode handle. Drives coverage and distance pricing.' },
      isDefault: { type: 'boolean' },
      createdAt: { type: ['string', 'null'], format: 'date-time' },
      coordinates: {
        type: ['object', 'null'],
        properties: { lat: { type: 'number' }, lon: { type: 'number' } },
      },
    },
  },

  AddressList: {
    type: 'array',
    items: { $ref: '#/components/schemas/Address' },
    description: 'Default first. `meta.defaultAddressId` carries it so checkout needs one call.',
  },

  AddressInput: {
    type: 'object',
    additionalProperties: false,
    description: 'On PATCH an absent field means "leave it alone", never "clear it".',
    properties: {
      addressOne: { type: 'string', maxLength: 255 },
      addressTwo: { type: 'string', maxLength: 255 },
      postTown: { type: 'string', maxLength: 120 },
      zipCode: { type: 'string', maxLength: 20 },
      country: { type: 'string', maxLength: 80 },
      label: { type: 'string', maxLength: 60 },
      locationId: { type: 'string', maxLength: 128 },
      lat: { type: 'number' },
      lon: { type: 'number' },
      isDefault: { type: 'boolean' },
    },
  },

  AddressDeleteResult: {
    type: 'object',
    required: ['deleted'],
    properties: {
      deleted: { type: 'boolean' },
      promotedAddressId: {
        type: ['string', 'null'],
        description:
          'The successor promoted when the default was removed. An account with addresses is ' +
          'never left without a default.',
      },
    },
  },

  ProviderProfile: {
    type: 'object',
    required: ['uid', 'seat', 'visibleFields', 'fields', 'verification'],
    description:
      'Field-scoped by SEAT. `visibleFields` is on the wire so a client can tell a public view ' +
      'from its own rather than inferring it from which keys happen to be missing.',
    properties: {
      uid: { type: 'string' },
      seat: { type: 'string', enum: ['self', 'otherCustomer', 'admin'] },
      visibleFields: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Exactly the field ids this seat may read. A customer sees a field only when its ' +
          'classification AND the registry customerVisible flag agree - either can veto.',
      },
      fields: { type: 'object', additionalProperties: true },
      verification: {
        type: 'object',
        properties: {
          accountStatus: { type: ['string', 'null'], description: 'Withheld entirely from a customer seat.' },
          isEmailVerified: { type: 'boolean' },
          documentsAccepted: { type: 'integer', description: 'Zero at a customer seat.' },
          documentsRequired: { type: 'integer', description: 'Zero at a customer seat.' },
          documentsComplete: { type: 'boolean' },
        },
      },
    },
  },

  ProviderProfilePatch: {
    type: 'object',
    required: ['clientRequestId'],
    additionalProperties: false,
    description:
      'Not a write - it proposes a revision for review. Only registry fields marked ' +
      'editable: review are accepted.',
    properties: {
      clientRequestId: {
        type: 'string',
        minLength: 16,
        maxLength: 128,
        description:
          'REQUIRED. Without it a provider on a flaky connection queues three copies of one ' +
          'biography change for a human to review.',
      },
      displayName: { type: 'string' },
      biography: { type: 'string' },
      skills: { type: 'array', items: { type: 'string' } },
      languages: { type: 'array', items: { type: 'string' } },
      experienceSummary: { type: 'string' },
    },
  },

  ProviderProfileRevision: {
    type: 'object',
    required: ['submitted', 'status'],
    properties: {
      submitted: { type: 'array', items: { type: 'string' } },
      status: { type: 'string', enum: ['PENDING_REVIEW'] },
    },
  },

  ProviderDocumentList: {
    type: 'array',
    description:
      'REVIEW STATE, never content. No URL and no storage path appears here; the preview ' +
      'endpoint mints a short-lived signed URL after re-authorizing, which is a different ' +
      'operation with a different audit trail.',
    items: {
      type: 'object',
      required: ['documentType', 'required', 'status'],
      properties: {
        requirementId: { type: 'string' },
        documentType: { type: 'string', description: 'From the document catalog, backed by worker_requirements.' },
        name: { type: 'string' },
        category: { type: 'string' },
        required: { type: 'boolean' },
        status: {
          type: 'string',
          description: '`missing` when the catalog requires it and nothing has been submitted.',
        },
        submittedAt: { type: ['string', 'null'], format: 'date-time' },
        expiresAt: { type: ['string', 'null'], format: 'date-time' },
        reviewNote: { type: ['string', 'null'] },
      },
    },
  },

  ProviderDocumentTypeCatalog: {
    type: 'object',
    description: 'Static policy: what may be submitted and which are required.',
    properties: {
      version: { type: 'integer' },
      documentTypes: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
  },

  ProviderDocumentUpload: {
    type: 'object',
    required: ['documentTypeId', 'fileName', 'file', 'clientRequestId'],
    properties: {
      documentTypeId: { type: 'string', description: 'From the document catalog.' },
      fileName: { type: 'string' },
      file: {
        type: 'string',
        description:
          'data: URI. Validated by SIGNATURE against an allowlist and a size ceiling, so a ' +
          'renamed executable is refused on its contents rather than its declared type.',
      },
      clientRequestId: {
        type: 'string',
        description:
          'REQUIRED. Unique per provider - a retried submit returns the ORIGINAL row rather ' +
          'than queueing a second copy of the same passport for review.',
      },
      issueDate: { type: ['string', 'null'], format: 'date' },
      expiresAt: { type: ['string', 'null'], format: 'date' },
      identifierLast4: { type: ['string', 'null'] },
      replacementForId: {
        type: ['integer', 'null'],
        description: 'The requirement this supersedes, when re-submitting after a rejection.',
      },
    },
  },

  ProviderDocument: {
    type: 'object',
    description: 'Review STATE for one submitted document. No storage path is projected.',
    properties: {
      requirementId: { type: 'string' },
      documentType: { type: 'string' },
      status: { type: 'string' },
      submittedAt: { type: ['string', 'null'], format: 'date-time' },
      expiresAt: { type: ['string', 'null'], format: 'date-time' },
      reviewNote: { type: ['string', 'null'] },
    },
  },

  ProviderDocumentPreview: {
    type: 'object',
    description:
      'A SHORT-LIVED signed URL. The response carries no-store headers because a browser or ' +
      'intermediary that retains it turns a brief grant into a durable one.',
    properties: {
      url: { type: 'string' },
      expiresAt: { type: ['string', 'null'], format: 'date-time' },
      mimeType: { type: ['string', 'null'] },
    },
  },

  ProviderDocumentMutation: {
    type: 'object',
    properties: { deleted: { type: 'boolean' } },
  },

  ProviderAvailability: {
    type: 'object',
    required: ['timezone', 'weeklySchedule'],
    description: 'The SAME engine matching consumes. That equality is the release gate.',
    properties: {
      timezone: { type: 'string' },
      weeklySchedule: { type: 'array', items: { type: 'object', additionalProperties: true } },
      version: { type: ['integer', 'null'] },
      updatedAt: { type: ['string', 'null'], format: 'date-time' },
      hasUsableSchedule: { type: 'boolean', description: 'What matching needs: at least one usable window.' },
    },
  },

  ProviderAvailabilityPatch: {
    type: 'object',
    required: ['slots'],
    additionalProperties: false,
    description: 'REPLACES the week, which is why it is idempotent: the same body twice reaches the same schedule.',
    properties: {
      slots: { type: 'array', items: { type: 'object', additionalProperties: true } },
      timezone: { type: 'string' },
      expectedVersion: {
        type: 'integer',
        description: 'Optimistic concurrency. What stops two devices silently overwriting each other.',
      },
    },
  },

  ProviderServiceList: {
    type: 'array',
    description:
      'Keyed on services.id - the Catalog V2 canonical specific-service identity - never on a ' +
      'service family. A provider service list keyed on a family is how the family becomes the ' +
      'bookable identity again.',
    items: {
      type: 'object',
      required: ['serviceId', 'isActive'],
      properties: {
        serviceId: { type: 'integer' },
        name: { type: ['string', 'null'] },
        status: { type: 'string' },
        isActive: { type: 'boolean' },
      },
    },
  },

  // ── Post-service trust (TAB 12) ───────────────────────────────────────────
  //
  // A review is grounded in a booking. There is no provider field in the input,
  // because the provider is resolved from the COMPLETED assignment - which makes
  // "do not accept arbitrary providerId + rating as authority" a property of the
  // schema rather than a validation rule.

  ReviewInput: {
    type: 'object',
    required: ['overallRating'],
    additionalProperties: false,
    description:
      'No providerId, no authorId, no rating subject. The booking in the path decides all ' +
      'three, so there is nothing here a caller could assert authority with.',
    properties: {
      overallRating: { type: 'integer', minimum: 1, maximum: 5 },
      dimensions: {
        type: 'object',
        additionalProperties: { type: 'integer', minimum: 1, maximum: 5 },
        description:
          'Keyed by dimension. A service may configure its own set in ' +
          'service_review_dimensions, keyed on services.id; otherwise the canonical six apply.',
      },
      publicComment: { type: ['string', 'null'], maxLength: 2000 },
      privateFeedback: {
        type: ['string', 'null'],
        maxLength: 2000,
        description:
          'Addressed to Servana, NOT to the provider. It never appears in a provider or public ' +
          'projection - a customer who writes that a provider made them uncomfortable has not ' +
          'consented to that reaching them.',
      },
      visibility: { type: 'string', enum: ['PUBLIC', 'ANONYMOUS_PUBLIC', 'PRIVATE'] },
      clientRequestId: {
        type: 'string',
        maxLength: 128,
        description: 'Replays the original review rather than creating a second.',
      },
    },
  },

  Review: {
    type: 'object',
    required: ['reviewId', 'overallRating'],
    properties: {
      reviewId: { type: 'string' },
      bookingId: { type: ['string', 'null'], description: "Author and admin only." },
      overallRating: { type: 'integer' },
      dimensions: { type: 'object', additionalProperties: { type: 'integer' } },
      publicComment: { type: ['string', 'null'] },
      privateFeedback: { type: ['string', 'null'], description: 'AUTHOR and admin only.' },
      visibility: { type: 'string' },
      publicationState: { type: 'string' },
      moderationStatus: { type: ['string', 'null'], description: 'Admin only in public reads.' },
      createdAt: { type: ['string', 'null'], format: 'date-time' },
      editedAt: { type: ['string', 'null'], format: 'date-time' },
      editableUntil: { type: ['string', 'null'], format: 'date-time' },
    },
  },

  ReviewEligibility: {
    type: 'object',
    required: ['bookingId', 'eligible'],
    description:
      'Why a review may or may not be written. Returned alongside the read so a client does ' +
      'not offer a form the next call refuses.',
    properties: {
      bookingId: { type: 'string' },
      eligible: { type: 'boolean' },
      reason: {
        type: ['string', 'null'],
        description:
          'The rule that refused. Distinguishing "not finished yet" from "too late" matters: ' +
          'they are opposite situations and telling a customer the wrong one sends them away.',
      },
      reviewId: { type: ['string', 'null'] },
      reviewWindow: {
        type: ['object', 'null'],
        properties: {
          opensAt: { type: 'string', format: 'date-time' },
          closesAt: { type: 'string', format: 'date-time' },
        },
      },
      editableUntil: { type: ['string', 'null'], format: 'date-time' },
      availableActions: { type: 'array', items: { type: 'string' } },
    },
  },

  ReviewOrEligibility: {
    type: 'object',
    description: 'Exactly one of the two is non-null.',
    properties: {
      review: { oneOf: [{ $ref: '#/components/schemas/Review' }, { type: 'null' }] },
      eligibility: { oneOf: [{ $ref: '#/components/schemas/ReviewEligibility' }, { type: 'null' }] },
    },
  },

  SupportCaseInput: {
    type: 'object',
    required: ['category', 'summary'],
    additionalProperties: false,
    properties: {
      category: {
        type: 'string',
        enum: ['SERVICE_QUALITY', 'INCOMPLETE_WORK', 'PROPERTY_DAMAGE', 'SAFETY_CONCERN', 'BILLING'],
        description:
          'BILLING is accepted and ROUTED to the finance domain rather than handled here - ' +
          'handling it would fork the refund rules into a second, weaker path.',
      },
      summary: { type: 'string', maxLength: 200 },
      detail: { type: ['string', 'null'], maxLength: 4000 },
      clientRequestId: { type: 'string', maxLength: 200 },
    },
  },

  SupportCase: {
    type: 'object',
    required: ['caseId', 'bookingId', 'category', 'routedTo', 'state'],
    properties: {
      caseId: { type: 'string' },
      bookingId: { type: 'integer', description: 'bookings.id' },
      category: { type: 'string' },
      severity: {
        type: 'string',
        enum: ['normal', 'elevated'],
        description:
          'Damage and safety are elevated: one has a financial exposure and the other may ' +
          'involve somebody being unsafe in their own home.',
      },
      routedTo: { type: 'string', enum: ['support', 'finance'] },
      state: { type: 'string' },
      summary: { type: 'string' },
      createdAt: { type: ['string', 'null'], format: 'date-time' },
      nextEndpoint: {
        type: ['string', 'null'],
        description:
          'Present when routedTo is finance: the canonical endpoint that actually issues a ' +
          'refund. The case records the complaint; it does not move money.',
      },
    },
  },

  SupportCaseList: {
    type: 'array',
    items: { $ref: '#/components/schemas/SupportCase' },
  },

  // ── Planned. Documented so the migration matrix can name a successor. ──────
  // ── Home composition (TAB 11) ─────────────────────────────────────────────
  //
  // A READ MODEL. Every card is a REFERENCE to a canonical id, and the homepage
  // owns none of the data it aggregates. The section envelope is what makes
  // partial failure renderable: a failed section arrives as `unavailable` with a
  // code, and the rest of the page is unaffected.

  HomeServiceCard: {
    type: 'object',
    required: ['serviceId', 'ref', 'name'],
    description:
      'Keyed on services.id - the Catalog V2 canonical specific-service identity - with the ' +
      'hierarchy travelling alongside so a client renders a breadcrumb without a second call. ' +
      'No service_family_id and no legacy option id appears.',
    properties: {
      serviceId: { type: 'integer', description: 'services.id' },
      ref: { type: 'string', description: 'The qualified catalog reference, e.g. service:180.' },
      name: { type: 'string' },
      slug: { type: ['string', 'null'] },
      imageUrl: { type: ['string', 'null'] },
      categoryId: { type: ['integer', 'null'] },
      categoryName: { type: ['string', 'null'] },
      subcategoryId: { type: ['integer', 'null'] },
      subcategoryName: { type: ['string', 'null'] },
      basePrice: {
        type: ['number', 'null'],
        description: 'From the catalog projection UNCHANGED. The homepage never recomputes a price.',
      },
      basePriceSummary: { type: ['string', 'null'] },
      bookable: { type: 'boolean' },
    },
  },

  HomeCategoryCard: {
    type: 'object',
    required: ['categoryId', 'ref', 'name'],
    properties: {
      categoryId: { type: 'integer', description: 'catalog_categories.id' },
      ref: { type: 'string' },
      name: { type: 'string' },
      serviceCount: { type: 'integer' },
      subcategoryCount: { type: 'integer' },
    },
  },

  HomeBookingCard: {
    type: 'object',
    required: ['bookingId', 'canonicalState'],
    description:
      'The CANONICAL booking state and its customer projection - the same derivation every ' +
      'other customer surface uses. The homepage declares no status vocabulary of its own; a ' +
      'four-value homepage enum over an eleven-state machine says "in progress" for three ' +
      'different situations.',
    properties: {
      bookingId: { type: 'integer', description: 'bookings.id' },
      bookingCode: { type: 'string', description: 'SVN-000075.' },
      canonicalState: { type: 'string' },
      label: { type: 'string', description: 'The customer-facing copy for that state.' },
      terminal: { type: 'boolean' },
      availableActions: { type: 'array', items: { type: 'string' } },
      scheduledAt: { type: ['string', 'null'], format: 'date-time' },
      serviceId: { type: ['integer', 'null'], description: 'services.id' },
      serviceName: { type: ['string', 'null'] },
    },
  },

  HomeSection: {
    type: 'object',
    required: ['type', 'status', 'items'],
    description:
      'One section, always present when requested. `items` is never absent - an unavailable ' +
      'section carries an empty array and a reason, so a client renders a gap rather than ' +
      'crashing on a missing key.',
    properties: {
      type: {
        type: 'string',
        enum: [
          'categories', 'featuredServices', 'popularServices', 'recentServices',
          'activeBooking', 'banners', 'notificationSummary',
        ],
      },
      status: { type: 'string', enum: ['ok', 'unavailable'] },
      items: { type: 'array', items: { type: 'object', additionalProperties: true } },
      reason: {
        type: ['string', 'null'],
        enum: ['EMPTY', 'UNAVAILABLE', 'NOT_CONFIGURED', 'REQUIRES_AUTH', null],
        description:
          'EMPTY and UNAVAILABLE are different facts a client should render differently: an ' +
          'empty recents list is a new customer, an unavailable one is a backend that failed. ' +
          'Collapsing them shows "no recent services" to somebody who has ten.',
      },
      ttlSeconds: { type: 'integer', description: 'How long this section may be cached. 0 means never.' },
    },
  },

  HomeFeed: {
    type: 'object',
    required: ['sections'],
    description:
      'A composition. `meta.unavailable` names the sections that failed, so a client can tell ' +
      'a partial page from a complete one. Cache-Control is derived from the sections PRESENT: ' +
      'anything personal makes the whole response private, no-store.',
    properties: {
      sections: { type: 'array', items: { $ref: '#/components/schemas/HomeSection' } },
    },
  },

  HomeSectionRegistry: {
    type: 'array',
    description:
      'METADATA about the page, not content. It names no account and no resource, so it caches ' +
      'like the catalog it describes. A client uses it to render an unknown section safely, ' +
      'which is what makes the registry append-only in practice as well as in principle.',
    items: {
      type: 'object',
      required: ['type', 'audience', 'ownedBy'],
      properties: {
        type: { type: 'string' },
        audience: {
          type: 'string',
          enum: ['public', 'personal'],
          description: 'The axis that decides caching. Getting it wrong is how one customer sees another.',
        },
        failureMode: { type: 'string', enum: ['optional', 'required'] },
        ownedBy: {
          type: 'string',
          description: 'WHICH canonical service owns this data. The homepage owns none of it.',
        },
        referenceId: { type: ['string', 'null'], description: 'The canonical id each item carries.' },
        ttlSeconds: { type: 'integer' },
        maxItems: { type: 'integer' },
        description: { type: 'string' },
      },
    },
  },
  EarningsSummary: { type: 'object', description: 'PLANNED — owned by the provider-earnings domain command.' },
  AdminBookingList: { type: 'object', description: 'PLANNED — owned by the admin-bookings domain command.' },
  AssignmentCandidatePool: {
    type: 'object',
    description:
      'PLANNED — the ranked candidate list under `data`, plus `diagnostics`: population, '
      + 'evaluated, the cap applied, how many providers hold the service at all, the dominant '
      + 'blocker and a zero-candidate reason code. Shaped by services/booking/candidateDiagnostics.',
  },
  AdminAssignRequest: { type: 'object', description: 'PLANNED — providerUid and an optional reason.' },
  AdminReassignRequest: { type: 'object', description: 'PLANNED — providerUid and a REQUIRED reason; the override is audited.' },
  AdminBookingActionResult: { type: 'object', description: 'PLANNED — the canonical booking projection after the transition.' },
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
