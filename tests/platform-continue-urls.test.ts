/**
 * `continueUrl` isolation, and the guarantee that adding `customer` changed
 * nothing for anyone who was already here.
 *
 * The allowlist exists because a password-reset link whose return address an
 * attacker controls is a credential-phishing primitive wearing Firebase's
 * domain (`6858a3f`). Widening it by one platform is only safe if the widening
 * is provably inert for every caller that does not ask for it — which is what
 * most of this file asserts.
 */

import {
    ALLOWED_PLATFORMS,
    PLATFORM_RESET_URLS,
    PLATFORM_VERIFY_URLS,
    continueUrlFor,
} from '../src/constants/platformContinueUrls';

describe('the allowlist itself', () => {
    test('contains exactly provider and customer', () => {
        expect([...ALLOWED_PLATFORMS].sort()).toEqual(['customer', 'provider']);
    });

    test('is derived from the reset map, so the two cannot drift apart', () => {
        // A hand-maintained second list is how an allowlist and the map it
        // guards end up disagreeing — one gets a new entry, the other does not.
        expect([...ALLOWED_PLATFORMS].sort()).toEqual(Object.keys(PLATFORM_RESET_URLS).sort());
    });

    test('the verify map may be sparse, and every key it has is allowlisted', () => {
        // Sparse on purpose: the provider portal has no verify-email route, so
        // there is nowhere honest to send a provider at the end of one.
        for (const key of Object.keys(PLATFORM_VERIFY_URLS)) {
            expect(ALLOWED_PLATFORMS.has(key)).toBe(true);
        }
    });

    test('does NOT contain "mobile" or "web"', () => {
        // "mobile" would hand a link to a flow that sends 6-digit codes.
        // "web" is the signup default sent by more than one app, so it would
        // silently redirect one of them to the other's page.
        expect(ALLOWED_PLATFORMS.has('mobile')).toBe(false);
        expect(ALLOWED_PLATFORMS.has('web')).toBe(false);
    });
});

/**
 * Every existing caller, by name, with the exact body it sends.
 *
 * Read from the four client repos rather than assumed, because "additive"
 * is a claim about *them* and cannot be established by looking at the backend
 * alone. Each case below names the file it came from so the next person can
 * re-check it rather than trust this comment.
 */
describe('what existing callers get — the no-change guarantee', () => {
    test('customer mobile app: does not call forgot-password at all', () => {
        // servana_client-main shows a "Password reset is coming soon" snackbar
        // (authentication_screen.dart) and makes no request. Nothing about this
        // change can reach it.
        expect(continueUrlFor('reset', undefined)).toBeUndefined();
    });

    test('worker mobile app: posts { email } with no platform', () => {
        // ServanaWorker servana_api.dart forgotPassword() sends data: {email}.
        // It also has no oobCode screen, no intent-filter and no
        // associated-domains entitlement — so it could not receive a deep link
        // even if one were routed to it. Firebase's page stays correct for it.
        expect(continueUrlFor('reset', undefined)).toBeUndefined();
    });

    test('admin portal: calls neither route', () => {
        // servana_adminportal auth.service.ts contains /auth/signin and
        // /profile/getprofile, and nothing else.
        expect(continueUrlFor('reset', undefined)).toBeUndefined();
        expect(continueUrlFor('verify', undefined)).toBeUndefined();
    });

    test('customer mobile signup sends platform "mobile" — no continueUrl', () => {
        // http_backend.dart:136 sends {'platform': 'mobile'}. That value takes
        // registerUser's OTP branch, which returns before any link is
        // generated — so this is unreachable as well as unresolvable.
        expect(continueUrlFor('verify', 'mobile')).toBeUndefined();
        expect(continueUrlFor('reset', 'mobile')).toBeUndefined();
    });

    test('worker signup sends "mobile" on device and "web" on Flutter Web — neither resolves', () => {
        // signup_view.dart:26 — `kIsWeb ? 'web' : 'mobile'`. Never 'provider'.
        expect(continueUrlFor('verify', 'mobile')).toBeUndefined();
        expect(continueUrlFor('verify', 'web')).toBeUndefined();
    });

    test('provider web signup body carries no platform at all', () => {
        // Servana.com.ph BackendSignUpRequest has no platform field, and its
        // live path is /auth/provider/register with sourceClient anyway.
        expect(continueUrlFor('verify', undefined)).toBeUndefined();
    });

    test('provider web forgot-password keeps resolving to the provider reset URL', () => {
        // provider-auth-api.service.ts:155 sends { email, platform: 'provider' },
        // and two of its own specs assert that exact body. The behaviour 6858a3f
        // shipped must survive this change untouched.
        expect(continueUrlFor('reset', 'provider')).toBe(PLATFORM_RESET_URLS.provider);
    });

    test('provider verification stays on Firebase, because it has no page to return to', () => {
        // Unless PROVIDER_VERIFY_URL is explicitly configured.
        if (!process.env.PROVIDER_VERIFY_URL) {
            expect(continueUrlFor('verify', 'provider')).toBeUndefined();
        }
    });

    test('an unrecognised platform yields no continueUrl rather than throwing', () => {
        expect(continueUrlFor('reset', 'admin')).toBeUndefined();
        expect(continueUrlFor('reset', '')).toBeUndefined();
        expect(continueUrlFor('verify', 'CUSTOMER')).toBeUndefined();
    });
});

describe('what the customer web portal gets', () => {
    test('customer resolves to the customer reset URL', () => {
        expect(continueUrlFor('reset', 'customer')).toBe(PLATFORM_RESET_URLS.customer);
    });

    test('customer resolves to the customer verify URL', () => {
        expect(continueUrlFor('verify', 'customer')).toBe(PLATFORM_VERIFY_URLS.customer);
    });

    test('reset and verify are different destinations', () => {
        // Collapsing them would land a customer who just verified their email
        // on a page asking for a new password.
        expect(continueUrlFor('reset', 'customer')).not.toBe(continueUrlFor('verify', 'customer'));
    });

    test('the customer URLs match routes the customer portal actually serves', () => {
        // servana_Customer_WebPortal app.routes.ts declares both. A continueUrl
        // pointing at a route that does not exist ends a successful action on a
        // 404, which is worse than ending it on Firebase's page.
        expect(continueUrlFor('reset', 'customer')).toMatch(/\/reset-password$/);
        expect(continueUrlFor('verify', 'customer')).toMatch(/\/verify-email$/);
    });

    test('every configured URL is absolute https', () => {
        for (const url of [
            ...Object.values(PLATFORM_RESET_URLS),
            ...Object.values(PLATFORM_VERIFY_URLS),
        ]) {
            expect(url).toMatch(/^https:\/\//);
        }
    });
});

describe('the lookup cannot be walked into the prototype', () => {
    test('__proto__, constructor and prototype all yield undefined', () => {
        for (const attempt of ['__proto__', 'constructor', 'prototype', 'toString']) {
            expect(continueUrlFor('reset', attempt)).toBeUndefined();
            expect(continueUrlFor('verify', attempt)).toBeUndefined();
        }
    });

    test('non-string input is rejected before the lookup', () => {
        // A JSON body can carry any of these where a string was expected.
        for (const attempt of [null, 42, true, {}, [], { toString: () => 'customer' }]) {
            expect(continueUrlFor('reset', attempt)).toBeUndefined();
        }
    });

    test('an object whose toString says "customer" is still refused', () => {
        // The typeof check is what makes this true; a coercing lookup would not.
        const sneaky = { toString: () => 'customer', valueOf: () => 'customer' };
        expect(continueUrlFor('reset', sneaky)).toBeUndefined();
    });
});
