/**
 * THE domain event registry — one declaration, four consumers, no database.
 *
 *   1. `eventOutbox.ts` PUBLISHES against it (an undeclared event is a throw).
 *   2. `notificationProjector.ts` PROJECTS from it — the only thing that turns
 *      an event into notifications.
 *   3. `scripts/generate-notification-docs.ts` EXECUTES it to write
 *      `DOMAIN_EVENT_REGISTRY.md` and `NOTIFICATIONS_V1_CONTRACT.md`.
 *   4. `tests/notification-*.test.ts` ASSERT against it.
 *
 * Same arrangement as `financePolicy`, `experiencePolicy` and
 * `messagingPolicy`, and for the same reason: a rule written down in a document
 * and again in a service is two rules that agree until one of them is edited.
 *
 * ## Why this exists at all
 *
 * Before this, thirty-two call sites across thirteen modules each hand-wrote a
 * title, a body, a severity, a route and (sometimes) an idempotency key, then
 * called `createNotification` directly. Nothing connected the notification a
 * provider received to the notification the customer received about the SAME
 * fact, so the two could disagree, one could be added without the other, and no
 * document could state what the platform reacts to.
 *
 * An event is the fact. A notification is one projection of it. Declaring the
 * fact once and deriving every projection is what makes "Admin, customer and
 * provider react to the same source event" checkable rather than aspirational.
 *
 * ## The migration this declaration is shaped by
 *
 * Every legacy call site that already produces a notification is KEPT, and the
 * projection here reuses its EXACT notification key and payload. The owner-scoped
 * unique index on `(owner_uid, notification_key)` then collapses the pair into
 * exactly one row, whichever producer wins the race. That is what lets the
 * event layer become the producer without a flag day, and it is asserted by
 * `tests/notification-dedup.test.ts` rather than assumed.
 *
 * Nothing here imports anything. Every decision function is pure, so the
 * generated registry is evidence rather than description.
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

/** Who a notification is FOR. Not a role claim — a seat on the source fact. */
export type RecipientSeat = 'customer' | 'provider' | 'admin';

export const RECIPIENT_SEATS: readonly RecipientSeat[] = Object.freeze([
  'customer',
  'provider',
  'admin',
]);

// ─── Canonical entity references (§94) ────────────────────────────────────────

/**
 * The identifiers an event payload may carry, and the ONLY ones.
 *
 * Canonical ids, never a screen name and never a legacy Level-3 identifier.
 * `serviceId` is `services.id` — the Catalog V2 canonical specific-service
 * identity. `service_families` is legacy coarse provenance and is deliberately
 * NOT in this list: putting it in an event payload is how it would quietly
 * become the bookable identity again.
 */
export const ENTITY_REFS = {
  bookingId: 'bookings.id',
  serviceId: 'services.id (Catalog V2 canonical specific service)',
  conversationId: 'chat_conversations.id',
  messageId: 'chat_messages.id',
  reviewId: 'customer_reviews.id',
  applicationId: 'service_applications.id',
  paymentId: 'payments.id',
  providerUid: 'user_credentials.uid (provider)',
  customerUid: 'user_credentials.uid (customer)',
} as const;

export type EntityRef = keyof typeof ENTITY_REFS;

export const ENTITY_REF_NAMES = Object.freeze(Object.keys(ENTITY_REFS)) as readonly EntityRef[];

/**
 * Identifiers that must NEVER appear in an event payload or a deep link.
 *
 * `serviceFamilyId` because Catalog V2 is certified and the family is legacy
 * provenance; the rest because a screen name is not an identity — it is a
 * client's current implementation detail, and an event that carries one breaks
 * the moment a client renames a route.
 */
export const FORBIDDEN_REFS: readonly string[] = Object.freeze([
  'serviceFamilyId',
  'service_family_id',
  'screenName',
  'routeName',
  'level3Id',
  'serviceOptionId',
]);

// ─── Channels and categories ──────────────────────────────────────────────────

export type NotificationChannel = 'inApp' | 'push' | 'email' | 'sms';

export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = Object.freeze([
  'inApp',
  'push',
  'email',
  'sms',
]);

/**
 * Preference categories.
 *
 * These names are NOT new. They are exactly the columns of
 * `provider_notification_preferences`, which is keyed on a uid and has no role
 * column — so the same table, the same defaults and the same nine categories
 * already serve any account. What was missing was a customer ever consulting
 * them: `sendFcmPushToCustomer` had no preference check at all, so a customer
 * who turned promotions off still received them.
 *
 * Reusing the existing names rather than minting a cleaner set is deliberate.
 * A rename would orphan every stored row and every provider's saved choices.
 */
