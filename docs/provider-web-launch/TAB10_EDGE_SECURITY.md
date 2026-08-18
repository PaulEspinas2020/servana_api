# TAB 10 — Edge and transport security headers

**Owner:** ServanaWorkerWeb (`netlify.toml`) + API nginx
**Status: portal half DONE and unreleased; API half and CSP enforcement are deploy-gated.**
**Measured:** live, 2026-08-18T14:56Z.

---

## What was actually there

| Origin | Security headers served |
|---|---|
| `https://provider.servana.com.ph` | `Strict-Transport-Security: max-age=31536000` — and nothing else |
| `https://api.servana.com.ph` | **none** |

`netlify.toml` had no `[[headers]]` block at all: a build command and an SPA
redirect.

### The part the sweep could not see

The portal was **not** without a Content-Security-Policy. `src/index.html`
carries a carefully derived one in a `<meta http-equiv="Content-Security-Policy">`
tag — correct origins for Firebase auth, reCAPTCHA Enterprise, the API, the
socket, Google Fonts and Firebase Storage.

A response-header sweep cannot see a meta CSP, which is why the portal reads as
having none. That distinction would be pedantic except for one thing:

> **`frame-ancestors` is ignored in a meta-tag CSP.**

The policy asks for `frame-ancestors 'none'` and does not receive it, and there
is no `X-Frame-Options` header either. So a portal handling provider identity
documents, payout configuration and job-state money actions has had, in practice,
**no frame protection**, while appearing in its own source to ask for it.

That is the clickjacking exposure the command names, arrived at by a subtler
route — and it is the reason the fix has to be a header rather than a better meta
tag.

---

## What now ships (unreleased)

Enforced from the first deploy, because none of these carries rollout risk:

| Header | Value | Why |
|---|---|---|
| `X-Frame-Options` | `DENY` | the frame protection the meta CSP could never deliver |
| `X-Content-Type-Options` | `nosniff` | stops a response being re-interpreted as script |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | a full referrer leaks provider and job ids |
| `Cross-Origin-Opener-Policy` | `same-origin` | isolates the browsing context |
| `Permissions-Policy` | `geolocation=(self), notifications=(self)`, everything else `()` | this portal genuinely uses both — go-online and live job tracking |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | two years, up from one, with subdomains |

**`preload` is deliberately absent.** The guardrail calls it effectively
irreversible and requires `includeSubDomains` verified safe for every Servana
subdomain — `api.`, `admin.`, and any staging host — before it is claimed.

### The CSP is report-only, and that is the guardrail not a hedge

`Content-Security-Policy-Report-Only`, mirroring the meta policy the application
**already runs against in production** — so the directive list is evidence rather
than a template — plus `frame-ancestors 'none'` and `object-src 'none'`.

It is promoted to enforcing after a full week of clean reports across every
provider flow: sign-in, dashboard, job accept-to-complete, chat with an
attachment, document upload, earnings, payout setup.

`'unsafe-inline'` in `script-src` is **carried, not endorsed**. It is in the
policy the app runs on today; removing it is a change to the build artefact
rather than to a header, and doing both at once would make any breakage
unattributable. The guardrail forbids *adding* it to make a policy pass, which is
not what this is — but it must not survive enforcement. Recorded as **M-25**.

---

## Mandate 7 — the post-deploy assertion

`scripts/assert-security-headers.mjs`, wired as `npm run headers:assert`.

Headers are configuration and configuration silently reverts; a `netlify.toml`
that declares a header is not evidence a browser was sent one. A redirect rule, a
plugin or a platform default can drop it with nothing failing.

**Watched to fail against production, not against a contrived mutation.** Run
against the live origin today it exits 1 with six failures, including:

```
FAIL  x-frame-options: (absent)
FAIL  x-content-type-options: (absent)
FAIL  referrer-policy: (absent)
FAIL  permissions-policy: (absent)
  - strict-transport-security max-age is 31536000, below the declared 63072000
  - strict-transport-security is missing includeSubDomains
```

The last two matter: HSTS was already *present*, so a presence-only check would
have passed both before and after this TAB and proved nothing.

---

## Mandate 6 — the preflight, re-measured

| Probe | Command's figure | Measured now |
|---|---|---|
| `OPTIONS /api/v1/me`, unknown origin | 401 | **404** |
| `OPTIONS /api/v1/me`, portal origin | — | **204**, correct |

The status changed because the v1 router is deployed and its own catch-all now
answers. The finding is unchanged: a legitimately new origin — a staging portal —
still receives a routing status rather than a clean CORS rejection, and is
therefore debugged in the wrong place.

### The item that is correct and must not regress

CORS allowlisting, re-verified after every change here:

```
Origin: https://provider.servana.com.ph  ->  Access-Control-Allow-Origin: https://provider.servana.com.ph
Origin: https://evil.example             ->  (no allow-origin header)
```

---

## Mandate status

| # | Mandate | State |
|---|---|---|
| 1 | `[[headers]]` block covering CSP, XFO, nosniff, Referrer-Policy, Permissions-Policy, HSTS | **DONE** (unreleased) |
| 2 | Derive the CSP from real dependencies, not a template | **DONE** — mirrors the policy already running in production |
| 3 | Report-only first, with a report endpoint, for a week | **PARTIAL** — report-only ships; the week of observation and the report endpoint are deploy-gated (**M-24**) |
| 4 | Scope `Permissions-Policy` deliberately | **DONE** |
| 5 | API-side HSTS and nosniff in nginx | **NOT DONE — no production access** (**M-26**) |
| 6 | Fix the preflight so a new origin sees a CORS rejection | **NOT DONE — nginx/middleware on the API host** (**M-26**) |
| 7 | Automated post-deploy header assertion | **DONE**, watched to fail against production |

### Guardrails honoured

- No CSP enforced without its week in report-only.
- No `'unsafe-inline'` or `'unsafe-eval'` **added** to make a policy pass; the
  existing one is carried and flagged for removal before enforcement.
- HSTS **not** preloaded.
- CORS allowlisting unchanged and re-verified in both directions.
