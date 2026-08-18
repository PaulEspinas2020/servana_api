/**
 * THE messaging declaration — one file, four consumers, no database handle.
 *
 *   1. `chat/chat.service.ts` and `chat/chat.repository.ts` ENFORCE it.
 *   2. `services/messaging/conversationDto.ts` PROJECTS from it.
 *   3. `scripts/generate-messaging-docs.ts` EXECUTES it to write
 *      `docs/messaging/MESSAGING_V1_CONTRACT.md`.
 *   4. `tests/messaging-*.test.ts` ASSERT against it.
 *
 * Same arrangement as `booking/experiencePolicy.ts` and
 * `finance/financePolicy.ts`, and for the same reason: a rule that is written
 * down in a document and again in a service is two rules that agree until the
 * day one of them is edited. Here the document is produced by running the
 * declaration, so it cannot describe a policy the backend does not implement.
 *
 * ## Why the conversation states live HERE and not in the repository
 *
 * `chat.repository` used to own `CONVERSATION_STATUS` and `WRITABLE_STATUSES`.
 * It still exports both — three clients and several services import them from
 * there — but it now re-exports these. The repository imports `../config`, which
 * needs a database, so a policy that lived there could not be executed by a docs
 * generator or read by a test without mocking pg. Moving the DECLARATION to a
 * dependency-free module and leaving the EXPORT where callers already find it
 * costs nothing and makes the policy runnable.
 *
 * ## Nothing in this file talks to anything
 *
 * No imports beyond types. Every decision function is pure. That is what lets
 * the generated document be evidence — the tables in it are produced by calling
 * these functions, not by describing them.
 */

// ─── Client surfaces ──────────────────────────────────────────────────────────

export type ClientSurface =
  | 'customerMobile'
  | 'customerWeb'
  | 'providerMobile'
  | 'providerWeb'
  | 'admin';

export const CLIENT_SURFACES: readonly ClientSurface[] = Object.freeze([
  'customerMobile',
  'customerWeb',
  'providerMobile',
  'providerWeb',
  'admin',
]);

// ─── Conversation identity ────────────────────────────────────────────────────

/**
 * What a conversation can be ABOUT.
 *
 * Exactly one kind today, and it is named rather than assumed: every
 * conversation in the platform is anchored to a booking, participants are
 * derived from that booking, and there is no direct customer↔provider channel.
 * A messaging layer whose only membership rule is "whoever the booking says"
 * cannot leak across accounts by construction, and that property is worth
 * stating as a policy rather than leaving as an implementation accident.
 *
 * Adding a kind means adding a membership resolver for it. The enum exists so
 * that is a visible decision instead of a new `if` inside an authorization
 * function.
 */
export const CONVERSATION_KINDS = {
  /** Anchored to `bookings.id`. Participants come from the booking. */
  BOOKING: 'BOOKING',
} as const;

export type ConversationKind = (typeof CONVERSATION_KINDS)[keyof typeof CONVERSATION_KINDS];

/**
 * The canonical resource identity every client must use.
 *
 * `chat_conversations.id` — an integer, already what all four shipped clients
 * key their threads on, and already unique per booking (`booking_id` carries a
 * unique constraint). A new opaque identifier would be a better shape in the
 * abstract and would mean every installed build losing its thread identity on
 * the day it was introduced, for no gain in the property that matters.
 */
export const CONVERSATION_IDENTITY = {
  resource: 'conversation',
  idColumn: 'chat_conversations.id',
  idType: 'integer',
  anchor: 'bookings.id via chat_conversations.booking_id (unique)',
  note:
    'One conversation per booking, forever. A second thread for the same booking would ' +
    'split the audit trail the platform depends on for disputes.',
} as const;

// ─── Conversation lifecycle ───────────────────────────────────────────────────

/**
 * Conversation lifecycle states. THE declaration; `chat.repository` re-exports.
 *
 * `is_closed` (the original boolean) is kept and kept correct: the Flutter
 * customer app, the provider portal and the admin portal all read it. It is
 * maintained as a derived compatibility flag meaning "customer and provider
 * cannot write here", so a client that knows nothing about `status` still
 * behaves correctly. Never drop it.
 */
export const CONVERSATION_STATUS = {
  ACTIVE: 'ACTIVE',
  READ_ONLY: 'READ_ONLY',
  ARCHIVED: 'ARCHIVED',
  CLOSED: 'CLOSED',
  SUPPORT_ESCALATED: 'SUPPORT_ESCALATED',
} as const;

export type ConversationStatus =
  (typeof CONVERSATION_STATUS)[keyof typeof CONVERSATION_STATUS];

