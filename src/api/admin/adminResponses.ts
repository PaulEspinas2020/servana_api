/**
 * Authored response schemas for the legacy admin surface.
 *
 * ## What this file is for
 *
 * `scripts/lib/adminSurface.ts` DERIVES everything about an admin operation
 * that can be derived: its path, method, guard, named permission, response
 * envelope, payload keys, and whether `parityMiddleware` rewrites it. What it
 * cannot derive is the SHAPE of the payload — that lives in a service, behind a
 * SQL query, and no static reader is going to recover it honestly.
 *
 * So the shape is authored here, one operation at a time, and
 * `docs/api/openapi.admin.json` is generated from the derived facts plus this
 * table. An operation with no entry here is still published — with its envelope
 * and its guard, which is already more than any client had — but its payload is
 * declared `unspecified` rather than guessed.
 *
 * ## The rule this file exists to obey
 *
 * A guessed schema is worse than an absent one. An absent schema tells a client
 * "nobody has written this down"; a wrong schema tells it "this is the shape",
 * and the client generates types from it and is broken in a way that looks like
 * the backend's fault. Every entry below was written by reading the service
 * function the handler calls, and each names that function in `derivedFrom` so
 * the next person can check it rather than trust it.
 *
 * That rule earned itself immediately. The first draft of the two template
 * entries was written from the route name alone and declared `body`,
 * `isArchived` and a `subject`-only shape. Reading `mapTemplateRow` showed
 * twelve fields, four of them coalesced, an `id` that is `String(row.id)`, and
 * `bodyTemplate` rather than `body`. Every one of those would have been a
 * client bug shipped as documentation.
 *
 * ## Order of work
 *
 * TAB 01 asks for blast radius order, not alphabetical: communications and
 * provider-onboarding first, because they are the two areas that reach people
 * outside Servana — the templates and events that message providers and
 * customers, and the decisions that let a person work.
 *
 * ## The ratchet
 *
 * `tests/admin-surface.test.ts` records how many operations have an authored
 * response and refuses to let that number fall. Adding one is progress; the
 * gate never demands all 251 at once, which is what makes a partial landing
 * safe rather than a broken build.
 */

export interface AdminResponseSchema {
  /**
   * The service function whose return value this describes.
   *
   * Required. A schema that does not name its source is a claim nobody can
   * re-check, and re-checking is the entire point.
   */
  derivedFrom: string;
  /** JSON Schema for the value under the envelope's payload key. */
  schema: Record<string, unknown>;
  /** Anything a client needs to know that the schema itself cannot say. */
  note?: string;
}

const EVENT_ARRAY = {
  type: 'array',
  items: { $ref: '#/components/schemas/CommunicationEvent' },
};

