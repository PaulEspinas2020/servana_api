<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-messaging-docs.ts, derived from
    src/services/messaging/messagingPolicy.ts   (states, seats, floors, events, attachments)
    src/services/messaging/conversationDto.ts   (the one message projection)
    src/api/v1/contract.ts                      (the canonical endpoints)
  Regenerate: npm run messaging:docs
-->

# Messaging v1 Contract

> The single messaging truth for Customer Mobile, Customer Web, Provider Mobile,
> Provider Web and Admin Web. Everything below is derived by EXECUTING
> `src/services/messaging/messagingPolicy.ts` — the permission matrix and the
> visibility table are produced by running the real decision functions, so they
> are evidence of the behaviour rather than a description of it.

## 1. The Conversation resource

A conversation is **BOOKING**-kind and nothing else: every
conversation in the platform is anchored to a booking, participants are derived from that booking,
and there is no direct customer↔provider channel. A messaging layer whose only membership rule is
"whoever the booking says" cannot leak across accounts by construction.

- **Identity** — `chat_conversations.id` (integer).
- **Anchor** — bookings.id via chat_conversations.booking_id (unique).
- One conversation per booking, forever. A second thread for the same booking would split the audit trail the platform depends on for disputes.

Participants are never supplied by a caller. There is no add-participant operation, because there is
nothing a caller could add someone to: membership is a projection of `booking_workers` and
`bookings.user_id`, repaired by `chat.reconciler`, and permitted only to NARROW what the booking
already granted.

### Lifecycle states

| State | Parties may post | Support may post | Entered by |
| --- | --- | --- | --- |
| `ACTIVE` | yes | yes | Created when a provider is confirmed for the booking. |
| `READ_ONLY` | — | yes | Completion plus the `GRACE_HOURS` window elapsing. |
| `ARCHIVED` | — | yes | An explicit archive, after READ_ONLY. |
| `CLOSED` | — | yes | The booking is cancelled. |
| `SUPPORT_ESCALATED` | yes | yes | A dispute is opened on the booking. |

Writable states: `ACTIVE`, `SUPPORT_ESCALATED`.

`is_closed` is the pre-`status` compatibility boolean and is still maintained. It means "the
parties cannot write here", three shipped clients read it, and it is republished in the DTO so a
client that knows nothing about `status` still behaves correctly.

### Opening a conversation

A booking conversation is a consequence of a provider being CONFIRMED, not of somebody opening a
screen. `POST /api/v1/conversations` honours that:

- **customer** — with a confirmed provider: yes; without one: refused ("A booking conversation opens when a provider is confirmed for the booking. Contact Servana Support if you need help before then.")
- **provider** — with a confirmed provider: yes; without one: refused ("A booking conversation opens when a provider is confirmed for the booking. Contact Servana Support if you need help before then.")
- **support** — with a confirmed provider: yes; without one: yes

## 2. Authorization

Every read and every write is authorized on the SERVER, from the booking:

- the **customer** is `bookings.user_id`;
- a **provider** is an ACTIVE row in `booking_workers` — and their assignment window travels with
  the authorization, from the same row, so the two cannot disagree;
- **support** is authorized by role. That is a deliberate, audited grant, and an admin who posts is
  recorded as a participant so "who from Servana touched this booking" is answerable from the
  participant list rather than by reading every message.

`chat_participants` is a PROJECTION. It may narrow access and may never widen it: a missing row
contributes nothing rather than defaulting to permissive.

### Who may post, by state

| State | customer | provider | support |
| --- | --- | --- | --- |
| `ACTIVE` | may post | may post | may post |
| `READ_ONLY` | read only | read only | may post |
| `ARCHIVED` | read only | read only | may post |
| `CLOSED` | read only | read only | may post |
| `SUPPORT_ESCALATED` | may post | may post | may post |

### How far back each seat may read

| Seat | With an assignment start | Without one |
| --- | --- | --- |
| customer | whole transcript | whole transcript |
| provider | from `2026-08-03T00:00:00.000Z` | **denied** — Message history is not available for this assignment |
| support | whole transcript | whole transcript |

A replacement provider reads from THEIR assignment forward and never inherits the previous
provider's transcript. An assignment with no usable start FAILS CLOSED — "I cannot tell where your
access begins" is not an argument for showing everything.

