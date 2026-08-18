<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-notification-docs.ts, derived from
    src/services/events/domainEvents.ts           (categories, deep links, capabilities)
    src/services/events/notificationInbox.ts      (the one inbox contract)
    src/api/v1/contract.ts                        (the canonical endpoints)
  Regenerate: npm run notification:docs
-->

# Notifications v1 Contract

> The single notification truth for Customer Mobile, Customer Web, Provider
> Mobile, Provider Web and Admin Web.

## 1. Canonical endpoints

| Endpoint | Auth | Idempotent | Domain service |
| --- | --- | --- | --- |
| `GET /api/v1/notifications` | authenticated | yes | `services/events/notificationInbox.listNotifications` |
| `GET /api/v1/notifications/unread-count` | authenticated | yes | `services/events/notificationInbox.countUnread` |
| `PATCH /api/v1/notifications/:key/read` | authenticated | yes | `services/events/notificationInbox.markRead` |
| `DELETE /api/v1/notifications/:key` | authenticated | yes | `services/events/notificationInbox.dismiss` |
| `POST /api/v1/notifications/read-all` | authenticated | yes | `services/events/notificationInbox.markAllRead` |
| `GET /api/v1/me/notification-preferences` | authenticated | yes | `services/events/notificationPreferences.getPreferences` |
| `PATCH /api/v1/me/notification-preferences` | authenticated | yes | `services/events/notificationPreferences.patchPreferences` |
| `POST /api/v1/me/devices` | authenticated | no | `services/events/deviceTokenService.registerDevice` |
| `DELETE /api/v1/me/devices` | authenticated | yes | `services/events/deviceTokenService.releaseDevice` |

The command names `POST /api/v1/notifications/:notificationId/read`. The repository already had
`PATCH /api/v1/notifications/:key/read`, implemented and documented, and `:key` IS the
notification identifier — opaque, owner-scoped, and the only handle any store exposes. Reusing the
equivalent canonical route that already exists is what the command asks for; minting a second method
for one idempotent operation would be a blind string replacement.

### Legacy routes still mounted

Every one stays until the client that calls it has migrated, and every one is counted by
`api/v1/legacyTelemetry` — the watch list is derived from this same contract, so a route can only
be documented as superseded if it is also being measured.

| Legacy route | Disposition | Canonical successor | Why it is still there |
| --- | --- | --- | --- |
| `GET /api/user/notifications` | ALIAS_TEMPORARILY | `notifications.list` | Customer clients call this today. |
| `GET /api/user/notifications/unread-count` | ALIAS_TEMPORARILY | `notifications.unreadCount` | Declared before /user/notifications/:key on the legacy router precisely so "unread-count" is not parsed as a notification key. v1 has the same ordering requirement and the shadow test now enforces it. |
| `PATCH /api/user/notifications/:key/read` | ALIAS_TEMPORARILY | `notifications.markRead` | Same service and the same key validation. The path differs only in the /user prefix, which named the caller rather than the resource. |
| `DELETE /api/provider/notifications/:key` | CANONICALIZE | `notifications.dismiss` | The provider inbox had list, read, read-all and dismiss; v1 took the first three and left dismiss behind, so every provider client kept one legacy call for one verb. The legacy route is provider-only and reaches provider_notifications directly; this one resolves the store from the caller, so a CUSTOMER can dismiss for the first time. |
| `POST /api/user/notifications/mark-all-read` | ALIAS_TEMPORARILY | `notifications.markAllRead` | Same service; v1 uses the resource-shaped path. |
| `GET /api/provider/notification-preferences` | ALIAS_TEMPORARILY | `me.notificationPreferences.get` | Provider Web. Same uid-keyed table - nothing about it is provider-specific, and the role gate on this path is the reason customers had no way to configure notifications they were already receiving. |
| `PUT /api/provider/notification-preferences` | ALIAS_TEMPORARILY | `me.notificationPreferences.patch` | Provider Web sends a full replace. Both shapes reach one writer, so a provider who has not migrated keeps the exact behaviour they have. |
| `POST /api/provider/fcm-token` | ALIAS_TEMPORARILY | `me.devices.register` | ServanaWorker and Provider Web. Multi-device already, and dual-written by the canonical service so a device registered either way stays reachable. |
| `POST /api/user/fcm-token` | ALIAS_TEMPORARILY | `me.devices.register` | ServanaClient. Wrote a SINGLE column, so a customer with a phone and a tablet only ever received push on whichever signed in last - silently. The canonical route gives customers the multi-device behaviour providers already had. |
| `DELETE /api/provider/fcm-token` | ALIAS_TEMPORARILY | `me.devices.release` | Same operation, provider-gated. Both reach one service. |
| `DELETE /api/user/fcm-token` | ALIAS_TEMPORARILY | `me.devices.release` | Same operation for customers, against the single legacy column. |

## 2. The inbox contract

