<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-convergence-docs.ts, derived from
    src/api/v1/convergence.ts      (the federated capability registry)
    src/api/v1/contract.ts         (the canonical endpoints and their callers)
    src/api/v1/legacyTelemetry.ts  (retirement criteria)
    src/api/v1/legacyTelemetry.ts (RETIREMENT_CRITERIA)
  Regenerate: npm run convergence:docs
-->

# Deprecation schedule

> No date in this document is a calendar date. Every one is a CONDITION, because
> "we think nobody calls it" is how a path a shipped build depends on gets
> deleted.

## 1. The gate

An alias may be deleted only when all four are true:

1. the canonical successor is `status: 'implemented'` — required;
2. every client the matrix lists reads `migrated` — required;
3. `[legacy-contract]` telemetry has recorded **zero** hits for
   14 consecutive days (web-only alias) or
   90 consecutive days (any mobile caller);
4. the deletion is a separate change from the migration that made it possible, so
   it can be reverted on its own.

Condition 3 is measured in days of observed silence rather than in releases
because an unupdated app keeps calling the old path for as long as it stays
installed.

## 2. Where things stand

| | |
| --- | --- |
| Legacy mappings tracked | 126 |
| In the retirement plan | 107 |
| `KEEP` (not a duplicate of anything) | 6 |
| `ROLE_SPECIFIC` (different auth/action, same service) | 13 |
| `ALIAS_TEMPORARILY` | 94 |
| `CANONICALIZE` | 12 |
| `RETIRE` | 1 |
| **Retirable today** | **0** |
| Blocked | 107 |

Nothing is retirable today, and the reason is the same for all of them: no client has migrated, because the v1 namespace is not deployed. The schedule is the order things become retirable, not a queue of pending deletions.

## 3. Every alias