### Refusals do not confirm what exists

One code answers both "no such conversation" and "not yours". Conversation ids are sequential
integers, so an endpoint that returned 404 for an unknown id and 403 for a real one would let anyone
count the platform's conversations by walking them.

## 3. The message DTO

One builder — `services/messaging/conversationDto.buildMessageView` — produces every message the
platform emits, for every transport. The canonical projection publishes:

`id`, `conversationId`, `bookingId`, `type`, `body`, `senderSeat`, `senderUid`, `isMine`, `isSystem`, `clientMsgId`, `sentAt`, `editedAt`, `deletedAt`, `isDeleted`, `readByCount`, `readByAll`, `attachments`, `metadata`.

Message types: `text`, `image`, `file`, `system`. A caller may send
`text`, `image`, `file`; `system` is authored by the backend
only and every system message is keyed and deduplicated.

- Body limit: **4000** characters.
- Send throttle: **20** messages per
  **10s**, per sender, applied AFTER the idempotency check so a
  retry of an accepted message never consumes budget.
- `clientMsgId` is **required**: 16–128
  characters matching `^[A-Za-z0-9._:-]+$`, unique per (conversation, sender) by partial
  unique index. A retried send returns the ORIGINAL message rather than creating a second one.

### Sender identity

Derived from authentication, always. `sender_uid` is written from the actor the handler built out
of the verified token; there is no path, query or body parameter that can name a sender, a customer
or a provider.

### Pagination

Keyset on `chat_messages.id`, id DESC (newest first). Default
**30**, clamped to **100**.
`cursor` — Return messages strictly OLDER than this id.

Offset paging is wrong for a live transcript: rows arrive at the end while a reader pages, so page
two of an offset scan silently repeats or skips messages.

### Delivery and read receipts

- **Delivered — not tracked.** No per-device acknowledgement channel exists. `sentAt` is the moment the server accepted the message; publishing it as "delivered" would be a claim about the recipient's device that nothing in the system can support.
- **Read — tracked.** Source: `chat_participants.last_read_message_id (high-water mark) + last_read_at`.
  A message is read by a participant when their pointer is at or past its id. The DTO publishes readByCount and readByAll — never the list of uids, which is participant identity a sender does not need to render a receipt.

## 4. Unread

ONE definition, one SQL expression, two call sites — the inbox and the per-conversation count. A
message is unread for a participant when:

1. the message is in a conversation the participant may read;
2. the message is not soft-deleted;
3. the message was created at or after the participant joined (a re-admitted participant does not inherit a backlog);
4. the participant has no read pointer, or the pointer is below the message id;
5. the participant is not the sender (your own message is never unread to you);

`POST /api/v1/conversations/:conversationId/read` advances the pointer and returns the
resulting count, so a client never has to guess what its badge should now say. The pointer is a
monotonic high-water mark and is only ever advanced to a message that exists in THIS conversation
and is visible to that participant — both enforced in SQL, so an out-of-order client cannot un-read
a conversation or point at somebody else's thread.

An admin authorized by role holds no pointer. Unread is undefined for them and is reported as
`{ count: 0, isParticipant: false }`
rather than invented.

### Drift detection

The count is produced by SQL and then RECOMPUTED from the message rows applying the same five
clauses. The two are compared, and a disagreement raises `UNREAD_COUNT_DRIFT`. The recount is not
used to correct the answer: silently returning the better number would hide the fact that two
readings of one table disagree, and a badge that self-heals on read is wrong everywhere it is not
read.

## 5. Realtime

One schema across Customer Mobile, Customer Web, Provider Mobile and Provider Web.

- Namespace: `/chat`
- Room: `conversation:<conversationId>` — membership re-authorized server-side on every join
- Schema version: **1**, stamped on every server-emitted payload alongside
  `event` and `emittedAt`

The event NAMES are the ones that already exist. Minting a clean vocabulary and emitting both for a
while would double-deliver every message to any client listening to the old and the new name — and a
duplicate message is exactly what this work removes. What was centralised is the payload: one
builder, one catalog, and a throw for any event not in it.

### Server → client