export const CONVERSATION_STATUS_NAMES = Object.freeze(
  Object.values(CONVERSATION_STATUS),
) as readonly ConversationStatus[];

export interface ConversationStateSpec {
  /** What this state means, in one sentence, for a person reading the doc. */
  description: string;
  /** May the customer and the assigned provider post? */
  partiesMayWrite: boolean;
  /** May Servana support post? */
  supportMayWrite: boolean;
  /** What puts a conversation here. */
  enteredBy: string;
}

export const CONVERSATION_STATES: Readonly<Record<ConversationStatus, ConversationStateSpec>> =
  Object.freeze({
    ACTIVE: {
      description: 'The normal state. Customer, assigned provider and support may all post.',
      partiesMayWrite: true,
      supportMayWrite: true,
      enteredBy: 'Created when a provider is confirmed for the booking.',
    },
    SUPPORT_ESCALATED: {
      description:
        'A dispute reopened the SAME conversation rather than starting a parallel one, so ' +
        'the booking keeps one auditable timeline. Everyone may still post.',
      partiesMayWrite: true,
      supportMayWrite: true,
      enteredBy: 'A dispute is opened on the booking.',
    },
    READ_ONLY: {
      description:
        'The transcript stays readable and the parties may no longer post. Support still can, ' +
        'so a late question has somewhere to be answered.',
      partiesMayWrite: false,
      supportMayWrite: true,
      enteredBy: `Completion plus the ${'`'}GRACE_HOURS${'`'} window elapsing.`,
    },
    CLOSED: {
      description: 'The booking was cancelled. Readable, not writable by the parties.',
      partiesMayWrite: false,
      supportMayWrite: true,
      enteredBy: 'The booking is cancelled.',
    },
    ARCHIVED: {
      description: 'Retained for the record. No new participants are admitted.',
      partiesMayWrite: false,
      supportMayWrite: true,
      enteredBy: 'An explicit archive, after READ_ONLY.',
    },
  });

/** States in which the customer and the assigned provider may still post. */
export const WRITABLE_STATUSES: ConversationStatus[] = CONVERSATION_STATUS_NAMES.filter(
  (s) => CONVERSATION_STATES[s].partiesMayWrite,
);

// ─── Seats ────────────────────────────────────────────────────────────────────

/**
 * WHO someone is in a conversation, in the vocabulary the DTO speaks.
 *
 * Deliberately not the numeric `user_credentials.role`, and deliberately not
 * `chat.service`'s internal `client | coworker | admin`. A seat is a
 * relationship to THIS conversation: the same admin is `support` here and a
 * customer on their own booking. Clients branch on the seat, so the seat is the
 * thing that has to be stable.
 */
export type ParticipantSeat = 'customer' | 'provider' | 'support';

export const PARTICIPANT_SEATS: readonly ParticipantSeat[] = Object.freeze([
  'customer',
  'provider',
  'support',
]);

/** `chat.service`'s internal access role, translated once. */
export const SEAT_OF_ACCESS_ROLE: Readonly<Record<'client' | 'coworker' | 'admin', ParticipantSeat>> =
  Object.freeze({ client: 'customer', coworker: 'provider', admin: 'support' });

// ─── Messages ─────────────────────────────────────────────────────────────────

export const MESSAGE_TYPES = Object.freeze(['text', 'image', 'file', 'system'] as const);
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** Types a CALLER may send. `system` is authored by the backend only. */
export const SENDABLE_MESSAGE_TYPES: readonly MessageType[] = Object.freeze([
  'text',
  'image',
  'file',
]);

export const MESSAGE_BODY_MAX = 4000;

/**
 * The idempotency key every send must carry.
 *
 * Not optional, and not generated server-side. A client that retries after a
 * timeout has no other way to say "this is the same message I already sent", and
 * a chat that duplicates on a flaky connection is one people stop trusting. The
 * database enforces it with a partial unique index; this is the shape contract.
 */
export const CLIENT_MESSAGE_ID = {
  minLength: 16,
  maxLength: 128,
  pattern: '^[A-Za-z0-9._:-]+$',
  required: true,
} as const;

/** Per-sender send throttle. Applied AFTER the idempotency check, so a retry
 *  of an already-accepted message never consumes budget. */
export const SEND_RATE_LIMIT = { windowMs: 10_000, maxMessages: 20 } as const;

