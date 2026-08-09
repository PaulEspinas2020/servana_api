/**
 * Where a Firebase email action returns the person afterwards.
 *
 * Firebase generates password-reset and email-verification links against the
 * project's own hosted action handler. Without an `ActionCodeSettings.url` the
 * journey simply ends there — on a page that is not Servana, with no way back.
 * `continueUrl` is what puts a route home on it.
 *
 * ── This is an allowlist, and that is the whole point ──────────────────────
 *
 * `continueUrl` is attacker-interesting: a reset link that can be pointed at an
 * arbitrary URL is a credential-phishing primitive wearing Firebase's domain.
 * So the caller does not supply a URL, it supplies a *name*, and the server
 * decides what that name resolves to. `6858a3f` introduced that rule; this file
 * only widens it by one platform.
 *
 * `ALLOWED_PLATFORMS` is DERIVED from the maps rather than declared beside them.
 * A hand-maintained second list is precisely how an allowlist and the map it
 * guards drift apart — one gets a new entry, the other does not, and the result
 * is either a dead feature or an unguarded lookup. Deriving it also keeps
 * `Object.keys` semantics, so `__proto__` and friends are not members.
 *
 * ── `platform` means two different things on two different routes ──────────
 *
 * This trips people up, so it is written down rather than left to be
 * rediscovered:
 *
 *   • On `/auth/forgot-password` and `/auth/resendverification`, `platform`
 *     names a **destination**, and the values are the keys below.
 *
 *   • On `/auth/signup`, `platform` selects the **verification channel**:
 *     `registerUser` branches on `platform === "mobile"` to send a 6-digit OTP,
 *     and sends a link for every other value. Its default is `"web"`.
 *
 * The two vocabularies overlap safely, and deliberately so:
 *
 *   - `"mobile"` is not a key here, so a mobile signup takes the OTP branch and
 *     never reaches a continueUrl at all.
 *   - `"web"` is not a key here either, so every existing web caller keeps
 *     today's behaviour — Firebase's default page — until it opts in by name.
 *   - `"customer"` and `"provider"` are not `"mobile"`, so a signup sending
 *     either still takes the link branch, which is the one that can carry a
 *     continueUrl.
 *
 * Adding `"mobile"` or `"web"` as a key here would break that and must not be
 * done: the first would hand a link to a flow that sends codes, and the second
 * would silently redirect two different web apps to one of them.
 */

/** A destination Servana is willing to send someone back to. */
export type ContinuePlatform = 'provider' | 'customer';

/**
 * Where a password reset finishes.
 *
 * ## The provider default was on the wrong host
 *
 * It read `https://servana.com.ph/provider/reset-password`. The provider portal
 * declares its own production origin as `https://provider.servana.com.ph`
 * (`environment.prod.ts`), and `servana.com.ph` is the origin the *customer*
 * portal was given — an app whose router sends every unknown path to a 404.
 *
 * So a provider resetting their password with `PROVIDER_RESET_URL` unset landed
 * on a page that could not help them. Corrected to the host the provider portal
 * says it serves; the `/provider` path prefix is real and comes from
 * `app-routing.module.ts`.
 *
 * Whether production sets `PROVIDER_RESET_URL` is not knowable from here. If it
 * does, this default never runs and nothing changes. If it does not, this is a
 * fix rather than a behaviour change, because the old value could only 404.
 */
export const PLATFORM_RESET_URLS: Record<ContinuePlatform, string> = {
    provider:
        process.env.PROVIDER_RESET_URL || 'https://provider.servana.com.ph/provider/reset-password',
    // ── Do not "correct" this to `client.servana.com.ph` ──────────────────
    //
    // It was changed to that host on 2026-08-09, sourced from `PUBLIC_SITE_URL`
    // in the customer portal's `.env.production`. Reverted the same day, because
    // an env file records what an app *believes*, not what is served:
    //
    //   dig client.servana.com.ph          -> NXDOMAIN (does not resolve)
    //   GET https://servana.com.ph/reset-password
    //                                      -> 301 -> www.servana.com.ph -> 404
    //
    // Production sets PROVIDER_RESET_URL but NOT CUSTOMER_RESET_URL, so this
    // default is what is emailed to real customers. `servana.com.ph` at least
    // resolves and serves a page; `client.servana.com.ph` gives the browser a
    // DNS error, which is strictly worse for the customer mobile app that is
    // live on Play and relies on this link.
    //
    // Both destinations are a dead end today: the customer web portal has never
    // been deployed (see the hosts note). The real fix is to deploy it and set
    // CUSTOMER_RESET_URL — not to point the default at a host that is missing.
    customer: process.env.CUSTOMER_RESET_URL || 'https://servana.com.ph/reset-password',
};

/**
 * Where an email-verification link finishes.
 *
 * Separate from the reset map because they are genuinely different pages: a
 * reset lands somewhere that takes a new password, a verification lands
 * somewhere that confirms and offers a way on. Collapsing them into one URL per
 * platform would send a customer who just verified their email to a password
 * form.
 *
 * ── Partial, and provider has no default on purpose ────────────────────────
 *
 * The provider portal has **no verify-email route**. Its routing module lists
 * login, signup, forgot-password, reset-password, invite, session-expired,
 * status and onboarding — and nothing else. A default pointing at
 * `/provider/verify-email` would therefore send providers to a 404 at the end
 * of a verification they completed successfully, which is worse than leaving
 * them on Firebase's page.
 *
 * So provider resolves to `undefined` unless `PROVIDER_VERIFY_URL` is set,
 * which is exactly today's behaviour. It becomes configurable the moment that
 * route exists, with no further code change.
 */
