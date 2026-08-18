<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-convergence-docs.ts, derived from
    src/api/v1/convergence.ts      (the federated capability registry)
    src/api/v1/contract.ts         (the canonical endpoints and their callers)
    src/api/v1/legacyTelemetry.ts  (retirement criteria)
    the federated capability registry
  Regenerate: npm run convergence:docs
-->

# Per-client migration plan

> The WORK LIST, derived. The ORDER and the argument for it live in
> [`CROSS_CLIENT_MIGRATION_PLAN.md`](CROSS_CLIENT_MIGRATION_PLAN.md), which is
> hand-written because an argument is not derivable. This is what each client
> actually has to change, and it is generated because a hand-maintained list of
> 109 endpoints across five clients is stale the day after it is written.

## How to read this

Clients appear in migration order: cheapest to correct first. A client migrates
one capability at a time, and the legacy route it was calling stays mounted
throughout — that is what "additive" means here, and it is why no step in this
plan can break a client that has not taken it yet.

A row says: this capability, this client, calling this today, should call this
instead. Nothing in the "Move to" column is planned work — every path listed is
mounted and tested now.

## 1. Admin Web

Correction cost: **minutes** — Netlify from git — the push is the deploy.
An alias this client blocks needs **14 days** of observed silence before it may go.

| | |
| --- | --- |
| Capabilities that apply | 35 |
| Already on canonical | 0 |
| Still on a legacy route | 13 |
| Partially migrated | 1 |
| No equivalent called today | 21 |

| Capability | Today | Calls now | Move to |
| --- | --- | --- | --- |
| Additional work | planned | `GET /api/additional/booking/:bookingId`, `POST /api/additional/request/:userId` | `POST /api/v1/bookings/:bookingId/additional-work`, `GET /api/v1/bookings/:bookingId/additional-work` |
| Admin ledger reconciliation | legacy | `GET /api/admin/finance/reconciliation/exceptions` | `GET /api/v1/admin/finance/reconciliation` |
| Advance the read pointer | legacy | `POST /api/chat/conversations/:id/read` | `POST /api/v1/conversations/:conversationId/read` |
| Attach a file to a conversation | planned | `POST /api/chat/attachments/upload` | `POST /api/v1/conversations/:conversationId/attachments` |
| Booking codes (OTP) | planned | `POST /api/:bookingId/resend-otp`, `POST /api/:id/confirm-otp` | `POST /api/v1/bookings/:bookingId/otp/request`, `POST /api/v1/bookings/:bookingId/otp/verify` |
| Disputes | ⚠ mixed | `POST /api/admin/bookings/:id/escalate` | `POST /api/v1/bookings/:bookingId/disputes`, `GET /api/v1/bookings/:bookingId/disputes` |
| How many unread I have | planned | `GET /api/user/notifications/unread-count` | `GET /api/v1/notifications/unread-count` |
| List my conversations with unread counts | legacy | `GET /api/chat/conversations` | `GET /api/v1/conversations` |
| Mark everything read | planned | `POST /api/user/notifications/mark-all-read` | `POST /api/v1/notifications/read-all` |
| Mark one notification read | planned | `PATCH /api/user/notifications/:key/read` | `PATCH /api/v1/notifications/:key/read` |
| Move a booking through its state machine | legacy | `POST /api/admin/bookings/:id/assign`, `POST /api/admin/bookings/:id/reassign`, `PUT /api/worker/bookings/:bookingId/accept`, `PUT /api/worker/bookings/:bookingId/arrived`, `PUT /api/worker/bookings/:bookingId/complete`, `PUT /api/worker/bookings/:bookingId/decline`, `PUT /api/worker/bookings/:bookingId/en-route`, `PUT /api/worker/bookings/:bookingId/start` | `POST /api/v1/provider/jobs/:bookingId/accept`, `POST /api/v1/provider/jobs/:bookingId/decline`, `POST /api/v1/provider/jobs/:bookingId/en-route`, `POST /api/v1/provider/jobs/:bookingId/arrived`, `POST /api/v1/provider/jobs/:bookingId/start`, `POST /api/v1/provider/jobs/:bookingId/complete`, `POST /api/v1/admin/bookings/:bookingId/assign`, `POST /api/v1/admin/bookings/:bookingId/reassign` |
| Open (or resolve) a booking conversation | legacy | `GET /api/bookings/:bookingId/conversation` | `POST /api/v1/conversations` |
| Operate the booking queue | legacy | `GET /api/admin/bookings`, `GET /api/admin/bookings/:id/assignment-candidates` | `GET /api/v1/admin/bookings`, `GET /api/v1/admin/bookings/:bookingId/assignment-candidates` |
| Page through a conversation transcript | legacy | `GET /api/chat/conversations/:id/messages` | `GET /api/v1/conversations/:conversationId/messages` |
| Read a booking | planned | `GET /api/:id`, `GET /api/:id/timeline`, `GET /api/users/:userId/bookings` | `GET /api/v1/bookings`, `GET /api/v1/bookings/:bookingId`, `GET /api/v1/bookings/:bookingId/timeline`, `GET /api/v1/bookings/:bookingId/transitions` |
| Read a booking's payment and price breakdown | planned | _no legacy equivalent — this is new_ | `GET /api/v1/bookings/:bookingId/payment` |
| Read a provider's public profile | planned | _no legacy equivalent — this is new_ | `GET /api/v1/providers/:providerUid/profile` |
| Read and change my account record | planned | `GET /api/auth/me`, `PUT /api/user/updateprofile` | `GET /api/v1/me`, `PATCH /api/v1/me` |
| Read and change my customer profile | planned | `GET /api/user/profile`, `PUT /api/user/updateprofile` | `GET /api/v1/customer/profile`, `PATCH /api/v1/customer/profile` |
| Read and change my notification preferences | planned | `GET /api/provider/notification-preferences`, `GET /api/workers/:uid/notification-preferences`, `PUT /api/provider/notification-preferences`, `PUT /api/workers/:uid/notification-preferences` | `GET /api/v1/me/notification-preferences`, `PATCH /api/v1/me/notification-preferences`, `GET /api/v1/settings/notification-preferences`, `PUT /api/v1/settings/notification-preferences` |
| Read and change my provider profile | planned | `GET /api/provider/profile`, `POST /api/provider/public-profile-revisions` | `GET /api/v1/provider/profile`, `PATCH /api/v1/provider/profile` |
| Read and change my settings | planned | _no legacy equivalent — this is new_ | `GET /api/v1/me/settings`, `PATCH /api/v1/me/settings` |
| Read booking-code state | planned | _no legacy equivalent — this is new_ | `GET /api/v1/bookings/:bookingId/otp/status` |
| Read my notification inbox | planned | `GET /api/user/notifications` | `GET /api/v1/notifications` |
| Read my security posture | planned | _no legacy equivalent — this is new_ | `GET /api/v1/me/security` |
| Read one conversation and its participants | legacy | `GET /api/chat/conversations/:id` | `GET /api/v1/conversations/:conversationId` |
| Read the reschedule history of a booking | planned | _no legacy equivalent — this is new_ | `GET /api/v1/bookings/:bookingId/reschedule` |
| Recover an account and verify a contact | legacy | `GET /api/auth/resendverification`, `POST /api/auth/forgot-password`, `POST /api/auth/resend-email-otp`, `POST /api/auth/reset-password`, `POST /api/auth/verify-email-otp` | `POST /api/v1/auth/forgot-password`, `POST /api/v1/auth/reset-password`, `POST /api/v1/auth/verify-email`, `POST /api/v1/auth/resend-verification`, `POST /api/v1/auth/verify-mobile` |
| Refund a booking payment | legacy | `POST /api/admin/finance/refunds` | `POST /api/v1/bookings/:bookingId/refunds` |
| Register, sign in, and end a session | legacy | `POST /api/auth/admin-signin`, `POST /api/auth/firebase-login`, `POST /api/auth/logout`, `POST /api/auth/provider/register`, `POST /api/auth/refresh`, `POST /api/auth/signin`, `POST /api/auth/signup` | `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout` |
| Reschedule | legacy | `POST /api/admin/bookings/:id/reschedule` | `POST /api/v1/bookings/:bookingId/reschedule` |
| Send a message | legacy | `POST /api/chat/conversations/:id/messages` | `POST /api/v1/conversations/:conversationId/messages` |
| Start or resume a booking payment | planned | `POST /api/:bookingId/paymongo/create` | `POST /api/v1/bookings/:bookingId/payment-intents` |
| Tracking | planned | `GET /api/:id/tracking`, `GET /api/booking/:bookingId/provider-location` | `GET /api/v1/bookings/:bookingId/tracking` |
| Which sections exist and what owns each | planned | _no legacy equivalent — this is new_ | `GET /api/v1/home/sections` |