| Legacy route | Disposition | Canonical successor | Blocked by | Window |
| --- | --- | --- | --- | --- |
| `POST /api/:bookingId/paymongo/create` | ALIAS_TEMPORARILY | `bookings.payments.intent` | Customer Mobile, Customer Web, Admin Web have not migrated | 90d |
| `POST /api/:bookingId/resend-otp` | ALIAS_TEMPORARILY | `bookings.otp.request` | Customer Mobile, Customer Web, Admin Web have not migrated | 90d |
| `GET /api/:id` | ALIAS_TEMPORARILY | `bookings.get` | Customer Mobile, Customer Web, Provider Mobile, Provider Web, Admin Web have not migrated | 90d |
| `POST /api/:id/confirm-otp` | ALIAS_TEMPORARILY | `bookings.otp.verify` | Customer Mobile, Customer Web, Provider Mobile, Admin Web have not migrated | 90d |
| `GET /api/:id/timeline` | ALIAS_TEMPORARILY | `bookings.timeline` | Customer Mobile, Customer Web have not migrated | 90d |
| `GET /api/:id/tracking` | ALIAS_TEMPORARILY | `bookings.tracking` | Customer Mobile, Customer Web, Admin Web have not migrated; Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 90d |
| `GET /api/:serviceId/options-with-addons` | ALIAS_TEMPORARILY | `catalog.subcategories.services` | Customer Mobile, Customer Web, Provider Mobile have not migrated | 90d |
| `GET /api/additional/booking/:bookingId` | ALIAS_TEMPORARILY | `bookings.additionalWork.list` | Customer Mobile, Customer Web, Provider Web, Admin Web have not migrated; Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 90d |
| `POST /api/additional/request/:userId` | ALIAS_TEMPORARILY | `bookings.additionalWork.create` | Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 14d |
| `GET /api/admin/bookings` | CANONICALIZE | `admin.bookings.list` | Admin Web has not migrated; marked CANONICALIZE — this path is still the canonical one for its callers | 14d |
| `POST /api/admin/bookings/:id/assign` | CANONICALIZE | `admin.bookings.assign` | Admin Web has not migrated; marked CANONICALIZE — this path is still the canonical one for its callers | 14d |
| `GET /api/admin/bookings/:id/assignment-candidates` | CANONICALIZE | `admin.bookings.assignmentCandidates` | Admin Web has not migrated; marked CANONICALIZE — this path is still the canonical one for its callers | 14d |
| `POST /api/admin/bookings/:id/escalate` | ALIAS_TEMPORARILY | `bookings.disputes.open` | Customer Mobile, Customer Web, Admin Web have not migrated; Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 90d |
| `POST /api/admin/bookings/:id/reassign` | CANONICALIZE | `admin.bookings.reassign` | Admin Web has not migrated; marked CANONICALIZE — this path is still the canonical one for its callers | 14d |
| `POST /api/admin/bookings/:id/reschedule` | ALIAS_TEMPORARILY | `bookings.reschedule` | Customer Mobile, Customer Web, Admin Web have not migrated | 90d |
| `GET /api/admin/finance/reconciliation/exceptions` | ALIAS_TEMPORARILY | `admin.finance.reconciliation` | Admin Web has not migrated | 14d |
| `POST /api/admin/finance/refunds` | ALIAS_TEMPORARILY | `bookings.refunds.create` | Customer Mobile, Customer Web, Admin Web have not migrated | 90d |
| `POST /api/admin/finance/refunds/:refundId/mark-failed` | CANONICALIZE | `admin.refunds.markFailed` | Admin Web has not migrated; marked CANONICALIZE — this path is still the canonical one for its callers | 14d |
| `POST /api/auth/admin-signin` | ALIAS_TEMPORARILY | `auth.login` | Customer Mobile, Customer Web, Provider Mobile, Provider Web, Admin Web have not migrated | 90d |
| `POST /api/auth/firebase-login` | ALIAS_TEMPORARILY | `auth.login` | Customer Mobile, Customer Web, Provider Mobile, Provider Web, Admin Web have not migrated | 90d |
| `POST /api/auth/forgot-password` | ALIAS_TEMPORARILY | `auth.forgotPassword` | Customer Mobile, Customer Web, Provider Mobile, Provider Web, Admin Web have not migrated | 90d |
| `POST /api/auth/logout` | ALIAS_TEMPORARILY | `auth.logout` | Customer Mobile, Customer Web, Provider Mobile, Admin Web have not migrated | 90d |
| `GET /api/auth/me` | ALIAS_TEMPORARILY | `identity.me` | Customer Mobile, Customer Web, Admin Web have not migrated; Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 90d |
| `POST /api/auth/provider/register` | ALIAS_TEMPORARILY | `auth.register` | Customer Mobile, Customer Web, Provider Mobile, Provider Web have not migrated | 90d |
| `POST /api/auth/refresh` | ALIAS_TEMPORARILY | `auth.refresh` | Customer Mobile, Customer Web, Provider Mobile, Provider Web, Admin Web have not migrated | 90d |
| `POST /api/auth/resend-email-otp` | ALIAS_TEMPORARILY | `auth.resendVerification` | Customer Mobile, Customer Web, Provider Mobile, Provider Web have not migrated | 90d |
| `GET /api/auth/resendverification` | ALIAS_TEMPORARILY | `auth.resendVerification` | Customer Mobile, Customer Web, Provider Mobile, Provider Web have not migrated | 90d |
| `POST /api/auth/reset-password` | ALIAS_TEMPORARILY | `auth.resetPassword` | Customer Mobile, Customer Web, Provider Mobile, Provider Web, Admin Web have not migrated | 90d |
| `POST /api/auth/signin` | ALIAS_TEMPORARILY | `auth.login` | Customer Mobile, Customer Web, Provider Mobile, Provider Web, Admin Web have not migrated | 90d |
| `POST /api/auth/signup` | ALIAS_TEMPORARILY | `auth.register` | Customer Mobile, Customer Web, Provider Mobile, Provider Web have not migrated | 90d |
| `POST /api/auth/verify-email-otp` | ALIAS_TEMPORARILY | `auth.verifyEmail` | Customer Mobile, Customer Web, Provider Mobile, Provider Web have not migrated | 90d |
| `GET /api/booking/:bookingId/provider-location` | ALIAS_TEMPORARILY | `bookings.tracking` | Customer Mobile, Customer Web, Admin Web have not migrated; Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 90d |
| `GET /api/bookings/:bookingId/conversation` | ALIAS_TEMPORARILY | `conversations.create` | Customer Mobile, Customer Web, Provider Mobile, Admin Web have not migrated | 90d |
| `GET /api/bookings/:bookingId/review-eligibility` | ALIAS_TEMPORARILY | `bookings.review.get` | Customer Mobile, Customer Web have not migrated | 90d |
| `POST /api/bookings/:bookingId/reviews` | ALIAS_TEMPORARILY | `bookings.review.create` | Customer Mobile, Customer Web have not migrated | 90d |
| `GET /api/bookings/:bookingId/reviews` | ALIAS_TEMPORARILY | `bookings.review.get` | Customer Mobile, Customer Web have not migrated | 90d |
| `POST /api/bookings/:id/cancel` | ALIAS_TEMPORARILY | `bookings.cancel` | Customer Mobile, Customer Web have not migrated | 90d |
| `GET /api/catalog` | ALIAS_TEMPORARILY | `catalog.browse` | Customer Mobile, Customer Web have not migrated | 90d |
| `GET /api/catalog/services` | ALIAS_TEMPORARILY | `catalog.services.list` | Customer Mobile, Customer Web have not migrated | 90d |
| `GET /api/catalog/services/:serviceId` | ALIAS_TEMPORARILY | `catalog.services.get` | Customer Mobile, Customer Web have not migrated | 90d |
| `GET /api/catalog/services/:serviceId/serviceability` | CANONICALIZE | `catalog.services.serviceability` | the canonical successor `catalog.services.serviceability` is not mounted yet; Customer Mobile, Customer Web have not migrated; marked CANONICALIZE — this path is still the canonical one for its callers | 90d |
| `GET /api/catalog/summary` | ALIAS_TEMPORARILY | `catalog.summary` | Customer Mobile, Customer Web have not migrated | 90d |
| `POST /api/chat/attachments/upload` | CANONICALIZE | `conversations.attachments.create` | Customer Mobile, Customer Web, Provider Mobile, Provider Web, Admin Web have not migrated; marked CANONICALIZE — this path is still the canonical one for its callers | 90d |
| `GET /api/chat/conversations` | ALIAS_TEMPORARILY | `conversations.list` | Customer Mobile, Customer Web, Provider Mobile, Admin Web have not migrated | 90d |
| `GET /api/chat/conversations/:id` | ALIAS_TEMPORARILY | `conversations.get` | Customer Mobile, Customer Web, Provider Mobile, Admin Web have not migrated | 90d |
| `GET /api/chat/conversations/:id/messages` | ALIAS_TEMPORARILY | `conversations.messages.list` | Customer Mobile, Customer Web, Provider Mobile, Admin Web have not migrated | 90d |
| `POST /api/chat/conversations/:id/messages` | ALIAS_TEMPORARILY | `conversations.messages.create` | Customer Mobile, Customer Web, Provider Mobile, Admin Web have not migrated | 90d |
| `POST /api/chat/conversations/:id/messages/:msgId/report` | ALIAS_TEMPORARILY | `conversations.messages.report` | Customer Mobile, Customer Web, Provider Mobile, Provider Web have not migrated | 90d |
| `POST /api/chat/conversations/:id/read` | ALIAS_TEMPORARILY | `conversations.read` | Customer Mobile, Customer Web, Provider Mobile, Admin Web have not migrated | 90d |
| `POST /api/provider/bookings/:bookingId/cancel` | ALIAS_TEMPORARILY | `provider.jobs.cancel` | Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 14d |
| `GET /api/provider/document-types` | ALIAS_TEMPORARILY | `provider.documents.types` | Provider Web has not migrated; Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 14d |
| `GET /api/provider/documents` | ALIAS_TEMPORARILY | `provider.documents.list` | Provider Mobile has not migrated | 90d |
| `POST /api/provider/documents` | ALIAS_TEMPORARILY | `provider.documents.create` | Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 14d |
| `DELETE /api/provider/documents/:documentId` | ALIAS_TEMPORARILY | `provider.documents.delete` | Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 14d |
| `GET /api/provider/documents/:documentId/preview` | ALIAS_TEMPORARILY | `provider.documents.preview` | Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 14d |
| `GET /api/provider/earnings` | ALIAS_TEMPORARILY | `provider.earnings.transactions` | Provider Mobile has not migrated | 90d |
| `GET /api/provider/earnings/summary` | ALIAS_TEMPORARILY | `provider.earnings.summary` | Provider Mobile has not migrated | 90d |
| `POST /api/provider/fcm-token` | ALIAS_TEMPORARILY | `me.devices.register` | Customer Mobile, Customer Web have not migrated; Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 90d |
| `DELETE /api/provider/fcm-token` | ALIAS_TEMPORARILY | `me.devices.release` | Customer Mobile, Customer Web have not migrated; Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 90d |
| `GET /api/provider/ledger` | ALIAS_TEMPORARILY | `provider.earnings.transactions` | Provider Mobile has not migrated | 90d |
| `GET /api/provider/notification-preferences` | ALIAS_TEMPORARILY | `me.notificationPreferences.get` | Customer Mobile, Customer Web, Provider Mobile, Admin Web have not migrated | 90d |
| `PUT /api/provider/notification-preferences` | ALIAS_TEMPORARILY | `me.notificationPreferences.patch` | Customer Mobile, Customer Web, Provider Mobile, Admin Web have not migrated | 90d |
| `GET /api/provider/notification-preferences` | ALIAS_TEMPORARILY | `settings.notificationPreferences.get` | Customer Mobile, Customer Web, Provider Mobile, Provider Web have not migrated | 90d |
| `PUT /api/provider/notification-preferences` | ALIAS_TEMPORARILY | `settings.notificationPreferences.put` | Customer Mobile, Customer Web, Provider Mobile, Provider Web have not migrated | 90d |
| `DELETE /api/provider/notifications/:key` | CANONICALIZE | `notifications.dismiss` | Customer Mobile, Customer Web, Provider Mobile have not migrated; marked CANONICALIZE — this path is still the canonical one for its callers | 90d |
| `GET /api/provider/payouts` | ALIAS_TEMPORARILY | `provider.earnings.payouts` | Provider Mobile has not migrated | 90d |
| `GET /api/provider/profile` | ALIAS_TEMPORARILY | `provider.profile.get` | Provider Mobile, Admin Web have not migrated | 90d |
| `POST /api/provider/public-profile-revisions` | ALIAS_TEMPORARILY | `provider.profile.patch` | Provider Mobile has not migrated | 90d |
| `GET /api/providers/:providerUid/rating` | ALIAS_TEMPORARILY | `reviews.provider.rating` | Customer Mobile, Customer Web have not migrated | 90d |
| `GET /api/providers/:providerUid/reviews` | ALIAS_TEMPORARILY | `reviews.provider.list` | Customer Mobile, Customer Web have not migrated | 90d |
| `GET /api/services/:serviceId/level2` | CANONICALIZE | `catalog.categories.subcategories` | Customer Mobile, Customer Web have not migrated; marked CANONICALIZE — this path is still the canonical one for its callers | 90d |
| `GET /api/services/:serviceId/options-with-addons` | CANONICALIZE | `catalog.subcategories.services` | Customer Mobile, Customer Web, Provider Mobile have not migrated; marked CANONICALIZE — this path is still the canonical one for its callers | 90d |
| `GET /api/services/full` | CANONICALIZE | `catalog.browse` | Customer Mobile, Customer Web have not migrated; marked CANONICALIZE — this path is still the canonical one for its callers | 90d |
| `GET /api/services/full` | CANONICALIZE | `search.query` | Customer Mobile, Customer Web have not migrated; marked CANONICALIZE — this path is still the canonical one for its callers | 90d |
| `POST /api/user/adduseraddress` | ALIAS_TEMPORARILY | `customer.addresses.create` | Customer Mobile, Customer Web have not migrated | 90d |
| `POST /api/user/adduseraddress` | ALIAS_TEMPORARILY | `customer.addresses.update` | Customer Mobile, Customer Web have not migrated | 90d |
| `GET /api/user/alluseraddresses` | ALIAS_TEMPORARILY | `customer.addresses.list` | Customer Mobile, Customer Web have not migrated | 90d |
| `DELETE /api/user/deleteaddress` | ALIAS_TEMPORARILY | `customer.addresses.delete` | Customer Mobile, Customer Web have not migrated | 90d |
| `POST /api/user/fcm-token` | ALIAS_TEMPORARILY | `me.devices.register` | Customer Mobile, Customer Web have not migrated; Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 90d |
| `DELETE /api/user/fcm-token` | ALIAS_TEMPORARILY | `me.devices.release` | Customer Mobile, Customer Web have not migrated; Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 90d |
| `PUT /api/user/makeaddressprimary` | ALIAS_TEMPORARILY | `customer.addresses.setDefault` | Customer Mobile, Customer Web have not migrated | 90d |
| `GET /api/user/notifications` | ALIAS_TEMPORARILY | `notifications.list` | Customer Mobile, Customer Web, Provider Mobile, Admin Web have not migrated | 90d |
| `PATCH /api/user/notifications/:key/read` | ALIAS_TEMPORARILY | `notifications.markRead` | Customer Mobile, Customer Web, Provider Mobile, Admin Web have not migrated | 90d |
| `POST /api/user/notifications/mark-all-read` | ALIAS_TEMPORARILY | `notifications.markAllRead` | Customer Mobile, Customer Web, Provider Mobile, Admin Web have not migrated | 90d |
| `GET /api/user/notifications/unread-count` | ALIAS_TEMPORARILY | `notifications.unreadCount` | Customer Mobile, Customer Web, Provider Mobile, Admin Web have not migrated | 90d |
| `GET /api/user/profile` | ALIAS_TEMPORARILY | `customer.profile.get` | Customer Mobile, Customer Web, Admin Web have not migrated | 90d |
| `PUT /api/user/updateprofile` | ALIAS_TEMPORARILY | `me.patch` | Customer Mobile, Customer Web, Provider Mobile, Provider Web, Admin Web have not migrated | 90d |
| `PUT /api/user/updateprofile` | ALIAS_TEMPORARILY | `customer.profile.patch` | Customer Mobile, Customer Web, Admin Web have not migrated | 90d |
| `GET /api/users/:userId/bookings` | ALIAS_TEMPORARILY | `bookings.listMine` | Customer Mobile, Customer Web have not migrated | 90d |
| `GET /api/worker/availability` | ALIAS_TEMPORARILY | `provider.availability.get` | Provider Mobile, Provider Web have not migrated | 90d |
| `PUT /api/worker/availability` | ALIAS_TEMPORARILY | `provider.availability.patch` | Provider Mobile, Provider Web have not migrated | 90d |
| `PUT /api/worker/bookings/:bookingId/accept` | ALIAS_TEMPORARILY | `provider.jobs.accept` | Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 14d |
| `PUT /api/worker/bookings/:bookingId/arrived` | ALIAS_TEMPORARILY | `provider.jobs.arrived` | Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 14d |
| `PUT /api/worker/bookings/:bookingId/complete` | ALIAS_TEMPORARILY | `provider.jobs.complete` | Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 14d |
| `PUT /api/worker/bookings/:bookingId/decline` | ALIAS_TEMPORARILY | `provider.jobs.decline` | Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 14d |
| `PUT /api/worker/bookings/:bookingId/en-route` | ALIAS_TEMPORARILY | `provider.jobs.enroute` | Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 14d |
| `PUT /api/worker/bookings/:bookingId/start` | ALIAS_TEMPORARILY | `provider.jobs.start` | Provider Web has not migrated; Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 14d |
| `GET /api/worker/job-cards` | ALIAS_TEMPORARILY | `provider.jobs.list` | Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 14d |
| `GET /api/worker/job-cards/:bookingId` | ALIAS_TEMPORARILY | `provider.jobs.get` | Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 14d |
| `GET /api/worker/services-overview` | ALIAS_TEMPORARILY | `provider.services.list` | Provider Web has not migrated; Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 14d |
| `GET /api/worker/time-off` | ALIAS_TEMPORARILY | `provider.timeOff.list` | Provider Web has not migrated; Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 14d |
| `POST /api/worker/time-off` | ALIAS_TEMPORARILY | `provider.timeOff.create` | Provider Web has not migrated; Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 14d |
| `DELETE /api/worker/time-off/:id` | ALIAS_TEMPORARILY | `provider.timeOff.cancel` | Provider Web has not migrated; Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 14d |
| `GET /api/workers/:uid/earnings-history` | RETIRE | `provider.earnings.transactions` | Provider Mobile has not migrated | 90d |
| `GET /api/workers/:uid/notification-preferences` | ALIAS_TEMPORARILY | `settings.notificationPreferences.get` | Customer Mobile, Customer Web, Provider Mobile, Provider Web have not migrated | 90d |
| `PUT /api/workers/:uid/notification-preferences` | ALIAS_TEMPORARILY | `settings.notificationPreferences.put` | Customer Mobile, Customer Web, Provider Mobile, Provider Web have not migrated | 90d |
| `GET /api/workers/:workerId/job-cards` | ALIAS_TEMPORARILY | `provider.jobs.list` | Provider Mobile has migrated in code but not shipped, so nothing yet proves the legacy path is unused in the field | 14d |

## 4. The paths the command names

**`GET /api/services/full`** → `catalog.browse`

The legacy LEVEL-2/LEVEL-3 projection the customer app reads today. Cannot be retired until ServanaClient migrates: it is the only catalog either Flutter app has ever consumed.

**`GET /api/services/full`** → `search.query`

Not a search endpoint — it is the whole legacy catalog, which ServanaClient downloads and searches ON THE DEVICE. That is why one absent `level2` key emptied the search cache and every query rendered "No services match your search". Retiring it needs the client to move to this route AND to /api/v1/catalog.

## 5. The next safe step

Deploy the v1 namespace, then migrate Admin Web first — it is the cheapest to
correct and the only surface whose entire capability set is already
role-specific, so a mistake there cannot reach a customer. Provider Web second,
for the same deploy shape and a live installed base that a revert reaches
immediately.

Neither retires anything. Retirement waits on the telemetry window, and the
window cannot start until traffic exists to be counted.