export const NOTIFICATION_CATEGORIES = {
  jobAssigned: {
    label: 'Job and booking activity',
    description: 'Assignment, acceptance, arrival, start, completion, cancellation.',
    defaultOn: true,
  },
  jobReminder: {
    label: 'Reminders',
    description: 'Upcoming job reminders.',
    defaultOn: false,
  },
  paymentReceived: {
    label: 'Payments, earnings and payouts',
    description: 'Payment confirmed, refund issued, payout released.',
    defaultOn: true,
  },
  newMessage: {
    label: 'Messages',
    description: 'A new message in a booking conversation.',
    defaultOn: true,
  },
  promotions: {
    label: 'Promotions',
    description: 'Marketing. Off by default and never overridable.',
    defaultOn: false,
  },
  requirementReview: {
    label: 'Applications and verification',
    description: 'Service application decisions, document review, moderation.',
    defaultOn: true,
  },
  support: {
    label: 'Support and safety',
    description: 'Support case activity and safety notices.',
    defaultOn: true,
  },
  accountSecurity: {
    label: 'Account and security',
    description: 'Sign-in alerts, credential changes, account state.',
    defaultOn: true,
  },
  system: {
    label: 'System',
    description: 'Maintenance and platform notices.',
    defaultOn: true,
  },
} as const;

export type NotificationCategory = keyof typeof NOTIFICATION_CATEGORIES;

export const NOTIFICATION_CATEGORY_NAMES = Object.freeze(
  Object.keys(NOTIFICATION_CATEGORIES),
) as readonly NotificationCategory[];

/**
 * When a preference may be OVERRIDDEN, and on which channel (§96).
 *
 * The rule, stated rather than assumed: a preference governs whether we
 * INTERRUPT somebody. It does not govern whether a fact is recorded.
 *
 *   - `inApp` is the RECORD. It is never suppressed by a preference, for any
 *     category. A person who turned push off has not asked to be lied to about
 *     what happened on their booking, and an inbox with holes in it is one
 *     nobody can reconcile — the unread count would drift against the events
 *     that produced it.
 *   - `push` is the INTERRUPTION. It obeys the preference, with two exceptions
 *     below.
 *   - `email`/`sms` are declared for completeness. Nothing in this tab routes
 *     to them; the existing `send()` template path is untouched.
 *
 * The two overridable categories are `accountSecurity` and `support`. A person
 * cannot opt out of being told their password changed or that a safety case
 * needs them — that is the standard transactional-security carve-out, and
 * `promotions` is explicitly excluded from it so the carve-out can never be
 * used to deliver marketing.
 */
export const CHANNEL_POLICY = {
  inApp: {
    obeysPreference: false,
    reason:
      'The in-app inbox is the RECORD, not an interruption. Suppressing it would put holes ' +
      'in the audit trail and make the unread count irreconcilable with the events that ' +
      'produced it.',
  },
  push: {
    obeysPreference: true,
    reason: 'Push is the interruption. It is what a preference is actually about.',
  },
  email: {
    obeysPreference: true,
    reason: 'Declared for completeness. This tab routes nothing to it.',
  },
  sms: {
    obeysPreference: true,
    reason: 'Declared for completeness. This tab routes nothing to it.',
  },
} as const;

/**
 * Categories a transactional/security notification may deliver on despite a
 * disabled preference. Deliberately short, and deliberately without
 * `promotions`.
 */
export const PREFERENCE_OVERRIDE_CATEGORIES: readonly NotificationCategory[] = Object.freeze([
  'accountSecurity',
  'support',
]);

export interface DeliveryDecision {
  deliver: boolean;
  /** Present when delivered against a disabled preference. */
  overridden: boolean;
  reason: string;
}

/**
 * May this notification go out on this channel? The ONE answer.
 *
 * `preferences` is the account's saved map. A missing entry means the category
 * default applies, which is what an account that has never opened the settings
 * screen has.
 */
export const mayDeliver = (
  category: NotificationCategory,
  channel: NotificationChannel,
  preferences: Partial<Record<NotificationCategory, boolean>> = {},
): DeliveryDecision => {
  const spec = NOTIFICATION_CATEGORIES[category];
  if (!spec) {
    // An unknown category fails CLOSED for interruptions and open for the
    // record: we still write down what happened, we just do not buzz a phone
    // about a category nobody declared.
    return channel === 'inApp'
      ? { deliver: true, overridden: false, reason: 'Unknown category; the record is still kept.' }
      : { deliver: false, overridden: false, reason: 'Unknown category; no interruption sent.' };
  }

  const policy = CHANNEL_POLICY[channel];
  if (!policy.obeysPreference) {
    return { deliver: true, overridden: false, reason: policy.reason };
  }

  const enabled = preferences[category] ?? spec.defaultOn;
  if (enabled) {
    return { deliver: true, overridden: false, reason: 'The account allows this category.' };
  }
  if (PREFERENCE_OVERRIDE_CATEGORIES.includes(category)) {
    return {
      deliver: true,
      overridden: true,
      reason:
        'Transactional/security category. A person cannot opt out of being told their account ' +
        'or a safety case needs them.',
    };
  }
  return { deliver: false, overridden: false, reason: 'The account turned this category off.' };
};

// ─── Deep links (§94, §97) ────────────────────────────────────────────────────