/**
 * Cursor pagination, one convention for every client.
 *
 * Keyset on `chat_messages.id` descending — newest first, page backwards with
 * `cursor`. Offset paging is wrong for a live transcript: rows arrive at the end
 * while a reader pages, so page 2 of an offset scan silently repeats or skips
 * messages. The cursor is the id of the oldest message in the page, sent back as
 * a string so it can become opaque later without a client change.
 */
export const MESSAGE_PAGE = {
  defaultLimit: 30 as number,
  maxLimit: 100 as number,
  order: 'id DESC (newest first)',
  cursorField: 'chat_messages.id',
  cursorMeaning: 'Return messages strictly OLDER than this id.',
} as const;

/**
 * What the platform actually knows about delivery and reading.
 *
 * Stated because the honest answer is narrower than the words usually imply,
 * and a DTO field called `deliveredAt` that is really "the server wrote the row"
 * is a lie a client will render as a checkmark next to someone's name.
 *
 *   - There is NO per-device delivery acknowledgement channel. Socket.IO
 *     acknowledges the SEND to the sender; it does not report arrival at the
 *     recipient. So no `deliveredAt` is published.
 *   - Read state is real and is derived from `chat_participants.last_read_message_id`
 *     — a high-water mark, monotonic, and only ever advanced to a message that
 *     exists in that conversation and is visible to that participant.
 *   - `last_read_at` records WHEN the pointer last moved, which is what a
 *     "seen 10:42" label needs and what the pointer alone cannot say.
 */
export const RECEIPT_MODEL = {
  delivered: {
    tracked: false,
    reason:
      'No per-device acknowledgement channel exists. `sentAt` is the moment the server ' +
      'accepted the message; publishing it as "delivered" would be a claim about the ' +
      "recipient's device that nothing in the system can support.",
  },
  read: {
    tracked: true,
    source: 'chat_participants.last_read_message_id (high-water mark) + last_read_at',
    perMessage:
      'A message is read by a participant when their pointer is at or past its id. ' +
      'The DTO publishes readByCount and readByAll — never the list of uids, which is ' +
      'participant identity a sender does not need to render a receipt.',
  },
} as const;

/**
 * The canonical message DTO field list.
 *
 * One builder produces this for the REST list, the REST send response, the
 * realtime `message:new` payload and the legacy chat routes. That is the
 * property the release gate depends on: "realtime and fallback reconciliation
 * agree" is not two code paths being kept in step, it is one code path with two
 * transports.
 */
export const MESSAGE_DTO_FIELDS = Object.freeze([
  'id',
  'conversationId',
  'bookingId',
  'type',
  'body',
  'senderSeat',
  'senderUid',
  'isMine',
  'isSystem',
  'clientMsgId',
  'sentAt',
  'editedAt',
  'deletedAt',
  'isDeleted',
  'readByCount',
  'readByAll',
  'attachments',
  'metadata',
] as const);

// ─── Unread ───────────────────────────────────────────────────────────────────

/**
 * ONE definition of unread, written down because three surfaces render a badge
 * from it and a badge that disagrees with the thread is the most-reported class
 * of messaging bug there is.
 *
 * A message is unread FOR a participant when all of the following hold. Every
 * clause is a `WHERE` in the one SQL expression `chat.repository` exposes, and
 * `tests/messaging-unread-reconciliation.test.ts` recomputes the count in
 * TypeScript from the same clauses and asserts the two agree.
 */
export const UNREAD_DEFINITION = Object.freeze([
  'the message is in a conversation the participant may read',
  'the message is not soft-deleted',
  'the message was created at or after the participant joined (a re-admitted participant does not inherit a backlog)',
  'the participant has no read pointer, or the pointer is below the message id',
  'the participant is not the sender (your own message is never unread to you)',
] as const);

/**
 * An admin is authorized by ROLE and usually holds no participant row, so
 * "unread" is undefined for them. Reporting zero with `isParticipant: false` is
 * the honest answer; computing a count against every conversation in the
 * platform would put every active booking in every admin's badge.
 */
export const UNREAD_FOR_NON_PARTICIPANT = { count: 0, isParticipant: false } as const;

// ─── Attachments ──────────────────────────────────────────────────────────────