| Event | Payload | Meaning |
| --- | --- | --- |
| `message:new` | Message DTO + event, schemaVersion, emittedAt | A message was persisted. The payload is byte-for-byte the DTO the REST list returns for the same message, so a client reconciling after a reconnect resolves to the same message id and the same body it already rendered. |
| `message:updated` | Message DTO + event, schemaVersion, emittedAt | An edit or a soft delete. Same DTO; the client replaces by id. |
| `message:read` | { conversationId, userUid, lastReadMessageId } + envelope | Somebody's read pointer advanced. Drives the read receipt. |
| `conversation:closed` | { conversationId } + envelope | The conversation left a writable state. The client should stop offering a composer; the next send would be refused with CONVERSATION_NOT_WRITABLE anyway. |
| `conversation:access-revoked` | { conversationId } + envelope | This socket was removed from the room because the booking relationship that granted access ended — a reassignment, a decline, or a sign-out. The client must drop any cached transcript for this conversation. |
| `participant:joined` | { conversationId, userUid, role } + envelope | Another participant opened the thread. Presence only; not persisted. |
| `typing` | { conversationId, userUid, isTyping } + envelope | Ephemeral. Never persisted, and authorization is checked before relay. |

### Client → server

| Event | Payload | Meaning |
| --- | --- | --- |
| `conversation:join` | { conversationId } → ack { ok, conversation | error } | Joins the room. Re-authorized server-side on every call. |
| `conversation:leave` | { conversationId } | Leaves the room. Best-effort and unauthorized on purpose — giving up access needs no permission, and the socket is dropped from the room either way on sign-out. |
| `message:send` | { conversationId, type, body, clientMsgId, attachments } → ack { ok, message } | The same domain call the REST endpoint makes, including the idempotency key — so a message sent over the socket and one sent over HTTP are the same write. |
| `message:typing` | { conversationId, isTyping } | Relayed as `typing` to the rest of the room, after authorization. |

### Fallback reconciliation

- Endpoint: `GET /api/v1/conversations/:conversationId/messages`
- Merge key: `id`
- The realtime payload and the REST row for the same message id are produced by the same function from the same row. A client may replace one with the other unconditionally.
- clientMsgId is unique per (conversation, sender) in the database, so a retried send returns the ORIGINAL message id rather than creating a second one.

The realtime payload is a SUPERSET of the REST message: it carries the canonical fields plus the
legacy keys the four shipped clients already read. Projecting a received payload through the
canonical projection yields byte-for-byte the REST body for the same message id, which is what makes
a reconnect an id comparison rather than a content comparison.

## 6. Session hygiene

- **Sign-out** — Every socket for that uid is removed from every room and told access-revoked.
- **Account switch** — Identical to sign-out — the previous identity is evicted before the next handshake, because a switch IS a sign-out followed by a sign-in.
- **Client obligation** — On `conversation:access-revoked` or sign-out, clear the account-scoped conversation cache, unread badges and any draft. Chat state is never global state.
- **No placeholder data** — The backend seeds no demo, sample or placeholder conversation or message. The only server-authored content is a `system` message from the booking lifecycle, and every one is keyed and deduplicated.

A socket authenticates once at handshake and its actor never changes, so a connection cannot begin
speaking for a second account. The gap that needed closing was the other one: revoking a token stops
the next REQUEST, and an already-open socket keeps receiving the previous account's messages.
`endAllSessions` now evicts them, for every reason it is called with.

## 7. Attachments

| Rule | Value |
| --- | --- |
| Maximum per message | 5 |
| Maximum size | 10 MiB |
| Allowed types | `image/jpeg`, `image/png`, `image/webp`, `application/pdf` |
| Content type proven by | `helpers/fileSignature.validateDataUri (magic bytes)` |
| Ownership | The storage object name must begin with `<callerUid>_`. |
| Upload authorization | The uploader must be able to SEND into the conversation the attachment is for. |

Accepted reference forms, and nothing else:

- `owned storage key: `<callerUid>_<uuid>``
- `https://firebasestorage.googleapis.com/v0/b/<configured-bucket>/o/chat-attachments/<callerUid>_<uuid>`

Any other host, bucket or prefix is refused. An unchecked `url` field is an open redirect and an
SSRF surface wearing a filename, and quoting somebody else's object URL must not attach their file
to your message — which is why the reference is re-derived from the caller's own uid prefix on every
send rather than trusted because it looks like one of ours.

The declared mime is validated against an allow-list at send time AND proven from the file's magic
bytes at upload time. A client can claim any content type it likes.