/**
 * THE deep-link contract, shared by Customer and Provider clients.
 *
 * One target per destination, each keyed on a CANONICAL id. The two client
 * vocabularies are projections of it, not separate truths:
 *
 *   customer clients read `{ routeKey, resourceId }`
 *   provider clients read `{ page | screen, bookingId | caseId | applicationId }`
 *
 * Both already exist in shipped builds and neither can be changed by this
 * backend, so the target is declared once and rendered into both. A client that
 * migrates later reads `target` + the canonical ids and stops parsing either.
 *
 * ## Authorization happens AFTER navigation
 *
 * `requiresAccessCheck` is true for every target that names a resource. The
 * notification is a POINTER, not a grant: tapping it navigates, and the screen
 * then calls the canonical endpoint, which authorizes. A deep link that carried
 * its own authority would be a capability URL sitting in a notification tray.
 */
export interface DeepLinkTargetSpec {
  /** The canonical id this target needs. */
  ref: EntityRef | null;
  description: string;
  /** Authorization is re-checked by the endpoint the screen calls. Always true
   *  for a target that names a resource. */
  requiresAccessCheck: boolean;
  /** Customer client projection. `{id}` is substituted. */
  customer: Record<string, string> | null;
  /** Provider client projection. `{id}` is substituted. */
  provider: Record<string, string> | null;
}

export const DEEP_LINK_TARGETS = {
  BOOKING_DETAIL: {
    ref: 'bookingId',
    description: "The booking's detail screen.",
    requiresAccessCheck: true,
    customer: { routeKey: 'BOOKING_DETAILS', resourceId: '{id}' },
    provider: { page: 'jobs', bookingId: '{id}' },
  },
  JOB_DETAIL: {
    ref: 'bookingId',
    description: "The provider's job screen for a booking.",
    requiresAccessCheck: true,
    customer: null,
    provider: { page: 'jobs', bookingId: '{id}' },
  },
  CONVERSATION: {
    ref: 'conversationId',
    description: 'A booking conversation.',
    requiresAccessCheck: true,
    // Provider deliberately gets the messages TAB and not the booking id.
    // ServanaWorker's route resolver prefers a booking id and would open
    // JobDetailsView, which has no chat entry point (PM-257) — so a tap would
    // land on a screen with no way to reach the message it announced.
    customer: { routeKey: 'CONVERSATION', resourceId: '{id}' },
    provider: { page: 'messages' },
  },
  EARNINGS: {
    ref: 'bookingId',
    description: "The provider's earnings, in the context of one booking.",
    requiresAccessCheck: true,
    customer: null,
    provider: { page: 'earnings', bookingId: '{id}' },
  },
  APPLICATION: {
    ref: 'applicationId',
    description: 'A provider service application.',
    requiresAccessCheck: true,
    customer: null,
    provider: { screen: 'ServiceApplication', applicationId: '{id}' },
  },
  REVIEW: {
    ref: 'reviewId',
    description: "The provider's reputation screen.",
    requiresAccessCheck: true,
    customer: null,
    provider: { page: 'reputation' },
  },
  NOTIFICATIONS: {
    ref: null,
    description: 'The inbox itself. Used when there is nothing more specific.',
    requiresAccessCheck: false,
    customer: { routeKey: 'NOTIFICATIONS' },
    provider: { page: 'notifications' },
  },
} as const satisfies Record<string, DeepLinkTargetSpec>;

export type DeepLinkTarget = keyof typeof DEEP_LINK_TARGETS;

export const DEEP_LINK_TARGET_NAMES = Object.freeze(
  Object.keys(DEEP_LINK_TARGETS),
) as readonly DeepLinkTarget[];

/**
 * Render a target into the vocabulary ONE client speaks, plus the canonical
 * fields every client can migrate to.
 *
 * Returns null when the target has no projection for that seat — an admin has
 * no mobile deep link, and a customer has no earnings screen. Null is a real
 * answer: the notification is still recorded, it simply is not tappable there.
 */
export const deepLinkFor = (
  target: DeepLinkTarget,
  seat: RecipientSeat,
  ids: Partial<Record<EntityRef, string | number>> = {},
): Record<string, unknown> | null => {
  const spec = DEEP_LINK_TARGETS[target] as DeepLinkTargetSpec | undefined;
  if (!spec) return null;

  const projection = seat === 'customer' ? spec.customer : seat === 'provider' ? spec.provider : null;
  if (!projection) return null;

  const id = spec.ref ? ids[spec.ref] : undefined;
  // A target that NEEDS an id and was not given one would render `{id}`
  // literally into a route. Refusing is the only safe answer: a deep link to
  // "{id}" is worse than no deep link, because the client opens a screen and
  // then fails to load it.
  if (spec.ref && (id === undefined || id === null || String(id) === '')) return null;

  const rendered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(projection)) {
    rendered[key] = value.replace('{id}', String(id ?? ''));
  }

  // The canonical half, additive. Shipped clients ignore it; a migrating client
  // reads only this and stops parsing the two legacy vocabularies.
  rendered.target = target;
  if (spec.requiresAccessCheck) rendered.requiresAccessCheck = true;
  return rendered;
};

// ─── The events ───────────────────────────────────────────────────────────────