## 2. Provider Web

Correction cost: **minutes** — push to main is a production deploy.
An alias this client blocks needs **14 days** of observed silence before it may go.

| | |
| --- | --- |
| Capabilities that apply | 39 |
| Already on canonical | 22 |
| Still on a legacy route | 3 |
| Partially migrated | 6 |
| No equivalent called today | 8 |

| Capability | Today | Calls now | Move to |
| --- | --- | --- | --- |
| Additional work | ⚠ mixed | `GET /api/additional/booking/:bookingId`, `POST /api/additional/request/:userId` | `POST /api/v1/bookings/:bookingId/additional-work`, `GET /api/v1/bookings/:bookingId/additional-work` |
| Attach a file to a conversation | planned | `POST /api/chat/attachments/upload` | `POST /api/v1/conversations/:conversationId/attachments` |
| Dismiss one notification | legacy | `DELETE /api/provider/notifications/:key` | `DELETE /api/v1/notifications/:key` |
| Move a booking through its state machine | ⚠ mixed | `POST /api/admin/bookings/:id/assign`, `POST /api/admin/bookings/:id/reassign`, `PUT /api/worker/bookings/:bookingId/accept`, `PUT /api/worker/bookings/:bookingId/arrived`, `PUT /api/worker/bookings/:bookingId/complete`, `PUT /api/worker/bookings/:bookingId/decline`, `PUT /api/worker/bookings/:bookingId/en-route`, `PUT /api/worker/bookings/:bookingId/start` | `POST /api/v1/provider/jobs/:bookingId/accept`, `POST /api/v1/provider/jobs/:bookingId/decline`, `POST /api/v1/provider/jobs/:bookingId/en-route`, `POST /api/v1/provider/jobs/:bookingId/arrived`, `POST /api/v1/provider/jobs/:bookingId/start`, `POST /api/v1/provider/jobs/:bookingId/complete`, `POST /api/v1/admin/bookings/:bookingId/assign`, `POST /api/v1/admin/bookings/:bookingId/reassign` |
| Read a booking | planned | `GET /api/:id`, `GET /api/:id/timeline`, `GET /api/users/:userId/bookings` | `GET /api/v1/bookings`, `GET /api/v1/bookings/:bookingId`, `GET /api/v1/bookings/:bookingId/timeline`, `GET /api/v1/bookings/:bookingId/transitions` |
| Read a booking's payment and price breakdown | planned | _no legacy equivalent — this is new_ | `GET /api/v1/bookings/:bookingId/payment` |
| Read and change my account record | ⚠ mixed | `GET /api/auth/me`, `PUT /api/user/updateprofile` | `GET /api/v1/me`, `PATCH /api/v1/me` |
| Read and change my availability, and book time off | legacy | `DELETE /api/worker/time-off/:id`, `GET /api/worker/availability`, `GET /api/worker/time-off`, `POST /api/worker/time-off`, `PUT /api/worker/availability` | `GET /api/v1/provider/availability`, `PATCH /api/v1/provider/availability`, `DELETE /api/v1/provider/time-off/:timeOffId`, `POST /api/v1/provider/time-off`, `GET /api/v1/provider/time-off` |
| Read and change my notification preferences | ⚠ mixed | `GET /api/provider/notification-preferences`, `GET /api/workers/:uid/notification-preferences`, `PUT /api/provider/notification-preferences`, `PUT /api/workers/:uid/notification-preferences` | `GET /api/v1/me/notification-preferences`, `PATCH /api/v1/me/notification-preferences`, `GET /api/v1/settings/notification-preferences`, `PUT /api/v1/settings/notification-preferences` |
| Read and change my settings | planned | _no legacy equivalent — this is new_ | `GET /api/v1/me/settings`, `PATCH /api/v1/me/settings` |
| Read my security posture | planned | _no legacy equivalent — this is new_ | `GET /api/v1/me/security` |
| Read the services I am approved for | planned | `GET /api/worker/services-overview` | `GET /api/v1/provider/services` |
| Recover an account and verify a contact | ⚠ mixed | `GET /api/auth/resendverification`, `POST /api/auth/forgot-password`, `POST /api/auth/resend-email-otp`, `POST /api/auth/reset-password`, `POST /api/auth/verify-email-otp` | `POST /api/v1/auth/forgot-password`, `POST /api/v1/auth/reset-password`, `POST /api/v1/auth/verify-email`, `POST /api/v1/auth/resend-verification`, `POST /api/v1/auth/verify-mobile` |
| Register, sign in, and end a session | legacy | `POST /api/auth/admin-signin`, `POST /api/auth/firebase-login`, `POST /api/auth/logout`, `POST /api/auth/provider/register`, `POST /api/auth/refresh`, `POST /api/auth/signin`, `POST /api/auth/signup` | `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout` |
| Report a message to moderation | planned | `POST /api/chat/conversations/:id/messages/:msgId/report` | `POST /api/v1/conversations/:conversationId/messages/:messageId/report` |
| Submit, read, preview and withdraw my documents | ⚠ mixed | `DELETE /api/provider/documents/:documentId`, `GET /api/provider/document-types`, `GET /api/provider/documents`, `GET /api/provider/documents/:documentId/preview`, `POST /api/provider/documents` | `POST /api/v1/provider/documents`, `DELETE /api/v1/provider/documents/:documentId`, `GET /api/v1/provider/documents`, `GET /api/v1/provider/documents/:documentId/preview`, `GET /api/v1/provider/document-types` |
| What is left before my account is usable | planned | _no legacy equivalent — this is new_ | `GET /api/v1/me/completion` |

