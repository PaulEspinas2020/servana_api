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
      total: {
        type: 'integer',
        minimum: 0,
        description:
          'The EXACT size of the filtered set, never null. This was previously declared '
          + '`integer | null` with the note "null when the total is not cheaply knowable" — '
          + 'a hedge against a cost nothing in this API pays. All four list endpoints derive '
          + 'it from a real count: three from an array length, and the reviews list from '
          + 'COUNT(*)::int, which parses to a JS number BECAUSE of the ::int cast (a bare '
          + 'COUNT(*) is bigint and node-postgres would hand back a string). So the nullable '
          + 'half was never reachable, and every client declared plain number anyway.'
          + ' '
          + 'If a total ever does become expensive, send a capped or estimated NUMBER and add '
          + 'a sibling totalIsEstimate flag beside it — do not reintroduce null. That flag is '
          + 'deliberately absent today: a field no producer ever sets is one every client '
          + 'branches on for nothing. See TAB 06.',
      },
      hasMore: { type: 'boolean' },
    },
  },

  TelemetryIngestRequest: {
    type: 'object',
    description:
      'A batch of scrubbed events. Unknown keys are DROPPED server-side rather than rejected, '
      + 'so one bad key in a batch does not cost the batch. There is deliberately no free-text '
      + 'field: a reporter that accepts a stack trace accepts whatever the strings in it happen '
      + 'to contain, which on this app includes addresses and signed URLs.',
    required: ['events'],
    properties: {
      events: {
        type: 'array',
        maxItems: 50,
        items: {
          type: 'object',
          required: ['event'],
          properties: {
            event: {
              type: 'string',
              enum: [
                'activationStarted', 'activationCompleted', 'jobOffered', 'jobAccepted',
                'jobStarted', 'jobCompleted', 'actionFailed',
              ],
            },
            flavor: { type: 'string' },
            appVersion: { type: 'string' },
            buildNumber: { type: 'string' },
            bookingRef: { type: 'string', description: 'An opaque reference. Never a customer name or address.' },
            failureClass: { type: 'string' },
            httpStatus: { type: 'integer' },
            attempt: { type: 'integer' },
            durationMs: { type: 'integer' },
            jobState: { type: 'string' },
          },
        },
      },
    },
  },

  TelemetryIngestResult: {
    type: 'object',
    required: ['accepted', 'dropped', 'rejected'],
    properties: {
      accepted: { type: 'integer', description: 'Events stored.' },
      dropped: { type: 'integer', description: 'Keys the server refused. Names are counted; values never leave the request.' },
      rejected: { type: 'integer', description: 'Events discarded whole — unknown name, wrong shape, or over the batch cap.' },
    },
  },

  ClientConfig: {
    type: 'object',
    description:
      'The client recall lever. `minimumSupported` is the version below which a client must '
      + 'refuse to run; `latestAvailable` never blocks. `source` is `default` when the '
      + 'configuration file was absent or unusable, which means the permissive 0.0.0 floor is '
      + 'in force and any configured recall is NOT being applied.',
    required: ['platforms', 'source'],
    properties: {
      platforms: {
        type: 'object',
        required: ['ios', 'android'],
        properties: {
          ios: { $ref: '#/components/schemas/ClientPlatformConfig' },
          android: { $ref: '#/components/schemas/ClientPlatformConfig' },
        },
      },
      source: { type: 'string', enum: ['config', 'default'] },
    },
  },

  ClientPlatformConfig: {
    type: 'object',
    required: ['minimumSupported', 'latestAvailable', 'message'],
    properties: {
      minimumSupported: { type: 'string', description: 'MAJOR.MINOR.PATCH. A client at exactly this version is supported.' },
      latestAvailable: { type: 'string', description: 'MAJOR.MINOR.PATCH. Informational; never a reason to block.' },
      message: { type: 'string', description: 'Shown verbatim when the client blocks.' },
    },
  },

  BuildInfo: {
    type: 'object',
    description:
      'Build provenance. Four fields and nothing else — no environment, no dependency '
      + 'liveness, no internal versions. `available` is false when no stamp was found, '
      + 'which happens on a first deploy or a cleaned workspace; the other fields are '
      + 'then null and the response is still 200, because absence is an answer.',
    required: ['commit', 'ref', 'builtAt', 'run', 'available'],
    properties: {
      commit: { type: ['string', 'null'] },
      ref: { type: ['string', 'null'] },
      builtAt: { type: ['string', 'null'] },
      run: { type: ['string', 'null'] },
      available: { type: 'boolean' },
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
          addons: { type: 'array', items: { $ref: '#/components/schemas/CatalogAddon' } },
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
      state: {
        oneOf: [
          { $ref: '#/components/schemas/CustomerBookingState' },
          { $ref: '#/components/schemas/ProviderBookingState' },
        ],
        description:
          'The caller-appropriate projection of the new state, so a client never has to '
          + 'derive it. WHICH of the two arrives is decided by the caller seat, not by the '
          + 'booking: a customer gets CustomerBookingState, a provider or admin gets '
          + 'ProviderBookingState. The two are not interchangeable — one carries `detail` '
          + 'and the other `nextAction`.',
      },
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

  Booking: {
    type: 'object',
    required: ['bookingId', 'bookingCode', 'status', 'effectiveStatus'],
    additionalProperties: true,
    description:
      'A booking as produced by bookingService.formatBooking.'
      + ' '
      + 'AN OPEN SHAPE, and deliberately declared as one. formatBooking spreads the whole '
      + 'camelCased database row — `{ ...toCamel(raw) }` — and getBookingById selects '
      + '`b.*` plus a dozen joined aliases, so the wire carries every column of `bookings` '
      + 'and then some. The properties below are the fields the FORMATTER itself '
      + 'guarantees; everything else is whatever the query selected that day. '
      + 'additionalProperties is true because saying otherwise would be a lie, not because '
      + 'the extra fields are unknowable.'
      + ' '
      + 'Note what this means for the v1 parity exemption: /api/v1 is exempt from '
      + 'parityMiddleware so that a declared shape IS the wire, but formatBooking adds its '
      + 'own aliases one layer down — bookingId, scheduleAt AND scheduledAt, providerUid, '
      + 'customerId AND customerUid, statusLower, assignmentStatus. The exemption stops '
      + 'the middleware, not the habit.'
      + ' '
      + 'CREDENTIALS ARE NOT IN THIS SHAPE. `bookings` stores otp_code and worker_code, '
      + 'and the spread used to disclose both to every caller with booking access — '
      + 'including the assigned provider, for whom worker_code is the doorstep proof they '
      + 'are supposed to be GIVEN. formatBooking now omits them unless a caller that has '
      + 'established the actor opts in. See tests/booking-credential-disclosure.test.ts.',
    properties: {
      bookingId: { type: 'integer', description: 'Added by the formatter when the row carries only `id`.' },
      id: { type: 'integer', description: 'The raw primary key. Present because the row is spread.' },
      bookingCode: {
        type: 'string',
        description: 'Human-readable, SVN-XXXXXX, derived from the id when the row has none.',
      },
      status: { type: 'string', description: 'The raw bookings.status column, uppercase as stored.' },
      statusLower: {
        type: 'string',
        description: 'The same value lowercased, added for platforms that normalise. Not a second state.',
      },
      effectiveStatus: {
        type: 'string',
        description:
          'DERIVED by deriveEffectiveBookingStatus from status and worker_status together. '
          + 'The only status field here that reconciles the two columns.',
      },
      scheduleAt: { $ref: '#/components/schemas/UtcTimestamp' },
      scheduledAt: {
        oneOf: [{ $ref: '#/components/schemas/UtcTimestamp' }],
        description: 'The SAME value as scheduleAt. Two names for one column, both emitted.',
      },
      providerUid: { type: ['string', 'null'], description: 'Alias of worker_uid.' },
      workerUid: { type: ['string', 'null'] },
      customerUid: { type: ['string', 'null'], description: 'Alias of user_id.' },
      customerId: {
        type: ['string', 'null'],
        description: 'The SAME value as customerUid. A string uid despite the name.',
      },
      assignmentStatus: { type: ['string', 'null'], description: 'Alias of booking_workers.status.' },
      workerStatus: { type: ['string', 'null'] },
    },
  },

  BookingList: {
    type: 'object',
    required: ['bookings'],
    properties: { bookings: { type: 'array', items: { $ref: '#/components/schemas/Booking' } } },
  },

  BookingTimeline: {
    type: 'object',
    required: ['timeline'],
    description:
      'Operational history, voiced for the customer. Not the audit record (§16).'
      + '\n\nCORRECTED. This schema declared `timeline` as an ARRAY of untyped objects. '
      + 'The handler answers ok(res, req, { timeline }) where timeline is the RETURN of '
      + 'bookingService.getCustomerBookingTimeline — an OBJECT carrying { bookingId, '
      + 'events, currentStep }. A client generated from the previous declaration would '
      + 'have iterated `timeline` and found nothing, with no error anywhere. Nothing '
      + 'caught it because `items: { type: object }` generates as an empty object, so no '
      + 'client could bind tightly enough to notice the OUTER type was wrong either. '
      + 'The wire is unchanged; the document now matches it.',
    properties: {
      timeline: {
        type: 'object',
        required: ['bookingId', 'events'],
        properties: {
          bookingId: { type: 'integer' },
          events: {
            type: 'array',
            description: 'Oldest first, from projectTimelineForCustomer.',
            items: { $ref: '#/components/schemas/CustomerTimelineEvent' },
          },
          currentStep: {
            type: ['string', 'null'],
            description:
              'The code of the LAST event, or null when there are none. Derived, not stored.',
          },
        },
      },
    },
  },
  CustomerTimelineEvent: {
    type: 'object',
    required: ['code', 'label', 'actor', 'sequence'],
    description:
      'One timeline entry as the CUSTOMER sees it. Only `event_type` and `created_at` '
      + 'cross from booking_timeline_events: `title`, `description` and `metadata` there '
      + 'are admin-authored and must never reach a customer.',
    properties: {
      code: { type: 'string', description: 'The event code. Stable; the label is not.' },
      label: {
        type: 'string',
        description:
          'Customer-voiced, never a backend transition name (§5). PROVIDER_DECLINED '
          + 'deliberately does not say the professional refused — §14 forbids exposing '
          + 'declined providers.',
      },
      at: { $ref: '#/components/schemas/UtcTimestamp' },
      actor: {
        type: 'string',
        description: "Falls back to 'SERVANA' when the provider seat does not map to a customer-facing actor.",
      },
      sequence: { type: 'integer' },
    },
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
      verdict: {
        type: 'object',
        required: ['allowed', 'refusal', 'noticeHours', 'reasons'],
        description:
          'The policy verdict, including the notice window that applied to this actor. '
          + 'From experiencePolicy.evaluateReschedule, which decides everything reachable '
          + 'WITHOUT the provider calendar. PROVIDER_CONFLICT is deliberately not decided '
          + 'there — it needs a query — so `allowed: true` here does not mean the '
          + 'reschedule succeeded, only that policy did not refuse it.',
        properties: {
          allowed: { type: 'boolean' },
          refusal: { type: ['string', 'null'], description: 'The refusal code when allowed is false.' },
          noticeCutoff: {
            type: ['string', 'null'],
            format: 'date-time',
            description: 'The earliest instant this actor could still have moved it to.',
          },
          noticeHours: { type: 'integer', description: 'The notice window that applied to THIS actor.' },
          reasons: { type: 'array', items: { type: 'string' } },
        },
      },
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
        allOf: [{ $ref: '#/components/schemas/AdditionalWorkRequest_Row' }],
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
      requests: { type: 'array', items: { $ref: '#/components/schemas/AdditionalWorkRequest_Row' } },
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
    required: ['bookingId', 'canonicalState', 'customer', 'address', 'availableActions'],
    description:
      'One job as the assigned provider sees it, from controllers/jobCardView.formatJobCard.'
      + ' '
      + 'An EXPLICIT allow-list, unlike Booking: the formatter names every field it emits, '
      + 'which is why the one-time codes on the booking row never reached this response '
      + 'even when the same columns were leaking through formatBooking. That is the '
      + 'argument bookingPaymentService.projectFor makes in this codebase — an additive '
      + 'projection discloses only what it names.'
      + ' '
      + 'DISCLOSURE IS TIERED. Customer identity and the exact address appear only after '
      + 'the provider has accepted; before that the name is masked and the address narrows '
      + 'to city and country; and a relinquished job discloses neither. So a null here is '
      + 'frequently "not yet entitled", not "not recorded".',
    properties: {
      bookingId: { type: 'integer' },
      workerId: { type: ['string', 'null'] },
      status: { type: 'string', description: 'DEPRECATED — raw bookings.status. Read canonicalState.' },
      workerStatus: { type: ['string', 'null'], description: 'DEPRECATED — raw booking_workers.status.' },
      scheduleAt: { $ref: '#/components/schemas/UtcTimestamp' },
      paymentMethod: { type: ['string', 'null'] },
      paymentStatus: { type: ['string', 'null'] },
      customer: {
        type: 'object',
        description: 'Masked until the job is accepted; emptied when it is relinquished.',
        properties: {
          uid: { type: ['string', 'null'] },
          name: { type: 'string', description: 'Masked before acceptance; empty string once relinquished.' },
          phone: { type: ['string', 'null'], description: 'NULL until the job is accepted.' },
        },
      },
      address: {
        type: 'object',
        description:
          'Before acceptance only city, country and label are disclosed. Coordinates come '
          + 'from the stored point and are never fabricated from a city centre — a null lat '
          + 'means no exact point was recorded, not that one was approximated.',
        properties: {
          addressOne: { type: ['string', 'null'] },
          addressTwo: { type: ['string', 'null'] },
          city: { type: ['string', 'null'] },
          zipCode: { type: ['string', 'null'] },
          country: { type: ['string', 'null'] },
          label: { type: ['string', 'null'] },
          instructions: { type: ['string', 'null'] },
          lat: { type: ['number', 'null'] },
          lng: { type: ['number', 'null'] },
        },
      },
      service: {
        type: 'object',
        properties: { name: { type: ['string', 'null'] }, type: { type: ['string', 'null'] } },
      },
      addOns: { description: 'The pricing_breakdown jsonb, passed through unshaped.' },
      assignedAt: { $ref: '#/components/schemas/UtcTimestamp' },
      startedAt: { $ref: '#/components/schemas/UtcTimestamp' },
      completedAt: { $ref: '#/components/schemas/UtcTimestamp' },
      canonicalState: { type: 'string' },
      stateLabel: { type: 'string', description: 'Provider voice: what they do next, not what the booking is.' },
      nextAction: { type: ['string', 'null'] },
      terminal: { type: 'boolean' },
      availableActions: {
        type: 'array',
        items: { type: 'string' },
        description:
          'GENERATED from the transition whitelist, not switched on a raw status string. '
          + 'Where the two status columns disagree it answers about the BOOKING: a booking '
          + 'cancelled while the assignment row still read ACCEPTED is read-only here, and '
          + 'used to offer MARK_EN_ROUTE.',
      },
    },
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
    required: ['reportId'],
    description:
      'The RECEIPT for a message reported to moderation — not the report itself, and not '
      + 'a moderation queue row.'
      + ' '
      + 'TAB 07 reports that this name "describes a different object" from the admin '
      + 'portal DTO of the same name, and that two objects are travelling under one name. '
      + 'Both halves are true and neither side is wrong; they are describing DIFFERENT '
      + 'ENDPOINTS ON DIFFERENT TREES.'
      + ' '
      + 'This schema is the 201 from POST /api/v1/conversations/{id}/messages/{id}/report, '
      + 'and chat.service.reportMessage is typed `Promise<{ reportId: string }>` and returns '
      + '`{ reportId: String(report.id) }`. One field is the whole answer: the filer needs a '
      + 'handle, not the queue.'
      + ' '
      + 'What the portal holds is a MODERATION QUEUE ROW, from '
      + 'GET /api/admin/communications/reports on the legacy admin tree — id, messageId, '
      + 'reportedByUid, reason, messageBody, conversationId, status, resolvedByUid, '
      + 'resolvedAt, resolutionNote, createdAt. That entity is published as '
      + '`AdminMessageReport` in docs/api/openapi.admin.json so the collision cannot '
      + 'persist. Note it answers camelCase from a mapper, while the PATCH on the same '
      + 'entity returns the raw snake_case row — see TAB 01.'
      + ' '
      + 'reportId is REQUIRED: the service cannot return without it, and an optional field '
      + 'that is always present teaches every client to null-check for nothing.',
    properties: {
      reportId: {
        type: 'string',
        description:
          'A STRING — chat_message_reports.id wrapped in String() by the service. The '
          + 'admin queue row exposes the same key as an INTEGER `id`, unstringified. Two '
          + 'representations of one row, and the reason each is declared where it is used.',
      },
    },
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
    properties: {
      reviews: { type: 'array', items: { $ref: '#/components/schemas/PublicReview' } },
      total: { type: 'integer', description: 'An exact COUNT(*)::int over the same filters. Never null.' },
    },
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
          basePriceMinor: { type: 'integer' },
          additionalWork: { type: 'number', description: 'Charged through its own checkout.' },
          additionalWorkMinor: { type: 'integer' },
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
          refundedAmountMinor: { type: 'integer' },
          refundedAt: { type: ['string', 'null'], format: 'date-time' },
          refundable: { type: 'number', description: 'Captured minus already refunded. Never below zero.' },
          refundableMinor: { type: 'integer' },
        },
      },
      provider: {
        type: 'object',
        required: ['uid', 'economicModel', 'payable', 'isEstimate'],
        description:
          'ADMIN only. Present because projectFor builds an explicit per-actor DTO rather '
          + 'than deleting fields from a shared object — a subtractive projection discloses '
          + 'every field somebody forgets to remove. Read from financeLedger.provider.',
        properties: {
          uid: { type: ['string', 'null'] },
          economicModel: {
            type: 'string',
            enum: ['EXTERNAL_PROVIDER', 'INTERNAL_FIXER'],
            description: 'An INTERNAL_FIXER earns nothing; the whole gross is Servana revenue.',
          },
          payable: {
            type: 'number',
            description:
              'What the provider is owed, in PHP major units. ZERO for an internal fixer, '
              + 'always — and withheldReason then says why. See TAB 04 on money units.',
          },
          payableMinor: { type: 'integer' },
          isEstimate: {
            type: 'boolean',
            description:
              'FALSE means `payable` came from a real disbursement row; TRUE means it was '
              + 'derived from the split and the actual payout has not been written yet.',
          },
          withheldReason: {
            type: ['string', 'null'],
            description: 'Present when the model earns nothing, so a zero is never unexplained.',
          },
        },
      },
      servana: {
        type: 'object',
        required: ['revenue', 'commissionRate'],
        description: 'ADMIN only — the retained revenue and commission rate.',
        properties: {
          revenue: {
            type: 'number',
            description:
              'Everything not owed to the provider, in PHP major units. The WHOLE gross for '
              + 'an internal fixer.',
          },
          revenueMinor: { type: 'integer' },
          commissionRate: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description:
              'A FRACTION of gross in [0, 1], not a percentage. 0.2 means 20%. The value is '
              + 'SERVANA_COMMISSION_RATE in services/revenueSplit.ts, and its sibling '
              + 'PROVIDER_SHARE_RATE is 0.8 — the two sum to exactly 1, which is what settles '
              + 'the unit beyond argument. tests/revenue-split asserts that sum.'
              + ' '
              + 'TWO VALUES REACH THE WIRE TODAY, and the second one matters: financePolicy '
              + 'splitFor returns SERVANA_COMMISSION_RATE for an EXTERNAL_PROVIDER and '
              + 'exactly 1 for an INTERNAL_FIXER, who earns no job share so Servana retains '
              + 'the whole gross. So 1 is a REAL value, not a theoretical edge — which is '
              + 'precisely where the magnitude heuristic `rate <= 1 ? rate * 100 : rate` is '
              + 'ambiguous, because 1 could be read as 100% or as 1%. Read it as a fraction '
              + 'and 1 is 100%, which is what an internal fixer means. Never infer the unit '
              + 'from the magnitude.'
              + ' '
              + 'Contrast providerSharePercent on ProviderEarningsTransactions, which is a '
              + 'whole-number PERCENT in [0, 100] on this same API. See TAB 05.',
          },
        },
      },
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
        providerSharePercent: {
          type: 'integer',
          minimum: 0,
          maximum: 100,
          description:
            'A WHOLE-NUMBER PERCENTAGE in [0, 100]. 80 means 80%. It is NOT a fraction, '
            + 'and this is the field on which that has already gone wrong once: '
            + 'providerController records that Provider Web kept its own constant named '
            + 'PROVIDER_SHARE_PERCENT holding a FRACTION — eight tenths — under a name '
            + 'saying percent, against a backend constant of eighty. Same name, same '
            + 'concept, units a hundredfold apart.'
            + ' '
            + 'Note the asymmetry with BookingPayment.servana.commissionRate, which is a '
            + 'FRACTION in [0, 1] on the same API. Two representations of one split exist '
            + 'because two audiences want different ones; neither NAME says which, so both '
            + 'now say it here. Derived from PROVIDER_SHARE_PERCENT, which '
            + 'tests/provider-earnings-rate-and-eta pins to Math.round(PROVIDER_SHARE_RATE '
            + '* 100).'
            + ' '
            + '0 for an INTERNAL_FIXER, who earns no job share at all.',
        },
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
        minimum: 0,
        maximum: 100,
        description:
          'A WHOLE-NUMBER PERCENTAGE in [0, 100]. 80 means 80%, not 0.8. '
          + 'Counts EVERY requirement including the cosmetic ones - what a progress bar '
          + 'means to a person.',
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

  ProviderTimeOff: {
    type: 'object',
    required: ['id', 'startDate', 'endDate', 'allDay', 'status', 'createdAt'],
    description:
      'One period, as STORED. bookingConflicts is present on creation: time off does NOT '
      + 'cancel accepted work, and a response silent about that would leave a provider '
      + 'assuming it had.'
      + ' '
      + 'CORRECTED IN TAB 07. `id` was declared `string` here and `number` in the admin '
      + 'portal, and the portal deliberately did not change on a guess — correctly, because '
      + 'the CONTRACT was the wrong one. `worker_time_off.id` is `integer NOT NULL`, '
      + 'node-postgres parses int4 to a JS number, and this repository own '
      + '`interface ProviderTimeOff` has always declared `id: number`. Three sources agreed '
      + 'and the document disagreed with all of them. A client that had trusted the '
      + 'contract and compared `id === "5"` would never have matched.',
    properties: {
      id: {
        type: 'integer',
        description:
          'A NUMBER. The column is integer and nothing stringifies it — contrast '
          + 'NotificationTemplate.id and CommunicationEvent.id on the admin tree, which are '
          + 'wrapped in String() by their mappers and really are strings.',
      },
      startDate: {
        type: 'string',
        format: 'date',
        description: 'YYYY-MM-DD. A DATE column, deliberately left unparsed — a date has no zone.',
      },
      endDate: { type: 'string', format: 'date' },
      allDay: {
        type: 'boolean',
        description: 'False only for a single-day window with explicit start and end times.',
      },
      startTime: { type: ['string', 'null'], description: 'HH:mm, null when allDay.' },
      endTime: { type: ['string', 'null'], description: 'HH:mm, null when allDay.' },
      reason: {
        type: ['string', 'null'],
        description: 'NULLABLE — the column is `reason text` with no NOT NULL.',
      },
      note: { type: ['string', 'null'] },
      status: {
        type: 'string',
        enum: ['active', 'cancelled'],
        description:
          'Cancelling does not delete the row, so a cancelled period is still returned by '
          + 'the list. A client filtering for live time off must read this.',
      },
      createdAt: {
        type: 'string',
        format: 'date-time',
        description: 'NOT NULL in the schema, so never null here.',
      },
      createdBy: { type: ['string', 'null'] },
      cancelledAt: { type: ['string', 'null'], format: 'date-time' },
      cancelledBy: { type: ['string', 'null'] },
      bookingConflicts: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description:
          'Present on CREATION only. Time off does not cancel accepted work; these are the '
          + 'bookings that now overlap it and are still the provider responsibility.',
      },
      conflictNotice: { type: ['string', 'null'] },
    },
  },

  ProviderTimeOffList: {
    type: 'object',
    required: ['timeOff'],
    properties: {
      timeOff: {
        type: 'array',
        items: { $ref: '#/components/schemas/ProviderTimeOff' },
        description:
          'Ordered by start_date ascending. Includes CANCELLED periods — read `status`.',
      },
    },
  },

  ProviderTimeOffRequest: {
    type: 'object',
    required: ['startDate', 'endDate', 'reason'],
    properties: {
      startDate: { type: 'string', format: 'date' },
      endDate: { type: 'string', format: 'date' },
      reason: { type: 'string' },
      allDay: { type: 'boolean' },
      startTime: { type: ['string', 'null'], description: 'Partial-day. Persisted, not echoed.' },
      endTime: { type: ['string', 'null'] },
      note: { type: ['string', 'null'] },
    },
  },

  ProviderTimeOffMutation: {
    type: 'object',
    properties: { cancelled: { type: 'boolean' } },
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
  EarningsSummary: {
    allOf: [{ $ref: '#/components/schemas/ProviderEarningsSummary' }],
    deprecated: true,
    description:
      'DEPRECATED ALIAS. Nothing references this name: the earnings endpoint declares '
      + 'ProviderEarningsSummary, and a reference count over the generated document finds '
      + 'zero for this one. It was an empty object that no endpoint served and no schema '
      + 'pointed at — a name with nothing behind it.'
      + ' '
      + 'Kept as an alias rather than deleted, because a client may already have generated '
      + 'a type from the name. Aliasing gives that type a real shape instead of '
      + 'Record<string, never>, which is strictly better for anyone holding it, and lets '
      + 'the name be removed later on evidence rather than on assumption.',
  },
  AdminBookingList: {
    type: 'object',
    required: ['rows', 'total', 'page', 'limit'],
    description:
      'The admin operations list. Read from adminBookingService.getAdminBookings, which '
      + 'returns { rows, total, page, limit } — note ROWS, not `items` and not the v1 '
      + '`data`/`meta` pagination shape used elsewhere on this surface. Documented as it '
      + 'stands rather than renamed: a rename bundled into a documentation pass is a change '
      + 'nobody can review.',
    properties: {
      rows: { type: 'array', items: { $ref: '#/components/schemas/AdminBookingRow' } },
      total: {
        type: 'integer',
        description:
          'An exact COUNT(*) over the filtered set, never null. Contrast PageMeta.total, '
          + 'which the contract declares nullable — see TAB 06.',
      },
      page: { type: 'integer', description: 'Clamped to a minimum of 1.' },
      limit: {
        type: 'integer',
        description: 'Clamped to 1..100. A larger request is capped silently, not refused.',
      },
    },
  },
  AdminBookingRow: {
    type: 'object',
    required: ['bookingId', 'canonicalState', 'stateGroup', 'terminal', 'customerType'],
    description:
      'One row of the admin operations list, as the mapper inside getAdminBookings builds '
      + 'it. Every `null` here is a COALESCE in that mapper, so null means "the column was '
      + 'null", never "the field was omitted".',
    properties: {
      bookingId: { type: 'integer' },
      rawStatus: { type: ['string', 'null'], description: 'The legacy bookings.status column, unmapped.' },
      operationsStatus: {
        type: 'string',
        description:
          'The LEGACY operations vocabulary. It cannot express EN_ROUTE or ARRIVED and '
          + 'reports both as `accepted`. It travels beside canonicalState, never instead of '
          + 'it, because portal badge maps are still keyed on this union.',
      },
      canonicalState: {
        type: 'string',
        description:
          'The authoritative state, read from the COMPUTED column rather than re-derived, '
          + 'so a row cannot display one state while having been filtered on another.',
      },
      stateGroup: { type: 'string' },
      stateLabel: { type: 'string' },
      stateIsCollapsedInLegacyField: {
        type: 'boolean',
        description: 'True when operationsStatus cannot express canonicalState — the EN_ROUTE/ARRIVED case.',
      },
      terminal: { type: 'boolean' },
      customerType: { type: 'string', enum: ['guest', 'client'], description: "Defaults to 'client'." },
      customerUid: { type: ['string', 'null'] },
      guestCustomerId: { type: ['string', 'null'] },
      customerName: {
        type: ['string', 'null'],
        description: 'Trimmed; an all-whitespace name becomes null rather than an empty string.',
      },
      providerUid: { type: ['string', 'null'] },
      providerName: { type: ['string', 'null'], description: 'Trimmed, as customerName.' },
      assignmentStatus: { type: ['string', 'null'], description: 'The worker_status column.' },
      confirmationSource: {
        type: ['string', 'null'],
        enum: ['admin_on_behalf_of_provider', null],
        description: 'Non-null only when an admin confirmed on a provider behalf.',
      },
      serviceId: { type: ['integer', 'null'] },
      serviceOptionId: { type: ['integer', 'null'] },
      serviceName: { type: ['string', 'null'] },
      specificServiceName: { type: ['string', 'null'] },
      scheduledAt: { $ref: '#/components/schemas/UtcTimestamp' },
      quotedPrice: { $ref: '#/components/schemas/MoneyRaw' },
      finalPrice: { $ref: '#/components/schemas/MoneyRaw' },
      paymentMethod: { type: ['string', 'null'] },
      paymentStatus: { type: ['string', 'null'] },
      branchId: { type: ['integer', 'null'] },
      branchName: { type: ['string', 'null'] },
      branchCity: { type: ['string', 'null'] },
      isUnassigned: { type: 'boolean', description: 'Derived: worker_uid is absent.' },
      isLate: {
        type: 'boolean',
        description:
          'Derived at READ TIME from scheduled_at < now(), excluding completed and '
          + 'cancelled. It is a property of when you asked, not a stored fact.',
      },
      hasPaymentIssue: { type: 'boolean', description: "Derived: payment_status in (FAILED, REFUND_PENDING)." },
      hasDispute: { type: 'boolean' },
      needsAdminAction: {
        type: 'boolean',
        description: "Derived: unassigned AND operationsStatus in (new, awaiting_assignment).",
      },
      createdAt: { $ref: '#/components/schemas/UtcTimestamp' },
      updatedAt: {
        type: 'null',
        description:
          'ALWAYS null. The mapper hard-codes `updatedAt: null` — it is a constant, not a '
          + 'signal, and a client must not read it as "never updated". Declared as type null '
          + 'so a generated client cannot mistake it for a timestamp that might arrive.',
      },
    },
  },
  AssignmentCandidatePool: {
    type: 'array',
    items: { $ref: '#/components/schemas/AssignmentCandidate' },
    description:
      'The ranked candidate list. An ARRAY, not an object: the handler calls '
      + 'ok(res, req, candidates, { diagnostics }), so `data` is the candidates and the '
      + 'diagnostics ride in `meta` — the legacy route put them in a sibling key for the '
      + 'same reason, that widening the array under `data` later is a breaking change. '
      + 'The diagnostics are CandidatePoolDiagnostics.',
  },
  AssignmentCandidate: {
    type: 'object',
    required: ['providerUid', 'eligible', 'score', 'reasons', 'checks', 'provider'],
    description:
      'One evaluated provider, from providerEligibilityEngine. This is the PREVIEW of a '
      + 'mutation and runs the same PROVIDER_CAPABILITY_SQL the assign call commits with: a '
      + 'preview narrower than its committer does not fail safe, it hides assignable '
      + 'providers from the operator deciding.',
    properties: {
      providerUid: { type: 'string' },
      eligible: { type: 'boolean' },
      score: { type: 'integer', minimum: 0, maximum: 100, description: '0-100, higher is a better candidate. The sort key.' },
      reasons: { type: 'array', items: { $ref: '#/components/schemas/EligibilityReason' } },
      checks: {
        type: 'object',
        required: [
          'accountActive', 'activationActive', 'notArchived', 'hasActiveService',
          'servicePolicyOk', 'availabilityOk', 'serviceAreaOk', 'complianceOk',
        ],
        description: 'Every stage evaluated, so an operator sees which one refused rather than only that one did.',
        properties: {
          accountActive: { type: 'boolean' },
          activationActive: { type: 'boolean' },
          notArchived: { type: 'boolean' },
          hasActiveService: { type: 'boolean' },
          servicePolicyOk: { type: 'boolean' },
          availabilityOk: { type: 'boolean' },
          serviceAreaOk: { type: 'boolean' },
          complianceOk: { type: 'boolean' },
        },
      },
      provider: {
        type: 'object',
        required: ['uid', 'name', 'email', 'activeServices'],
        properties: {
          uid: { type: 'string' },
          name: { type: 'string' },
          email: { type: 'string' },
          phone: { type: ['string', 'null'] },
          avatarUrl: { type: ['string', 'null'] },
          activeServices: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  EligibilityReason: {
    type: 'object',
    required: ['code', 'severity', 'message'],
    description:
      'Why a provider is or is not assignable. `code` is an OPEN union — the engine types '
      + 'it as EligibilityCheckCode | string — so a client must not switch on it without a '
      + 'default branch.',
    properties: {
      code: {
        type: 'string',
        description:
          'Known codes: ACCOUNT_INACTIVE, ACCOUNT_ARCHIVED, NO_ACTIVE_SERVICE, '
          + 'SERVICE_GRANT_INACTIVE, TIME_OFF, BOOKING_CONFLICT, NO_AVAILABILITY_SET, '
          + 'DAY_NOT_AVAILABLE, OUTSIDE_SCHEDULE_WINDOW, NO_SERVICE_AREA, CITY_NOT_IN_AREA, '
          + 'BRANCH_NOT_IN_AREA, DEFAULT_ALL_CITIES, ELIGIBLE. NOT declared as an enum, '
          + 'because the engine permits any string and an exact enum would make a new code a '
          + 'compile error in every client.',
      },
      severity: { type: 'string', enum: ['info', 'warning', 'blocker'] },
      message: { type: 'string' },
    },
  },
  CandidatePoolDiagnostics: {
    type: 'object',
    required: ['capabilityEvaluated', 'population', 'evaluated', 'truncated', 'eligible', 'blocked'],
    description:
      'Why the pool is the size it is. Carried in `meta.diagnostics` on the '
      + 'assignment-candidates response. A count alone cannot answer, months later, whether '
      + 'supply was healthy at the moment of an assignment.',
    properties: {
      serviceId: { type: ['string', 'null'] },
      capabilityEvaluated: {
        type: 'boolean',
        description:
          'FALSE means the booking resolved to no canonical service, so the capability stage '
          + 'was SKIPPED and every provider listed is "eligible" for a job nobody was checked '
          + 'against. That is a more dangerous pool than an empty one and it shows up in no '
          + 'count — read this before trusting `eligible`.',
      },
      population: { type: 'integer', description: 'Providers returned by the population query.' },
      evaluated: { type: 'integer', description: 'Providers actually evaluated. Lower than population means capped.' },
      truncated: { type: 'boolean' },
      cap: { type: ['integer', 'null'], description: 'CANDIDATE_POOL_CAP, currently 20. Named and reported so "no providers available" can never again mean "the ones who could do it sort after the twentieth first name".' },
      capable: { type: ['integer', 'null'], description: 'Providers holding the canonical service grant. null = not measured.' },
      eligible: { type: 'integer' },
      blocked: { type: 'integer' },
      primaryBlockers: {
        type: 'object',
        additionalProperties: { type: 'integer' },
        description: 'One entry per blocked provider, attributed to its EARLIEST blocker by BLOCKER_PRECEDENCE. Sums to `blocked`.',
      },
      blockerOccurrences: {
        type: 'object',
        additionalProperties: { type: 'integer' },
        description: 'Every blocker seen, counted once per provider. Sums HIGHER than `blocked`, deliberately.',
      },
      dominantBlocker: { type: ['string', 'null'] },
      zeroCandidateReason: {
        type: ['string', 'null'],
        enum: [
          'BOOKING_HAS_NO_SERVICE', 'NO_PROVIDER_POPULATION', 'NO_PROVIDER_HAS_CAPABILITY',
          'POOL_TRUNCATED_BEFORE_EVALUATION', 'ALL_CANDIDATES_BLOCKED', null,
        ],
      },
      zeroCandidateMessage: { type: ['string', 'null'] },
      supplyCollapse: {
        type: 'object',
        required: ['suspected'],
        properties: {
          suspected: { type: 'boolean' },
          detail: { type: ['string', 'null'], description: 'The arithmetic that raised it, in words.' },
        },
      },
      capabilitySource: {
        type: 'object',
        description:
          'The capability-source split. `canonicalCovers: false` means this pool exists ONLY '
          + 'because the legacy fallback is still in the predicate — remove it today and these '
          + 'providers stop being assignable.',
        properties: {
          canonicalServiceId: { type: ['string', 'null'] },
          legacyFamilyId: { type: ['string', 'null'] },
          capableCanonical: { type: ['integer', 'null'] },
          capableLegacyOnly: { type: ['integer', 'null'] },
          canonicalCovers: { type: ['boolean', 'null'] },
        },
      },
    },
  },
  AdminAssignRequest: {
    type: 'object',
    required: ['providerUid'],
    description: 'Assign a provider to an UNASSIGNED booking. Read from the admin.bookings.assign handler.',
    properties: {
      providerUid: {
        type: 'string',
        minLength: 1,
        description: 'Rejected when empty or absent — readNonEmpty, not a truthiness check.',
      },
      reason: {
        type: 'string',
        description:
          'OPTIONAL here and REQUIRED on reassign. The asymmetry is deliberate: a first '
          + 'assignment takes nothing away from anybody, so it needs no justification.',
      },
    },
  },
  AdminReassignRequest: {
    type: 'object',
    required: ['toProviderUid', 'reason'],
    description:
      'Move an assigned booking from one provider to another. NOTE the field name: the '
      + 'handler reads `toProviderUid`, NOT `providerUid`. The previous description of this '
      + 'schema said providerUid, and a client built from that sentence would have sent a '
      + 'body the handler rejects as missing.',
    properties: {
      toProviderUid: {
        type: 'string',
        minLength: 1,
        description: 'The provider receiving the job. The one losing it is read from the booking.',
      },
      reason: {
        type: 'string',
        minLength: 1,
        description:
          'MANDATORY, and enforced twice — readNonEmpty in the handler and a second check in '
          + 'adminReassignProvider. Taking a job from a provider who already has it is an '
          + 'override, and an override without a stated reason is an audit record that cannot '
          + 'answer the only question it will ever be asked.',
      },
    },
  },
  RefundFailureRequest: {
    type: 'object',
    required: ['failureReason'],
    description: 'Why the approved refund did not go through. Required: "failed" with no explanation leaves the next operator unable to tell a retriable processor timeout from a closed account.',
    properties: {
      failureReason: { type: 'string', minLength: 1, description: 'Recorded verbatim on the review.' },
    },
  },
  RefundTransitionResult: {
    type: 'object',
    required: ['refundId', 'status'],
    description: 'The transition that was applied. Deliberately not the whole review — a caller that needs the record reads it back, rather than this becoming a second and subtly different source for it.',
    properties: {
      refundId: { type: 'integer', description: 'finance_refund_reviews.id' },
      status: { type: 'string', enum: ['failed'], description: 'The terminal reached.' },
    },
  },
  /**
   * Retained as a UNION, not deleted.
   *
   * This one name was the declared response of BOTH assign and reassign, and
   * reading the two services shows they return DIFFERENT objects: assign
   * answers { bookingId, providerUid, providerName, status }, reassign answers
   * { bookingId, fromProviderUid, toProviderUid, providerName } and carries no
   * `status` at all. One schema could never have described both.
   *
   * Each endpoint now declares its own precise shape. This name stays, as a
   * oneOf over the two, so a client that pinned it still resolves — additive
   * per the expand/migrate/contract rule, rather than a rename that breaks a
   * generated client the day it lands.
   */
  AdminBookingActionResult: {
    oneOf: [
      { $ref: '#/components/schemas/AdminAssignResult' },
      { $ref: '#/components/schemas/AdminReassignResult' },
    ],
    description:
      'DEPRECATED as a response type. Prefer AdminAssignResult or AdminReassignResult — '
      + 'this name described two different objects and could not be bound to either.',
  },
  AdminAssignResult: {
    type: 'object',
    required: ['bookingId', 'providerUid', 'status'],
    description: 'Read from adminBookingService.adminAssignProvider. Both of its return paths.',
    properties: {
      bookingId: { type: 'integer' },
      providerUid: { type: 'string' },
      providerName: { type: ['string', 'null'] },
      status: {
        type: 'string',
        enum: ['WORKER_ASSIGNED'],
        description: 'A single value today. Present on assign and ABSENT on reassign.',
      },
      idempotent: {
        type: 'boolean',
        enum: [true],
        description:
          'Present ONLY when the booking already carried this provider, so the call changed '
          + 'nothing. Absent on a first assignment — a client must test presence, not truth.',
      },
    },
  },
  AdminReassignResult: {
    type: 'object',
    required: ['bookingId', 'fromProviderUid', 'toProviderUid'],
    description:
      'Read from adminBookingService.adminReassignProvider. It carries NO `status` field, '
      + 'unlike the assign result, and names both ends of the move.',
    properties: {
      bookingId: { type: 'integer' },
      fromProviderUid: { type: ['string', 'null'], description: 'The provider losing the job. Null when the booking was unassigned.' },
      toProviderUid: { type: 'string' },
      providerName: {
        type: 'string',
        description:
          'Present on the committed path and ABSENT on the idempotent early return, which '
          + 'answers { bookingId, fromProviderUid, toProviderUid, idempotent } only.',
      },
      idempotent: {
        type: 'boolean',
        enum: [true],
        description: 'Present only when the booking already carried toProviderUid.',
      },
    },
  },
  CustomerBookingState: {
    type: 'object',
    required: ['canonicalState', 'label', 'detail', 'terminal', 'availableActions'],
    description:
      'From projections.toCustomerProjection. Deliberately about the PROVIDER progress '
      + 'rather than the administrative state: "Awaiting Assignment" is an operations '
      + 'concept and means nothing to somebody waiting for a cleaner.',
    properties: {
      canonicalState: { type: 'string' },
      label: { type: 'string', description: 'What the customer is told. Their register, not the operator one.' },
      detail: { type: 'string', description: 'One line of context under the label. NOT present on the provider projection.' },
      terminal: { type: 'boolean' },
      availableActions: { type: 'array', items: { type: 'string' } },
    },
  },
  ProviderBookingState: {
    type: 'object',
    required: ['canonicalState', 'label', 'terminal', 'availableActions'],
    description: 'From projections.toProviderProjection. Action-oriented.',
    properties: {
      canonicalState: { type: 'string' },
      label: { type: 'string', description: 'What the provider does next, not what the booking is.' },
      nextAction: {
        type: ['string', 'null'],
        description: 'The single next step when there is an obvious one. NOT present on the customer projection.',
      },
      terminal: { type: 'boolean' },
      availableActions: { type: 'array', items: { type: 'string' } },
    },
  },
  AdditionalWorkRequest_Row: {
    type: 'object',
    required: ['id', 'booking_id', 'status', 'total_amount'],
    description:
      'A change order row, as additional.service returns it. '
      + 'NOTE THE FIELD NAMES: this is a RAW database row and its keys are SNAKE_CASE '
      + '- booking_id, total_amount, approved_at, worker_decision. Almost every other v1 '
      + 'response is camelCase, because a mapper sits between the query and the wire. There '
      + 'is no mapper here: getByBooking returns res.rows and createRequest returns rows[0] '
      + 'from an INSERT ... RETURNING *. Documented as it stands rather than renamed - the '
      + 'wire is what clients read today.',
    properties: {
      id: { type: 'integer' },
      booking_id: { type: 'integer' },
      status: {
        type: 'string',
        description:
          'Created as PENDING_ADMIN_APPROVAL. The statuses that count as approved for '
          + 'amount purposes are WAITING_FOR_PAYMENT, WAITING_WORKER_APPROVAL, ACCEPTED, '
          + 'IN_PROGRESS, PROCEEDING and COMPLETED.',
      },
      total_amount: {
        allOf: [{ $ref: '#/components/schemas/MoneyRaw' }],
        description:
          'A STRING on the wire. This response is a raw row with no mapper, and nothing '
          + 'parses OID 1700. Adding two of these concatenates.',
      },
      approved_amount: {
        allOf: [{ $ref: '#/components/schemas/MoneyRaw' }],
        description:
          'NOT a stored column: a CASE expression returning total_amount when status is in '
          + 'the approved set and NULL otherwise. It is total_amount seen through the status, '
          + 'never a separately agreed figure. Absent from the CREATE response, which is '
          + 'RETURNING * and so carries only real columns.',
      },
      approved_at: { $ref: '#/components/schemas/UtcTimestamp' },
      paid_at: { $ref: '#/components/schemas/UtcTimestamp' },
      worker_decision: { type: ['string', 'null'] },
      decided_at: { $ref: '#/components/schemas/UtcTimestamp' },
      created_at: { $ref: '#/components/schemas/UtcTimestamp' },
      updated_at: { $ref: '#/components/schemas/UtcTimestamp' },
      requested_by: {
        type: ['string', 'null'],
        description: 'Present on the CREATE response (RETURNING *); not selected by the list query.',
      },
    },
  },
  PublicReview: {
    type: 'object',
    required: ['reviewId', 'overallRating', 'visibility', 'moderationStatus'],
    description:
      'One publicly visible review, from customerReviewService.mapPublicReviewRow. '
      + 'NO CUSTOMER IDENTITY is projected (§58) — there is no customerUid, no name and no '
      + 'avatar, and that is a property of the mapper rather than of the query. '
      + 'The list is already filtered: only PUBLIC and ANONYMOUS_PUBLIC visibility, only '
      + 'PUBLISHED/EDITED/REDACTED publication states, and only non-deleted rows. A review '
      + 'missing from this list has been withdrawn or held, and the two are not '
      + 'distinguishable from here.',
    properties: {
      reviewId: { type: 'string', description: 'Cast to text in SQL — a STRING, not a number.' },
      overallRating: { type: 'number' },
      publicComment: { type: ['string', 'null'] },
      visibility: { type: 'string', enum: ['PUBLIC', 'ANONYMOUS_PUBLIC'] },
      moderationStatus: { type: 'string' },
      createdAt: { $ref: '#/components/schemas/UtcTimestamp' },
      editedAt: {
        oneOf: [{ $ref: '#/components/schemas/UtcTimestamp' }],
        description: 'Non-null means the customer edited it after publishing.',
      },
      providerResponse: {
        oneOf: [
          {
            type: 'object',
            required: ['responseId', 'body'],
            properties: {
              responseId: { type: 'string', description: 'Cast to text — a STRING.' },
              body: { type: 'string' },
              createdAt: { $ref: '#/components/schemas/UtcTimestamp' },
            },
          },
          { type: 'null' },
        ],
        description:
          'NULL when there is no response OR when the response exists but is deleted or '
          + 'not yet through moderation — the LEFT JOIN filters on both. A null is not '
          + 'proof the provider stayed silent.',
      },
    },
  },
  CatalogAddon: {
    type: 'object',
    required: ['ref', 'id', 'name'],
    description:
      'An add-on offered with a catalog service, from catalogPublicService. Both `ref` and '
      + '`id` are emitted: the ref is the stable addressable handle, the id is the raw '
      + 'numeric key the legacy option tables use.',
    properties: {
      ref: { type: 'string', description: 'makeRef(addon, id). Prefer this over id.' },
      id: { type: 'integer' },
      name: { type: 'string', description: 'The level_3 label.' },
      unit: { type: ['string', 'null'] },
      basePrice: { $ref: '#/components/schemas/MoneyMajor' },
      basePriceSummary: { type: ['string', 'null'], description: 'Pre-rendered "P350 per unit" style text.' },
      durationMins: { type: ['integer', 'null'] },
    },
  },
  /**
   * The three ways an amount appears on this API, declared once.
   *
   * TAB 04 asks for the JSON type, the unit and the currency of every money
   * field. Three schemas rather than three sentences repeated forty times: a
   * field that references one of these cannot disagree with the others about
   * what a peso is, and a field added tomorrow has to choose.
   *
   * ## Why there are THREE and not two
   *
   * The book supposes the string case is a driver quirk — "numeric(12,2)
   * reaches some clients as a string through some drivers and the portal cannot
   * know which fields do". Measured here, it is not about the driver at all.
   *
   * `src/db/dbQuery.ts` registers type parsers for OIDs 1114, 1184 and 1082 —
   * timestamps and dates. It registers NOTHING for 1700, `numeric`. So
   * node-postgres hands every numeric column back as a STRING, always,
   * deterministically, on every machine.
   *
   * What decides the wire type is therefore whether a MAPPER coerced it:
   *
   *   `financePolicy.toCentavos`  = Number(v ?? 0) rounded to 2dp
   *   `catalogPublicService.money` = v == null ? null : Number(v)
   *
   * Every canonical v1 finance and catalog response passes through one of
   * those, so it carries a real `number`. The responses that return a raw row —
   * `AdminBookingRow`, `AdditionalWorkRequest_Row` — have no mapper at all and
   * carry the driver's STRING.
   *
   * That is a knowable, per-field fact rather than an unknowable driver
   * property, so this contract states it per field. A client no longer has to
   * accept `number | string` everywhere defensively; it has to accept it
   * exactly where `MoneyRaw` says so.
   */
  OpenApiDocument: {
    type: 'object',
    description:
      'An OpenAPI 3.1 document — this one, as the running process derives it, under the '
      + 'usual v1 `data` key. It is NOT the committed docs/api/openapi.v1.json: that file '
      + 'answers what the repository says, which a checkout already answers. This is '
      + 'derived from the same V1_CONTRACT that register.ts mounts the routers from, so '
      + 'there is no second copy that can go stale.'
      + ' '
      + 'The response carries x-contract-sha256 and an ETag of the same digest. The digest '
      + 'is sha256(JSON.stringify(document)) with no indentation — a client holding a '
      + 'pinned copy reproduces it by parsing that file and stringifying it the same way. '
      + 'It is deliberately NOT the hash of the response body, which carries a per-request '
      + 'id and would differ every time. See TAB 08.',
    additionalProperties: true,
    properties: {
      openapi: { type: 'string', enum: ['3.1.0'] },
      info: { type: 'object', additionalProperties: true },
      paths: { type: 'object', additionalProperties: true },
      components: { type: 'object', additionalProperties: true },
    },
  },
  MoneyMajor: {
    type: ['number', 'null'],
    description:
      'UNIT: PHP MAJOR units — pesos, two decimal places. CURRENCY: PHP. A real JSON number: '
      + 'the value passed through a coercing mapper (financePolicy.toCentavos or '
      + 'catalogPublicService.money) before serialisation. Currency is PHP; there is one '
      + 'currency in this system and financePolicy.CURRENCY is the constant. '
      + 'Prefer the Minor twin for arithmetic where one exists: a float number of pesos '
      + 'accumulates error at the fourth decimal place and surfaces months later in a '
      + 'reconciliation report.',
  },
  MoneyMinor: {
    type: ['integer', 'null'],
    description:
      'UNIT: PHP MINOR units — centavos, an INTEGER. CURRENCY: PHP. This is the representation to '
      + 'compute with: an integer number of centavos cannot drift. Produced by '
      + 'financePolicy.toMinorUnits, which is Math.round(toCentavos(v) * 100).',
  },
  MoneyRaw: {
    type: ['number', 'string', 'null'],
    description:
      'UNIT: PHP MAJOR units — pesos. CURRENCY: PHP. Reaches the wire UNCOERCED, so it is a '
      + 'STRING whenever the column is non-null.'
      + ' '
      + 'Not a driver quirk and not a maybe. node-postgres has no type parser registered for '
      + 'OID 1700 (numeric) in this application, so every numeric column arrives as a string; '
      + 'the fields declared MoneyMajor are numbers because a mapper called Number() on them, '
      + 'and these have no mapper. `number` stays in the union only because a caller may send '
      + 'one back and because a non-numeric column could occupy the same field.'
      + ' '
      + 'A client MUST NOT do arithmetic on this without converting. Adding two of them '
      + 'concatenates.',
  },
  UtcTimestamp: {
    type: ['string', 'null'],
    format: 'date-time',
    description:
      'ISO 8601 with a UTC designator, guaranteed at the DRIVER rather than per field: '
      + 'src/db/dbQuery.ts registers asUtcIso against OIDs 1114 (timestamp) and 1184 '
      + '(timestamptz), and that function ends in Date.toISOString(), which always emits a '
      + 'trailing Z. Postgres native "2026-08-11 11:03:23.421016+00" therefore cannot reach '
      + 'a client through this path. This became true in TAB 03: the parser was always '
      + 'installed, but its zone guard demanded a four-digit offset while Postgres emits '
      + 'two, so every timestamptz fell through unconverted. See TAB 03.',
  },
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

/**
 * The UTC rule, stated on EVERY timestamp rather than on one of them.
 *
 * TAB 03 asks for exactly this: *"State the rule in the schema description of
 * every timestamp field, not one of them."* Before this, precisely one field in
 * 62 carried it — a convention written down once and therefore true by memory.
 *
 * Applied by the GENERATOR rather than typed into 62 descriptions, because a
 * hand-maintained copy of one sentence is a hand-maintained opportunity for 62
 * of them to disagree. A field added tomorrow inherits it without anybody
 * remembering to.
 *
 * The sentence is appended, never substituted: a field that already explains
 * what it means keeps its own words and gains the guarantee after them.
 */
export const UTC_RULE =
  'ISO 8601 with a UTC designator — always ends in Z. Guaranteed at the driver, '
  + 'not per field: src/db/dbQuery.ts parses OIDs 1114 and 1184 through asUtcIso, '
  + 'which ends in Date.toISOString(). Never Postgres native '
  + '"2026-08-11 11:03:23.421016+00".';

/** Append UTC_RULE to every `format: date-time` description in the document. */
export function stateTheUtcRule<T>(node: T): T {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    node.forEach((child) => stateTheUtcRule(child));
    return node;
  }
  const o = node as Record<string, unknown>;
  if (o.format === 'date-time') {
    const existing = typeof o.description === 'string' ? o.description.trim() : '';
    if (!existing.includes('UTC designator')) {
      o.description = existing ? `${existing} ${UTC_RULE}` : UTC_RULE;
    }
  }
  for (const value of Object.values(o)) stateTheUtcRule(value);
  return node;
}

/**
 * The unit and currency of an amount, stated on EVERY money field.
 *
 * TAB 04 asks for three things per money field: its JSON type, its unit, and
 * its currency. The type is already declared on each field and the unit is
 * settled by `MoneyMajor` / `MoneyMinor` / `MoneyRaw`. What was missing is that
 * a reader had to KNOW which of those a given field was — the portal ended up
 * accepting `number | string` everywhere because the contract never said.
 *
 * Stamped by the generator for the same reason the UTC rule is: forty copies of
 * one sentence is forty chances to disagree, and a field added tomorrow
 * inherits this without anybody remembering to.
 *
 * ## Deciding what is money
 *
 * By NAME, then narrowed by type, then by an explicit exclusion list. Name
 * alone is not enough — `total` is a row count on a page, `payoutWindowHours`
 * is a duration, `refundReviewId` is a key, `commissionRate` is a fraction and
 * TAB 05 governs it. Each exclusion is listed rather than pattern-matched, so
 * adding one is a decision somebody makes in a diff.
 */
const MONEY_NAME = /amount|gross|fee|earning|payout|price|payable|revenue|refunded|refundable/i;

/**
 * Money-SHAPED names that are not money. Each states why, because a silent
 * exclusion is how a real amount ends up undocumented.
 */
const NOT_MONEY: Record<string, string> = {
  refundReviewId: 'a key into finance_refund_reviews, not an amount',
  refundId: 'a key',
  payoutWindowHours: 'a duration in hours',
  payoutStatus: 'an enum',
  providerPayoutStatus: 'an enum',
  payoutStatusCanonical: 'an enum',
  payoutBlockedBy: 'an enum',
  payoutBlockedReason: 'prose',
  priceSummary: 'pre-rendered display text, already carrying its own currency mark',
  basePriceSummary: 'pre-rendered display text',
  commissionRate: 'a FRACTION of gross, not an amount. TAB 05 governs it',
  estimatedJobsCount: 'a count',
  refundedAt: 'a timestamp',
  releasedAt: 'a timestamp',
  paidAt: 'a timestamp',
  eligibleAt: 'a timestamp',
  reversesProviderEarning: 'a boolean',
  pendingIsEstimate: 'a boolean',
  earningsDisclosure: 'prose',
  withheldReason: 'prose',
};

const MINOR_RULE =
  'UNIT: PHP MINOR units — centavos, an integer. This is the representation to compute '
  + 'with; an integer number of centavos cannot drift. CURRENCY: PHP (financePolicy.CURRENCY).';

const MAJOR_RULE =
  'UNIT: PHP MAJOR units — pesos, two decimal places. CURRENCY: PHP '
  + '(financePolicy.CURRENCY). Prefer the Minor twin for arithmetic where one exists.';

const RAW_RULE =
  'UNIT: PHP MAJOR units — pesos. CURRENCY: PHP. Arrives as a STRING: nothing parses '
  + 'OID 1700 (numeric) in this application and this response has no coercing mapper, so '
  + 'adding two of these concatenates.';

const isNumericType = (t: unknown): boolean => {
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => x === 'number' || x === 'integer');
};

/** Append the unit and currency to every money field's description. */
export function stateTheMoneyRule<T>(node: T): T {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    node.forEach((child) => stateTheMoneyRule(child));
    return node;
  }
  const o = node as Record<string, unknown>;

  const props = o.properties as Record<string, Record<string, unknown>> | undefined;
  if (props) {
    for (const [name, field] of Object.entries(props)) {
      if (!field || typeof field !== 'object') continue;
      if (!MONEY_NAME.test(name) || NOT_MONEY[name]) continue;

      const isMinor = /Minor$/.test(name);
      const types = Array.isArray(field.type) ? field.type : [field.type];
      const isRaw = types.includes('string');
      if (!isNumericType(field.type) && !isRaw) continue;

      const rule = isMinor ? MINOR_RULE : isRaw ? RAW_RULE : MAJOR_RULE;
      const existing = typeof field.description === 'string' ? field.description.trim() : '';
      if (!existing.includes('UNIT: PHP')) {
        field.description = existing ? `${existing} ${rule}` : rule;
      }
    }
  }

  for (const value of Object.values(o)) stateTheMoneyRule(value);
  return node;
}

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
      // Deep-cloned before the rule is stamped in: SCHEMAS is a module-level
      // singleton, and mutating it would make the second call to this function
      // see descriptions the first one wrote. `api:docs` and `api:docs:check`
      // both run in one process during `npm run verify`, so that is not
      // hypothetical — it is the difference between a stable document and one
      // that grows a duplicated sentence every time it is generated.
      schemas: stateTheMoneyRule(
        stateTheUtcRule(JSON.parse(JSON.stringify(SCHEMAS)) as Record<string, unknown>),
      ),
    },
    tags: [...new Set(V1_CONTRACT.map((e) => e.domain))].sort().map((name) => ({ name })),
    'x-generated-from': 'src/api/v1/contract.ts',
    'x-implemented-count': IMPLEMENTED.length,
    'x-total-count': V1_CONTRACT.length,
  };
}