export interface RecipientProjection {
  seat: RecipientSeat;
  /** How the recipient's uid is found. Documentation AND the projector's rule. */
  resolvedFrom: string;
  /** null when this seat observes the event and receives no notification. */
  notification: {
    /** The stored `type`. These are the EXISTING type strings, preserved. */
    type: string;
    category: NotificationCategory;
    severity: 'info' | 'warning' | 'critical' | 'success' | 'high';
    title: string;
    /** `{placeholder}` is substituted from the event's display data. */
    body: string;
    /** A short, safe label. Usually the booking code. */
    contextLabel: string | null;
    deepLink: DeepLinkTarget;
    /**
     * The idempotency key template. `{placeholder}` is substituted from the
     * event's ids.
     *
     * Where a legacy call site already produces this notification, the template
     * reproduces its key EXACTLY. The owner-scoped unique index then collapses
     * the two producers into one row, which is what makes the migration safe
     * without a flag day.
     */
    keyTemplate: string;
    /** The legacy producer this replaces, or null when the event is additive. */
    supersedes: string | null;
  } | null;
}

export interface DomainEventSpec {
  name: string;
  version: number;
  description: string;
  /** Canonical ids the payload MUST carry. Enforced at publish time. */
  requiredRefs: readonly EntityRef[];
  /** Ids the payload MAY carry. */
  optionalRefs: readonly EntityRef[];
  /** Where it is published from, and whether that is a transaction boundary. */
  publishedBy: string;
  transactional: boolean;
  recipients: readonly RecipientProjection[];
}

/**
 * The eleven canonical events named by the command (§91).
 *
 * Every one is a FACT that already happens in the platform. Nothing here
 * invents a new business moment; the events name moments the code already
 * reaches and that, until now, each notified in their own way.
 */