## 3. Customer Web

Correction cost: **hours** — Angular, not yet deployed.
An alias this client blocks needs **14 days** of observed silence before it may go.

| | |
| --- | --- |
| Capabilities that apply | 46 |
| Already on canonical | 0 |
| Still on a legacy route | 17 |
| Partially migrated | 4 |
| No equivalent called today | 25 |

| Capability | Today | Calls now | Move to |
| --- | --- | --- | --- |
| A provider's rating summary | planned | `GET /api/providers/:providerUid/rating` | `GET /api/v1/reviews/providers/:providerUid/rating` |
| Additional work | planned | `GET /api/additional/booking/:bookingId`, `POST /api/additional/request/:userId` | `POST /api/v1/bookings/:bookingId/additional-work`, `GET /api/v1/bookings/:bookingId/additional-work` |
| Advance the read pointer | legacy | `POST /api/chat/conversations/:id/read` | `POST /api/v1/conversations/:conversationId/read` |
| Attach a file to a conversation | planned | `POST /api/chat/attachments/upload` | `POST /api/v1/conversations/:conversationId/attachments` |
| Booking codes (OTP) | planned | `POST /api/:bookingId/resend-otp`, `POST /api/:id/confirm-otp` | `POST /api/v1/bookings/:bookingId/otp/request`, `POST /api/v1/bookings/:bookingId/otp/verify` |
| Browse the service catalog | planned | `GET /api/:serviceId/options-with-addons`, `GET /api/catalog`, `GET /api/catalog/services`, `GET /api/catalog/services/:serviceId`, `GET /api/catalog/summary`, `GET /api/services/:serviceId/level2`, `GET /api/services/:serviceId/options-with-addons`, `GET /api/services/full` | `GET /api/v1/catalog`, `GET /api/v1/catalog/summary`, `GET /api/v1/catalog/categories`, `GET /api/v1/catalog/categories/:categoryId`, `GET /api/v1/catalog/categories/:categoryId/subcategories`, `GET /api/v1/catalog/subcategories/:subcategoryId`, `GET /api/v1/catalog/subcategories/:subcategoryId/services`, `GET /api/v1/catalog/services`, `GET /api/v1/catalog/services/:serviceId` |
| Cancellation | legacy | `POST /api/bookings/:id/cancel`, `POST /api/provider/bookings/:bookingId/cancel` | `POST /api/v1/bookings/:bookingId/cancel`, `POST /api/v1/provider/jobs/:bookingId/cancel` |
| Dismiss one notification | planned | `DELETE /api/provider/notifications/:key` | `DELETE /api/v1/notifications/:key` |
| Disputes | planned | `POST /api/admin/bookings/:id/escalate` | `POST /api/v1/bookings/:bookingId/disputes`, `GET /api/v1/bookings/:bookingId/disputes` |
| How many unread I have | legacy | `GET /api/user/notifications/unread-count` | `GET /api/v1/notifications/unread-count` |
| List my conversations with unread counts | legacy | `GET /api/chat/conversations` | `GET /api/v1/conversations` |
| Manage my saved addresses | legacy | `DELETE /api/user/deleteaddress`, `GET /api/user/alluseraddresses`, `POST /api/user/adduseraddress`, `PUT /api/user/makeaddressprimary` | `GET /api/v1/customer/addresses`, `POST /api/v1/customer/addresses`, `PATCH /api/v1/customer/addresses/:addressId`, `DELETE /api/v1/customer/addresses/:addressId`, `POST /api/v1/customer/addresses/:addressId/default` |
| Mark everything read | legacy | `POST /api/user/notifications/mark-all-read` | `POST /api/v1/notifications/read-all` |
| Mark one notification read | legacy | `PATCH /api/user/notifications/:key/read` | `PATCH /api/v1/notifications/:key/read` |
| Open (or resolve) a booking conversation | legacy | `GET /api/bookings/:bookingId/conversation` | `POST /api/v1/conversations` |
| Page through a conversation transcript | legacy | `GET /api/chat/conversations/:id/messages` | `GET /api/v1/conversations/:conversationId/messages` |
| Raise a support case about a completed booking | planned | _no legacy equivalent — this is new_ | `POST /api/v1/bookings/:bookingId/support-cases` |
| Read a booking | ⚠ mixed | `GET /api/:id`, `GET /api/:id/timeline`, `GET /api/users/:userId/bookings` | `GET /api/v1/bookings`, `GET /api/v1/bookings/:bookingId`, `GET /api/v1/bookings/:bookingId/timeline`, `GET /api/v1/bookings/:bookingId/transitions` |
| Read a booking's payment and price breakdown | planned | _no legacy equivalent — this is new_ | `GET /api/v1/bookings/:bookingId/payment` |
| Read a provider's public profile | planned | _no legacy equivalent — this is new_ | `GET /api/v1/providers/:providerUid/profile` |
| Read a provider's published reviews | planned | `GET /api/providers/:providerUid/reviews` | `GET /api/v1/reviews/providers/:providerUid` |
| Read and change my account record | ⚠ mixed | `GET /api/auth/me`, `PUT /api/user/updateprofile` | `GET /api/v1/me`, `PATCH /api/v1/me` |
| Read and change my customer profile | legacy | `GET /api/user/profile`, `PUT /api/user/updateprofile` | `GET /api/v1/customer/profile`, `PATCH /api/v1/customer/profile` |
| Read and change my notification preferences | planned | `GET /api/provider/notification-preferences`, `GET /api/workers/:uid/notification-preferences`, `PUT /api/provider/notification-preferences`, `PUT /api/workers/:uid/notification-preferences` | `GET /api/v1/me/notification-preferences`, `PATCH /api/v1/me/notification-preferences`, `GET /api/v1/settings/notification-preferences`, `PUT /api/v1/settings/notification-preferences` |
| Read and change my settings | planned | _no legacy equivalent — this is new_ | `GET /api/v1/me/settings`, `PATCH /api/v1/me/settings` |
| Read booking-code state | planned | _no legacy equivalent — this is new_ | `GET /api/v1/bookings/:bookingId/otp/status` |
| Read my notification inbox | legacy | `GET /api/user/notifications` | `GET /api/v1/notifications` |
| Read my security posture | planned | _no legacy equivalent — this is new_ | `GET /api/v1/me/security` |
| Read one conversation and its participants | legacy | `GET /api/chat/conversations/:id` | `GET /api/v1/conversations/:conversationId` |
| Read the reschedule history of a booking | planned | _no legacy equivalent — this is new_ | `GET /api/v1/bookings/:bookingId/reschedule` |
| Read the review I wrote for a booking | legacy | `GET /api/bookings/:bookingId/review-eligibility`, `GET /api/bookings/:bookingId/reviews` | `GET /api/v1/bookings/:bookingId/review` |
| Read the support cases I raised on a booking | planned | _no legacy equivalent — this is new_ | `GET /api/v1/bookings/:bookingId/support-cases` |
| Recover an account and verify a contact | ⚠ mixed | `GET /api/auth/resendverification`, `POST /api/auth/forgot-password`, `POST /api/auth/resend-email-otp`, `POST /api/auth/reset-password`, `POST /api/auth/verify-email-otp` | `POST /api/v1/auth/forgot-password`, `POST /api/v1/auth/reset-password`, `POST /api/v1/auth/verify-email`, `POST /api/v1/auth/resend-verification`, `POST /api/v1/auth/verify-mobile` |
| Refund a booking payment | planned | `POST /api/admin/finance/refunds` | `POST /api/v1/bookings/:bookingId/refunds` |
| Register and release this device for push | planned | `DELETE /api/provider/fcm-token`, `DELETE /api/user/fcm-token`, `POST /api/provider/fcm-token`, `POST /api/user/fcm-token` | `POST /api/v1/me/devices`, `DELETE /api/v1/me/devices` |
| Register, sign in, and end a session | ⚠ mixed | `POST /api/auth/admin-signin`, `POST /api/auth/firebase-login`, `POST /api/auth/logout`, `POST /api/auth/provider/register`, `POST /api/auth/refresh`, `POST /api/auth/signin`, `POST /api/auth/signup` | `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout` |
| Report a message to moderation | planned | `POST /api/chat/conversations/:id/messages/:msgId/report` | `POST /api/v1/conversations/:conversationId/messages/:messageId/report` |
| Reschedule | planned | `POST /api/admin/bookings/:id/reschedule` | `POST /api/v1/bookings/:bookingId/reschedule` |
| Review a completed booking | legacy | `POST /api/bookings/:bookingId/reviews` | `POST /api/v1/bookings/:bookingId/review` |
| Search services | planned | `GET /api/services/full` | `GET /api/v1/search`, `GET /api/v1/catalog/search` |
| Send a message | legacy | `POST /api/chat/conversations/:id/messages` | `POST /api/v1/conversations/:conversationId/messages` |
| Start or resume a booking payment | legacy | `POST /api/:bookingId/paymongo/create` | `POST /api/v1/bookings/:bookingId/payment-intents` |
| The composed home surface | planned | _no legacy equivalent — this is new_ | `GET /api/v1/home` |
| Tracking | legacy | `GET /api/:id/tracking`, `GET /api/booking/:bookingId/provider-location` | `GET /api/v1/bookings/:bookingId/tracking` |
| What is left before my account is usable | planned | _no legacy equivalent — this is new_ | `GET /api/v1/me/completion` |
| Which sections exist and what owns each | planned | _no legacy equivalent — this is new_ | `GET /api/v1/home/sections` |