export const ATTACHMENT_POLICY = {
  maxPerMessage: 5,
  maxBytes: 10 * 1024 * 1024,
  allowedMimeTypes: Object.freeze([
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
  ] as const),
  /**
   * An attachment reference is only accepted if it was produced by THIS
   * caller's own upload. The storage key is prefixed with the uploader's uid and
   * the reference is re-derived from that prefix on every send, so a caller
   * cannot attach an object somebody else uploaded by quoting its URL.
   */
  ownership: 'The storage object name must begin with `<callerUid>_`.',
  /**
   * Two accepted forms, and nothing else: a bare owned storage key (what the
   * upload endpoint returns and what the shipped clients store), or an absolute
   * Firebase Storage download URL in the CONFIGURED bucket under the
   * `chat-attachments/` prefix. Any other host, bucket or prefix is refused —
   * an unchecked URL field is an open redirect and an SSRF surface wearing a
   * filename.
   */
  acceptedReferenceForms: Object.freeze([
    'owned storage key: `<callerUid>_<uuid>`',
    'https://firebasestorage.googleapis.com/v0/b/<configured-bucket>/o/chat-attachments/<callerUid>_<uuid>',
  ] as const),
  /** Content type is proven from the file's magic bytes at upload, not from the
   *  declared data-URI mime — a client can claim anything. */
  contentTypeProof: 'helpers/fileSignature.validateDataUri (magic bytes)',
  /** Uploading requires send capability on the conversation when one is named. */
  uploadAuthorization:
    'The uploader must be able to SEND into the conversation the attachment is for.',
  /**
   * How the object is served — stated because the honest answer is narrower than
   * "access-controlled" usually implies.
   *
   * An attachment is stored with a random `firebaseStorageDownloadTokens` value
   * and served from a URL containing it. That is an UNGUESSABLE CAPABILITY: the
   * object is not publicly listable and the bucket needs no `allUsers` grant,
   * but anyone holding the URL can fetch it, and the URL does not expire.
   *
   * The stronger model exists in this codebase — `uploadPrivateFileToStorage`
   * plus a short-lived `createPrivatePreviewUrl` minted after re-authorizing the
   * caller — and is what provider documents use. Chat attachments do not use it
   * yet, because all four shipped clients STORE the returned URL and render it
   * directly; moving to signed previews changes the client contract from "a URL
   * you keep" to "a URL you re-request", which is a client release, not a
   * backend change. Recorded here rather than left as an unstated difference
   * between two parts of the same system.
   */
  urlModel: {
    kind: 'unguessable capability URL',
    expires: false,
    reauthorizedPerRequest: false,
    strongerModelAvailable: 'helpers/firebaseStorageUploader.createPrivatePreviewUrl (300s, re-authorized)',
    whyNotYet:
      'Every shipped client stores and renders the returned URL. Signed previews change the ' +
      'client contract from "a URL you keep" to "a URL you re-request".',
  },
} as const;

export type AttachmentRefusal =
  | 'ATTACHMENT_MALFORMED'
  | 'ATTACHMENT_REFERENCE_INVALID'
  | 'ATTACHMENT_NOT_OWNED'
  | 'ATTACHMENT_TYPE_NOT_ALLOWED'
  | 'ATTACHMENT_TOO_LARGE'
  | 'ATTACHMENT_COUNT_EXCEEDED';

// ─── Realtime ─────────────────────────────────────────────────────────────────

/**
 * The realtime schema version, stamped on every emitted payload.
 *
 * Additive: no shipped client reads it. It exists so the NEXT change to an event
 * payload can be detected by a client rather than guessed at, which is the thing
 * that made this schema hard to evolve in the first place.
 */
export const REALTIME_SCHEMA_VERSION = 1;

/** The Socket.IO namespace every client connects to for messaging. */
export const REALTIME_NAMESPACE = '/chat';

/** Room naming. One room per conversation; membership is re-authorized on join. */
export const REALTIME_ROOM = 'conversation:<conversationId>';

export interface RealtimeEventSpec {
  name: string;
  direction: 'server→client' | 'client→server';
  /** The payload, described by its keys. Message events carry the message DTO. */
  payload: string;
  description: string;
}

/**
 * THE realtime event catalog — one schema across Customer Mobile/Web and
 * Provider Mobile/Web.
 *
 * ## Why the names are the ones that already exist
 *
 * The obvious move when centralising is to mint a clean event vocabulary and
 * emit both for a while. That would double-deliver every message to any client
 * that listened to the old and the new name, and a duplicate message is exactly
 * the failure this tab is supposed to remove. The existing names are already
 * shared by all four clients, so the canonical schema IS the current names, with
 * the payloads centralised behind one builder and three additive envelope keys
 * (`event`, `schemaVersion`, `emittedAt`) stamped on the way out.
 *
 * Emitting anything not in this list is a throw in `emitMessagingEvent`. An
 * event nobody documented is one no client can be written against.
 */
