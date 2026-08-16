/**
 * ONE preference model, for every account (§96).
 *
 * ## What was wrong
 *
 * `provider_notification_preferences` is keyed on a uid and has no role column,
 * so it has always been capable of serving anyone. But both legacy routes onto
 * it are gated on a provider role, and `sendFcmPushToCustomer` never read it at
 * all — so a customer had no way to configure notifications and, if they had,
 * nothing would have consulted the answer. A preference nobody reads is a
 * setting screen that lies to the person using it.
 *
 * ## What this module is, and is not
 *
 * It is the DECISION layer: which categories exist, what the defaults are, and
 * whether a given category may go out on a given channel for a given account.
 * The decision itself lives in `domainEvents.mayDeliver`, which is pure and
 * which the generated contract document renders its table from.
 *
 * It is NOT a second writer. `notification.service.getNotificationPrefs` and
 * `saveNotificationPrefs` remain the only code that touches the table, because
 * two writers to one preference row is how a provider's saved choices get
 * silently overwritten by a customer-shaped default map.
 */

import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_NAMES,
  NOTIFICATION_CHANNELS,
  mayDeliver,
  type DeliveryDecision,
  type NotificationCategory,
  type NotificationChannel,
} from './domainEvents';
import {
  getNotificationPrefs,
  saveNotificationPrefs,
} from '../notification.service';
import { recordEventSignal } from './eventTelemetry';

export type PreferenceMap = Record<NotificationCategory, boolean>;

/** The defaults, derived from the category declarations rather than restated. */
export const defaultPreferences = (): PreferenceMap =>
  Object.fromEntries(
    NOTIFICATION_CATEGORY_NAMES.map((name) => [name, NOTIFICATION_CATEGORIES[name].defaultOn]),
  ) as PreferenceMap;

/**
 * The account's preferences, with every declared category present.
 *
 * A row that predates a category returns the category DEFAULT rather than
 * `undefined`, so a caller never has to decide what a missing key means — which
 * is the decision that produces two different answers in two clients.
 */
export const getPreferences = async (uid: string): Promise<PreferenceMap> => {
  const stored = (await getNotificationPrefs(uid)) as Partial<PreferenceMap>;
  const defaults = defaultPreferences();
  const out = { ...defaults };
  for (const name of NOTIFICATION_CATEGORY_NAMES) {
    if (typeof stored[name] === 'boolean') out[name] = stored[name] as boolean;
  }
  return out;
};

export class PreferenceError extends Error {
  constructor(readonly code: 'PREFERENCE_INVALID', message: string) {
    super(message);
    this.name = 'PreferenceError';
  }
}

/**
 * A PARTIAL update. Unnamed categories keep their current value.
 *
 * PATCH semantics rather than PUT, deliberately: a client that knows about
 * seven categories must not silently reset the two it has never heard of to
 * their defaults, which is exactly what a full replace does the first time the
 * backend adds one. The existing `/settings/notification-preferences` PUT is a
 * full replace and is kept for the shipped provider clients; `saveNotificationPrefs`
 * already merges, so both shapes reach one writer.
 */
export const patchPreferences = async (
  uid: string,
  patch: Record<string, unknown>,
): Promise<PreferenceMap> => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new PreferenceError('PREFERENCE_INVALID', 'Body must be an object of category flags.');
  }

  const clean: Partial<PreferenceMap> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!(NOTIFICATION_CATEGORY_NAMES as readonly string[]).includes(key)) {
      throw new PreferenceError(
        'PREFERENCE_INVALID',
        `Unknown notification category "${key}". Known: ${NOTIFICATION_CATEGORY_NAMES.join(', ')}.`,
      );
    }
    if (typeof value !== 'boolean') {
      throw new PreferenceError('PREFERENCE_INVALID', `${key} must be true or false.`);
    }
    clean[key as NotificationCategory] = value;
  }

  await saveNotificationPrefs(uid, clean as never);
  return getPreferences(uid);
};

export interface ChannelDecisions {
  category: NotificationCategory;
  channels: Record<NotificationChannel, DeliveryDecision>;
}

/**
 * Every channel's answer for one category and one account.
 *
 * Used by the projector to decide whether to interrupt, and by the contract
 * document to render its matrix. One function, two consumers, so the table in
 * the document is what the code does.
 */
export const resolveDelivery = async (
  uid: string,
  category: NotificationCategory,
): Promise<ChannelDecisions> => {
  const preferences = await getPreferences(uid);
  const channels = Object.fromEntries(
    NOTIFICATION_CHANNELS.map((channel) => [channel, mayDeliver(category, channel, preferences)]),
  ) as Record<NotificationChannel, DeliveryDecision>;
  return { category, channels };
};

/**
 * The one question the push path asks.
 *
 * Records `PUSH_SUPPRESSED_BY_PREFERENCE` when the record is written and the
 * interruption withheld — which is what lets a support report of "I never got
 * notified" be answered with "you were, in the app; you asked us not to buzz".
 */
export const mayPush = async (
  uid: string,
  category: NotificationCategory,
): Promise<DeliveryDecision> => {
  const preferences = await getPreferences(uid);
  const decision = mayDeliver(category, 'push', preferences);
  if (!decision.deliver) recordEventSignal('PUSH_SUPPRESSED_BY_PREFERENCE', category);
  return decision;
};