## 4. Provider Mobile

Correction cost: **days–weeks** — Play review, then the installed base updates.
An alias this client blocks needs **90 days** of observed silence before it may go.

| | |
| --- | --- |
| Capabilities that apply | 40 |
| Already on canonical | 0 |
| Still on a legacy route | 20 |
| Partially migrated | 6 |
| No equivalent called today | 14 |

| Capability | Today | Calls now | Move to |
| --- | --- | --- | --- |
| A provider's own job queue | ⚠ mixed | `GET /api/worker/job-cards`, `GET /api/worker/job-cards/:bookingId`, `GET /api/workers/:workerId/job-cards` | `GET /api/v1/provider/jobs`, `GET /api/v1/provider/jobs/:bookingId` |
| Additional work | planned | `GET /api/additional/booking/:bookingId`, `POST /api/additional/request/:userId` | `POST /api/v1/bookings/:bookingId/additional-work`, `GET /api/v1/bookings/:bookingId/additional-work` |
| Advance the read pointer | legacy | `POST /api/chat/conversations/:id/read` | `POST /api/v1/conversations/:conversationId/read` |
| Attach a file to a conversation | planned | `POST /api/chat/attachments/upload` | `POST /api/v1/conversations/:conversationId/attachments` |
| Booking codes (OTP) | planned | `POST /api/:bookingId/resend-otp`, `POST /api/:id/confirm-otp` | `POST /api/v1/bookings/:bookingId/otp/request`, `POST /api/v1/bookings/:bookingId/otp/verify` |
| Browse the service catalog | legacy | `GET /api/:serviceId/options-with-addons`, `GET /api/catalog`, `GET /api/catalog/services`, `GET /api/catalog/services/:serviceId`, `GET /api/catalog/summary`, `GET /api/services/:serviceId/level2`, `GET /api/services/:serviceId/options-with-addons`, `GET /api/services/full` | `GET /api/v1/catalog`, `GET /api/v1/catalog/summary`, `GET /api/v1/catalog/categories`, `GET /api/v1/catalog/categories/:categoryId`, `GET /api/v1/catalog/categories/:categoryId/subcategories`, `GET /api/v1/catalog/subcategories/:subcategoryId`, `GET /api/v1/catalog/subcategories/:subcategoryId/services`, `GET /api/v1/catalog/services`, `GET /api/v1/catalog/services/:serviceId` |
| Cancellation | legacy | `POST /api/bookings/:id/cancel`, `POST /api/provider/bookings/:bookingId/cancel` | `POST /api/v1/bookings/:bookingId/cancel`, `POST /api/v1/provider/jobs/:bookingId/cancel` |
| Dismiss one notification | planned | `DELETE /api/provider/notifications/:key` | `DELETE /api/v1/notifications/:key` |
| Disputes | planned | `POST /api/admin/bookings/:id/escalate` | `POST /api/v1/bookings/:bookingId/disputes`, `GET /api/v1/bookings/:bookingId/disputes` |
| How many unread I have | legacy | `GET /api/user/notifications/unread-count` | `GET /api/v1/notifications/unread-count` |
| List my conversations with unread counts | legacy | `GET /api/chat/conversations` | `GET /api/v1/conversations` |
| Mark everything read | legacy | `POST /api/user/notifications/mark-all-read` | `POST /api/v1/notifications/read-all` |
| Mark one notification read | legacy | `PATCH /api/user/notifications/:key/read` | `PATCH /api/v1/notifications/:key/read` |
| Move a booking through its state machine | legacy | `POST /api/admin/bookings/:id/assign`, `POST /api/admin/bookings/:id/reassign`, `PUT /api/worker/bookings/:bookingId/accept`, `PUT /api/worker/bookings/:bookingId/arrived`, `PUT /api/worker/bookings/:bookingId/complete`, `PUT /api/worker/bookings/:bookingId/decline`, `PUT /api/worker/bookings/:bookingId/en-route`, `PUT /api/worker/bookings/:bookingId/start` | `POST /api/v1/provider/jobs/:bookingId/accept`, `POST /api/v1/provider/jobs/:bookingId/decline`, `POST /api/v1/provider/jobs/:bookingId/en-route`, `POST /api/v1/provider/jobs/:bookingId/arrived`, `POST /api/v1/provider/jobs/:bookingId/start`, `POST /api/v1/provider/jobs/:bookingId/complete`, `POST /api/v1/admin/bookings/:bookingId/assign`, `POST /api/v1/admin/bookings/:bookingId/reassign` |
| Open (or resolve) a booking conversation | legacy | `GET /api/bookings/:bookingId/conversation` | `POST /api/v1/conversations` |
| Page through a conversation transcript | legacy | `GET /api/chat/conversations/:id/messages` | `GET /api/v1/conversations/:conversationId/messages` |
| Provider earnings summary | legacy | `GET /api/provider/earnings/summary` | `GET /api/v1/provider/earnings/summary` |
| Provider earnings transactions | legacy | `GET /api/provider/earnings`, `GET /api/provider/ledger` | `GET /api/v1/provider/earnings/transactions` |
| Provider payouts | legacy | `GET /api/provider/payouts` | `GET /api/v1/provider/earnings/payouts` |
| Read a booking | ⚠ mixed | `GET /api/:id`, `GET /api/:id/timeline`, `GET /api/users/:userId/bookings` | `GET /api/v1/bookings`, `GET /api/v1/bookings/:bookingId`, `GET /api/v1/bookings/:bookingId/timeline`, `GET /api/v1/bookings/:bookingId/transitions` |
| Read a booking's payment and price breakdown | planned | _no legacy equivalent — this is new_ | `GET /api/v1/bookings/:bookingId/payment` |
| Read and change my account record | ⚠ mixed | `GET /api/auth/me`, `PUT /api/user/updateprofile` | `GET /api/v1/me`, `PATCH /api/v1/me` |
| Read and change my availability, and book time off | ⚠ mixed | `DELETE /api/worker/time-off/:id`, `GET /api/worker/availability`, `GET /api/worker/time-off`, `POST /api/worker/time-off`, `PUT /api/worker/availability` | `GET /api/v1/provider/availability`, `PATCH /api/v1/provider/availability`, `DELETE /api/v1/provider/time-off/:timeOffId`, `POST /api/v1/provider/time-off`, `GET /api/v1/provider/time-off` |
| Read and change my notification preferences | legacy | `GET /api/provider/notification-preferences`, `GET /api/workers/:uid/notification-preferences`, `PUT /api/provider/notification-preferences`, `PUT /api/workers/:uid/notification-preferences` | `GET /api/v1/me/notification-preferences`, `PATCH /api/v1/me/notification-preferences`, `GET /api/v1/settings/notification-preferences`, `PUT /api/v1/settings/notification-preferences` |
| Read and change my provider profile | legacy | `GET /api/provider/profile`, `POST /api/provider/public-profile-revisions` | `GET /api/v1/provider/profile`, `PATCH /api/v1/provider/profile` |
| Read and change my settings | planned | _no legacy equivalent — this is new_ | `GET /api/v1/me/settings`, `PATCH /api/v1/me/settings` |
| Read booking-code state | planned | _no legacy equivalent — this is new_ | `GET /api/v1/bookings/:bookingId/otp/status` |
| Read my notification inbox | legacy | `GET /api/user/notifications` | `GET /api/v1/notifications` |
| Read my security posture | planned | _no legacy equivalent — this is new_ | `GET /api/v1/me/security` |
| Read one conversation and its participants | legacy | `GET /api/chat/conversations/:id` | `GET /api/v1/conversations/:conversationId` |
| Read the reschedule history of a booking | planned | _no legacy equivalent — this is new_ | `GET /api/v1/bookings/:bookingId/reschedule` |
| Read the services I am approved for | planned | `GET /api/worker/services-overview` | `GET /api/v1/provider/services` |
| Recover an account and verify a contact | ⚠ mixed | `GET /api/auth/resendverification`, `POST /api/auth/forgot-password`, `POST /api/auth/resend-email-otp`, `POST /api/auth/reset-password`, `POST /api/auth/verify-email-otp` | `POST /api/v1/auth/forgot-password`, `POST /api/v1/auth/reset-password`, `POST /api/v1/auth/verify-email`, `POST /api/v1/auth/resend-verification`, `POST /api/v1/auth/verify-mobile` |
| Register and release this device for push | legacy | `DELETE /api/provider/fcm-token`, `DELETE /api/user/fcm-token`, `POST /api/provider/fcm-token`, `POST /api/user/fcm-token` | `POST /api/v1/me/devices`, `DELETE /api/v1/me/devices` |
| Register, sign in, and end a session | legacy | `POST /api/auth/admin-signin`, `POST /api/auth/firebase-login`, `POST /api/auth/logout`, `POST /api/auth/provider/register`, `POST /api/auth/refresh`, `POST /api/auth/signin`, `POST /api/auth/signup` | `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout` |
| Report a message to moderation | planned | `POST /api/chat/conversations/:id/messages/:msgId/report` | `POST /api/v1/conversations/:conversationId/messages/:messageId/report` |
| Send a message | legacy | `POST /api/chat/conversations/:id/messages` | `POST /api/v1/conversations/:conversationId/messages` |
| Submit, read, preview and withdraw my documents | ⚠ mixed | `DELETE /api/provider/documents/:documentId`, `GET /api/provider/document-types`, `GET /api/provider/documents`, `GET /api/provider/documents/:documentId/preview`, `POST /api/provider/documents` | `POST /api/v1/provider/documents`, `DELETE /api/v1/provider/documents/:documentId`, `GET /api/v1/provider/documents`, `GET /api/v1/provider/documents/:documentId/preview`, `GET /api/v1/provider/document-types` |
| Tracking | planned | `GET /api/:id/tracking`, `GET /api/booking/:bookingId/provider-location` | `GET /api/v1/bookings/:bookingId/tracking` |
| What is left before my account is usable | planned | _no legacy equivalent — this is new_ | `GET /api/v1/me/completion` |