export const REALTIME_EVENTS: readonly RealtimeEventSpec[] = Object.freeze([
  {
    name: 'message:new',
    direction: 'server→client',
    payload: 'Message DTO + event, schemaVersion, emittedAt',
    description:
      'A message was persisted. The payload is byte-for-byte the DTO the REST list ' +
      'returns for the same message, so a client reconciling after a reconnect resolves ' +
      'to the same message id and the same body it already rendered.',
  },
  {
    name: 'message:updated',
    direction: 'server→client',
    payload: 'Message DTO + event, schemaVersion, emittedAt',
    description: 'An edit or a soft delete. Same DTO; the client replaces by id.',
  },
  {
    name: 'message:read',
    direction: 'server→client',
    payload: '{ conversationId, userUid, lastReadMessageId } + envelope',
    description: "Somebody's read pointer advanced. Drives the read receipt.",
  },
  {
    name: 'conversation:closed',
    direction: 'server→client',
    payload: '{ conversationId } + envelope',
    description:
      'The conversation left a writable state. The client should stop offering a composer; ' +
      'the next send would be refused with CONVERSATION_NOT_WRITABLE anyway.',
  },
  {
    name: 'conversation:access-revoked',
    direction: 'server→client',
    payload: '{ conversationId } + envelope',
    description:
      'This socket was removed from the room because the booking relationship that granted ' +
      'access ended — a reassignment, a decline, or a sign-out. The client must drop any ' +
      'cached transcript for this conversation.',
  },
  {
    name: 'participant:joined',
    direction: 'server→client',
    payload: '{ conversationId, userUid, role } + envelope',
    description: 'Another participant opened the thread. Presence only; not persisted.',
  },
  {
    name: 'typing',
    direction: 'server→client',
    payload: '{ conversationId, userUid, isTyping } + envelope',
    description: 'Ephemeral. Never persisted, and authorization is checked before relay.',
  },
  {
    name: 'conversation:join',
    direction: 'client→server',
    payload: '{ conversationId } → ack { ok, conversation | error }',
    description: 'Joins the room. Re-authorized server-side on every call.',
  },
  {
    name: 'conversation:leave',
    direction: 'client→server',
    payload: '{ conversationId }',
    description:
      'Leaves the room. Best-effort and unauthorized on purpose — giving up access needs no ' +
      'permission, and the socket is dropped from the room either way on sign-out.',
  },
  {
    name: 'message:send',
    direction: 'client→server',
    payload: '{ conversationId, type, body, clientMsgId, attachments } → ack { ok, message }',
    description:
      'The same domain call the REST endpoint makes, including the idempotency key — so a ' +
      'message sent over the socket and one sent over HTTP are the same write.',
  },
  {
    name: 'message:typing',
    direction: 'client→server',
    payload: '{ conversationId, isTyping }',
    description: 'Relayed as `typing` to the rest of the room, after authorization.',
  },
]);

export const REALTIME_EVENT_NAMES: readonly string[] = Object.freeze(
  REALTIME_EVENTS.map((e) => e.name),
);

export const SERVER_EMITTED_EVENTS: readonly string[] = Object.freeze(
  REALTIME_EVENTS.filter((e) => e.direction === 'server→client').map((e) => e.name),
);

/**
 * The fallback contract.
 *
 * A client that missed events while backgrounded or disconnected re-reads
 * `GET /conversations/:id/messages` and merges by `id`. Because both transports
 * are fed by one DTO builder, the merge is an id comparison and never a
 * content reconciliation — which is what makes "realtime and fallback agree" a
 * property of the code rather than a thing to test forever.
 */
export const FALLBACK_RECONCILIATION = {
  endpoint: 'GET /api/v1/conversations/:conversationId/messages',
  mergeKey: 'id',
  guarantee:
    'The realtime payload and the REST row for the same message id are produced by the same ' +
    'function from the same row. A client may replace one with the other unconditionally.',
  duplicateSuppression:
    'clientMsgId is unique per (conversation, sender) in the database, so a retried send ' +
    'returns the ORIGINAL message id rather than creating a second one.',
} as const;

// ─── Session hygiene ──────────────────────────────────────────────────────────

/**
 * Account switch and sign-out.
 *
 * A socket authenticates ONCE at handshake and its actor never changes, so a
 * connection cannot start speaking for a second account. What can go wrong is
 * the other half: a live socket belonging to the previous account outliving the
 * switch, and a cached transcript being rendered under the new one. The server's
 * half of the fix is to evict the sockets and tell them why; the client's half
 * is to drop account-scoped state when it receives that.
 */