### How the object is served

**unguessable capability URL** — expires: —;
re-authorized per request: —.

The object is stored with a random download token and served from a URL containing it. It is not
publicly listable and the bucket needs no `allUsers` grant — but anyone holding the URL can fetch
it, and the URL does not expire.

The stronger model exists in this codebase and is what provider documents use:
`helpers/firebaseStorageUploader.createPrivatePreviewUrl (300s, re-authorized)`. Chat attachments do not use it yet.
Every shipped client stores and renders the returned URL. Signed previews change the client contract from "a URL you keep" to "a URL you re-request". It is recorded here rather than left as an unstated
difference between two parts of the same system.

## 8. Observability

Counted per window and reported under `[messaging-telemetry]`. Codes and counts only — no uid, no
conversation id, no message body. A log that names who was talking to whom has to be protected like
the conversation it describes.

| Signal | Detects | Why it is counted |
| --- | --- | --- |
| `MESSAGE_SEND_FAILED` | A send was refused or threw, by refusal code. | A rising refusal rate for one code is a policy that is wrong, not users misbehaving. |
| `MESSAGE_DUPLICATE_SUPPRESSED` | A send matched an existing clientMsgId and returned the original. | This is the retry path working. A spike means clients are timing out on a write that is in fact succeeding — a latency problem wearing a reliability costume. |
| `REALTIME_CONNECTED` | A socket completed the handshake and joined the namespace. | The denominator for the two below. |
| `REALTIME_DISCONNECTED` | A socket dropped, by Socket.IO reason. | Transport churn is the reason a client falls back to polling; if it is high, the fallback path is the real path and has to be treated as such. |
| `REALTIME_RECONNECTED` | A uid re-established a socket within the reconnect window. | Distinguishes a flapping connection from a user who closed the app. |
| `UNREAD_COUNT_DRIFT` | The per-conversation unread count recomputed from messages disagreed with the count the list query returned. | The badge and the thread are read by different queries in every client. If they can disagree the badge is decoration, and nobody finds out from a bug report. |

## 9. Canonical endpoints

| Endpoint | Auth | Idempotent | Domain service |
| --- | --- | --- | --- |
| `POST /api/v1/conversations` | authenticated | no | `services/messaging/messagingService.openConversation` |
| `GET /api/v1/conversations` | authenticated | yes | `services/messaging/messagingService.listConversations` |
| `GET /api/v1/conversations/:conversationId` | authenticated | yes | `services/messaging/messagingService.getConversation` |
| `GET /api/v1/conversations/:conversationId/messages` | authenticated | yes | `services/messaging/messagingService.listMessages` |
| `POST /api/v1/conversations/:conversationId/messages` | authenticated | no | `chat/chat.service.sendMessage` |
| `POST /api/v1/conversations/:conversationId/read` | authenticated | yes | `services/messaging/messagingService.markRead` |

### Legacy routes still mounted

Every one of these stays until the client that calls it has migrated, and every one is counted by
`api/v1/legacyTelemetry` — the watch list is derived from this same contract, so a route can only
be documented as superseded if it is also being measured.