## 5. Customer Mobile

Correction cost: **days–weeks** — Play review; the largest installed base.
An alias this client blocks needs **90 days** of observed silence before it may go.

| | |
| --- | --- |
| Capabilities that apply | 46 |
| Already on canonical | 0 |
| Still on a legacy route | 20 |
| Partially migrated | 5 |
| No equivalent called today | 21 |

| Capability | Today | Calls now | Move to |
| --- | --- | --- | --- |
| A provider's rating summary | planned | `GET /api/providers/:providerUid/rating` | `GET /api/v1/reviews/providers/:providerUid/rating` |
| Additional work | planned | `GET /api/additional/booking/:bookingId`, `POST /api/additional/request/:userId` | `POST /api/v1/bookings/:bookingId/additional-work`, `GET /api/v1/bookings/:bookingId/additional-work` |
| Advance the read pointer | legacy | `POST /api/chat/conversations/:id/read` | `POST /api/v1/conversations/:conversationId/read` |
| Attach a file to a conversation | planned | `POST /api/chat/attachments/upload` | `POST /api/v1/conversations/:conversationId/attachments` |
| Booking codes (OTP) | legacy | `POST /api/:bookingId/resend-otp`, `POST /api/:id/confirm-otp` | `POST /api/v1/bookings/:bookingId/otp/request`, `POST /api/v1/bookings/:bookingId/otp/verify` |
| Browse the service catalog | ⚠ mixed | `GET /api/:serviceId/options-with-addons`, `GET /api/catalog`, `GET /api/catalog/services`, `GET /api/catalog/services/:serviceId`, `GET /api/catalog/summary`, `GET /api/services/:serviceId/level2`, `GET /api/services/:serviceId/options-with-addons`, `GET /api/services/full` | `GET /api/v1/catalog`, `GET /api/v1/catalog/summary`, `GET /api/v1/catalog/categories`, `GET /api/v1/catalog/categories/:categoryId`, `GET /api/v1/catalog/categories/:categoryId/subcategories`, `GET /api/v1/catalog/subcategories/:subcategoryId`, `GET /api/v1/catalog/subcategories/:subcategoryId/services`, `GET /api/v1/catalog/services`, `GET /api/v1/catalog/services/:serviceId` |
| Cancellation | legacy | `POST /api/bookings/:id/cancel`, `POST /api/provider/bookings/:bookingId/cancel` | `POST /api/v1/bookings/:bookingId/cancel`, `POST /api/v1/provider/jobs/:bookingId/cancel` |
| Dismiss one notification | planned | `DELETE /api/provider/notifications/:key` | `DELETE /api/v1/notifications/:key` |
| Disputes | planned | `POST /api/admin/bookings/:id/escalate` | `POST /api/v1/bookings/:bookingId/disputes`, `GET /api/v1/bookings/:bookingId/disputes` |
| How many unread I have | legacy | `GET /api/user/notifications/unread-count` | `GET /api/v1/notifications/unread-count` |
| List my conversations with unread counts | legacy | `GET /api/chat/conversations` | `GET /api/v1/conversations` |
| Manage my saved addresses | legacy | `DELETE /api/user/deleteaddress`, `GET /api/user/alluseraddresses`, `POST /api/user/adduseraddress`, `PUT /api/user/makeaddressprimary` | `GET /api/v1/customer/addresses`, `POST /api/v1/customer/addresses`, `PATCH /api/v1/customer/addresses/:addressId`, `DELETE /api/v1/customer/addresses/:addressId`, `POST /api/v1/customer/addresses/:addressId/default` |
| Mark everything read | legacy | `POST /api/user/notifications/mark-all-read` | `POST /api/v1/notifications/read-all` |
| Mark one notification read | legacy | `PATCH /api/user/notifications/:key/read` | `PATCH /api/v1/notifications/:key/read` |
| Open (or resolve) a booking conversation | legacy | `GET /api/bookings/:bookingId/conversation` | `POST /api/v1/conversations` |
| Page through a conversation transcript | legacy | `GET /api/chat/conversations/:id/messages` | `GET /api/v1/conversations/:conversationId/messages` |
| Raise a support case about a completed booking | planned | _no legacy equivalent — this is new_ | `POST /api/v1/bookings/:bookingId/support-cases` |
| Read a booking | ⚠ mixed | `GET /api/:id`, `GET /api/:id/timeline`, `GET /api/users/:userId/bookings` | `GET /api/v1/bookings`, `GET /api/v1/bookings/:bookingId`, `GET /api/v1/bookings/:bookingId/timeline`, `GET /api/v1/bookings/:bookingId/transitions` |
| Read a booking's payment and price breakdown | planned | _no legacy equivalent — this is new_ | `GET /api/v1/bookings/:bookingId/payment` |
| Read a provider's public profile | planned | _no legacy equivalent — this is new_ | `GET /api/v1/providers/:providerUid/profile` |
| Read a provider's published reviews | planned | `GET /api/providers/:providerUid/reviews` | `GET /api/v1/reviews/providers/:providerUid` |
| Read and change my account record | ⚠ mixed | `GET /api/auth/me`, `PUT /api/user/updateprofile` | `GET /api/v1/me`, `PATCH /api/v1/me` |
| Read and change my customer profile | legacy | `GET /api/user/profile`, `PUT /api/user/updateprofile` | `GET /api/v1/customer/profile`, `PATCH /api/v1/customer/profile` |
| Read and change my notification preferences | planned | `GET /api/provider/notification-preferences`, `GET /api/workers/:uid/notification-preferences`, `PUT /api/provider/notification-preferences`, `PUT /api/workers/:uid/notification-preferences` | `GET /api/v1/me/notification-preferences`, `PATCH /api/v1/me/notification-preferences`, `GET /api/v1/settings/notification-preferences`, `PUT /api/v1/settings/notification-preferences` |
| Read and change my settings | planned | _no legacy equivalent — this is new_ | `GET /api/v1/me/settings`, `PATCH /api/v1/me/settings` |
| Read booking-code state | planned | _no legacy equivalent — this is new_ | `GET /api/v1/bookings/:bookingId/otp/status` |
| Read my notification inbox | legacy | `GET /api/user/notifications` | `GET /api/v1/notifications` |
| Read my security posture | planned | _no legacy equivalent — this is new_ | `GET /api/v1/me/security` |
| Read one conversation and its participants | legacy | `GET /api/chat/conversations/:id` | `GET /api/v1/conversations/:conversationId` |
| Read the reschedule history of a booking | planned | _no legacy equivalent — this is new_ | `GET /api/v1/bookings/:bookingId/reschedule` |
| Read the review I wrote for a booking | legacy | `GET /api/bookings/:bookingId/review-eligibility`, `GET /api/bookings/:bookingId/reviews` | `GET /api/v1/bookings/:bookingId/review` |
| Read the support cases I raised on a booking | planned | _no legacy equivalent — this is new_ | `GET /api/v1/bookings/:bookingId/support-cases` |
| Recover an account and verify a contact | ⚠ mixed | `GET /api/auth/resendverification`, `POST /api/auth/forgot-password`, `POST /api/auth/resend-email-otp`, `POST /api/auth/reset-password`, `POST /api/auth/verify-email-otp` | `POST /api/v1/auth/forgot-password`, `POST /api/v1/auth/reset-password`, `POST /api/v1/auth/verify-email`, `POST /api/v1/auth/resend-verification`, `POST /api/v1/auth/verify-mobile` |
| Refund a booking payment | planned | `POST /api/admin/finance/refunds` | `POST /api/v1/bookings/:bookingId/refunds` |
| Register and release this device for push | legacy | `DELETE /api/provider/fcm-token`, `DELETE /api/user/fcm-token`, `POST /api/provider/fcm-token`, `POST /api/user/fcm-token` | `POST /api/v1/me/devices`, `DELETE /api/v1/me/devices` |
| Register, sign in, and end a session | legacy | `POST /api/auth/admin-signin`, `POST /api/auth/firebase-login`, `POST /api/auth/logout`, `POST /api/auth/provider/register`, `POST /api/auth/refresh`, `POST /api/auth/signin`, `POST /api/auth/signup` | `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout` |
| Report a message to moderation | planned | `POST /api/chat/conversations/:id/messages/:msgId/report` | `POST /api/v1/conversations/:conversationId/messages/:messageId/report` |
| Reschedule | planned | `POST /api/admin/bookings/:id/reschedule` | `POST /api/v1/bookings/:bookingId/reschedule` |
| Review a completed booking | legacy | `POST /api/bookings/:bookingId/reviews` | `POST /api/v1/bookings/:bookingId/review` |
| Search services | ⚠ mixed | `GET /api/services/full` | `GET /api/v1/search`, `GET /api/v1/catalog/search` |
| Send a message | legacy | `POST /api/chat/conversations/:id/messages` | `POST /api/v1/conversations/:conversationId/messages` |
| Start or resume a booking payment | legacy | `POST /api/:bookingId/paymongo/create` | `POST /api/v1/bookings/:bookingId/payment-intents` |
| The composed home surface | planned | _no legacy equivalent — this is new_ | `GET /api/v1/home` |
| Tracking | legacy | `GET /api/:id/tracking`, `GET /api/booking/:bookingId/provider-location` | `GET /api/v1/bookings/:bookingId/tracking` |
| What is left before my account is usable | planned | _no legacy equivalent — this is new_ | `GET /api/v1/me/completion` |
| Which sections exist and what owns each | planned | _no legacy equivalent — this is new_ | `GET /api/v1/home/sections` |

## What none of this authorizes

Migrating a client does not retire anything. The alias stays until the observed
traffic window in [`DEPRECATION_SCHEDULE.md`](DEPRECATION_SCHEDULE.md) has run,
because a client that has migrated in source may still have an installed base
that has not.