export const PLATFORM_VERIFY_URLS: Partial<Record<ContinuePlatform, string>> = {
    ...(process.env.PROVIDER_VERIFY_URL ? { provider: process.env.PROVIDER_VERIFY_URL } : {}),
    // Reverted alongside the reset map above — same reason, same evidence:
    // `client.servana.com.ph` does not resolve, and CUSTOMER_VERIFY_URL is not
    // set in production, so this default is what customers actually receive.
    customer: process.env.CUSTOMER_VERIFY_URL || 'https://servana.com.ph/verify-email',
};

/**
 * The only `platform` values that may resolve to a continueUrl.
 *
 * Derived from the reset map, not declared — see the note at the top. The reset
 * map is the authority because both platforms have a real reset page, whereas
 * the verify map is deliberately sparse; deriving from the sparse one would
 * shrink the allowlist and silently drop `provider` from password reset.
 */
export const ALLOWED_PLATFORMS: ReadonlySet<string> = new Set(Object.keys(PLATFORM_RESET_URLS));

/**
 * Resolves a caller-supplied platform name to a return URL, or `undefined`.
 *
 * `undefined` is the safe answer and the common one: every caller that omits
 * `platform`, and every caller that sends a value not on the allowlist, gets it
 * — and Firebase then uses its own hosted page exactly as it does today. No
 * existing client changes behaviour by this function existing.
 *
 * Non-string input (an object, an array, a number — anything a JSON body can
 * carry) is rejected before the lookup, so this cannot be walked into a
 * prototype read.
 */
export function continueUrlFor(
    kind: 'reset' | 'verify',
    platform: unknown,
): string | undefined {
    if (typeof platform !== 'string' || !ALLOWED_PLATFORMS.has(platform)) return undefined;
    const map: Partial<Record<ContinuePlatform, string>> =
        kind === 'reset' ? PLATFORM_RESET_URLS : PLATFORM_VERIFY_URLS;
    return map[platform as ContinuePlatform];
}

/**
 * Builds the `ActionCodeSettings` argument for a Firebase Admin link call — or
 * `undefined`, which is not the same thing.
 *
 * ## Why this exists rather than a ternary at each call site
 *
 * `generatePasswordResetLink(email, {})` is **not** the same call as
 * `generatePasswordResetLink(email)`. Passing an empty settings object, or one
 * carrying `url: ''`, makes Firebase reject a request that works today — so the
 * difference between `undefined` and `{}` is the difference between a working
 * signup and a broken one, and it is invisible to any test that only checks
 * which URL was resolved.
 *
 * Two call sites got that ternary right independently. A third would be a coin
 * flip, and the failure only shows up in production email. One function means
 * the decision is made once and is the obvious thing to reach for.
 *
 * Falsy input — `undefined`, `null`, `''` — all mean "no return URL", and all
 * produce `undefined` rather than a settings object nobody asked for.
 */
export function toActionCodeSettings(continueUrl?: string): { url: string } | undefined {
    return continueUrl ? { url: continueUrl } : undefined;
}

/**
 * Rejects a configured URL that would produce a dead or unsafe link.
 *
 * Called at boot (see `assertContinueUrlsAreUsable`) rather than at send time,
 * because the alternative is discovering a typo in an env var from a customer
 * who cannot get back into their account.
 *
 * `https` is required. An `http` reset link is a password-change flow over
 * plaintext, and Firebase's own allowlist would reject it at send time anyway —
 * later, and less legibly.
 */
export function isUsableContinueUrl(value: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return false;
    }
    return parsed.protocol === 'https:' && parsed.hostname.length > 0;
}

/**
 * Fails startup on a continue URL that could never work.
 *
 * These URLs are only ever exercised by an email somebody receives, which makes
 * a typo in `CUSTOMER_RESET_URL` the kind of defect that sits unnoticed until a
 * customer is locked out and support cannot say why. Boot is the last moment it
 * can be caught cheaply.
 *
 * Throws rather than warns: a process that starts and silently emails broken
 * password-reset links is worse than one that refuses to start and says which
 * variable is wrong.
 */
export function assertContinueUrlsAreUsable(): void {
    const entries: Array<[string, string | undefined]> = [
        ['PROVIDER_RESET_URL', PLATFORM_RESET_URLS.provider],
        ['CUSTOMER_RESET_URL', PLATFORM_RESET_URLS.customer],
        ['PROVIDER_VERIFY_URL', PLATFORM_VERIFY_URLS.provider],
        ['CUSTOMER_VERIFY_URL', PLATFORM_VERIFY_URLS.customer],
    ];

    const broken = entries
        .filter(([, url]) => url !== undefined && !isUsableContinueUrl(url))
        .map(([name, url]) => `${name}=${url}`);

    if (broken.length > 0) {
        throw new Error(
            `Unusable Firebase continue URL(s): ${broken.join(', ')}. ` +
            `Each must be an absolute https URL. These are emailed to people as ` +
            `password-reset and email-verification destinations.`,
        );
    }
}