export const SESSION_HYGIENE = {
  onSignOut: 'Every socket for that uid is removed from every room and told access-revoked.',
  onAccountSwitch:
    'Identical to sign-out — the previous identity is evicted before the next handshake, ' +
    'because a switch IS a sign-out followed by a sign-in.',
  clientObligation:
    'On `conversation:access-revoked` or sign-out, clear the account-scoped conversation ' +
    'cache, unread badges and any draft. Chat state is never global state.',
  noPlaceholderData:
    'The backend seeds no demo, sample or placeholder conversation or message. The only ' +
    'server-authored content is a `system` message from the booking lifecycle, and every ' +
    'one is keyed and deduplicated.',
} as const;

// ─── Telemetry (§89) ──────────────────────────────────────────────────────────

export interface MessagingSignal {
  code: string;
  detects: string;
  why: string;
}

/**
 * What has to be counted for the messaging layer to be operable.
 *
 * Each of these is a thing that fails silently. A send that 500s is invisible to
 * everyone except the person whose message vanished; a socket that reconnects in
 * a loop looks like a healthy connection count; an unread badge that drifts is
 * reported as "the app is broken" months later.
 */
export const MESSAGING_SIGNALS: readonly MessagingSignal[] = Object.freeze([
  {
    code: 'MESSAGE_SEND_FAILED',
    detects: 'A send was refused or threw, by refusal code.',
    why: 'A rising refusal rate for one code is a policy that is wrong, not users misbehaving.',
  },
  {
    code: 'MESSAGE_DUPLICATE_SUPPRESSED',
    detects: 'A send matched an existing clientMsgId and returned the original.',
    why:
      'This is the retry path working. A spike means clients are timing out on a write that ' +
      'is in fact succeeding — a latency problem wearing a reliability costume.',
  },
  {
    code: 'REALTIME_CONNECTED',
    detects: 'A socket completed the handshake and joined the namespace.',
    why: 'The denominator for the two below.',
  },
  {
    code: 'REALTIME_DISCONNECTED',
    detects: 'A socket dropped, by Socket.IO reason.',
    why:
      'Transport churn is the reason a client falls back to polling; if it is high, the ' +
      'fallback path is the real path and has to be treated as such.',
  },
  {
    code: 'REALTIME_RECONNECTED',
    detects: 'A uid re-established a socket within the reconnect window.',
    why: 'Distinguishes a flapping connection from a user who closed the app.',
  },
  {
    code: 'UNREAD_COUNT_DRIFT',
    detects:
      'The per-conversation unread count recomputed from messages disagreed with the count ' +
      'the list query returned.',
    why:
      'The badge and the thread are read by different queries in every client. If they can ' +
      'disagree the badge is decoration, and nobody finds out from a bug report.',
  },
]);

export const MESSAGING_SIGNAL_CODES: readonly string[] = Object.freeze(
  MESSAGING_SIGNALS.map((s) => s.code),
);

// ─── Decisions (pure) ─────────────────────────────────────────────────────────

export interface WriteDecision {
  allowed: boolean;
  /** Present when refused. The client-facing reason. */
  reason: string | null;
}

/**
 * May this seat post into a conversation in this state?
 *
 * The ONE place the answer is computed. `chat.service` calls it rather than
 * restating `WRITABLE_STATUSES.includes(status)`, and the generated document
 * builds its table by calling it over every (state, seat) pair — so the table is
 * evidence of the behaviour rather than a description of it.
 *
 * `legacyIsClosed` is the pre-`status` boolean. It may only REFUSE: a row
 * written before `status` existed carries `is_closed = true` and `status`
 * defaulted to ACTIVE, and resolving that disagreement towards "writable" would
 * reopen every conversation the platform ever closed.
 */