/** Keyed by `METHOD /full/path`, exactly as `opKey()` renders it. */
export const ADMIN_RESPONSES: Record<string, AdminResponseSchema> = {
  // ── communications ────────────────────────────────────────────────────────
  // 21 operations, and first by blast radius: these are the templates and
  // events that reach providers and customers, so a silent field rename here
  // is a message that does not arrive.

  'GET /api/admin/communications/templates': {
    derivedFrom:
      'adminCommunicationService.listNotificationTemplates -> mapTemplateRow ' +
      '(src/services/adminCommunicationService.ts)',
    schema: { type: 'array', items: { $ref: '#/components/schemas/NotificationTemplate' } },
    note:
      'Filtered by the `channel` and `include_archived` query parameters; without ' +
      '`include_archived=true` the WHERE clause adds `archived_at IS NULL`. ' +
      'Ordered by `name ASC`.',
  },

  'GET /api/admin/communications/templates/:templateKey': {
    derivedFrom:
      'adminCommunicationService.getNotificationTemplate -> mapTemplateRow ' +
      '(src/services/adminCommunicationService.ts)',
    schema: { $ref: '#/components/schemas/NotificationTemplate' },
    note:
      'The service returns null for an unknown key and the controller turns that ' +
      'into a 404 admin error envelope, so the 200 body is never null.',
  },

  'POST /api/admin/communications/templates': {
    derivedFrom:
      'adminCommunicationService.createNotificationTemplate (INSERT … RETURNING *) ' +
      '-> mapTemplateRow',
    schema: { $ref: '#/components/schemas/NotificationTemplate' },
    note:
      'The created row, not an acknowledgement. `templateKey`, `name`, `channel` and ' +
      '`bodyTemplate` are required by the controller. A duplicate key surfaces as ' +
      'Postgres 23505 and the controller maps it to a 409 conflict.',
  },

  'PATCH /api/admin/communications/templates/:templateKey': {
    derivedFrom:
      'adminCommunicationService.updateNotificationTemplate (UPDATE … RETURNING *) ' +
      '-> mapTemplateRow',
    schema: { $ref: '#/components/schemas/NotificationTemplate' },
    note:
      'The updated row. The service builds its SET list from the supplied fields ' +
      'and returns null when none were supplied OR the key is unknown — the ' +
      'controller renders both as 404, so a no-op update is indistinguishable ' +
      'from a missing template.',
  },

  'DELETE /api/admin/communications/templates/:templateKey': {
    derivedFrom:
      'adminCommunicationService.archiveNotificationTemplate (returns boolean); ' +
      'the payload is built by the CONTROLLER, not the service',
    schema: {
      type: 'object',
      required: ['templateKey', 'archived'],
      properties: {
        templateKey: { type: 'string' },
        archived: { type: 'boolean', enum: [true] },
      },
    },
    note:
      'ARCHIVES, it does not delete: the service sets `archived_at` and the row stays ' +
      'readable through `include_archived=true`. `archived` is a constant true — the ' +
      'false case is a 404, never a 200.',
  },

  'POST /api/admin/communications/templates/:templateKey/preview': {
    derivedFrom:
      'adminCommunicationService.previewNotificationTemplate(tpl.bodyTemplate, variables); ' +
      'payload assembled in the controller',
    schema: {
      type: 'object',
      required: ['preview'],
      properties: {
        preview: { type: 'string', description: 'The body template with variables substituted.' },
        subject: { type: ['string', 'null'], description: 'Copied from the template row.' },
        channel: { type: 'string', description: 'Copied from the template row.' },
      },
    },
    note: 'Renders only. Nothing is sent and nothing is written.',
  },

  'GET /api/admin/communications/events': {
    derivedFrom: 'adminCommunicationService.listCommunicationEvents -> mapEventRow',
    schema: {
      type: 'object',
      required: ['total', 'page', 'limit', 'items'],
      properties: {
        total: {
          type: 'integer',
          description:
            'An exact COUNT(*) over the filtered set, never null. Contrast PageMeta.total ' +
            'on the v1 surface, which is nullable — see TAB 06.',
        },
        page: { type: 'integer', description: 'Clamped to a minimum of 1.' },
        limit: { type: 'integer', description: 'Clamped to 1..100. A larger request is capped silently.' },
        items: EVENT_ARRAY,
      },
    },
    note:
      'Paged, and the pagination keys are `total/page/limit/items` — NOT the v1 ' +
      '`meta`/`data` shape. Ordered by `created_at DESC`.',
  },

  'GET /api/admin/communications/events/:eventKey': {
    derivedFrom: 'adminCommunicationService.getCommunicationEventDetail -> mapEventRow',
    schema: { $ref: '#/components/schemas/CommunicationEvent' },
  },

  'GET /api/admin/communications/failures': {
    derivedFrom: 'adminCommunicationService.findRetryableFailures -> mapEventRow',
    schema: EVENT_ARRAY,
    note:
      'RETRYABLE failures only: `status = \'failed\' AND retry_count < 5`. An event that ' +
      'exhausted its five attempts is a failure and is NOT in this list, so this is not ' +
      'the answer to "what failed".',
  },

  'GET /api/admin/communications/entity/:entityType/:entityId': {
    derivedFrom: 'adminCommunicationService.getEntityCommunicationTimeline -> mapEventRow',
    schema: EVENT_ARRAY,
    note: 'Newest first, capped at 50 by default. No total is returned, so absence of a 51st row is not proof there is none.',
  },

  'GET /api/admin/communications/recipient/:recipientUid': {
    derivedFrom: 'adminCommunicationService.getRecipientCommunicationTimeline -> mapEventRow',
    schema: EVENT_ARRAY,
    note: 'Same shape and same 50-row cap as the entity timeline.',
  },

  'GET /api/admin/communications/summary': {
    derivedFrom: 'adminCommunicationService.getCommunicationSummary',
    schema: {
      type: 'object',
      required: ['total', 'failed', 'retried', 'last24h', 'failed24h', 'byChannel'],
      properties: {
        total: { type: 'integer' },
        failed: { type: 'integer' },
        retried: { type: 'integer' },
        last24h: { type: 'integer' },
        failed24h: { type: 'integer' },
        byChannel: {
          type: 'object',
          required: ['email', 'socket', 'chat', 'fcm'],
          description:
            'A FIXED set of four channels, computed as COUNT(*) FILTER clauses in one ' +
            'query. A fifth channel added to the events table does not appear here until ' +
            'the SQL is edited, and the totals will not add up rather than the key being absent.',
          properties: {
            email: { type: 'integer' },
            socket: { type: 'integer' },
            chat: { type: 'integer' },
            fcm: { type: 'integer' },
          },
        },
      },
    },
    note:
      'Every figure is an integer: the service parseInt()s each COUNT, which Postgres ' +
      'returns as a string for bigint.',
  },

  'GET /api/admin/communications/reports': {
    derivedFrom: 'adminCommunicationService.listMessageReports',
    schema: { type: 'array', items: { $ref: '#/components/schemas/AdminMessageReport' } },
    note:
      'CAUTION: the service wraps its query in `try { … } catch { return [] }`. A database ' +
      'error is therefore indistinguishable from "no reports" — an empty array here is not ' +
      'evidence that the moderation queue is clear.',
  },

  'PATCH /api/admin/communications/reports/:reportId': {
    derivedFrom:
      'adminCommunicationService.resolveMessageReport — returns `rows[0]`, the RAW ' +
      'UPDATE … RETURNING * row, with NO mapper applied',
    schema: {
      type: 'object',
      description:
        'The raw chat_message_reports row. Keys are SNAKE_CASE here — message_id, ' +
        'reporter_uid, resolved_by, resolved_at, resolution_note — because unlike every ' +
        'other communications response this one is not passed through a mapper.',
      properties: {
        id: { type: 'integer' },
        message_id: { type: 'integer' },
        reporter_uid: { type: 'string' },
        category: { type: ['string', 'null'] },
        status: { type: 'string', enum: ['dismissed', 'actioned'] },
        resolved_by: { type: ['string', 'null'] },
        resolved_at: { type: ['string', 'null'], format: 'date-time' },
        resolution_note: { type: ['string', 'null'] },
        created_at: { type: ['string', 'null'], format: 'date-time' },
      },
    },
    note:
      'The GET list returns camelCase (`messageId`, `reportedByUid`) and this PATCH ' +
      'returns snake_case for the same entity. Documented as it stands, per TAB 01: ' +
      'renaming it belongs in a change somebody can review, not in a documentation pass. ' +
      'Also note the WHERE clause requires the report to still be pending, so resolving ' +
      'an already-resolved report is a 404, not a repeat.',
  },

  // ── provider-onboarding ───────────────────────────────────────────────────
  // 16 operations, and second by blast radius after communications: these are
  // the decisions that let a person work. A silent field rename here is a
  // provider who cannot be approved, or one who is approved by a screen reading
  // a field that stopped arriving.

  'GET /api/admin/provider-onboarding/queues': {
    derivedFrom: 'adminOnboardingService.getQueueSummary',
    schema: { $ref: '#/components/schemas/OnboardingQueueSummary' },
    note:
      'One query, eight COUNT(*) FILTER clauses over provider role 2/4 rows that are not '
      + 'archived. Every figure is an integer: the service parseInt()s each count, because '
      + 'Postgres returns bigint as a string.',
  },

  'GET /api/admin/provider-onboarding/cases': {
    derivedFrom: 'adminOnboardingService.listCases',
    schema: {
      type: 'object',
      required: ['rows', 'total', 'page', 'limit'],
      properties: {
        rows: { type: 'array', items: { $ref: '#/components/schemas/OnboardingCaseRow' } },
        total: { type: 'integer', description: 'Exact COUNT over the filtered set.' },
        page: { type: 'integer' },
        limit: { type: 'integer' },
      },
    },
    note:
      'Paged as `rows/total/page/limit` — the same shape as the admin bookings list, and '
      + 'NOT the `items` shape the communications events list uses. Two paginated admin '
      + 'lists, two key names; documented as they stand.',
  },

  'GET /api/admin/provider-onboarding/cases/:caseId': {
    derivedFrom: 'adminOnboardingService.getCaseDetail',
    schema: { $ref: '#/components/schemas/OnboardingCaseDetail' },
    note:
      'Accepts a case id OR a provider uid — the service tests the argument against a UUID '
      + 'pattern and looks it up either way, so a caller holding only a provider uid does '
      + 'not have to find the case first.',
  },

  'GET /api/admin/provider-onboarding/cases/:caseId/readiness': {
    derivedFrom: 'adminOnboardingService.calculateReadiness',
    schema: { $ref: '#/components/schemas/OnboardingReadiness' },
    note:
      'Computed on read, never stored. It is the answer to "could this provider be approved '
      + 'right now", and it is derived from requirements, service applications and email '
      + 'verification at the moment of asking.',
  },

  'GET /api/admin/provider-onboarding/cases/:caseId/notes': {
    derivedFrom: 'adminOnboardingService.getNotes',
    schema: { type: 'array', items: { $ref: '#/components/schemas/OnboardingCaseNote' } },
    note:
      'Includes INTERNAL notes by default (`includeInternal = true`). `isProviderVisible` '
      + 'is the field that decides whether a note may be shown to the provider, and a client '
      + 'that ignores it will leak internal review commentary.',
  },

  'POST /api/admin/provider-onboarding/cases/:caseId/notes': {
    derivedFrom: 'adminOnboardingService.addNote — returns res.rows[0], the RAW inserted row',
    schema: { $ref: '#/components/schemas/OnboardingCaseNoteRaw' },
    note:
      'SNAKE_CASE. The list route maps its rows to camelCase; this one returns the raw '
      + 'INSERT row with no mapper, so the note you just created comes back under different '
      + 'key names from the notes you read. Documented as it stands.',
  },

  'GET /api/admin/provider-onboarding/cases/:caseId/timeline': {
    derivedFrom: 'adminOnboardingService.getTimeline',
    schema: { type: 'array', items: { $ref: '#/components/schemas/OnboardingTimelineEvent' } },
    note: 'Capped at 50 by default. No total is returned, so a short list is not proof of a short history.',
  },

  'GET /api/admin/provider-onboarding/reason-codes': {
    derivedFrom: 'adminOnboardingService.getReasonCodes',
    schema: { type: 'array', items: { $ref: '#/components/schemas/OnboardingReasonCode' } },
    note:
      'The vocabulary a rejection or resubmission request must choose from — '
      + 'assertValidReasonCode refuses anything not in this list, so a client should populate '
      + 'its picker from here rather than hard-coding codes.',
  },

  'PATCH /api/admin/provider-onboarding/cases/:caseId/assign': {
    derivedFrom: 'adminOnboardingService.assignCase',
    schema: {
      type: 'object',
      required: ['caseId', 'assignedReviewer'],
      properties: {
        caseId: { type: 'string' },
        assignedReviewer: {
          type: ['string', 'null'],
          description: 'NULL is a real value and means the case was UNassigned.',
        },
      },
    },
    note: 'Deliberately not the whole case. A caller that needs the case reads it back.',
  },

  'PATCH /api/admin/provider-onboarding/cases/:caseId/priority': {
    derivedFrom: 'adminOnboardingService.setPriority',
    schema: {
      type: 'object',
      required: ['caseId', 'priority'],
      properties: {
        caseId: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
      },
    },
    note:
      'The four values are validated server-side; anything else is a 400. The `version` '
      + 'column is incremented by this write, so a client holding a stale version will fail '
      + 'its next optimistic-concurrency check.',
  },

  'PATCH /api/admin/provider-onboarding/cases/:caseId/move': {
    derivedFrom:
      'adminOnboardingService.moveCase -> transitionCase, which returns updated.rows[0] — '
      + 'the RAW provider_onboarding_cases row',
    schema: { $ref: '#/components/schemas/OnboardingCaseRaw' },
    note:
      'SNAKE_CASE, and OPTIMISTICALLY CONCURRENT: the caller supplies expectedVersion and '
      + 'the update fails if the case has moved since. Read `version` from the returned row '
      + 'before the next transition.',
  },

  'POST /api/admin/provider-onboarding/cases/:caseId/final-approve': {
    derivedFrom: 'adminOnboardingService.finalApproveProvider',
    schema: {
      type: 'object',
      required: ['caseId', 'onboardingStatus', 'providerUid'],
      properties: {
        caseId: { type: 'string' },
        onboardingStatus: { type: 'string', enum: ['approved'] },
        providerUid: { type: 'string' },
      },
    },
    note:
      'A single-value enum, deliberately: this endpoint has one terminal. The decision that '
      + 'lets a person work — audited as onboarding_final_approved, which the audit trail '
      + 'classifies HIGH RISK.',
  },

  'POST /api/admin/provider-onboarding/cases/:caseId/final-reject': {
    derivedFrom: 'adminOnboardingService.finalRejectProvider',
    schema: {
      type: 'object',
      required: ['caseId', 'onboardingStatus', 'providerUid'],
      properties: {
        caseId: { type: 'string' },
        onboardingStatus: { type: 'string', enum: ['rejected'] },
        providerUid: { type: 'string' },
      },
    },
    note: 'Mirror of final-approve. Also HIGH RISK in the audit classification.',
  },

  'POST /api/admin/provider-onboarding/requirements/:id/approve': {
    derivedFrom:
      'adminOnboardingService.decideRequirement — `{ ...decRes.rows[0], providerNotified, '
      + 'lifecycleSynchronized }`, a RAW INSERT ... RETURNING * row plus two flags',
    schema: { $ref: '#/components/schemas/RequirementDecisionResult' },
  },

  'POST /api/admin/provider-onboarding/requirements/:id/reject': {
    derivedFrom: 'adminOnboardingService.decideRequirement, decision = rejected',
    schema: { $ref: '#/components/schemas/RequirementDecisionResult' },
    note: 'A reason code is required and is validated against the reason-codes vocabulary.',
  },

  'POST /api/admin/provider-onboarding/requirements/:id/request-resubmission': {
    derivedFrom: 'adminOnboardingService.decideRequirement, decision = needs_resubmission',
    schema: { $ref: '#/components/schemas/RequirementDecisionResult' },
    note:
      'Distinct from reject: the provider may upload again. `providerMayResubmit` on the '
      + 'chosen reason code is what makes that true.',
  },

  'POST /api/admin/communications/export': {
    derivedFrom:
      'adminCommunicationService.listCommunicationEvents, serialised to CSV in the ' +
      'controller (res.setHeader Content-Type text/csv; res.send)',
    schema: {
      type: 'string',
      contentMediaType: 'text/csv',
      description:
        'A CSV attachment (comm_events.csv), NOT JSON. Capped at 500 rows, page 1, ' +
        'regardless of what the caller asks for. Generating a JSON type for this ' +
        'operation is a mistake the envelope field exists to prevent.',
    },
    note: 'The export is audited — `comm_export_requested` is written before the file is sent.',
  },
};