| Legacy route | Disposition | Canonical successor | Why it is still there |
| --- | --- | --- | --- |
| `GET /api/bookings/:bookingId/conversation` | ALIAS_TEMPORARILY | `conversations.create` | The live resolve-by-booking call. It is a GET that never creates, and the customer app already maps its 404 to "no conversation yet". This entry adds the explicit open, gated by the same rule: a booking conversation exists because a provider was confirmed, not because somebody opened a screen. |
| `GET /api/chat/conversations` | ALIAS_TEMPORARILY | `conversations.list` | The live inbox for all four apps. Chat routes do NOT use an envelope — the stores read a top-level `conversations` key — so the legacy shape is kept exactly and this entry adds the canonical one alongside. Both now read the same unread expression. |
| `GET /api/admin/communications/conversations` | ROLE_SPECIFIC | `conversations.list` | The admin oversight list carries a named permission and a booking filter, and joins moderation state this route has no business publishing to a customer. Same tables, same conversation ids; a genuinely different question. |
| `GET /api/chat/conversations/:id` | ALIAS_TEMPORARILY | `conversations.get` | The live detail call. Same authorization; the canonical shape adds the seat, the send capability with its reason, the unread count and a last-message preview built through the caller's own read floor. |
| `GET /api/admin/communications/conversations/:id` | ROLE_SPECIFIC | `conversations.get` | The admin detail view, permissioned, and carrying report and moderation state. Different fields, different authorization, same conversation id. |
| `GET /api/chat/conversations/:id/messages` | ALIAS_TEMPORARILY | `conversations.messages.list` | The live transcript read, now a narrower projection of the SAME page reader — same authorization, same read floor, same builder. Its cursor parameter is called `before`; the canonical one is `cursor`, and both mean the same message id. |
| `GET /api/admin/communications/conversations/:id/messages` | ROLE_SPECIFIC | `conversations.messages.list` | The permissioned admin transcript. It reads the whole thread by design — the audit trail is the point — where this route applies the caller's own read floor. |
| `POST /api/chat/conversations/:id/messages` | ALIAS_TEMPORARILY | `conversations.messages.create` | The live send for all four apps. IDENTICAL domain call — this entry is a second URL onto one write, not a second write path. |
| `POST /api/admin/communications/conversations/:id/messages` | ROLE_SPECIFIC | `conversations.messages.create` | The admin send. Permissioned and audited, and it already delegates to `chat.service.sendMessage`, so an admin message obeys the same idempotency, validation and attachment rules as anyone else's. |
| `POST /api/chat/conversations/:id/read` | ALIAS_TEMPORARILY | `conversations.read` | The live read-pointer call, which answers `{ success: true }` and nothing else. The canonical one returns the resulting unread count, so a client stops having to guess what its badge should now say. |

## 10. Cross-platform caller matrix

`migrated` — this client calls the canonical v1 route today.
`legacy` — this client calls a legacy route the canonical entry supersedes.
`planned` — this client will migrate; it calls no equivalent today.
`—` — the capability does not apply to this client.

| Capability | Customer Mobile | Customer Web | Provider Mobile | Provider Web | Admin Web |
| --- | --- | --- | --- | --- | --- |
| Open (or resolve) a booking conversation | legacy | legacy | legacy | legacy | legacy |
| List my conversations with unread counts | legacy | legacy | legacy | legacy | legacy |
| Read one conversation and its participants | legacy | legacy | legacy | legacy | legacy |
| Page through a conversation transcript | legacy | legacy | legacy | legacy | legacy |
| Send a message | legacy | legacy | legacy | legacy | legacy |
| Advance the read pointer | legacy | legacy | legacy | legacy | legacy |

No client is `migrated` yet: the platform application repositories are out of scope until the
backend Master Command completes. Every legacy route above stays mounted and reaches the same
authorization, the same write and the same conversation ids, so a client migrating later changes its
URL and its response parsing — not which messages it can see.

### Why each capability is or is not role-split

**Open (or resolve) a booking conversation** (`services/messaging/messagingService`)

No role split. One endpoint, idempotent: it returns the booking's existing conversation or opens it. Who may open one is a policy decision — `mayOpenConversation` — not a second endpoint, so a customer and an admin run the same code and differ only in what the policy allows.

**List my conversations with unread counts** (`services/messaging/messagingService`)

No role split. The subject is the TOKEN — there is no uid parameter to substitute. An admin gets the oversight list from the same handler, which is a privileged read of the same resource rather than a second inbox with its own rules.

**Read one conversation and its participants** (`services/messaging/messagingService`)

No role split, but the DTO is field-scoped by seat from one projection: contact details of other participants are never disclosed, and only support sees departed participants. One projection function, not three endpoints that could each over-disclose.

**Page through a conversation transcript** (`services/messaging/messagingService`)

No role split. The read FLOOR differs by seat — a provider reads from their own assignment forward — and that is a policy applied inside one handler by `messageReadFloor`, not a separate provider endpoint that could forget it.

**Send a message** (`chat/chat.service.sendMessage`)

No role split, and three transports on one write: the canonical REST endpoint, the legacy REST route and the `message:send` socket event all call the same function. The admin portal's send goes through it too, so an admin message is subject to the same idempotency, validation and attachment rules as anyone else's.

**Advance the read pointer** (`services/messaging/messagingService`)

No role split. The pointer belongs to the caller and is taken from the token; there is no parameter naming whose pointer to move. It is monotonic, so an out-of-order client cannot un-read a conversation.