export const DOMAIN_EVENTS = {
  BookingCreated: {
    name: 'BookingCreated',
    version: 1,
    description: 'A customer placed a booking. No provider is assigned yet.',
    requiredRefs: ['bookingId', 'customerUid'],
    optionalRefs: ['serviceId'],
    publishedBy: 'controllers/bookingController.createBooking',
    transactional: false,
    recipients: [
      {
        seat: 'customer',
        resolvedFrom: 'event.refs.customerUid',
        notification: {
          type: 'booking_created',
          category: 'jobAssigned',
          severity: 'info',
          title: 'Booking received',
          body: "Your booking has been placed. We'll notify you when a provider is assigned.",
          contextLabel: '{bookingCode}',
          deepLink: 'BOOKING_DETAIL',
          keyTemplate: 'booking_created_{bookingId}',
          supersedes: 'bookingController.createBooking (keyless — a retry produced a SECOND row)',
        },
      },
      { seat: 'admin', resolvedFrom: 'admin fan-out', notification: null },
    ],
  },

  BookingAssigned: {
    name: 'BookingAssigned',
    version: 1,
    description: 'A provider was assigned to a booking, by an admin or by matching.',
    requiredRefs: ['bookingId', 'providerUid'],
    optionalRefs: ['customerUid', 'serviceId'],
    publishedBy: 'services/booking/transitionExecutor (ADMIN_ASSIGN, AUTO_ASSIGN)',
    transactional: true,
    recipients: [
      {
        seat: 'provider',
        resolvedFrom: 'event.refs.providerUid',
        notification: {
          type: 'assigned_job',
          category: 'jobAssigned',
          severity: 'high',
          title: 'New Job Assigned',
          body: 'You have a new job for booking {bookingCode}. Open Jobs to accept it.',
          contextLabel: '{bookingCode}',
          deepLink: 'JOB_DETAIL',
          keyTemplate: 'assigned_job_{bookingId}_{providerUid}',
          supersedes: 'technicianService + adminBookingService (identical key)',
        },
      },
      {
        seat: 'customer',
        resolvedFrom: 'bookings.user_id',
        notification: {
          type: 'provider_assigned',
          category: 'jobAssigned',
          severity: 'info',
          title: 'Provider assigned',
          body: 'A provider has been assigned to booking {bookingCode}.',
          contextLabel: '{bookingCode}',
          deepLink: 'BOOKING_DETAIL',
          keyTemplate: 'provider_assigned_{bookingId}',
          supersedes: 'technicianService + adminBookingService (identical key)',
        },
      },
    ],
  },

  ProviderAccepted: {
    name: 'ProviderAccepted',
    version: 1,
    description: 'The assigned provider accepted the job.',
    requiredRefs: ['bookingId', 'providerUid'],
    optionalRefs: ['customerUid', 'conversationId'],
    publishedBy: 'services/booking/transitionExecutor (PROVIDER_ACCEPT)',
    transactional: true,
    recipients: [
      {
        seat: 'customer',
        resolvedFrom: 'bookings.user_id',
        notification: {
          type: 'booking_accepted',
          category: 'jobAssigned',
          severity: 'info',
          title: 'Provider confirmed',
          body: 'Your provider confirmed booking {bookingCode}.',
          contextLabel: '{bookingCode}',
          deepLink: 'BOOKING_DETAIL',
          keyTemplate: 'booking_accepted_{bookingId}',
          supersedes: 'technicianService.acceptJob (identical key)',
        },
      },
      { seat: 'provider', resolvedFrom: 'event.refs.providerUid', notification: null },
    ],
  },

  JobStarted: {
    name: 'JobStarted',
    version: 1,
    description: 'The provider verified the worker code and started the job.',
    requiredRefs: ['bookingId', 'providerUid'],
    optionalRefs: ['customerUid'],
    publishedBy: 'services/booking/transitionExecutor (PROVIDER_START)',
    transactional: true,
    recipients: [
      {
        seat: 'customer',
        resolvedFrom: 'bookings.user_id',
        notification: {
          type: 'job_started',
          category: 'jobAssigned',
          severity: 'info',
          title: 'Work started',
          body: 'Your provider has started work on booking {bookingCode}.',
          contextLabel: '{bookingCode}',
          deepLink: 'BOOKING_DETAIL',
          keyTemplate: 'job_started_{bookingId}',
          supersedes: null,
        },
      },
    ],
  },

  JobCompleted: {
    name: 'JobCompleted',
    version: 1,
    description: 'The provider marked the job complete.',
    requiredRefs: ['bookingId', 'providerUid'],
    optionalRefs: ['customerUid'],
    publishedBy: 'services/booking/transitionExecutor (PROVIDER_COMPLETE)',
    transactional: true,
    recipients: [
      {
        seat: 'customer',
        resolvedFrom: 'bookings.user_id',
        notification: {
          type: 'job_completed',
          category: 'jobAssigned',
          severity: 'info',
          title: 'Job completed',
          body: 'Booking {bookingCode} is complete. You can leave a review from the booking.',
          contextLabel: '{bookingCode}',
          deepLink: 'BOOKING_DETAIL',
          keyTemplate: 'job_completed_{bookingId}',
          supersedes: null,
        },
      },
      {
        seat: 'provider',
        resolvedFrom: 'event.refs.providerUid',
        notification: {
          type: 'job_completed',
          category: 'jobAssigned',
          severity: 'info',
          title: 'Job completed',
          body: 'Booking {bookingCode} is marked complete. Earnings follow the payout window.',
          contextLabel: '{bookingCode}',
          deepLink: 'EARNINGS',
          keyTemplate: 'job_completed_provider_{bookingId}',
          supersedes: null,
        },
      },
    ],
  },

  BookingCancelled: {
    name: 'BookingCancelled',
    version: 1,
    description: 'The booking was cancelled, by whichever party the metadata names.',
    requiredRefs: ['bookingId'],
    optionalRefs: ['providerUid', 'customerUid'],
    publishedBy:
      'services/booking/transitionExecutor (CUSTOMER_CANCEL, PROVIDER_CANCEL, ADMIN_CANCEL)',
    transactional: true,
    recipients: [
      {
        seat: 'customer',
        resolvedFrom: 'bookings.user_id',
        notification: {
          type: 'booking_cancelled',
          category: 'jobAssigned',
          severity: 'warning',
          title: 'Booking cancelled',
          body: 'Booking {bookingCode} was cancelled.',
          contextLabel: '{bookingCode}',
          deepLink: 'BOOKING_DETAIL',
          keyTemplate: 'booking_cancelled_{bookingId}',
          supersedes: null,
        },
      },
      {
        seat: 'provider',
        resolvedFrom: 'the assignment at the moment of cancellation',
        notification: {
          type: 'booking_cancelled',
          category: 'jobAssigned',
          severity: 'warning',
          title: 'Job cancelled',
          body: 'Booking {bookingCode} was cancelled and is no longer on your schedule.',
          contextLabel: '{bookingCode}',
          deepLink: 'JOB_DETAIL',
          keyTemplate: 'booking_cancelled_provider_{bookingId}',
          supersedes: null,
        },
      },
    ],
  },

  BookingRescheduled: {
    name: 'BookingRescheduled',
    version: 1,
    description: 'The booking moved to a new scheduled time.',
    requiredRefs: ['bookingId'],
    optionalRefs: ['providerUid', 'customerUid'],
    publishedBy: 'services/booking/bookingRescheduleService',
    transactional: false,
    recipients: [
      {
        seat: 'customer',
        resolvedFrom: 'bookings.user_id',
        notification: {
          type: 'booking_rescheduled',
          category: 'jobAssigned',
          severity: 'info',
          title: 'Booking rescheduled',
          body: 'Booking {bookingCode} has a new schedule. Open it to see the time.',
          contextLabel: '{bookingCode}',
          deepLink: 'BOOKING_DETAIL',
          keyTemplate: 'booking_rescheduled_{bookingId}_{occurredAt}',
          supersedes: null,
        },
      },
      {
        seat: 'provider',
        resolvedFrom: 'the current assignment',
        notification: {
          type: 'booking_rescheduled',
          category: 'jobAssigned',
          severity: 'high',
          title: 'Job rescheduled',
          body: 'Booking {bookingCode} moved to a new time. Check your schedule.',
          contextLabel: '{bookingCode}',
          deepLink: 'JOB_DETAIL',
          keyTemplate: 'booking_rescheduled_provider_{bookingId}_{occurredAt}',
          supersedes: null,
        },
      },
    ],
  },

  MessageReceived: {
    name: 'MessageReceived',
    version: 1,
    description: 'A message was persisted in a booking conversation.',
    requiredRefs: ['conversationId', 'messageId', 'bookingId'],
    optionalRefs: ['providerUid', 'customerUid'],
    publishedBy: 'chat/chat.service.sendMessage',
    transactional: false,
    recipients: [
      {
        seat: 'customer',
        resolvedFrom: 'the conversation participants, minus the sender and anyone departed',
        notification: {
          type: 'new_message',
          category: 'newMessage',
          severity: 'info',
          title: 'New message',
          body: 'You have a new message about booking {bookingCode}.',
          contextLabel: '{bookingCode}',
          deepLink: 'CONVERSATION',
          keyTemplate: 'chat_msg:{messageId}',
          supersedes: 'chat.service.notifyMessageRecipients (identical key)',
        },
      },
      {
        seat: 'provider',
        resolvedFrom: 'the conversation participants, minus the sender and anyone departed',
        notification: {
          type: 'new_message',
          category: 'newMessage',
          severity: 'info',
          title: 'New message',
          body: 'You have a new message about booking {bookingCode}.',
          contextLabel: '{bookingCode}',
          deepLink: 'CONVERSATION',
          keyTemplate: 'chat_msg:{messageId}',
          supersedes: 'chat.service.notifyMessageRecipients (identical key)',
        },
      },
    ],
  },

  ProviderApplicationUpdated: {
    name: 'ProviderApplicationUpdated',
    version: 1,
    description: "A provider's service application changed decision state.",
    requiredRefs: ['applicationId', 'providerUid'],
    optionalRefs: ['serviceId'],
    publishedBy: 'services/serviceApplicationService',
    transactional: false,
    recipients: [
      {
        seat: 'provider',
        resolvedFrom: 'event.refs.providerUid',
        notification: {
          type: 'service_application',
          category: 'requirementReview',
          severity: 'info',
          title: 'Application updated',
          body: 'Your service application has an update. Open it to see the decision.',
          contextLabel: 'Service application',
          deepLink: 'APPLICATION',
          keyTemplate: 'svc_app_event_{applicationId}_{occurredAt}',
          supersedes:
            'serviceApplicationService (five keyed producers, kept — they carry the specific decision)',
        },
      },
    ],
  },

  PaymentUpdated: {
    name: 'PaymentUpdated',
    version: 1,
    description: 'A booking payment reached a settled state: captured or refunded.',
    requiredRefs: ['bookingId'],
    optionalRefs: ['paymentId', 'providerUid', 'customerUid'],
    publishedBy: 'services/paymentService (capture, cash, refund)',
    transactional: false,
    recipients: [
      {
        seat: 'provider',
        resolvedFrom: 'the assignment on the booking',
        notification: {
          type: 'earnings_payout',
          category: 'paymentReceived',
          severity: 'info',
          title: 'Payment Received',
          body:
            'Payment for booking {bookingCode} has been confirmed. Your earnings will be ' +
            'reflected in your ledger.',
          contextLabel: '{bookingCode}',
          deepLink: 'EARNINGS',
          keyTemplate: 'payment_confirmed_{bookingId}',
          supersedes: 'paymentService.approvePayment / markCashPaid (keyless — a retry produced a SECOND row)',
        },
      },
      {
        seat: 'customer',
        resolvedFrom: 'bookings.user_id',
        notification: {
          type: 'payment_updated',
          category: 'paymentReceived',
          severity: 'info',
          title: 'Payment updated',
          body: 'The payment for booking {bookingCode} has been updated.',
          contextLabel: '{bookingCode}',
          deepLink: 'BOOKING_DETAIL',
          keyTemplate: 'payment_updated_{bookingId}_{occurredAt}',
          supersedes: null,
        },
      },
    ],
  },

  ReviewCreated: {
    name: 'ReviewCreated',
    version: 1,
    description: 'A customer published a review of a completed booking.',
    requiredRefs: ['reviewId', 'providerUid'],
    optionalRefs: ['bookingId', 'customerUid'],
    publishedBy: 'services/customerReviewService',
    transactional: false,
    recipients: [
      {
        seat: 'provider',
        resolvedFrom: 'event.refs.providerUid',
        notification: {
          type: 'review_received',
          category: 'requirementReview',
          severity: 'info',
          title: 'New review',
          body: 'A customer left a review for your work.',
          contextLabel: 'Reputation',
          deepLink: 'REVIEW',
          keyTemplate: 'review-received:{reviewId}',
          supersedes: 'customerReviewService (identical key)',
        },
      },
    ],
  },
} as const satisfies Record<string, DomainEventSpec>;