ONE notification shape over three physical stores. Which store a caller reads is resolved from
their ACCOUNT, never from a parameter, so the three tables are three private inboxes rather than one
shared surface.

| Seat | Store |
| --- | --- |
| customer | `customer_notifications` |
| provider | `provider_notifications` |
| admin | `admin_notifications` |

### The defect this closed

`GET /api/v1/notifications` called `listCustomerNotifications` directly. A PROVIDER calling
the canonical endpoint received an EMPTY ARRAY — not an error, not a 403, just nothing — while their
notifications sat in `provider_notifications` where only the legacy provider route looked. The
endpoint was documented as serving any authenticated caller and served one of the three seats.

### Why three tables and not one

Each has live writers, live readers and different columns. Merging them is a data migration against
the only reachable database, which is production. What the release gate needs is one CONTRACT: one
DTO, one unread definition, one ordering, one mark-read semantic. That is achievable now, and it is
what this is.

### Unread reconciles

A notification is unread when its status is `unread` and it has not expired. The count is produced
by the SAME store resolution the list uses, so the badge and the screen can never be reading
different tables — and every mutation returns the resulting count, so a client never has to
re-fetch to learn its badge or decrement a number it guessed.

## 3. Cross-platform caller matrix

`migrated` — this client calls the canonical v1 route today.
`legacy` — this client calls a legacy route the canonical entry supersedes.
`planned` — this client will migrate; it calls no equivalent today.
`—` — the capability does not apply to this client.

| Capability | Customer Mobile | Customer Web | Provider Mobile | Provider Web | Admin Web |
| --- | --- | --- | --- | --- | --- |
| Read my notification inbox | legacy | legacy | legacy | migrated | planned |
| How many unread I have | legacy | legacy | legacy | migrated | planned |
| Mark one notification read | legacy | legacy | legacy | migrated | planned |
| Mark everything read | legacy | legacy | legacy | migrated | planned |
| Dismiss one notification | planned | planned | planned | legacy | — |
| Read and change my notification preferences | planned | planned | legacy | legacy | planned |
| Register and release this device for push | legacy | planned | legacy | migrated | — |

No client is `migrated` yet: the platform application repositories are out of scope until the
backend Master Command completes. Every legacy route above stays mounted and reaches the same
domain service, so a client migrating later changes its URL and its response parsing — not which
notifications it can see.

### Why each capability is or is not role-split

**Read my notification inbox** (`services/events/notificationInbox`)

No role split, and this is where the split USED to be. The canonical route read the customer table only, so a provider calling it received an empty inbox while their notifications sat in provider_notifications. One inbox service now resolves the owner's store from their account and reads it — two physical tables, one logical inbox, one DTO.

**How many unread I have** (`services/events/notificationInbox`)

No role split. Counted from the SAME store resolution the list uses, so the badge and the screen cannot disagree about which table they are reading.

**Mark one notification read** (`services/events/notificationInbox`)

No role split. The key is opaque and owner-scoped: the same key can exist for two accounts and each only ever resolves their own row, because every statement is predicated on the owner uid from the token.

**Mark everything read** (`services/events/notificationInbox`)

No role split. The subject is the token; there is no parameter naming whose inbox to clear.

**Dismiss one notification** (`services/events/notificationInbox`)

No role split, and it is the fourth verb of an inbox that already had three. The legacy route was provider-only and reached provider_notifications directly, which is why customers have never been able to dismiss anything: their rows are in customer_notifications and nothing looked there. Resolving the store from the caller is the same decision list, unread-count and markRead already made — a second, provider-shaped dismiss endpoint would rebuild the defect the inbox exists to end. Admin is a declared surface and answers NOTIFICATION_NOT_ACTIONABLE: that store has no dismiss, and saying so is not the same as claiming the notification is missing.

**Read and change my notification preferences** (`services/events/notificationPreferences`)

No role split, and again this is where one used to be. The preference table is keyed on a uid and has no role column, yet both legacy routes were gated on a provider role — so customers received notifications they had no way to configure, and their push ignored the table entirely. One model, one table, every account.

**Register and release this device for push** (`services/events/deviceTokenService`)

No role split. Providers had a multi-device token TABLE and customers had a single column, so a customer with two devices could only ever receive push on the last one to sign in. One account-scoped token store for both, with the provider table kept and dual-written until ServanaWorker migrates.

## 4. One event, three reactions

The release gate is that Admin, customer and provider react to the SAME source event. That is a
property of there being one projection function, not of three code paths being kept in step.

Seats: `customer`, `provider`, `admin`.

Recipients are resolved from the SOURCE OF TRUTH, never from the payload. The customer comes from
`bookings.user_id` and providers from the ACTIVE assignment — the same status list that authorizes
chat — so a provider reassigned away cannot be notified about a booking they can no longer open,
which would be a notification pointing at a screen that will refuse them.

The actor is excluded from their own event: a person who sent a message, cancelled their own booking
or left a review does not need to be told they did it.