export const mayWrite = (
  status: ConversationStatus,
  seat: ParticipantSeat,
  opts: { legacyIsClosed?: boolean } = {},
): WriteDecision => {
  const spec = CONVERSATION_STATES[status];
  if (!spec) {
    // An unknown state fails closed. A conversation whose status the backend
    // does not recognise is not one to accept writes into.
    return { allowed: false, reason: 'This conversation is not accepting messages.' };
  }
  if (seat === 'support') {
    // Support is exempt from the state narrowing so an official resolution can
    // be posted into a closed or archived thread — and NOT exempt from
    // membership, which is a role grant and is audited.
    return spec.supportMayWrite
      ? { allowed: true, reason: null }
      : { allowed: false, reason: 'This conversation is closed.' };
  }
  /**
   * The STATE is consulted first, and the legacy boolean second.
   *
   * Order matters for the message, not the outcome. `setConversationStatus`
   * sets `is_closed` for every non-writable state, so a READ_ONLY conversation
   * carries both — and checking the boolean first would answer every one of
   * them with the generic "Conversation is closed", losing the sentence that
   * tells the customer their booking finished rather than being cancelled.
   *
   * The boolean therefore only decides the case it exists for: a row written
   * before `status` existed, where `status` defaulted to ACTIVE and `is_closed`
   * is the only truth. There it still refuses.
   */
  if (!spec.partiesMayWrite) {
    switch (status) {
      case CONVERSATION_STATUS.READ_ONLY:
        return { allowed: false, reason: 'This booking conversation is read-only.' };
      case CONVERSATION_STATUS.ARCHIVED:
        return { allowed: false, reason: 'This booking conversation has been archived.' };
      default:
        return { allowed: false, reason: 'Conversation is closed' };
    }
  }
  if (opts.legacyIsClosed === true) {
    return { allowed: false, reason: 'Conversation is closed' };
  }
  return { allowed: true, reason: null };
};

export interface ReadFloorDecision {
  /** `full` — the whole transcript. `since` — from a timestamp. `denied` — none. */
  mode: 'full' | 'since' | 'denied';
  since: string | null;
  reason: string | null;
}

/**
 * How far back this seat may read.
 *
 * The customer owns the conversation and support needs the audit trail, so both
 * read everything. A provider reads from the moment THEIR assignment began —
 * a replacement provider must not be handed the previous provider's transcript.
 *
 * A missing timestamp FAILS CLOSED. A null floor used to mean "no floor", which
 * is precisely how a provider with no participant row came to read the whole
 * thread. "I cannot tell where your access starts" is not an argument for
 * showing everything.
 */
export const messageReadFloor = (
  seat: ParticipantSeat,
  assignedAt: string | null | undefined,
): ReadFloorDecision => {
  if (seat === 'customer' || seat === 'support') {
    return { mode: 'full', since: null, reason: null };
  }
  if (!assignedAt) {
    return {
      mode: 'denied',
      since: null,
      reason: 'Message history is not available for this assignment',
    };
  }
  return { mode: 'since', since: assignedAt, reason: null };
};

/**
 * Whether a conversation may be CREATED for a booking right now.
 *
 * A booking conversation is a consequence of a provider being confirmed, not of
 * someone opening a screen — `technicianService.acceptJob` and admin assignment
 * create it transactionally, and the read path deliberately never does. The
 * canonical `POST /conversations` has to honour that or it becomes a back door
 * that manufactures empty threads for unassigned bookings, which is the exact
 * behaviour that was removed.
 *
 * Support may create one regardless: an admin opening a thread on a booking with
 * no provider is a deliberate, audited act, and it is how a customer with a
 * problem before assignment gets helped at all.
 */
export const mayOpenConversation = (
  seat: ParticipantSeat,
  opts: { hasActiveProvider: boolean },
): WriteDecision => {
  if (seat === 'support') return { allowed: true, reason: null };
  if (opts.hasActiveProvider) return { allowed: true, reason: null };
  return {
    allowed: false,
    reason:
      'A booking conversation opens when a provider is confirmed for the booking. ' +
      'Contact Servana Support if you need help before then.',
  };
};

// ─── Capabilities and the cross-platform caller matrix ────────────────────────

export interface MessagingCapability {
  key: string;
  title: string;
  /** Contract ids in `src/api/v1/contract.ts`. */
  contractIds: readonly string[];
  /** The ONE domain module every surface reaches for this capability. */
  domainModule: string;
  surfaces: readonly ClientSurface[];
  /** Required: why this is or is not split by role. */
  roleSplitRationale: string;
}