/**
 * Shared schemas the entries above reference.
 *
 * Kept separate from the operations so two operations returning the same object
 * cannot drift into two descriptions of it — the same reason `openapi.ts` has a
 * `SCHEMAS` map rather than inlining every shape.
 */
export const ADMIN_SCHEMAS: Record<string, unknown> = {
  NotificationTemplate: {
    type: 'object',
    description:
      'One row of admin_notification_templates, as mapTemplateRow returns it. Field ' +
      'names and nullability are that function, not the table: it renames every column ' +
      'to camelCase and coalesces four of them.',
    required: ['id', 'templateKey', 'name', 'channel', 'bodyTemplate', 'variables', 'isActive'],
    properties: {
      id: {
        type: 'string',
        description:
          'A STRING, deliberately. mapTemplateRow wraps the column in String(row.id), ' +
          'so a client comparing id === 5 never matches.',
      },
      templateKey: { type: 'string', description: 'The stable key callers address the template by.' },
      name: { type: 'string', description: 'The ORDER BY key for the list route.' },
      channel: { type: 'string' },
      category: { type: ['string', 'null'], description: 'Coalesced to null by mapTemplateRow.' },
      subject: {
        type: ['string', 'null'],
        description: 'Coalesced to null. Meaningless for channels with no subject line.',
      },
      bodyTemplate: {
        type: 'string',
        description: 'NOT coalesced — the column is the source of truth for nullability.',
      },
      variables: {
        type: 'array',
        items: {},
        description:
          'Coalesced to [] by mapTemplateRow, so a client never has to null-check it. The ' +
          'item shape is whatever the jsonb column holds and is NOT described here — an ' +
          'honest gap rather than a guessed array item.',
      },
      isActive: { type: 'boolean' },
      createdAt: { $ref: '#/components/schemas/UtcTimestamp' },
      updatedAt: { $ref: '#/components/schemas/UtcTimestamp' },
      archivedAt: {
        oneOf: [{ $ref: '#/components/schemas/UtcTimestamp' }],
        description:
          'Coalesced to null. Non-null is what `include_archived=true` exists to reveal.',
      },
    },
  },

  CommunicationEvent: {
    type: 'object',
    description:
      'One row of admin_communication_events, as mapEventRow returns it. Fourteen of ' +
      'its twenty-six fields are coalesced to null by the mapper, so `null` here means ' +
      '"the column was null", never "the field was omitted".',
    required: ['id', 'eventKey', 'channel', 'direction', 'status', 'severity', 'retryCount'],
    properties: {
      id: {
        type: 'string',
        description: 'A STRING — String(row.id), the same treatment as NotificationTemplate.id.',
      },
      eventKey: {
        type: 'string',
        description: 'The identifier the retry and detail routes address, NOT `id`.',
      },
      channel: { type: 'string', description: 'email | socket | chat | fcm, per the summary route.' },
      direction: { type: 'string' },
      status: { type: 'string', description: "'failed' and 'retried' are the two the retry paths read." },
      severity: { type: 'string' },
      category: { type: ['string', 'null'] },
      recipientUid: { type: ['string', 'null'] },
      recipientEmail: { type: ['string', 'null'] },
      recipientName: { type: ['string', 'null'] },
      recipientRole: { type: ['string', 'null'] },
      senderUid: { type: ['string', 'null'] },
      senderRole: { type: ['string', 'null'] },
      entityType: { type: ['string', 'null'], description: 'Addressed by the entity timeline route.' },
      entityId: { type: ['string', 'null'] },
      templateName: { type: ['string', 'null'] },
      subject: { type: ['string', 'null'] },
      safeBody: {
        type: ['string', 'null'],
        description: 'The REDACTED body. Named safeBody because it is not the message as sent.',
      },
      providerResponse: { type: ['string', 'null'], description: 'Raw response from the delivery provider.' },
      retryCount: {
        type: 'integer',
        description:
          'Five is the ceiling. findRetryableFailures excludes rows at or above it, and ' +
          'markEventNonRetryable sets it to 5 to take a row out of the queue.',
      },
      lastRetryAt: { type: ['string', 'null'], format: 'date-time' },
      errorMessage: { type: ['string', 'null'] },
      metadata: { type: ['object', 'null'], description: 'Free-form jsonb. Shape is not declared.' },
      createdAt: { $ref: '#/components/schemas/UtcTimestamp' },
      updatedAt: { $ref: '#/components/schemas/UtcTimestamp' },
    },
  },

  AdminMessageReport: {
    type: 'object',
    description:
      'A moderation report as the LIST route returns it — camelCase, assembled in ' +
      'listMessageReports from chat_message_reports joined to chat_messages and ' +
      'user_credentials. The PATCH route on the same entity returns the raw snake_case ' +
      'row instead; the two are not the same shape.',
    required: ['id', 'messageId', 'reportedByUid', 'conversationId', 'status'],
    properties: {
      id: { type: 'integer', description: 'An INTEGER here — not stringified, unlike the two schemas above.' },
      messageId: { type: 'integer' },
      reportedByUid: { type: 'string', description: 'The reporter. Column is reporter_uid.' },
      reason: {
        type: ['string', 'null'],
        description: 'Renamed from the `category` column by the mapper.',
      },
      messageBody: {
        type: ['string', 'null'],
        description: 'LEFT JOINed from chat_messages, so null when the message is gone.',
      },
      conversationId: { type: 'integer' },
      status: { type: 'string', description: "pending until resolved, then 'dismissed' or 'actioned'." },
      resolvedByUid: { type: ['string', 'null'] },
      resolvedAt: { oneOf: [{ $ref: '#/components/schemas/UtcTimestamp' }] },
      resolutionNote: { type: ['string', 'null'] },
      createdAt: { $ref: '#/components/schemas/UtcTimestamp' },
    },
  },

  OnboardingQueueSummary: {
    type: 'object',
    required: [
      'newSubmissions', 'inReview', 'waitingProvider', 'waitingInternal',
      'escalated', 'readyForFinalReview', 'highPriority', 'unassigned',
    ],
    description:
      'The onboarding queue, counted in one pass. Providers only — role 2 or 4, not '
      + 'archived. Every value is an integer.',
    properties: {
      newSubmissions: {
        type: 'integer',
        description:
          'Counts a provider with NO case row as well as one whose status is `submitted`. '
          + 'A provider who has never been triaged is a new submission, not an absence.',
      },
      inReview: { type: 'integer' },
      waitingProvider: { type: 'integer' },
      waitingInternal: { type: 'integer' },
      escalated: { type: 'integer' },
      readyForFinalReview: { type: 'integer' },
      highPriority: {
        type: 'integer',
        description:
          'high OR urgent, and only for cases not already approved, rejected, withdrawn or '
          + 'expired — a closed case cannot be urgent.',
      },
      unassigned: {
        type: 'integer',
        description: 'No reviewer, and only in submitted / queued / in_review.',
      },
    },
  },

  OnboardingCaseRow: {
    type: 'object',
    required: ['providerUid', 'email', 'onboardingStatus', 'priority', 'version'],
    description: 'One row of the onboarding queue list.',
    properties: {
      caseId: {
        type: ['string', 'null'],
        description: 'NULL for a provider who has no case row yet — see newSubmissions.',
      },
      providerUid: { type: 'string' },
      fullName: {
        type: 'string',
        description: 'First and last joined and trimmed, FALLING BACK TO THE EMAIL when both are empty.',
      },
      email: { type: 'string' },
      phoneNumber: { type: ['string', 'null'] },
      photoUrl: { type: ['string', 'null'] },
      accountStatus: { type: 'string', description: "Defaults to 'pending'." },
      isEmailVerified: { type: 'boolean' },
      onboardingStatus: { type: 'string', description: "Defaults to 'not_started' when no case row exists." },
      priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
      assignedReviewer: { type: ['string', 'null'] },
      waitingParty: { type: ['string', 'null'] },
      submittedAt: { $ref: '#/components/schemas/UtcTimestamp' },
      lastActivityAt: { $ref: '#/components/schemas/UtcTimestamp' },
      version: {
        type: 'integer',
        description: 'Optimistic-concurrency token. Pass it as expectedVersion when moving the case.',
      },
      reqCount: { type: 'integer', description: 'Requirements uploaded.' },
      pendingApps: { type: 'integer' },
      activeServices: { type: 'integer' },
    },
  },

  OnboardingCaseDetail: {
    type: 'object',
    required: ['case', 'provider', 'requirements', 'services'],
    description: 'Everything a reviewer needs on one screen.',
    properties: {
      case: {
        type: 'object',
        description: 'The case row, camelCased.',
        properties: {
          id: { type: 'string' },
          providerUid: { type: 'string' },
          onboardingStatus: { type: 'string' },
          priority: { type: 'string' },
          assignedReviewer: { type: ['string', 'null'] },
          assignedTeam: { type: ['string', 'null'] },
          waitingParty: { type: ['string', 'null'] },
          submittedAt: { $ref: '#/components/schemas/UtcTimestamp' },
          firstReviewDueAt: { $ref: '#/components/schemas/UtcTimestamp' },
          decisionDueAt: { $ref: '#/components/schemas/UtcTimestamp' },
          lastActivityAt: { $ref: '#/components/schemas/UtcTimestamp' },
          completedAt: { $ref: '#/components/schemas/UtcTimestamp' },
          reopenedAt: { $ref: '#/components/schemas/UtcTimestamp' },
          internalNote: { type: ['string', 'null'] },
          version: { type: 'integer' },
        },
      },
      provider: { type: 'object', additionalProperties: true, description: 'The provider identity block.' },
      requirements: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'Uploaded requirements with their current decision.',
      },
      services: { type: 'array', items: { type: 'object', additionalProperties: true } },
      activeServices: { type: 'integer' },
      pendingApplications: {
        type: 'integer',
        description: "Service applications in pending_review, counted in JS from the same rows.",
      },
    },
  },

  OnboardingReadiness: {
    type: 'object',
    required: ['providerUid', 'isReady', 'readinessStatus', 'blockingCount', 'blockers', 'checks', 'summary'],
    description:
      'Whether this provider could be approved right now. COMPUTED ON READ, never stored, '
      + 'so it is a statement about the moment you asked.',
    properties: {
      providerUid: { type: 'string' },
      isReady: { type: 'boolean' },
      readinessStatus: { type: 'string', enum: ['ready', 'not_ready'] },
      blockingCount: { type: 'integer' },
      warningCount: {
        type: 'integer',
        description: 'Blockers of severity `warning`. These do NOT count toward blockingCount.',
      },
      blockers: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'Each carries a severity; only the non-warning ones block approval.',
      },
      checks: {
        type: 'object',
        required: ['emailVerified', 'allRequirementsApproved', 'hasActiveService'],
        properties: {
          emailVerified: { type: 'boolean' },
          allRequirementsApproved: {
            type: 'boolean',
            description:
              'FALSE when the provider has uploaded NOTHING — the predicate is '
              + '`reqs.length > 0 && every(approved)`, so an empty set is not vacuously true. '
              + 'That is deliberate: a provider with no documents is not a provider with all '
              + 'documents approved.',
          },
          hasActiveService: { type: 'boolean' },
        },
      },
      summary: {
        type: 'object',
        description: 'The counts behind the checks, so a reviewer sees why rather than only what.',
        properties: {
          emailVerified: { type: 'boolean' },
          requirementsUploaded: { type: 'integer' },
          requirementsApproved: { type: 'integer' },
          serviceApplications: { type: 'integer' },
          approvedApplications: { type: 'integer' },
          activeServices: { type: 'integer' },
        },
      },
    },
  },

  OnboardingCaseNote: {
    type: 'object',
    required: ['id', 'noteType', 'body', 'isProviderVisible', 'authorUid'],
    description: 'A case note as the LIST route returns it — camelCase, author name joined.',
    properties: {
      id: { type: 'string' },
      noteType: { type: 'string', description: "'internal' for reviewer-only commentary." },
      body: { type: 'string' },
      isProviderVisible: {
        type: 'boolean',
        description:
          'The disclosure gate. The list returns internal notes by default, so a client that '
          + 'ignores this field will show a provider what reviewers said about them.',
      },
      authorUid: { type: 'string' },
      authorName: { type: 'string', description: "Falls back to 'Admin' when the join finds no name." },
      createdAt: { $ref: '#/components/schemas/UtcTimestamp' },
    },
  },

  OnboardingCaseNoteRaw: {
    type: 'object',
    description:
      'The note as the CREATE route returns it: the raw INSERT row, SNAKE_CASE, no mapper. '
      + 'The list route on the same entity answers camelCase. Documented as it stands.',
    additionalProperties: true,
    properties: {
      id: { type: 'string' },
      case_id: { type: 'string' },
      note_type: { type: 'string' },
      body: { type: 'string' },
      is_provider_visible: { type: 'boolean' },
      author_uid: { type: 'string' },
      created_at: { $ref: '#/components/schemas/UtcTimestamp' },
    },
  },

  OnboardingCaseRaw: {
    type: 'object',
    description:
      'A provider_onboarding_cases row as `transitionCase` returns it — raw, SNAKE_CASE, '
      + 'no mapper. Contrast OnboardingCaseDetail.case, which is the camelCased projection '
      + 'of the same table.',
    additionalProperties: true,
    properties: {
      id: { type: 'string' },
      provider_uid: { type: 'string' },
      onboarding_status: { type: 'string' },
      priority: { type: 'string' },
      assigned_reviewer: { type: ['string', 'null'] },
      waiting_party: { type: ['string', 'null'] },
      version: {
        type: 'integer',
        description: 'Already incremented by this transition. Use THIS value as the next expectedVersion.',
      },
      last_activity_at: { $ref: '#/components/schemas/UtcTimestamp' },
    },
  },

  OnboardingTimelineEvent: {
    type: 'object',
    required: ['id', 'action', 'domain'],
    description: 'One audited step in a case history.',
    properties: {
      id: { type: 'string' },
      action: { type: 'string', description: 'e.g. case_status_changed_to_in_review.' },
      domain: { type: 'string', description: "'case', 'requirement', and so on." },
      prevState: { type: ['string', 'null'] },
      nextState: { type: ['string', 'null'] },
      reasonCode: { type: ['string', 'null'] },
      providerMessage: {
        type: ['string', 'null'],
        description: 'What the PROVIDER was told, as distinct from the internal rationale.',
      },
      actorUid: { type: ['string', 'null'] },
      actorName: { type: 'string', description: "Falls back to 'System' for an unattributed step." },
      resultVersion: { type: ['integer', 'null'] },
      metadata: { type: 'object', additionalProperties: true, description: 'Coalesced to {}.' },
      createdAt: { $ref: '#/components/schemas/UtcTimestamp' },
    },
  },

  OnboardingReasonCode: {
    type: 'object',
    required: ['code', 'domain', 'internalLabel', 'providerFacingTitle'],
    description:
      'One entry in the decision vocabulary. assertValidReasonCode refuses any code not in '
      + 'this table, so a client should populate its picker from here rather than hard-code.',
    properties: {
      code: { type: 'string' },
      domain: { type: 'string' },
      applicableDecisions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Coalesced to []. Which decisions this code may accompany.',
      },
      internalLabel: { type: 'string', description: 'Reviewer-facing.' },
      providerFacingTitle: { type: 'string', description: 'What the PROVIDER is told.' },
      providerFacingBody: { type: ['string', 'null'] },
      suggestedCorrection: { type: ['string', 'null'] },
      requiresFreeText: { type: 'boolean', description: 'The reviewer must add their own words.' },
      requiresEscalation: { type: 'boolean' },
      providerMayResubmit: {
        type: 'boolean',
        description: 'What separates a request-resubmission from a rejection.',
      },
      isSensitive: { type: 'boolean' },
      isActive: { type: 'boolean' },
    },
  },

  RequirementDecisionResult: {
    type: 'object',
    required: ['id', 'decision', 'provider_uid', 'reviewer_uid'],
    description:
      'The recorded decision, plus two flags about what happened AFTER it. The row half is '
      + 'a raw INSERT ... RETURNING *, so those keys are SNAKE_CASE; the two flags are '
      + 'camelCase because the service adds them. One object, two naming conventions — '
      + 'documented as it stands.',
    additionalProperties: true,
    properties: {
      id: { type: 'string', description: 'uuid.' },
      worker_requirement_id: { type: 'integer' },
      provider_uid: { type: 'string' },
      requirement_definition_code: { type: ['string', 'null'] },
      decision: {
        type: 'string',
        enum: ['approved', 'rejected', 'needs_resubmission', 'escalated'],
        description: 'Constrained by a CHECK on the table, so no other value can be stored.',
      },
      reason_code: { type: ['string', 'null'] },
      provider_message: { type: ['string', 'null'] },
      internal_rationale: {
        type: ['string', 'null'],
        description: 'REVIEWER-ONLY. Never show this to a provider; provider_message is their copy.',
      },
      reviewer_uid: { type: 'string' },
      decided_at: { $ref: '#/components/schemas/UtcTimestamp' },
      expected_req_version: { type: ['integer', 'null'] },
      is_superseded: {
        type: 'boolean',
        description:
          'Decisions are APPEND-ONLY: a later decision supersedes an earlier one rather than '
          + 'replacing it, so the history of a requirement is recoverable.',
      },
      providerNotified: {
        type: 'boolean',
        description:
          'Whether the provider was actually told. FALSE is a real outcome — the decision '
          + 'stands and the notification did not go out.',
      },
      lifecycleSynchronized: {
        type: 'boolean',
        description: 'Whether the provider account lifecycle was updated to match this decision.',
      },
    },
  },

  UtcTimestamp: {
    type: ['string', 'null'],
    format: 'date-time',
    description:
      'ISO 8601 with a UTC designator, guaranteed at the DRIVER rather than per field: ' +
      'src/db/dbQuery.ts registers asUtcIso against OIDs 1114 (timestamp) and 1184 ' +
      '(timestamptz), and that function ends in Date.toISOString(), which always emits Z. ' +
      'Postgres native "2026-08-11 11:03:23.421016+00" therefore cannot reach a client ' +
      'through this path. See TAB 03.',
  },
};
