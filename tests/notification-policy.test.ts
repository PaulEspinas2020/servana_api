/**
 * The notification policy is ONE declaration with real consumers.
 *
 * `domainEvents` is only worth having if the services enforce it, the documents
 * are generated from it and nothing restates it. A policy module everybody
 * imports and nobody obeys is a comment with a type signature.
 *
 * Two halves:
 *
 *   1. the DECISIONS behave — preference precedence, the transactional
 *      carve-out, deep-link rendering, the refusal to invent a route;
 *   2. the declaration is WIRED — device tokens are account-scoped, stale tokens
 *      are pruned only on permanent errors, and the telemetry catalog and the
 *      emitter name the same signals.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => {
  const fake = require('./support/eventDbFake');
  return { __esModule: true, default: fake.dbQueryFake, pool: { connect: jest.fn() } };
});
jest.mock('../src/provider.realtime', () => ({ emitToProvider: jest.fn() }));
jest.mock('../src/services/adminCommunicationService', () => ({
  logCommunicationEvent: jest.fn().mockResolvedValue(undefined),
}));

import fs from 'fs';
import path from 'path';
import * as fake from './support/eventDbFake';
import {
  CHANNEL_POLICY,
  DEEP_LINK_TARGETS,
  DEEP_LINK_TARGET_NAMES,
  DOMAIN_EVENTS,
  DOMAIN_EVENT_NAMES,
  ENTITY_REF_NAMES,
  EVENT_SIGNAL_CODES,
  FORBIDDEN_REFS,
  NOTIFICATION_CATEGORY_NAMES,
  NOTIFICATION_CHANNELS,
  PREFERENCE_OVERRIDE_CATEGORIES,
  deepLinkFor,
  mayDeliver,
  type DomainEventSpec,
} from '../src/services/events/domainEvents';
import {
  EMITTED_SIGNAL_CODES,
  undeclaredSignals,
} from '../src/services/events/eventTelemetry';
import * as preferences from '../src/services/events/notificationPreferences';
import * as devices from '../src/services/events/deviceTokenService';

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

beforeEach(() => {
  fake.reset();
  devices.__resetDeviceTokenSchema();
});

// ─── Preference decisions ─────────────────────────────────────────────────────

describe('mayDeliver', () => {
  it('NEVER suppresses the in-app record, for any category', () => {
    // The inbox is the RECORD. Suppressing it would put holes in the audit trail
    // and make the unread count irreconcilable with the events that produced it.
    for (const category of NOTIFICATION_CATEGORY_NAMES) {
      const decision = mayDeliver(category, 'inApp', { [category]: false } as never);
      expect(decision.deliver).toBe(true);
      expect(decision.overridden).toBe(false);
    }
    expect(CHANNEL_POLICY.inApp.obeysPreference).toBe(false);
  });

  it('withholds push when the account turned the category off', () => {
    expect(mayDeliver('newMessage', 'push', { newMessage: false }).deliver).toBe(false);
    expect(mayDeliver('newMessage', 'push', { newMessage: true }).deliver).toBe(true);
  });

  it('applies the category DEFAULT when the account has never chosen', () => {
    // An account that has never opened the settings screen has no row at all.
    expect(mayDeliver('jobAssigned', 'push', {}).deliver).toBe(true);
    expect(mayDeliver('promotions', 'push', {}).deliver).toBe(false);
  });

  it('overrides a disabled preference ONLY for the transactional categories', () => {
    for (const category of NOTIFICATION_CATEGORY_NAMES) {
      const decision = mayDeliver(category, 'push', { [category]: false } as never);
      const shouldOverride = PREFERENCE_OVERRIDE_CATEGORIES.includes(category);
      expect(decision.deliver).toBe(shouldOverride);
      expect(decision.overridden).toBe(shouldOverride);
    }
  });

  it('NEVER lets the carve-out deliver marketing', () => {
    // The whole risk of a transactional override is that it becomes a way to
    // reach people who opted out. `promotions` is excluded by declaration.
    expect(PREFERENCE_OVERRIDE_CATEGORIES).not.toContain('promotions');
    expect(mayDeliver('promotions', 'push', { promotions: false }).deliver).toBe(false);
  });

  it('fails closed for an unknown category on an interrupting channel', () => {
    const push = mayDeliver('somethingNew' as never, 'push', {});
    const inApp = mayDeliver('somethingNew' as never, 'inApp', {});
    expect(push.deliver).toBe(false);
    // ...and still keeps the record, because not knowing the category is not a
    // reason to lose the fact.
    expect(inApp.deliver).toBe(true);
  });
});

describe('the preference model is account-scoped and complete', () => {
  it('returns EVERY declared category, whether or not a row exists', async () => {
    const prefs = await preferences.getPreferences('nobody');
    expect(Object.keys(prefs).sort()).toEqual([...NOTIFICATION_CATEGORY_NAMES].sort());
  });

  it('a PATCH changes only what it names', async () => {
    fake.seedUser('acct-1', 3);
    const before = await preferences.getPreferences('acct-1');
    expect(before.promotions).toBe(false);
    expect(before.jobAssigned).toBe(true);

    const after = await preferences.patchPreferences('acct-1', { promotions: true });
    expect(after.promotions).toBe(true);
    // The categories the caller did not name are untouched — which a full
    // replace could not promise.
    expect(after.jobAssigned).toBe(true);
    expect(after.newMessage).toBe(true);
  });

  it('refuses an unknown category rather than ignoring it', async () => {
    await expect(preferences.patchPreferences('acct-1', { notACategory: true }))
      .rejects.toMatchObject({ code: 'PREFERENCE_INVALID' });
  });

  it('refuses a non-boolean value', async () => {
    await expect(preferences.patchPreferences('acct-1', { promotions: 'yes' }))
      .rejects.toMatchObject({ code: 'PREFERENCE_INVALID' });
  });

  it('two accounts do not share preferences', async () => {
    fake.seedUser('acct-1', 3);
    fake.seedUser('acct-2', 2);
    await preferences.patchPreferences('acct-1', { promotions: true });

    expect((await preferences.getPreferences('acct-1')).promotions).toBe(true);
    expect((await preferences.getPreferences('acct-2')).promotions).toBe(false);
  });

  it('resolves every channel in one answer', async () => {
    const decisions = await preferences.resolveDelivery('acct-1', 'accountSecurity');
    expect(Object.keys(decisions.channels).sort()).toEqual([...NOTIFICATION_CHANNELS].sort());
  });
});

// ─── Device tokens ────────────────────────────────────────────────────────────

describe('device tokens are account-scoped and multi-device', () => {
  const TOKEN_A = 'device-token-aaaaaaaaaa';
  const TOKEN_B = 'device-token-bbbbbbbbbb';

  beforeEach(() => {
    fake.seedUser('acct-1', 3);
    fake.seedUser('acct-2', 3);
  });

  it('one account can hold several devices — the customer defect', async () => {
    // Customers had a single COLUMN, so a phone and a tablet meant push on
    // whichever signed in last, silently.
    await devices.registerDevice('acct-1', TOKEN_A);
    const result = await devices.registerDevice('acct-1', TOKEN_B);

    expect(result.registered).toBe(true);
    expect((await devices.tokensFor('acct-1')).sort()).toEqual([TOKEN_A, TOKEN_B].sort());
  });

  it('registering a device another account holds MOVES it', async () => {
    await devices.registerDevice('acct-1', TOKEN_A);
    await devices.registerDevice('acct-2', TOKEN_A);

    // A handset can only be signed into one account at a time. Two owners would
    // be a cross-account leak with a lock screen attached.
    expect(await devices.tokensFor('acct-1')).toEqual([]);
    expect(await devices.tokensFor('acct-2')).toEqual([TOKEN_A]);
  });

  it('releasing ONE device leaves the others enrolled', async () => {
    await devices.registerDevice('acct-1', TOKEN_A);
    await devices.registerDevice('acct-1', TOKEN_B);

    await devices.releaseDevice('acct-1', TOKEN_A);
    expect(await devices.tokensFor('acct-1')).toEqual([TOKEN_B]);
  });

  it('releasing with NO token releases everything — sign out everywhere', async () => {
    await devices.registerDevice('acct-1', TOKEN_A);
    await devices.registerDevice('acct-1', TOKEN_B);

    await devices.releaseDevice('acct-1');
    expect(await devices.tokensFor('acct-1')).toEqual([]);
  });

  it('reads the LEGACY stores too, so a device registered before this still works', async () => {
    // The union is the migration. Dropping the legacy read would silently stop
    // push for everyone who registered through the old route.
    fake.store.providerDeviceTokens.push({ token: 'legacy-provider-token', worker_uid: 'acct-1' });
    const user = fake.store.users.find((u) => u.uid === 'acct-1')!;
    user.fcm_token = 'legacy-column-token';

    expect((await devices.tokensFor('acct-1')).sort())
      .toEqual(['legacy-column-token', 'legacy-provider-token']);
  });

  it('refuses a malformed token rather than storing it', async () => {
    for (const bad of ['', 'short', 'has whitespace in it', 42, null]) {
      const result = await devices.registerDevice('acct-1', bad);
      expect(result.registered).toBe(false);
    }
    expect(await devices.tokensFor('acct-1')).toEqual([]);
  });
});

describe('stale token pruning is narrow on purpose', () => {
  it('prunes ONLY on the two permanent errors', () => {
    expect(devices.isPermanentTokenError({ code: 'messaging/registration-token-not-registered' })).toBe(true);
    expect(devices.isPermanentTokenError({ code: 'messaging/invalid-registration-token' })).toBe(true);

    // Everything else is transient. Deleting a token on a transient failure
    // would un-enroll working devices during exactly the outage that caused it.
    for (const code of [
      'messaging/server-unavailable',
      'messaging/internal-error',
      'messaging/quota-exceeded',
      'ETIMEDOUT',
    ]) {
      expect(devices.isPermanentTokenError({ code })).toBe(false);
    }
    expect(devices.isPermanentTokenError(new Error('network'))).toBe(false);
  });

  it('removes the token from every store it can be in', async () => {
    fake.seedUser('acct-1', 2);
    const token = 'device-token-cccccccccc';
    await devices.registerDevice('acct-1', token);
    expect(await devices.tokensFor('acct-1')).toEqual([token]);

    await devices.pruneToken(token);
    expect(await devices.tokensFor('acct-1')).toEqual([]);
  });
});

// ─── Deep links ───────────────────────────────────────────────────────────────

describe('the deep-link contract', () => {
  it('renders both client vocabularies from ONE target', () => {
    const customer = deepLinkFor('BOOKING_DETAIL', 'customer', { bookingId: 75 });
    const provider = deepLinkFor('BOOKING_DETAIL', 'provider', { bookingId: 75 });

    expect(customer).toMatchObject({ routeKey: 'BOOKING_DETAILS', resourceId: '75' });
    expect(provider).toMatchObject({ page: 'jobs', bookingId: '75' });
    // ...plus the canonical half a migrating client reads instead of either.
    expect(customer!.target).toBe('BOOKING_DETAIL');
    expect(provider!.target).toBe('BOOKING_DETAIL');
  });

  it('REFUSES to render a target whose canonical id is missing', () => {
    // A deep link to the literal "{id}" is worse than none: the client opens a
    // screen and then fails to load it.
    expect(deepLinkFor('BOOKING_DETAIL', 'customer', {})).toBeNull();
    expect(deepLinkFor('CONVERSATION', 'customer', { bookingId: 75 })).toBeNull();
  });

  it('returns null where a seat has no screen, rather than inventing one', () => {
    expect(deepLinkFor('EARNINGS', 'customer', { bookingId: 75 })).toBeNull();
    expect(deepLinkFor('APPLICATION', 'customer', { applicationId: 'a1' })).toBeNull();
  });

  it('marks every resource target as requiring an access check AFTER navigation', () => {
    for (const name of DEEP_LINK_TARGET_NAMES) {
      const spec = DEEP_LINK_TARGETS[name];
      if (spec.ref) expect(spec.requiresAccessCheck).toBe(true);
    }
    const link = deepLinkFor('BOOKING_DETAIL', 'customer', { bookingId: 75 });
    expect(link!.requiresAccessCheck).toBe(true);
  });

  it('gives providers the messages TAB and not a booking id for CONVERSATION', () => {
    // ServanaWorker's resolver prefers a booking id and would open JobDetailsView,
    // which has no chat entry point (PM-257) — a tap would land on a screen with
    // no way to reach the message it announced.
    const provider = deepLinkFor('CONVERSATION', 'provider', { conversationId: 11, bookingId: 75 });
    expect(provider).toMatchObject({ page: 'messages' });
    expect(provider).not.toHaveProperty('bookingId');
  });

  it('every event projection names a declared target', () => {
    for (const name of DOMAIN_EVENT_NAMES) {
      const spec = DOMAIN_EVENTS[name] as DomainEventSpec;
      for (const recipient of spec.recipients) {
        if (!recipient.notification) continue;
        expect(DEEP_LINK_TARGET_NAMES).toContain(recipient.notification.deepLink);
      }
    }
  });
});

// ─── Canonical ids ────────────────────────────────────────────────────────────

describe('canonical identifiers', () => {
  it('every required ref of every event is a declared canonical id', () => {
    for (const name of DOMAIN_EVENT_NAMES) {
      const spec = DOMAIN_EVENTS[name] as DomainEventSpec;
      for (const ref of [...spec.requiredRefs, ...spec.optionalRefs]) {
        expect(ENTITY_REF_NAMES).toContain(ref);
      }
    }
  });

  it('the legacy service family is on the forbidden list', () => {
    // Catalog V2 is certified with services.id as the canonical specific-service
    // identity. An event carrying a family id is how it creeps back in.
    expect(FORBIDDEN_REFS).toContain('serviceFamilyId');
    expect(FORBIDDEN_REFS).toContain('service_family_id');
    expect(ENTITY_REF_NAMES).not.toContain('serviceFamilyId' as never);
  });

  it('no event carries a screen name as an identifier', () => {
    for (const ref of ENTITY_REF_NAMES) {
      expect(ref).not.toMatch(/screen|route|page/i);
    }
  });
});

// ─── Wiring ───────────────────────────────────────────────────────────────────

describe('the declaration has real consumers', () => {
  it('the executor publishes INSIDE its transaction, before the COMMIT', () => {
    const executor = read('src/services/booking/transitionExecutor.ts');
    const publishAt = executor.indexOf('await publishBookingEvent({');
    // The COMMIT that follows the publish, found by searching FROM the publish
    // rather than by matching surrounding whitespace — which is brittle in a
    // file three other tabs also edit.
    const commitAt = executor.indexOf("await client.query('COMMIT');", publishAt);
    expect(publishAt).toBeGreaterThan(0);
    expect(commitAt).toBeGreaterThan(publishAt);
    // The client is threaded through, which is what makes it one transaction
    // rather than two writes that happen to be adjacent.
    expect(executor).toMatch(/publishBookingEvent\(\{[\s\S]{0,600}client,\s*\n\s*\}\)/);
  });

  it('dispatch happens AFTER the commit and is never awaited', () => {
    const executor = read('src/services/booking/transitionExecutor.ts');
    expect(executor).toMatch(/await client\.query\('COMMIT'\);[\s\S]{0,900}dispatchSoon\(\);/);
  });

  it('the route sanitiser preserves the canonical target', () => {
    // It stripped `target` until TAB 09, so the one field that says
    // unambiguously where a notification points never survived the write.
    const service = read('src/services/notification.service.ts');
    expect(service).toMatch(/'target',/);
  });

  it('every telemetry code the emitter uses is declared', () => {
    expect(undeclaredSignals()).toEqual([]);
    for (const code of EVENT_SIGNAL_CODES) expect(EMITTED_SIGNAL_CODES).toContain(code);
  });

  it('every event names where it is published from', () => {
    for (const name of DOMAIN_EVENT_NAMES) {
      const spec = DOMAIN_EVENTS[name] as DomainEventSpec;
      expect(spec.publishedBy.length).toBeGreaterThan(10);
      expect(spec.description.length).toBeGreaterThan(20);
    }
  });

  it('every projection records which legacy producer it supersedes, or that it is new', () => {
    // A projection with no `supersedes` entry is one nobody checked for a
    // duplicate — which is the failure this whole migration strategy prevents.
    for (const name of DOMAIN_EVENT_NAMES) {
      const spec = DOMAIN_EVENTS[name] as DomainEventSpec;
      for (const recipient of spec.recipients) {
        if (!recipient.notification) continue;
        expect(recipient.notification).toHaveProperty('supersedes');
      }
    }
  });
});
