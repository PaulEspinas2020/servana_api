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

  // ── audit-logs ────────────────────────────────────────────────────────────
  // 7 operations. The lock TAB 09 found already existed: request_id is a real
  // column here, filtered in SQL, so an operator's quoted reference resolves.

  'GET /api/admin/audit-logs': {
    derivedFrom: 'adminAuditService.findEvents -> rowToListItem',
    schema: {
      type: 'array',
      items: { $ref: '#/components/schemas/AuditListItem' },
    },
    note:
      'The controller answers ok(res, result.rows, meta) — the ARRAY is under `data` and '
      + 'total/page/limit/totalPages ride in `meta`, together with the requestId and a '
      + "generatedAt. Filterable by request_id, which is what makes an operator's quoted "
      + 'reference resolvable. See TAB 09.',
  },

  'GET /api/admin/audit-logs/:eventId': {
    derivedFrom: 'adminAuditService.getEventById',
    schema: { $ref: '#/components/schemas/AuditEventDetail' },
    note: 'Returns null for an unknown id and the controller renders that as a 404.',
  },

  'GET /api/admin/audit-logs/actor/:actorUid': {
    derivedFrom: 'adminAuditService.findActorTimeline -> rowToListItem',
    schema: { type: 'array', items: { $ref: '#/components/schemas/AuditListItem' } },
    note: 'Everything one actor did. Same item shape as the main list.',
  },

  'GET /api/admin/audit-logs/entity/:entityType/:entityId': {
    derivedFrom: 'adminAuditService.findEntityTimeline -> rowToListItem',
    schema: { type: 'array', items: { $ref: '#/components/schemas/AuditListItem' } },
    note: 'Everything that happened TO one entity. Same item shape as the main list.',
  },

  'GET /api/admin/audit-logs/summary': {
    derivedFrom: 'adminAuditService.getSummary — typed in the service signature',
    schema: {
      type: 'object',
      required: ['total', 'failed', 'blocked', 'highRisk', 'payment', 'booking', 'provider', 'catalog'],
      properties: {
        total: { type: 'integer' },
        failed: { type: 'integer' },
        blocked: {
          type: 'integer',
          description:
            'Refused attempts, which are the more interesting security events — a denied '
            + 'super-admin bootstrap is audited as blocked.',
        },
        highRisk: {
          type: 'integer',
          description:
            'Actions the service classifies HIGH_RISK: onboarding final decisions, provider '
            + 'suspension and archival, payment approvals, catalog publishes.',
        },
        payment: { type: 'integer' },
        booking: { type: 'integer' },
        provider: { type: 'integer' },
        catalog: { type: 'integer' },
      },
    },
  },

  'POST /api/admin/audit-logs/export': {
    derivedFrom: 'adminAuditService.exportEvents',
    schema: {
      type: 'object',
      required: ['content', 'format', 'count'],
      properties: {
        content: {
          type: 'string',
          description: 'The whole export as a STRING in the JSON body — not a file download.',
        },
        format: { type: 'string', enum: ['csv', 'json'] },
        count: { type: 'integer', description: 'Rows exported, capped by EXPORT_LIMIT.' },
      },
    },
    note:
      'Unlike the communications export, which sends text/csv as an attachment, this one '
      + 'returns the payload inside the normal JSON envelope. Two admin exports, two '
      + 'transports. A reason is required and the export is itself audited.',
  },

  'GET /api/admin/audit-logs/actions': {
    derivedFrom: 'adminAuditController.getAuditActions — the ACTION_LABELS vocabulary',
    schema: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
      description: 'The action vocabulary a client should populate its filter from.',
    },
  },

  // ── notifications ─────────────────────────────────────────────────────────

  'GET /api/admin/notifications': {
    derivedFrom: 'adminNotificationService.listForAdmin, with unreadCount in meta',
    schema: { type: 'array', items: { $ref: '#/components/schemas/AdminNotification' } },
    note:
      'The unread COUNT rides in `meta.unread`, not in the array. Limit defaults to 30 and '
      + 'a non-finite value falls back to 30 rather than erroring.',
  },

  'PATCH /api/admin/notifications/:id/read': {
    derivedFrom: 'adminNotificationService.markRead(uid, id) — the handler returns no payload',
    schema: {
      description:
        'NO PAYLOAD. The body is `{ status: "success" }` and nothing else — one of only two '
        + 'admin operations that acknowledge without returning anything. A client must not '
        + 'wait for an updated notification; re-read the list.',
    },
  },

  'PATCH /api/admin/notifications/read-all': {
    derivedFrom: 'adminNotificationService.markRead(uid) — no id, so every unread row',
    schema: {
      description:
        'NO PAYLOAD, and no count of what was marked. Same acknowledgement-only shape as '
        + 'the single-read route.',
    },
  },

  // ── users ─────────────────────────────────────────────────────────────────

  'GET /api/admin/users': {
    derivedFrom: 'adminUserAccountService.listUsers',
    schema: { type: 'array', items: { $ref: '#/components/schemas/AdminUserRow' } },
    note:
      'The array is under `data`; total/page/limit ride in `meta`. Every ROLE is in scope '
      + 'here — customers, providers and admins — unlike /api/admin/providers, which is '
      + 'filtered to roles 2 and 4.',
  },

  'PATCH /api/admin/users/:uid/archive': {
    derivedFrom: 'adminUserAccountService.setUserArchive',
    schema: {
      type: 'object',
      required: ['uid', 'role', 'isArchive'],
      properties: {
        uid: { type: 'string' },
        role: { type: 'integer', description: 'A NUMBER — Number(row.role).' },
        accountStatus: { type: ['string', 'null'] },
        isArchive: { type: 'boolean', description: 'The state AFTER the write, not the request.' },
      },
    },
    note: 'Archiving is reversible and does not delete the account.',
  },

  // ── customers ─────────────────────────────────────────────────────────────
  // Guests and clients are two different things in this system, and several of
  // these routes exist only because of that split.

  'GET /api/admin/customers': {
    derivedFrom: 'adminGuestService.listAllCustomers — typed `data: any[]` in the signature',
    schema: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
      description:
        'Clients AND guests in one list. The row shape is `any[]` in the service signature, '
        + 'so it is NOT described here — an honest gap rather than a guessed shape.',
    },
    note: 'total/page/limit ride in `meta`. Limit is clamped to 1..100.',
  },

  'GET /api/admin/customers/guests': {
    derivedFrom: 'adminGuestService.listGuests — typed `data: any[]`',
    schema: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
      description: 'Guest rows. Item shape is `any[]` in the service and is not guessed here.',
    },
    note: 'total/page/limit in `meta`. Limit clamped to 1..100, default 25.',
  },

  'GET /api/admin/customers/metrics': {
    derivedFrom: 'adminGuestService.getCustomerMetrics — typed in the service signature',
    schema: {
      type: 'object',
      required: ['totalClients', 'totalGuests', 'totalCustomers'],
      properties: {
        totalClients: { type: 'integer', description: 'user_credentials with role 3.' },
        totalGuests: { type: 'integer' },
        totalCustomers: {
          type: 'integer',
          description:
            'Clients plus guests. NOT a distinct-person count — a guest later linked to a '
            + 'client is counted in both halves, which is what linkedToClient measures.',
        },
        guestsWithUpcomingBookings: { type: 'integer' },
        repeatGuests: { type: 'integer' },
        linkedToClient: {
          type: 'integer',
          description: 'Guests since matched to a client account. The overlap in totalCustomers.',
        },
        withPaymentOutstanding: { type: 'integer' },
      },
    },
  },

  'GET /api/admin/customers/guest-check': {
    derivedFrom:
      'adminBookingCreateService.detectGuestDuplicate, spread with normalizedPhone added ' +
      'by the controller',
    schema: {
      type: 'object',
      required: ['normalizedPhone'],
      additionalProperties: true,
      properties: {
        normalizedPhone: {
          type: 'string',
          description:
            'The phone AFTER normalizePhilippinePhone. Echoed deliberately: the caller sent '
            + 'a raw string and the duplicate check ran against this one, so a client that '
            + 'stores the raw value will not match what the system matched on.',
        },
      },
    },
    note:
      'Whether this contact already exists as a guest or a client. Read before creating a '
      + 'guest, so one person does not become two records. The duplicate half of the '
      + 'payload is spread from the service and is not otherwise described here.',
  },

  // ── support ───────────────────────────────────────────────────────────────

  'GET /api/admin/support/cases': {
    derivedFrom: 'adminSupportCaseService.listAdminCases',
    schema: { type: 'array', items: { $ref: '#/components/schemas/AdminSupportCaseRow' } },
  },

  'GET /api/admin/support/cases/:caseId': {
    derivedFrom:
      'adminSupportCaseService.getAdminCase — spreads the RAW case row and attaches eight '
      + 'raw child collections',
    schema: { $ref: '#/components/schemas/AdminSupportCaseDetail' },
  },

  'POST /api/admin/support/cases/sla-sweep': {
    derivedFrom: 'adminSupportCaseService.sweepBreachedCases',
    schema: {
      type: 'object',
      required: ['processed'],
      properties: {
        processed: {
          type: 'integer',
          description:
            'How many breached cases were swept. ZERO is the normal answer and means nothing '
            + 'had breached, not that the sweep failed.',
        },
      },
    },
    note: 'Idempotent by predicate: a second run finds nothing still breached.',
  },

  // ── providers ─────────────────────────────────────────────────────────────
  // 50 operations, the largest single admin area. Third by blast radius: these
  // read and change the record of a person's ability to work — their identity,
  // documents, services, availability and money.
  //
  // Authored where the service could be READ. Where it could not, the entry is
  // absent and the operation publishes UNSPECIFIED, which is this file's rule:
  // a guessed schema is worse than an absent one.

  'GET /api/admin/providers': {
    derivedFrom: 'adminProviderService.listProviders — returns rowsRes.rows, the RAW rows',
    schema: {
      type: 'object',
      required: ['rows', 'total', 'page', 'limit'],
      properties: {
        rows: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            'RAW database rows, SNAKE_CASE, no mapper. Unlike getProviderIdentity, which '
            + 'camelCases the same person, this list hands back what the query selected. '
            + 'Documented as it stands rather than renamed.',
        },
        total: { type: 'integer', description: 'Exact COUNT over the filtered set.' },
        page: { type: 'integer' },
        limit: { type: 'integer' },
      },
    },
    note: 'Pages as rows/total/page/limit, like the onboarding queue and the admin bookings list.',
  },

  'GET /api/admin/providers/metrics': {
    derivedFrom: 'adminProviderService.getProviderMetrics',
    schema: { $ref: '#/components/schemas/AdminProviderMetrics' },
    note:
      'READ THE -1 SEMANTICS below before rendering any of these. Two fields are counted '
      + 'through safeCount/safeMongoCount, which return -1 when the table or collection '
      + 'cannot be read at all.',
  },

  'GET /api/admin/providers/:uid': {
    derivedFrom: 'adminProviderService.getProviderIdentity',
    schema: { $ref: '#/components/schemas/AdminProviderIdentity' },
    note:
      'Spans TWO stores: user_credentials and the profile/address tables in Postgres, plus '
      + 'the provider location document in MongoDB. onlineStatus and lastSeenAt come from '
      + 'the Mongo document, so they are absent-safe rather than authoritative.',
  },

  'GET /api/admin/providers/:uid/services': {
    derivedFrom: 'adminProviderService.getProviderActiveServices',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        required: ['serviceId'],
        properties: {
          serviceId: { type: 'integer' },
          category: { type: 'string', description: "Coalesced to '' — an empty string, never null." },
          serviceName: { type: 'string', description: "Coalesced to ''." },
          assignedAt: { $ref: '#/components/schemas/UtcTimestamp' },
        },
      },
    },
    note:
      'The services this provider may actually be assigned work for, from employee_services. '
      + 'Distinct from service APPLICATIONS, which are requests to gain one.',
  },

  'GET /api/admin/providers/:uid/service-applications': {
    derivedFrom: 'adminProviderService.getProviderServiceApplications',
    schema: { type: 'array', items: { $ref: '#/components/schemas/ProviderServiceApplication' } },
  },

  'GET /api/admin/providers/:uid/requirements': {
    derivedFrom: 'adminProviderService.getProviderRequirements',
    schema: { type: 'array', items: { $ref: '#/components/schemas/ProviderRequirementRow' } },
    note:
      'A LIST response, and it deliberately withholds signed URLs — see fileUrl. Use the '
      + 'per-document preview endpoint to obtain one.',
  },

  'GET /api/admin/providers/:uid/jobs': {
    derivedFrom: 'adminProviderService.getProviderJobs',
    schema: {
      type: 'object',
      required: ['rows', 'total', 'page', 'limit'],
      properties: {
        rows: { type: 'array', items: { $ref: '#/components/schemas/AdminProviderJobRow' } },
        total: { type: 'integer' },
        page: { type: 'integer' },
        limit: { type: 'integer' },
      },
    },
  },

  'GET /api/admin/providers/:uid/performance': {
    derivedFrom: 'adminProviderService.getProviderPerformance',
    schema: { $ref: '#/components/schemas/AdminProviderPerformance' },
  },

  'GET /api/admin/providers/:uid/earnings': {
    derivedFrom: 'adminProviderService.getProviderEarningsSummary',
    schema: { $ref: '#/components/schemas/AdminProviderEarnings' },
    note:
      'The ADMIN view, which shows gross as well as the provider share. Note '
      + 'providerSharePercent is a whole-number PERCENT while BookingPayment.servana.'
      + 'commissionRate on the v1 surface is a FRACTION — see TAB 05.',
  },

  'GET /api/admin/providers/:uid/time-off': {
    derivedFrom:
      'technicianService.getWorkerTimeOff — SELECT * FROM worker_time_off ' +
      'WHERE worker_uid = $1 ORDER BY start_date ASC, with no mapper',
    schema: { type: 'array', items: { $ref: '#/components/schemas/AdminProviderTimeOff' } },
    note:
      'Includes CANCELLED periods — cancelling sets a status, it does not delete the row. '
      + 'A client listing live time off must filter on status. This is the same entity as '
      + 'the v1 ProviderTimeOff schema, whose `id` TAB 07 corrected from string to integer.',
  },

  'GET /api/admin/providers/:uid/catalog-capabilities': {
    derivedFrom: 'adminProviderService.getProviderCatalogCapabilities',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'status'],
        properties: {
          id: { type: 'integer' },
          offeringId: { type: ['integer', 'null'] },
          serviceId: {
            type: ['integer', 'null'],
            description:
              'The CANONICAL services.id, not the legacy family id. The eligibility engine '
              + 'keys capability on this one; the legacy family is a separate column '
              + 'elsewhere and the two are not interchangeable.',
          },
          offeringName: { type: 'string', description: "Coalesced to ''." },
          catalogKey: { type: 'string', description: "Coalesced to ''." },
          category: { type: 'string', description: "Coalesced to ''." },
          serviceName: { type: 'string', description: "Coalesced to ''." },
          status: { type: 'string' },
          approvedAt: { $ref: '#/components/schemas/UtcTimestamp' },
          suspendedAt: {
            oneOf: [{ $ref: '#/components/schemas/UtcTimestamp' }],
            description: 'Non-null means the capability is withdrawn but the row survives.',
          },
          applicationId: { type: ['integer', 'null'] },
        },
      },
    },
    note:
      'What this provider is CAPABLE of in the canonical catalog — distinct from '
      + '/services, which is the legacy employee_services grant. The eligibility engine '
      + 'reads both, and its diagnostics report which source covered a booking.',
  },

  'GET /api/admin/providers/:uid/availability': {
    derivedFrom: 'adminProviderService.getProviderAvailability',
    schema: {
      type: 'object',
      required: ['schedule', 'timezone', 'timeOff'],
      properties: {
        schedule: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            'Coalesced to []. An EMPTY array is not "available always" — the auto-online '
            + 'engine reports that state as availabilityMode: missing.',
        },
        timezone: {
          type: 'string',
          description:
            "Coalesced to 'Asia/Manila'. An IANA NAME, not an offset — and Angular's "
            + 'DatePipe cannot read IANA names at all, so a client must not pass this '
            + 'straight to a date formatter. See TAB 03.',
        },
        updatedAt: { $ref: '#/components/schemas/UtcTimestamp' },
        timeOff: {
          type: 'array',
          description: 'A REDUCED projection — five fields, not the full time-off row.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              startDate: { type: 'string', format: 'date' },
              endDate: { type: 'string', format: 'date' },
              reason: { type: ['string', 'null'] },
              createdAt: { $ref: '#/components/schemas/UtcTimestamp' },
            },
          },
        },
      },
    },
    note:
      'The embedded timeOff carries NO status field, unlike GET /:uid/time-off. So this '
      + 'projection cannot distinguish an active period from a cancelled one — use the '
      + 'dedicated time-off route when that matters.',
  },

  'GET /api/admin/providers/:uid/service-area': {
    derivedFrom: 'adminProviderService.getProviderServiceArea',
    schema: {
      type: 'object',
      required: ['cityIds'],
      properties: {
        cityIds: {
          type: 'array',
          items: { type: 'integer' },
          description:
            'Coalesced to []. EMPTY MEANS NOT CONFIGURED, which the auto-online engine '
            + 'reports as serviceAreaMode: missing — it does not mean "everywhere".',
        },
        label: { type: ['string', 'null'] },
        updatedAt: { $ref: '#/components/schemas/UtcTimestamp' },
      },
    },
  },

  // ── auto-online ───────────────────────────────────────────────────────────

  'GET /api/admin/providers/:uid/auto-online/readiness': {
    derivedFrom: 'providerAutoOnlineEngine.evaluateProvider',
    schema: { $ref: '#/components/schemas/ProviderAutoOnlineReadiness' },
    note:
      'Evaluated on READ, not stored — lastEvaluatedAt is the moment you asked. The same '
      + 'shape is returned by re-evaluate and by enable-override.',
  },

  'POST /api/admin/providers/:uid/auto-online/re-evaluate': {
    derivedFrom: 'providerAutoOnlineEngine.evaluateProvider — identical call to readiness',
    schema: { $ref: '#/components/schemas/ProviderAutoOnlineReadiness' },
    note:
      'Returns the same shape as the GET. The difference is intent, not payload: this one '
      + 'records that an admin asked for a re-evaluation.',
  },

  'POST /api/admin/providers/:uid/auto-online/enable-override': {
    derivedFrom:
      'providerAutoOnlineEngine.enableAutoOnlineOverride, then evaluateProvider — the '
      + 'response is the RE-EVALUATED readiness, not an acknowledgement',
    schema: { $ref: '#/components/schemas/ProviderAutoOnlineReadiness' },
    note: 'A reason is required. Read autoOnline.eligible on the way back to confirm the override took.',
  },

  'POST /api/admin/providers/:uid/auto-online/disable': {
    derivedFrom: 'providerAutoOnlineEngine.disableAutoOnline — the payload is built in the controller',
    schema: {
      type: 'object',
      required: ['success'],
      properties: {
        success: {
          type: 'boolean',
          enum: [true],
          description:
            'A constant. The failure case is an error envelope, never `success: false` — so '
            + 'branching on this value tests nothing.',
        },
      },
    },
    note:
      'NOTE THE NESTING: this is `{ status: "success", data: { success: true } }`. Two '
      + 'success signals in one body, one of them the admin envelope and one the payload.',
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

  AdminProviderMetrics: {
    type: 'object',
    required: ['total', 'active', 'archived', 'pendingReview', 'suspended', 'rejected'],
    description:
      'Provider counts for the admin dashboard, from one query plus several helpers.'
      + ' '
      + 'TWO FIELDS CAN BE -1. providersMissingAvailability and providersMissingServiceArea '
      + 'are counted through safeCount and safeMongoCount, whose contract is stated in the '
      + 'service: "-1 means could not be established, NEVER zero". Rendering -1 as 0 turns '
      + '"we cannot read that table" into "everything is fine", which is the reading that '
      + 'costs the most.',
    properties: {
      total: { type: 'integer' },
      active: { type: 'integer' },
      archived: { type: 'integer' },
      pendingReview: { type: 'integer' },
      suspended: { type: 'integer' },
      rejected: { type: 'integer' },
      providersWithDocuments: { type: 'integer' },
      providersMissingDocuments: { type: 'integer' },
      providersWithServiceApplications: { type: 'integer' },
      providersWithPendingServiceApplications: { type: 'integer' },
      providersWithActiveServices: { type: 'integer' },
      providersWithBothActiveServiceAndPendingApplication: {
        type: 'integer',
        description: 'Deduped: a provider counted here is in both of the two above.',
      },
      providersMissingAvailability: {
        type: 'integer',
        minimum: -1,
        description:
          '-1 MEANS UNKNOWN, not zero. Counted through safeCount, which returns -1 when the '
          + 'table is absent or its schema does not match.',
      },
      providersMissingServiceArea: {
        type: 'integer',
        minimum: -1,
        description:
          '-1 MEANS UNKNOWN, not zero. This one spans MongoDB — worker_locations is not in '
          + 'Postgres, and reaching for it through safeCount is how it silently read -1 for '
          + 'the life of the function.',
      },
    },
  },

  AdminProviderIdentity: {
    type: 'object',
    required: ['uid', 'email', 'role', 'accountStatus'],
    description:
      'A provider as the 360 detail screen reads them. Assembled across user_credentials, '
      + 'the profile and address tables, the availability state and the MongoDB location '
      + 'document — so a null here can mean "not recorded" or "that store had nothing".',
    properties: {
      uid: { type: 'string' },
      email: { type: 'string' },
      firstName: { type: ['string', 'null'] },
      lastName: { type: ['string', 'null'] },
      fullName: {
        type: 'string',
        description: 'Joined and trimmed, FALLING BACK TO THE EMAIL when both names are empty.',
      },
      phoneNumber: { type: ['string', 'null'] },
      role: {
        type: 'integer',
        description: 'A NUMBER — Number(cred.role). 2 and 4 are both provider roles.',
      },
      accountStatus: { type: 'string', description: "Coalesced to 'pending'." },
      isArchive: { type: 'boolean' },
      isEmailVerified: { type: 'boolean' },
      createdDate: { $ref: '#/components/schemas/UtcTimestamp' },
      photoUrl: { type: ['string', 'null'] },
      birthdate: { type: ['string', 'null'], description: 'A DATE — no zone, deliberately unparsed.' },
      gender: { type: ['string', 'null'] },
      address: {
        oneOf: [
          {
            type: 'object',
            properties: {
              addressOne: { type: 'string' },
              addressTwo: { type: ['string', 'null'] },
              zipCode: { type: ['string', 'null'] },
              city: { type: ['string', 'null'] },
              country: { type: 'string', description: "Coalesced to 'PH'." },
              label: { type: ['string', 'null'] },
            },
          },
          { type: 'null' },
        ],
        description:
          'NULL when addressOne is empty — the whole object is withheld rather than '
          + 'returned with null fields, so a client tests the object, not each field.',
      },
      onlineStatus: {
        type: 'string',
        enum: ['online', 'offline'],
        description:
          "From the MongoDB location document. 'offline' is also what an ABSENT document "
          + 'yields, so it does not distinguish "logged off" from "never seen".',
      },
      lastSeenAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description: 'From MongoDB, so it does NOT pass through the Postgres UTC parser.',
      },
      availabilitySource: { type: ['string', 'null'] },
      availabilityChangedAt: { $ref: '#/components/schemas/UtcTimestamp' },
      availabilityChangedByUid: { type: ['string', 'null'] },
      availabilityChangedByRole: { type: ['string', 'null'] },
      availabilityReason: { type: ['string', 'null'] },
    },
  },

  ProviderServiceApplication: {
    type: 'object',
    required: ['id', 'serviceId', 'status', 'version'],
    description: 'A provider request to be granted a service.',
    properties: {
      id: { type: 'string', description: 'A STRING — String(r.id).' },
      serviceId: { type: 'integer' },
      category: { type: 'string', description: "Always '' on this route — the query selects a literal empty string." },
      serviceName: { type: 'string', description: "Coalesced to ''." },
      status: { type: 'string' },
      submittedAt: { $ref: '#/components/schemas/UtcTimestamp' },
      updatedAt: { $ref: '#/components/schemas/UtcTimestamp' },
      reviewedAt: { $ref: '#/components/schemas/UtcTimestamp' },
      reviewedBy: { type: ['string', 'null'] },
      reviewedByName: {
        type: ['string', 'null'],
        description: 'NULL when the reviewer join found nothing, not when there was no reviewer.',
      },
      reviewReason: { type: ['string', 'null'] },
      approvedAt: { $ref: '#/components/schemas/UtcTimestamp' },
      cancelledAt: { $ref: '#/components/schemas/UtcTimestamp' },
      version: { type: 'integer', description: 'Optimistic-concurrency token.' },
    },
  },

  ProviderRequirementRow: {
    type: 'object',
    required: ['id', 'fileName', 'previewAvailable', 'legacyStorage', 'version'],
    description:
      'One uploaded requirement document, as the LIST returns it. Read fileUrl and '
      + 'legacyStorage together before rendering anything.',
    properties: {
      id: { type: 'integer' },
      fileName: { type: 'string' },
      fileUrl: {
        type: ['string', 'null'],
        description:
          'NULL for every canonically-stored document, ALWAYS. The service withholds it '
          + 'deliberately: "canonical private rows never leak signed URLs through list '
          + 'responses". A non-null value here means a LEGACY row that keeps its '
          + 'compatibility URL until the controlled backfill. Use the preview endpoint to '
          + 'obtain a URL, and do not treat null as "no document" — read previewAvailable.',
      },
      previewExpiresAt: {
        type: 'null',
        description: 'ALWAYS null on the list. A constant, not a signal — the list issues no preview.',
      },
      previewAvailable: {
        type: 'boolean',
        description: 'True when EITHER a canonical storage path or a legacy URL exists. This is the "is there a document" field.',
      },
      legacyStorage: { type: 'boolean', description: 'True when there is no canonical storage path.' },
      uploadedAt: { $ref: '#/components/schemas/UtcTimestamp' },
      requirementType: { type: ['string', 'null'] },
      mimeType: { type: ['string', 'null'] },
      byteSize: { type: ['integer', 'null'], description: 'Number()d, so a bigint column arrives as a number.' },
      lifecycleState: { type: 'string', description: "Coalesced to 'legacy_review_required'." },
      scanState: {
        type: 'string',
        description:
          "The malware scan state, coalesced to 'legacy_review_required' — which means NOT "
          + 'SCANNED, not "clean". A legacy row has never been through the scanner.',
      },
      issueDate: { type: ['string', 'null'], description: 'A DATE, no zone.' },
      expiresAt: { type: ['string', 'null'] },
      identifierMask: {
        type: ['string', 'null'],
        description: 'A MASKED identifier. The full value is never projected to an admin list.',
      },
      version: { type: 'integer', description: 'Coalesced to 1.' },
    },
  },

  AdminProviderJobRow: {
    type: 'object',
    required: ['id', 'bookingId', 'bookingCode', 'currency'],
    description: 'One job in a provider history, as the admin list projects it.',
    properties: {
      id: { type: 'string', description: 'A STRING, and the SAME value as bookingId.' },
      bookingId: { type: 'string', description: 'A STRING here, though the v1 surface types booking ids as integers.' },
      bookingCode: { type: 'string', description: 'Derived, SVN-XXXXXX. Not a stored column.' },
      status: { type: 'string', description: "Coalesced to ''." },
      serviceName: { type: 'string' },
      categoryName: { type: 'string' },
      customerName: {
        type: 'string',
        description:
          'DELIBERATELY MASKED: first name plus the INITIAL of the surname, e.g. "Maria S.". '
          + 'A provider job history is not a customer directory, and the full surname is not '
          + 'projected here even for an admin.',
      },
      addressLine: { type: 'string' },
      city: { type: 'string' },
      scheduledAt: { $ref: '#/components/schemas/UtcTimestamp' },
      createdAt: { $ref: '#/components/schemas/UtcTimestamp' },
      bookingAmount: { type: 'number', description: 'final_price, Number()d. PHP major units.' },
      quotedPrice: { type: 'number', description: 'PHP major units.' },
      transpoFee: { type: 'number', description: 'PHP major units.' },
      paymentMethod: { type: 'string', description: "Lower-cased, coalesced to 'cash'." },
      currency: { type: 'string', enum: ['PHP'] },
    },
  },

  AdminProviderPerformance: {
    type: 'object',
    required: ['totalJobs', 'completedJobs', 'completionRate', 'currency'],
    properties: {
      totalJobs: { type: 'integer' },
      completedJobs: { type: 'integer' },
      cancelledJobs: { type: 'integer' },
      activeJobs: { type: 'integer', description: 'In progress right now.' },
      completionRate: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description:
          'A WHOLE-NUMBER PERCENTAGE in [0, 100] — 80 means 80%, not 0.8. Rounded. '
          + 'ZERO when totalJobs is 0, which is a division guard rather than a measurement: '
          + 'a provider with no jobs has no completion rate, and 0% reads as failure. '
          + 'Check totalJobs before rendering this. See TAB 05 on rate units.',
      },
      totalGross: { type: 'number', description: 'PHP major units.' },
      currency: { type: 'string', enum: ['PHP'] },
    },
  },

  AdminProviderEarnings: {
    type: 'object',
    required: ['totalJobs', 'totalGrossAmount', 'totalProviderShare', 'providerSharePercent', 'currency'],
    description: 'The ADMIN earnings view, which discloses gross as well as the provider share.',
    properties: {
      totalJobs: { type: 'integer' },
      totalGrossAmount: { type: 'number', description: 'PHP major units.' },
      totalProviderShare: {
        type: 'number',
        description: 'providerShareOf(gross) — computed server-side, never by a client.',
      },
      thisMonthGross: {
        type: 'number',
        description:
          'Filtered by DATE_TRUNC month on the SESSION timezone, which the pool pins to UTC. '
          + 'So "this month" is a UTC month, and Servana operates in Asia/Manila (+08): the '
          + 'first eight hours of a Manila month fall in the previous UTC one.',
      },
      thisMonthProviderShare: { type: 'number' },
      providerSharePercent: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description:
          'A WHOLE-NUMBER PERCENT in [0, 100]. NOT a fraction — contrast '
          + 'BookingPayment.servana.commissionRate on the v1 surface, which is a fraction in '
          + '[0, 1]. One split, two representations, a hundredfold apart. See TAB 05.',
      },
      currency: { type: 'string', enum: ['PHP'] },
    },
  },

  AdminProviderTimeOff: {
    type: 'object',
    required: ['id', 'worker_uid', 'start_date', 'end_date', 'status'],
    description:
      'A worker_time_off row as the ADMIN route returns it: SELECT *, no mapper, so the '
      + 'keys are SNAKE_CASE. The v1 ProviderTimeOff schema describes the same table in '
      + 'camelCase — two shapes for one entity, documented rather than reconciled.',
    additionalProperties: true,
    properties: {
      id: {
        type: 'integer',
        description: 'A NUMBER. The column is integer; TAB 07 corrected the v1 contract, which claimed string.',
      },
      worker_uid: { type: 'string' },
      start_date: { type: 'string', format: 'date' },
      end_date: { type: 'string', format: 'date' },
      all_day: { type: 'boolean' },
      start_time: { type: ['string', 'null'] },
      end_time: { type: ['string', 'null'] },
      reason: { type: ['string', 'null'] },
      note: { type: ['string', 'null'] },
      status: {
        type: 'string',
        enum: ['active', 'cancelled'],
        description: 'Cancelling does NOT delete the row, so this list includes cancelled periods.',
      },
      created_at: { $ref: '#/components/schemas/UtcTimestamp' },
      created_by: { type: ['string', 'null'] },
      cancelled_at: { $ref: '#/components/schemas/UtcTimestamp' },
      cancelled_by: { type: ['string', 'null'] },
    },
  },

  ProviderAutoOnlineReadiness: {
    type: 'object',
    required: ['providerUid', 'source', 'details', 'documents', 'serviceAssociation', 'autoOnline'],
    description:
      'Whether this provider can be brought online automatically, and what is stopping it. '
      + 'Evaluated on READ — autoOnline.lastEvaluatedAt is the moment you asked, not a '
      + 'stored fact. Typed as ProviderAutoOnlineReadiness in providerAutoOnlineEngine.',
    properties: {
      providerUid: { type: 'string' },
      source: {
        type: 'object',
        description: 'Where this provider came from, and how confident that is.',
        properties: {
          registrationSource: {
            type: 'string',
            enum: [
              'provider_web', 'provider_mobile', 'admin_created',
              'inferred_mobile', 'inferred_web', 'unknown',
            ],
          },
          sourceConfidence: {
            type: 'string',
            enum: ['explicit', 'inferred', 'unknown'],
            description: "'inferred' means it was deduced, not recorded — do not report it as fact.",
          },
          firstSeenAt: { type: ['string', 'null'], format: 'date-time' },
          lastSeenAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      details: {
        type: 'object',
        description: 'Identity completeness.',
        properties: {
          complete: { type: 'boolean' },
          missingFields: { type: 'array', items: { type: 'string' } },
          firstName: { type: 'boolean' },
          lastName: { type: 'boolean' },
          hasEmail: { type: 'boolean' },
          hasPhone: { type: 'boolean' },
          roleValid: { type: 'boolean' },
          accountAllowed: { type: 'boolean' },
        },
      },
      documents: {
        type: 'object',
        properties: {
          complete: { type: 'boolean' },
          requiredTotal: { type: 'integer', enum: [3], description: 'A CONSTANT of 3 in the engine.' },
          submittedRequired: { type: 'integer' },
          approvedRequired: { type: 'integer' },
          pendingReviewRequired: { type: 'integer' },
          missingRequiredTypes: { type: 'array', items: { type: 'string' } },
          classification: {
            type: 'string',
            enum: ['typed', 'legacy_inferred', 'incomplete', 'unknown'],
            description: "'legacy_inferred' means the types were deduced from older rows.",
          },
        },
      },
      serviceAssociation: {
        type: 'object',
        properties: {
          complete: { type: 'boolean' },
          associatedServiceIds: { type: 'array', items: { type: 'integer' } },
          associatedOfferingIds: { type: 'array', items: { type: 'integer' } },
          associatedCatalogKeys: { type: 'array', items: { type: 'string' } },
          source: {
            type: 'string',
            enum: ['employee_services', 'service_applications', 'catalog_capabilities', 'mixed', 'none'],
            description: 'WHICH store the association was found in. `mixed` means more than one, and they may disagree.',
          },
        },
      },
      autoOnline: {
        type: 'object',
        required: ['eligible', 'active', 'bookable', 'onlineStatus', 'lastEvaluatedAt'],
        properties: {
          eligible: { type: 'boolean', description: 'May be brought online automatically.' },
          active: { type: 'boolean', description: 'Auto-online is switched on for them.' },
          bookable: {
            type: 'boolean',
            description: 'The one that decides whether work can reach them. Eligible and active are inputs to it.',
          },
          onlineStatus: { type: 'string', enum: ['online', 'offline'] },
          availabilityMode: {
            type: 'string',
            enum: ['all_time', 'custom', 'missing'],
            description: "'missing' is not 'always available' — it means nothing was configured.",
          },
          serviceAreaMode: {
            type: 'string',
            enum: ['all', 'custom', 'missing'],
            description: "'missing' means no area was configured.",
          },
          activatedAt: { type: ['string', 'null'], format: 'date-time' },
          lastEvaluatedAt: {
            type: 'string',
            format: 'date-time',
            description: 'The moment THIS request evaluated it. Never a stored value.',
          },
          reasonCodes: { type: 'array', items: { type: 'string' } },
          blockers: { type: 'array', items: { type: 'string' }, description: 'What prevents bookability.' },
          warnings: {
            type: 'array',
            items: { type: 'string' },
            description: 'Do NOT prevent bookability. Rendering these as blockers overstates the problem.',
          },
        },
      },
    },
  },

  AuditListItem: {
    type: 'object',
    required: ['eventId', 'action', 'actionCategory', 'outcome', 'entityType', 'entityId', 'severity'],
    description: 'One audit event as the lists project it. Every field is stringified or defaulted by rowToListItem.',
    properties: {
      eventId: { type: 'string' },
      occurredAt: { $ref: '#/components/schemas/UtcTimestamp' },
      displayTime: {
        type: 'string',
        description:
          'A PRE-RENDERED Manila local time string, beside the ISO occurredAt. Two '
          + 'representations of one instant: render this, compute with occurredAt. Do not '
          + 'parse displayTime — it is display text, not a timestamp.',
      },
      action: { type: 'string' },
      actionLabel: { type: 'string', description: 'Human-readable, FALLING BACK to the raw action when unmapped.' },
      actionCategory: { type: 'string', description: "Coalesced to ''." },
      outcome: { type: 'string', description: "Coalesced to 'success'." },
      actorUid: { type: ['string', 'null'] },
      actorDisplayName: { type: ['string', 'null'] },
      actorRole: { type: ['string', 'null'] },
      entityType: { type: 'string', description: "Coalesced to ''." },
      entityId: { type: 'string', description: "A STRING, coalesced to ''." },
      entityDisplayName: { type: ['string', 'null'] },
      summary: { type: 'string', description: 'Composed server-side from action, outcome, entity and actor.' },
      severity: { type: 'string', description: 'Computed from the action and its outcome, not stored.' },
      requestId: {
        type: ['string', 'null'],
        description:
          'THE JOIN KEY. Filterable via ?request_id=, which is how an operator turns a '
          + 'quoted reference into the action that produced it. See TAB 09.',
      },
    },
  },

  AuditEventDetail: {
    type: 'object',
    description: 'One audit event in full, including the before/after state it changed.',
    additionalProperties: true,
    properties: {
      entity: { type: 'object', additionalProperties: true },
      relatedEntities: { type: ['object', 'null'] },
      before: { type: ['object', 'null'], description: 'State BEFORE the action. Null when it created something.' },
      after: { type: ['object', 'null'], description: 'State AFTER. Null when it deleted something.' },
      changedFields: { type: 'array', items: { type: 'string' }, description: 'Coalesced to [].' },
      reason: { type: ['string', 'null'] },
      note: { type: ['string', 'null'] },
      request: {
        type: 'object',
        description: 'How the action arrived. This is the block an operator joins a quoted id against.',
        properties: {
          requestId: { type: ['string', 'null'] },
          clientRequestId: { type: ['string', 'null'] },
          ipAddress: { type: ['string', 'null'] },
          userAgent: { type: ['string', 'null'] },
          source: { type: 'string', description: "Coalesced to 'admin_portal'." },
        },
      },
      metadata: { type: ['object', 'null'] },
      severity: { type: 'string' },
      display: {
        type: 'object',
        description: 'Pre-composed presentation text, so two clients cannot word the same event differently.',
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          actorLabel: { type: 'string', description: "Falls back to the uid, then to 'System'." },
          entityLabel: { type: 'string', description: 'entityType:entityId.' },
          changedFieldsSummary: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },

  AdminNotification: {
    type: 'object',
    required: ['id', 'type', 'severity', 'title'],
    properties: {
      id: { type: 'integer', description: 'A NUMBER — Number(row.id).' },
      type: { type: 'string' },
      severity: { type: 'string' },
      title: { type: 'string' },
      body: { type: ['string', 'null'] },
      bookingId: { type: ['integer', 'null'] },
      conversationId: { type: ['integer', 'null'] },
      readAt: {
        oneOf: [{ $ref: '#/components/schemas/UtcTimestamp' }],
        description: 'NULL means unread. This is the field, not a boolean.',
      },
      createdAt: { $ref: '#/components/schemas/UtcTimestamp' },
    },
  },

  AdminUserRow: {
    type: 'object',
    required: ['uid', 'role', 'isArchive', 'isEmailVerified'],
    description: 'One account of ANY role — customer, provider or admin.',
    properties: {
      uid: { type: 'string' },
      email: { type: ['string', 'null'] },
      phoneNumber: { type: ['string', 'null'] },
      firstName: { type: 'string', description: "Coalesced to '', never null." },
      lastName: { type: 'string', description: "Coalesced to ''." },
      fullName: {
        type: 'string',
        description:
          'Joined from the parts that exist. EMPTY STRING when neither does — it does NOT '
          + 'fall back to the email, unlike the provider and onboarding lists, which do.',
      },
      role: { type: 'integer', description: 'A NUMBER. 1 admin, 2 and 4 provider, 3 customer.' },
      accountStatus: { type: ['string', 'null'] },
      isArchive: { type: 'boolean' },
      isEmailVerified: { type: 'boolean' },
      createdAt: { $ref: '#/components/schemas/UtcTimestamp' },
    },
  },

  AdminSupportCaseRow: {
    type: 'object',
    required: ['caseId', 'domain', 'providerState', 'internalState', 'version'],
    description:
      'One support case in the admin queue. Note the TWO state fields: providerState is '
      + 'what the provider is shown, internalState is what the queue runs on. They are not '
      + 'the same vocabulary and must not be rendered interchangeably.',
    properties: {
      caseId: { type: 'string', description: 'A STRING — String(row.case_id).' },
      reference: { type: 'string', description: 'The PUBLIC reference, which is what a provider quotes.' },
      providerUid: { type: 'string' },
      domain: { type: 'string' },
      categoryId: { type: ['string', 'null'] },
      categoryTitle: {
        type: ['string', 'null'],
        description: 'The PROVIDER-facing category title, from provider_title.',
      },
      title: { type: ['string', 'null'] },
      providerState: { type: 'string', description: 'What the provider sees.' },
      internalState: { type: 'string', description: 'What the queue runs on. NOT provider-facing.' },
      severity: { type: ['string', 'null'] },
      priority: { type: ['string', 'null'] },
      queue: { type: ['string', 'null'], description: 'current_queue.' },
      providerActionRequired: { type: 'boolean' },
      escalationState: { type: ['string', 'null'] },
      escalationDueAt: { $ref: '#/components/schemas/UtcTimestamp' },
      version: { type: 'integer', description: 'Optimistic-concurrency token for transitions.' },
    },
  },

  AdminSupportCaseDetail: {
    type: 'object',
    description:
      'A case in full. The RAW case row is spread at the top level — so those keys are '
      + 'SNAKE_CASE — with `caseId` added as a camelCase string alongside, and eight raw '
      + 'child collections attached. One object, two naming conventions, and the children '
      + 'are unmapped query rows.',
    additionalProperties: true,
    properties: {
      caseId: { type: 'string', description: 'Added by the service beside the raw case_id it duplicates.' },
      sources: { type: 'array', items: { type: 'object', additionalProperties: true } },
      messages: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'Provider-visible correspondence.',
      },
      internalNotes: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'REVIEWER-ONLY. Never render these beside messages — they are not provider-facing.',
      },
      events: { type: 'array', items: { type: 'object', additionalProperties: true } },
      attachments: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'Metadata only. Use the preview endpoint for a URL.',
      },
      resolutions: { type: 'array', items: { type: 'object', additionalProperties: true } },
      appeals: { type: 'array', items: { type: 'object', additionalProperties: true } },
      escalations: { type: 'array', items: { type: 'object', additionalProperties: true } },
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