export type DomainEventName = keyof typeof DOMAIN_EVENTS;

export const DOMAIN_EVENT_NAMES = Object.freeze(
  Object.keys(DOMAIN_EVENTS),
) as readonly DomainEventName[];

export const isDomainEventName = (value: unknown): value is DomainEventName =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(DOMAIN_EVENTS, value);

// ─── Projection (pure) ────────────────────────────────────────────────────────

export interface DomainEventEnvelope {
  /** The outbox row id, once persisted. Null for an unpersisted event. */
  id: number | null;
  name: DomainEventName;
  version: number;
  refs: Partial<Record<EntityRef, string | number>>;
  /**
   * Safe display substitutions. NEVER a customer name, address, phone or note —
   * a push payload is readable on a lock screen by anyone holding the device.
   * `bookingCode` is the SVN- reference both apps and support already say aloud.
   */
  display: Record<string, string>;
  occurredAt: string;
  /** Free-form, redacted, never rendered into a body. Diagnostics only. */
  metadata?: Record<string, unknown>;
}

export interface NotificationProjection {
  seat: RecipientSeat;
  type: string;
  category: NotificationCategory;
  severity: string;
  title: string;
  body: string;
  contextLabel: string | null;
  notificationKey: string;
  deepLink: DeepLinkTarget;
  route: Record<string, unknown> | null;
  canOpenDetail: boolean;
}