export const MESSAGING_CAPABILITIES: readonly MessagingCapability[] = Object.freeze([
  {
    key: 'openConversation',
    title: 'Open (or resolve) a booking conversation',
    contractIds: ['conversations.create'],
    domainModule: 'services/messaging/messagingService',
    surfaces: Object.freeze([
      'customerMobile',
      'customerWeb',
      'providerMobile',
      'providerWeb',
      'admin',
    ] as ClientSurface[]),
    roleSplitRationale:
      'No role split. One endpoint, idempotent: it returns the booking\'s existing ' +
      'conversation or opens it. Who may open one is a policy decision — ' +
      '`mayOpenConversation` — not a second endpoint, so a customer and an admin run the ' +
      'same code and differ only in what the policy allows.',
  },
  {
    key: 'inbox',
    title: 'List my conversations with unread counts',
    contractIds: ['conversations.list'],
    domainModule: 'services/messaging/messagingService',
    surfaces: Object.freeze([
      'customerMobile',
      'customerWeb',
      'providerMobile',
      'providerWeb',
      'admin',
    ] as ClientSurface[]),
    roleSplitRationale:
      'No role split. The subject is the TOKEN — there is no uid parameter to substitute. ' +
      'An admin gets the oversight list from the same handler, which is a privileged read ' +
      'of the same resource rather than a second inbox with its own rules.',
  },
  {
    key: 'conversationDetail',
    title: 'Read one conversation and its participants',
    contractIds: ['conversations.get'],
    domainModule: 'services/messaging/messagingService',
    surfaces: Object.freeze([
      'customerMobile',
      'customerWeb',
      'providerMobile',
      'providerWeb',
      'admin',
    ] as ClientSurface[]),
    roleSplitRationale:
      'No role split, but the DTO is field-scoped by seat from one projection: contact ' +
      'details of other participants are never disclosed, and only support sees departed ' +
      'participants. One projection function, not three endpoints that could each ' +
      'over-disclose.',
  },
  {
    key: 'transcript',
    title: 'Page through a conversation transcript',
    contractIds: ['conversations.messages.list'],
    domainModule: 'services/messaging/messagingService',
    surfaces: Object.freeze([
      'customerMobile',
      'customerWeb',
      'providerMobile',
      'providerWeb',
      'admin',
    ] as ClientSurface[]),
    roleSplitRationale:
      'No role split. The read FLOOR differs by seat — a provider reads from their own ' +
      'assignment forward — and that is a policy applied inside one handler by ' +
      '`messageReadFloor`, not a separate provider endpoint that could forget it.',
  },
  {
    key: 'send',
    title: 'Send a message',
    contractIds: ['conversations.messages.create'],
    domainModule: 'chat/chat.service.sendMessage',
    surfaces: Object.freeze([
      'customerMobile',
      'customerWeb',
      'providerMobile',
      'providerWeb',
      'admin',
    ] as ClientSurface[]),
    roleSplitRationale:
      'No role split, and three transports on one write: the canonical REST endpoint, the ' +
      'legacy REST route and the `message:send` socket event all call the same function. ' +
      'The admin portal\'s send goes through it too, so an admin message is subject to the ' +
      'same idempotency, validation and attachment rules as anyone else\'s.',
  },
  {
    key: 'attach',
    title: 'Attach a file to a conversation',
    contractIds: ['conversations.attachments.create'],
    domainModule: 'chat/chat.service.uploadAttachment',
    surfaces: Object.freeze([
      'customerMobile',
      'customerWeb',
      'providerMobile',
      'providerWeb',
      'admin',
    ] as ClientSurface[]),
    roleSplitRationale:
      'No role split, and the conversation is named by the PATH rather than the body. That ' +
      'is the difference that matters: the legacy route took it as an optional body field ' +
      'and ran the access check only when the caller supplied one, so omitting it stored a ' +
      'file and returned a URL without any conversation being consulted. The allowlist and ' +
      'the size ceiling are checked by file SIGNATURE, so a renamed executable is refused on ' +
      'its contents rather than on its declared type.',
  },
  {
    key: 'report',
    title: 'Report a message to moderation',
    contractIds: ['conversations.messages.report'],
    domainModule: 'chat/chat.service.reportMessage',
    surfaces: Object.freeze([
      'customerMobile',
      'customerWeb',
      'providerMobile',
      'providerWeb',
    ] as ClientSurface[]),
    roleSplitRationale:
      'No role split among the four participant surfaces. Admin is deliberately absent: ' +
      'staff act on reports through the admin communications routes, which are permissioned ' +
      'and audited, and an admin filing a participant report would enter the same queue they ' +
      'resolve. The reporter is the token subject, so no request can file one as somebody ' +
      'else.',
  },
  {
    key: 'markRead',
    title: 'Advance the read pointer',
    contractIds: ['conversations.read'],
    domainModule: 'services/messaging/messagingService',
    surfaces: Object.freeze([
      'customerMobile',
      'customerWeb',
      'providerMobile',
      'providerWeb',
      'admin',
    ] as ClientSurface[]),
    roleSplitRationale:
      'No role split. The pointer belongs to the caller and is taken from the token; there ' +
      'is no parameter naming whose pointer to move. It is monotonic, so an out-of-order ' +
      'client cannot un-read a conversation.',
  },
]);

export const MESSAGING_CAPABILITY_KEYS: readonly string[] = Object.freeze(
  MESSAGING_CAPABILITIES.map((c) => c.key),
);