/** `{placeholder}` from refs, then display, then the envelope's own fields. */
const substitute = (
  template: string,
  event: DomainEventEnvelope,
): string =>
  template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    if (key === 'occurredAt') {
      // Milliseconds are the wrong grain for an idempotency key — two publishes
      // of the same fact a millisecond apart are the same fact. Seconds, and
      // only where the template asks for it.
      return String(Math.floor(new Date(event.occurredAt).getTime() / 1000));
    }
    if (event.display[key] !== undefined) return event.display[key];
    const ref = event.refs[key as EntityRef];
    if (ref !== undefined && ref !== null) return String(ref);
    return whole;
  });

/**
 * Every notification ONE event produces, for every seat.
 *
 * Pure: no database, no uid resolution, no side effect. The projector resolves
 * recipients and writes; this decides WHAT would be written, which is what makes
 * the "all three seats react to the same source event" test a comparison of
 * values rather than a comparison of two code paths.
 *
 * A template that still contains an unsubstituted `{placeholder}` is DROPPED
 * rather than delivered: a notification reading "booking {bookingCode}" is worse
 * than none, and its key would be unstable, which would defeat the deduplication
 * this whole design rests on.
 */
export const projectEvent = (event: DomainEventEnvelope): NotificationProjection[] => {
  const spec = DOMAIN_EVENTS[event.name] as DomainEventSpec | undefined;
  if (!spec) return [];

  const out: NotificationProjection[] = [];
  for (const recipient of spec.recipients) {
    if (!recipient.notification) continue;
    const n = recipient.notification;

    const notificationKey = substitute(n.keyTemplate, event);
    if (/\{\w+\}/.test(notificationKey)) continue;

    const body = substitute(n.body, event);
    if (/\{\w+\}/.test(body)) continue;

    const contextLabel = n.contextLabel ? substitute(n.contextLabel, event) : null;
    const route = deepLinkFor(n.deepLink, recipient.seat, event.refs);

    out.push({
      seat: recipient.seat,
      type: n.type,
      category: n.category,
      severity: n.severity,
      title: n.title,
      body,
      contextLabel: contextLabel && /\{\w+\}/.test(contextLabel) ? null : contextLabel,
      notificationKey,
      deepLink: n.deepLink,
      route,
      canOpenDetail: route !== null,
    });
  }
  return out;
};

/** Validation used by the publisher. Kept here so the rule has one home. */
export const missingRequiredRefs = (
  name: DomainEventName,
  refs: Partial<Record<EntityRef, string | number>>,
): EntityRef[] => {
  const spec = DOMAIN_EVENTS[name] as DomainEventSpec | undefined;
  if (!spec) return [];
  return spec.requiredRefs.filter((ref) => {
    const value = refs[ref];
    return value === undefined || value === null || String(value).trim() === '';
  });
};

/** Refs an event may not carry at all. Enforced at publish, not by convention. */
export const forbiddenRefsPresent = (
  refs: Record<string, unknown>,
): string[] => Object.keys(refs).filter((key) => FORBIDDEN_REFS.includes(key));

// ─── Capabilities and the cross-platform caller matrix ────────────────────────

export interface NotificationCapability {
  key: string;
  title: string;
  contractIds: readonly string[];
  domainModule: string;
  surfaces: readonly ClientSurface[];
  roleSplitRationale: string;
}

export const NOTIFICATION_CAPABILITIES: readonly NotificationCapability[] = Object.freeze([
  {
    key: 'inbox',
    title: 'Read my notification inbox',
    contractIds: ['notifications.list'],
    domainModule: 'services/events/notificationInbox',
    surfaces: Object.freeze([
      'customerMobile', 'customerWeb', 'providerMobile', 'providerWeb', 'admin',
    ] as ClientSurface[]),
    roleSplitRationale:
      'No role split, and this is where the split USED to be. The canonical route read the ' +
      'customer table only, so a provider calling it received an empty inbox while their ' +
      'notifications sat in provider_notifications. One inbox service now resolves the owner\'s ' +
      'store from their account and reads it — two physical tables, one logical inbox, one DTO.',
  },
  {
    key: 'unreadCount',
    title: 'How many unread I have',
    contractIds: ['notifications.unreadCount'],
    domainModule: 'services/events/notificationInbox',
    surfaces: Object.freeze([
      'customerMobile', 'customerWeb', 'providerMobile', 'providerWeb', 'admin',
    ] as ClientSurface[]),
    roleSplitRationale:
      'No role split. Counted from the SAME store resolution the list uses, so the badge and ' +
      'the screen cannot disagree about which table they are reading.',
  },
  {
    key: 'markRead',
    title: 'Mark one notification read',
    contractIds: ['notifications.markRead'],
    domainModule: 'services/events/notificationInbox',
    surfaces: Object.freeze([
      'customerMobile', 'customerWeb', 'providerMobile', 'providerWeb', 'admin',
    ] as ClientSurface[]),
    roleSplitRationale:
      'No role split. The key is opaque and owner-scoped: the same key can exist for two ' +
      'accounts and each only ever resolves their own row, because every statement is ' +
      'predicated on the owner uid from the token.',
  },
  {
    key: 'markAllRead',
    title: 'Mark everything read',
    contractIds: ['notifications.markAllRead'],
    domainModule: 'services/events/notificationInbox',
    surfaces: Object.freeze([
      'customerMobile', 'customerWeb', 'providerMobile', 'providerWeb', 'admin',
    ] as ClientSurface[]),
    roleSplitRationale:
      'No role split. The subject is the token; there is no parameter naming whose inbox to ' +
      'clear.',
  },
  {
    key: 'preferences',
    title: 'Read and change my notification preferences',
    contractIds: [
      'me.notificationPreferences.get',
      'me.notificationPreferences.patch',
      'settings.notificationPreferences.get',
      'settings.notificationPreferences.put',
    ],
    domainModule: 'services/events/notificationPreferences',
    surfaces: Object.freeze([
      'customerMobile', 'customerWeb', 'providerMobile', 'providerWeb', 'admin',
    ] as ClientSurface[]),
    roleSplitRationale:
      'No role split, and again this is where one used to be. The preference table is keyed on ' +
      'a uid and has no role column, yet both legacy routes were gated on a provider role — so ' +
      'customers received notifications they had no way to configure, and their push ignored ' +
      'the table entirely. One model, one table, every account.',
  },
  {
    key: 'deviceTokens',
    title: 'Register and release this device for push',
    contractIds: ['me.devices.register', 'me.devices.release'],
    domainModule: 'services/events/deviceTokenService',
    surfaces: Object.freeze([
      'customerMobile', 'customerWeb', 'providerMobile', 'providerWeb',
    ] as ClientSurface[]),
    roleSplitRationale:
      'No role split. Providers had a multi-device token TABLE and customers had a single ' +
      'column, so a customer with two devices could only ever receive push on the last one to ' +
      'sign in. One account-scoped token store for both, with the provider table kept and ' +
      'dual-written until ServanaWorker migrates.',
  },
]);

export const NOTIFICATION_CAPABILITY_KEYS: readonly string[] = Object.freeze(
  NOTIFICATION_CAPABILITIES.map((c) => c.key),
);

// ─── Telemetry ────────────────────────────────────────────────────────────────

export interface EventSignal {
  code: string;
  detects: string;
  why: string;
}

export const EVENT_SIGNALS: readonly EventSignal[] = Object.freeze([
  {
    code: 'EVENT_PUBLISHED',
    detects: 'An event was written to the outbox, by name.',
    why: 'The denominator. A projection rate means nothing without it.',
  },
  {
    code: 'EVENT_PUBLISH_REJECTED',
    detects: 'A publish was refused — unknown name, missing required ref, forbidden ref.',
    why:
      'This is the guard working. A rising rate means a producer is passing the wrong shape, ' +
      'which would otherwise surface as notifications that silently never arrive.',
  },
  {
    code: 'EVENT_DISPATCHED',
    detects: 'An outbox row was projected into notifications and marked done.',
    why: 'Published-minus-dispatched is the backlog, and a backlog is a silent outage.',
  },
  {
    code: 'EVENT_DISPATCH_FAILED',
    detects: 'A dispatch attempt threw. The row stays pending and is retried.',
    why: 'A row that fails forever is a notification nobody will ever receive.',
  },
  {
    code: 'NOTIFICATION_DEDUPED',
    detects: 'A projection resolved to a notification key that already existed.',
    why:
      'The deduplication working. It is EXPECTED while the legacy producers still run beside ' +
      'the projector — and once they are retired, a non-zero rate means genuine redelivery.',
  },
  {
    code: 'PUSH_SUPPRESSED_BY_PREFERENCE',
    detects: 'The record was written and the interruption was withheld, by category.',
    why:
      'Distinguishes "we never told them" from "they asked us not to buzz". Without it, a ' +
      'support report of a missing notification has no way to be answered.',
  },
  {
    code: 'DEVICE_TOKEN_PRUNED',
    detects: 'A token the push provider reported as unregistered was removed.',
    why:
      'Stale tokens accumulate silently and every send retries them. A spike is usually an app ' +
      'uninstall wave or a signing-certificate change.',
  },
]);

export const EVENT_SIGNAL_CODES: readonly string[] = Object.freeze(
  EVENT_SIGNALS.map((s) => s.code),
);
